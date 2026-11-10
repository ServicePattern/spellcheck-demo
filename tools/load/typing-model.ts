import type { Conversation, Language } from './chats.ts';
import { createRandomStream } from './random.ts';
import type { TypingSettings } from './settings.ts';
import { wordsWithTypos } from './typos.ts';

export const SPEED_SPREAD = 0.25;
export const BURST_WORDS_SPREAD = 0.5;
export const PAUSE_SPREAD = 0.7;
export const BETWEEN_MESSAGES_SPREAD = 0.6;
const CHARACTERS_PER_WORD = 5;

export interface TypingModel {
  language: Language;
  wordsPerMinute: number;
  typedWords(message: string): string[];
  wordsInNextBurst(): number;
  burstMs(characterCount: number): number;
  pauseMs(): number;
  betweenMessagesMs(): number;
  isSpellCheckOnlyRound(): boolean;
  spellCheckOnlyCaret(draft: string): number;
  isCompletionAccepted(): boolean;
  nextConversation(conversations: Conversation[]): Conversation;
}

export function createTypingModel(settings: TypingSettings, seed: number, agentNumber: number): TypingModel {
  const typing = createRandomStream(seed, agentNumber, 'typing');
  const typos = createRandomStream(seed, agentNumber, 'typos');
  const rounds = createRandomStream(seed, agentNumber, 'rounds');
  const accepting = createRandomStream(seed, agentNumber, 'accepting');
  const scripts = createRandomStream(seed, agentNumber, 'scripts');
  const language: Language = typing.isChance(settings.arabicShare) ? 'Arabic' : 'English';
  const speedFactor = 1 - SPEED_SPREAD + typing.next() * 2 * SPEED_SPREAD;
  const wordsPerMinute = settings.wordsPerMinute * speedFactor;
  let conversationOrder: Conversation[] = [];
  return {
    language,
    wordsPerMinute,
    typedWords: (message) => wordsWithTypos(message, settings.typoEvery, typos),
    wordsInNextBurst: () => Math.max(1, Math.round(typing.logNormal(settings.burstWords, BURST_WORDS_SPREAD))),
    burstMs: (characterCount) => characterCount / (wordsPerMinute * CHARACTERS_PER_WORD) * 60000,
    pauseMs: () => typing.logNormal(settings.pauseMs, PAUSE_SPREAD),
    betweenMessagesMs: () => typing.logNormal(settings.betweenMessagesMs, BETWEEN_MESSAGES_SPREAD),
    isSpellCheckOnlyRound: () => rounds.isChance(settings.spellCheckOnlyShare),
    spellCheckOnlyCaret: (draft) => {
      const wordEnds = Array.from(draft.matchAll(/\S(?=\s)/g), (match) => match.index + 1);
      return wordEnds.length ? wordEnds[rounds.integerBelow(wordEnds.length)] : 0;
    },
    isCompletionAccepted: () => accepting.isChance(settings.acceptShare),
    nextConversation: (conversations) => {
      if (!conversationOrder.length) {
        const ofLanguage = conversations.filter((conversation) => conversation.language === language);
        conversationOrder = scripts.shuffled(ofLanguage);
      }
      const conversation = conversationOrder.shift();
      if (!conversation) {
        throw new Error(`No ${language} conversation in the chat sources.`);
      }
      return conversation;
    },
  };
}
