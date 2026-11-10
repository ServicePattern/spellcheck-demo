import { expect, test } from '@playwright/test';
import type { Conversation, Language } from './chats.ts';
import { parseSettings, type TypingSettings } from './settings.ts';
import { createTypingModel, type TypingModel } from './typing-model.ts';

const DEFAULTS = parseSettings(['--agents', '1']).typing;
const MESSAGE = 'Thank you. I can see the registration from March, but the contributions have not been paid yet.';

function sample(model: TypingModel): unknown[] {
  return [
    model.language,
    model.wordsPerMinute,
    model.typedWords(MESSAGE),
    model.wordsInNextBurst(),
    model.pauseMs(),
    model.betweenMessagesMs(),
    model.isSpellCheckOnlyRound(),
    model.spellCheckOnlyCaret(MESSAGE),
    model.isCompletionAccepted(),
  ];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function draws(count: number, draw: () => number): number[] {
  return Array.from({ length: count }, draw);
}

test('draws repeat for a seed and differ across seeds', () => {
  const samples = (seed: number) => Array.from({ length: 5 }, () => sample(createTypingModel(DEFAULTS, seed, 1)));
  expect(samples(7)).toEqual(samples(7));
  expect(sample(createTypingModel(DEFAULTS, 7, 1))).not.toEqual(sample(createTypingModel(DEFAULTS, 8, 1)));
});

test('agents 1 and 2 draw the same whether 2 or 5 agents exist', () => {
  const run = (agentCount: number) => {
    const models = Array.from({ length: agentCount }, (_, index) => createTypingModel(DEFAULTS, 7, index + 1));
    const samples = models.map((model) => Array.from({ length: 10 }, () => sample(model)));
    return samples.slice(0, 2);
  };
  expect(run(5)).toEqual(run(2));
});

test('speeds stay within 25% of the set speed and center on it', () => {
  const speeds = Array.from({ length: 2000 }, (_, index) => createTypingModel(DEFAULTS, 3, index + 1).wordsPerMinute);
  expect(Math.min(...speeds)).toBeGreaterThanOrEqual(30);
  expect(Math.max(...speeds)).toBeLessThanOrEqual(50);
  expect(median(speeds)).toBeGreaterThan(38);
  expect(median(speeds)).toBeLessThan(42);
});

test('medians of words per burst, pause and time between messages land near the settings', () => {
  const model = createTypingModel(DEFAULTS, 5, 1);
  expect(median(draws(5000, model.wordsInNextBurst))).toBe(3);
  expect(Math.min(...draws(5000, model.wordsInNextBurst))).toBe(1);
  expect(median(draws(5000, model.pauseMs))).toBeGreaterThan(1700);
  expect(median(draws(5000, model.pauseMs))).toBeLessThan(1900);
  expect(median(draws(5000, model.betweenMessagesMs))).toBeGreaterThan(19000);
  expect(median(draws(5000, model.betweenMessagesMs))).toBeLessThan(21000);
});

test('a burst takes its characters at the agent speed', () => {
  const model = createTypingModel(DEFAULTS, 1, 1);
  expect(model.burstMs(12)).toBeCloseTo(12 / (model.wordsPerMinute * 5) * 60000);
  const settings: TypingSettings = { ...DEFAULTS, wordsPerMinute: 60 };
  const fast = createTypingModel(settings, 1, 1);
  expect(fast.burstMs(10)).toBeCloseTo(10 / (fast.wordsPerMinute * 5) * 60000);
});

test('shares of languages, spell check only rounds and accepted completions land near the settings', () => {
  const settings: TypingSettings = { ...DEFAULTS, arabicShare: 0.3 };
  const languages = Array.from({ length: 4000 }, (_, index) => createTypingModel(settings, 2, index + 1).language);
  const arabicShare = languages.filter((language) => language === 'Arabic').length / languages.length;
  expect(arabicShare).toBeGreaterThan(0.27);
  expect(arabicShare).toBeLessThan(0.33);
  const model = createTypingModel(DEFAULTS, 2, 1);
  const spellCheckOnlyShare = draws(5000, () => Number(model.isSpellCheckOnlyRound())).filter(Boolean).length / 5000;
  expect(spellCheckOnlyShare).toBeGreaterThan(0.08);
  expect(spellCheckOnlyShare).toBeLessThan(0.12);
  const acceptShare = draws(5000, () => Number(model.isCompletionAccepted())).filter(Boolean).length / 5000;
  expect(acceptShare).toBeGreaterThan(0.24);
  expect(acceptShare).toBeLessThan(0.28);
});

test('a spell check only caret is at the end of a word before the last one', () => {
  const model = createTypingModel(DEFAULTS, 4, 1);
  const draft = 'وعليكم السلام، دعني أتحقق';
  const carets = new Set(draws(500, () => model.spellCheckOnlyCaret(draft)));
  expect([...carets].sort((a, b) => a - b)).toEqual([6, 14, 19]);
  expect(model.spellCheckOnlyCaret('Hello')).toBe(0);
});

test('an agent takes only conversations of its language, each once before any repeats', () => {
  const conversation = (language: Language, name: string): Conversation => {
    return {
      language,
      sourceFile: name,
      turns: [],
    };
  };
  const conversations = [
    conversation('English', 'en1'),
    conversation('Arabic', 'ar1'),
    conversation('English', 'en2'),
    conversation('Arabic', 'ar2'),
    conversation('Arabic', 'ar3'),
  ];
  const model = createTypingModel({ ...DEFAULTS, arabicShare: 1 }, 6, 1);
  const taken = Array.from({ length: 6 }, () => model.nextConversation(conversations).sourceFile);
  expect(taken.slice(0, 3).sort()).toEqual(['ar1', 'ar2', 'ar3']);
  expect(taken.slice(3).sort()).toEqual(['ar1', 'ar2', 'ar3']);
});
