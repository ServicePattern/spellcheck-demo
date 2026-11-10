import {
  buildAutoCompletionMessage,
  buildSpellCheckMessage,
  parseAutoCompletion,
  parseMistakes,
} from '../../src/assistant/llm.ts';
import type { LLMClient, LLMRequestKind, LLMResult } from '../../src/assistant/types.ts';
import { messageScriptsOf, type Conversation, type Language, type MessageScript } from './chats.ts';
import type { Clock } from './clock.ts';
import { requestContextFor, type RequestContext } from './context.ts';
import type { TypingSettings } from './settings.ts';
import type { TypingModel } from './typing-model.ts';

export type Outcome = 'answered' | 'unreadable' | 'aborted' | 'timeout' | 'failed' | 'cut';

export interface RequestEnd {
  agentNumber: number;
  kind: LLMRequestKind;
  language: Language;
  sentAt: number;
  outcome: Outcome;
  latencyMs: number;
  allowedMs: number;
  userMessageChars: number;
  answerChars: number;
  mistakeCount?: number;
  isCompletionEmpty?: boolean;
  reason?: string;
  userMessage: string;
  rawAnswer?: string;
}

export interface RequestEvent {
  type: 'request';
  request: RequestEnd;
}

export interface RoundEvent {
  type: 'round';
  agentNumber: number;
  at: number;
}

export interface BurstEvent {
  type: 'burst';
  agentNumber: number;
  at: number;
  draft: string;
}

export interface MessageStartEvent {
  type: 'message-start';
  agentNumber: number;
  at: number;
}

export interface MessageSentEvent {
  type: 'message';
  agentNumber: number;
  startedAt: number;
  sentAt: number;
}

export type AgentEvent = RequestEvent | RoundEvent | BurstEvent | MessageStartEvent | MessageSentEvent;

export interface AgentOptions {
  agentNumber: number;
  model: TypingModel;
  settings: TypingSettings;
  conversations: Conversation[];
  clock: Clock;
  llmClient: LLMClient;
  stopSignal: AbortSignal;
  takeRequestPermit: () => boolean;
  onEvent: (event: AgentEvent) => void;
}

type EndReason = 'resume' | 'stop';

interface SentRequest {
  kind: LLMRequestKind;
  sentAt: number;
  outcome: Outcome;
  latencyMs: number;
  userMessage: string;
  rawAnswer?: string;
  reason?: string;
  mistakeCount?: number;
  completion?: string;
}

interface RoundDraft {
  draft: string;
  caret: number;
  requestContext: RequestContext;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  try {
    while (true) {
      const conversation = options.model.nextConversation(options.conversations);
      for (const script of messageScriptsOf(conversation)) {
        await typeMessage(options, script);
        await options.clock.sleep(options.model.betweenMessagesMs(), options.stopSignal);
      }
    }
  } catch (error) {
    if (!options.stopSignal.aborted) {
      throw error;
    }
  }
}

async function typeMessage(options: AgentOptions, script: MessageScript): Promise<void> {
  const { model, clock, stopSignal, agentNumber } = options;
  const requestContext = requestContextFor(script.language, script.conversationSoFar);
  const words = model.typedWords(script.message);
  const startedAt = clock.now();
  options.onEvent({
    type: 'message-start',
    agentNumber,
    at: startedAt,
  });
  let typedCount = 0;
  while (typedCount < words.length) {
    const burstCount = Math.min(model.wordsInNextBurst(), words.length - typedCount);
    const draftBefore = draftOf(words, typedCount);
    const draftAfter = draftOf(words, typedCount + burstCount);
    await clock.sleep(model.burstMs(draftAfter.length - draftBefore.length), stopSignal);
    typedCount += burstCount;
    options.onEvent({
      type: 'burst',
      agentNumber,
      at: clock.now(),
      draft: draftAfter,
    });
    typedCount = await pauseAfterBurst(options, words, typedCount, requestContext);
  }
  options.onEvent({
    type: 'message',
    agentNumber,
    startedAt,
    sentAt: clock.now(),
  });
}

function draftOf(words: string[], count: number): string {
  return words.slice(0, count).join(' ');
}

async function pauseAfterBurst(
  options: AgentOptions,
  words: string[],
  typedCount: number,
  requestContext: RequestContext,
): Promise<number> {
  const { model, clock, settings, stopSignal } = options;
  let count = typedCount;
  while (true) {
    const pauseMs = model.pauseMs();
    if (pauseMs < settings.debounceMs) {
      await clock.sleep(pauseMs, stopSignal);
      return count;
    }
    const resumeAt = clock.now() + pauseMs;
    await clock.sleep(settings.debounceMs, stopSignal);
    const acceptedWords = await runRound(options, draftOf(words, count), resumeAt, requestContext);
    if (acceptedWords === undefined) {
      return count;
    }
    count = Math.min(words.length, count + acceptedWords);
  }
}

async function runRound(
  options: AgentOptions,
  draft: string,
  resumeAt: number,
  requestContext: RequestContext,
): Promise<number | undefined> {
  const { model, clock, stopSignal, agentNumber } = options;
  options.onEvent({
    type: 'round',
    agentNumber,
    at: clock.now(),
  });
  const isSpellCheckOnly = model.isSpellCheckOnlyRound();
  const roundDraft: RoundDraft = {
    draft,
    caret: isSpellCheckOnly ? model.spellCheckOnlyCaret(draft) : draft.length,
    requestContext,
  };
  const sentAt = clock.now();
  const kinds: LLMRequestKind[] = isSpellCheckOnly ? ['spell-check'] : ['spell-check', 'auto-completion'];
  const round = new AbortController();
  const pauseEnd = new AbortController();
  const endPause = () => pauseEnd.abort();
  stopSignal.addEventListener('abort', endPause, { once: true });
  let acceptedWords: number | undefined;
  const requests: Promise<SentRequest>[] = [];
  for (const kind of kinds) {
    if (!options.takeRequestPermit()) {
      break;
    }
    requests.push(sendRequest(options, kind, roundDraft, round.signal, sentAt).then((sent) => {
      if (isCompletionToAccept(sent, round.signal) && model.isCompletionAccepted()) {
        acceptedWords = countWords(sent.completion ?? '');
        endPause();
      }
      return sent;
    }));
  }
  await clock.sleep(Math.max(0, resumeAt - clock.now()), pauseEnd.signal).catch(() => undefined);
  stopSignal.removeEventListener('abort', endPause);
  const roundEndedAt = clock.now();
  const endReason: EndReason = stopSignal.aborted ? 'stop' : 'resume';
  round.abort(endReason);
  for (const sent of await Promise.all(requests)) {
    options.onEvent({ type: 'request', request: toRequestEnd(options, sent, roundEndedAt) });
  }
  if (stopSignal.aborted) {
    throw stopSignal.reason;
  }
  return acceptedWords;
}

function isCompletionToAccept(sent: SentRequest, roundSignal: AbortSignal): boolean {
  return sent.outcome === 'answered' && !!sent.completion?.trim() && !roundSignal.aborted;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function sendRequest(
  options: AgentOptions,
  kind: LLMRequestKind,
  roundDraft: RoundDraft,
  roundSignal: AbortSignal,
  sentAt: number,
): Promise<SentRequest> {
  const { clock, settings, llmClient } = options;
  const userMessage = buildUserMessage(kind, roundDraft);
  const timeout = new AbortController();
  const timerEnd = new AbortController();
  clock.sleep(settings.timeoutMs, timerEnd.signal).then(() => timeout.abort('timeout'), () => undefined);
  const result = await llmClient.ask(userMessage, AbortSignal.any([roundSignal, timeout.signal]), kind)
    .catch((error: unknown): LLMResult<string> => ({ error: String(error) }));
  timerEnd.abort();
  const sent: SentRequest = {
    kind,
    sentAt,
    outcome: 'answered',
    latencyMs: clock.now() - sentAt,
    userMessage,
  };
  if (timeout.signal.aborted) {
    return { ...sent, outcome: 'timeout' };
  }
  if (roundSignal.aborted) {
    return { ...sent, outcome: roundSignal.reason === 'stop' ? 'cut' : 'aborted' };
  }
  if ('error' in result) {
    return { ...sent, outcome: 'failed', reason: result.error };
  }
  return { ...sent, ...readAnswer(kind, result.answer) };
}

function readAnswer(kind: LLMRequestKind, rawAnswer: string): Partial<SentRequest> {
  if (kind === 'spell-check') {
    const mistakes = parseMistakes(rawAnswer);
    return mistakes === null
      ? { outcome: 'unreadable', rawAnswer }
      : { outcome: 'answered', rawAnswer, mistakeCount: mistakes.length };
  }
  const completion = parseAutoCompletion(rawAnswer);
  return completion === null
    ? { outcome: 'unreadable', rawAnswer }
    : { outcome: 'answered', rawAnswer, completion };
}

function buildUserMessage(kind: LLMRequestKind, { draft, caret, requestContext }: RoundDraft): string {
  if (kind === 'spell-check') {
    return buildSpellCheckMessage({
      draft,
      caretOffset: caret,
      llmContext: requestContext.llmContext,
      customDictionary: requestContext.customDictionary,
    });
  }
  return buildAutoCompletionMessage({
    draft,
    caretOffset: caret,
    isCaretOnNewLine: false,
    llmContext: requestContext.llmContext,
  });
}

function toRequestEnd(options: AgentOptions, sent: SentRequest, roundEndedAt: number): RequestEnd {
  const request: RequestEnd = {
    agentNumber: options.agentNumber,
    kind: sent.kind,
    language: options.model.language,
    sentAt: sent.sentAt,
    outcome: sent.outcome,
    latencyMs: sent.latencyMs,
    allowedMs: roundEndedAt - sent.sentAt,
    userMessageChars: sent.userMessage.length,
    answerChars: sent.rawAnswer?.length ?? 0,
    userMessage: sent.userMessage,
  };
  if (sent.rawAnswer !== undefined) {
    request.rawAnswer = sent.rawAnswer;
  }
  if (sent.reason !== undefined) {
    request.reason = sent.reason;
  }
  if (sent.outcome === 'answered' && sent.kind === 'spell-check') {
    request.mistakeCount = sent.mistakeCount;
  }
  if (sent.outcome === 'answered' && sent.kind === 'auto-completion') {
    request.isCompletionEmpty = !sent.completion?.trim();
  }
  return request;
}
