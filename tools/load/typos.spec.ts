import { expect, test } from '@playwright/test';
import { createRandom } from './random.ts';
import { isTypoCandidate, withTypo, wordsWithTypos } from './typos.ts';

function isOneEditVariant(original: string, variant: string): boolean {
  const from = Array.from(original);
  const to = Array.from(variant);
  if (to.length === from.length - 1) {
    return from.some((_, index) => [...from.slice(0, index), ...from.slice(index + 1)].join('') === variant);
  }
  if (to.length === from.length + 1) {
    return from.some((character, index) => {
      return [...from.slice(0, index), character, ...from.slice(index)].join('') === variant;
    });
  }
  const differences = from.flatMap((character, index) => character === to[index] ? [] : [index]);
  const [first, second] = differences;
  return differences.length === 2 && second === first + 1
    && from[first] === to[second] && from[second] === to[first];
}

function variantsOf(word: string, count: number): string[] {
  return Array.from({ length: count }, (_, seed) => withTypo(word, createRandom(seed)));
}

test('an English word gets one swap, drop or double, never itself', () => {
  for (const variant of variantsOf('registration', 200)) {
    expect(variant).not.toBe('registration');
    expect(isOneEditVariant('registration', variant)).toBe(true);
  }
});

test('an Arabic word gets one swap, drop or double of its letters', () => {
  for (const variant of variantsOf('المستندات', 200)) {
    expect(variant).not.toBe('المستندات');
    expect(isOneEditVariant('المستندات', variant)).toBe(true);
  }
});

test('all three kinds of edit happen', () => {
  const lengths = new Set(variantsOf('registration', 200).map((variant) => variant.length));
  expect([...lengths].sort()).toEqual([11, 12, 13]);
});

test('punctuation around a word is kept', () => {
  for (const variant of variantsOf('registration,', 100)) {
    expect(variant.endsWith(',')).toBe(true);
  }
  for (const variant of variantsOf('طلبك،', 100)) {
    expect(variant.endsWith('،')).toBe(true);
  }
});

test('reference numbers, words with digits and short words are never changed', () => {
  expect(isTypoCandidate('SI-48213')).toBe(false);
  expect(isTypoCandidate('2026-10-08')).toBe(false);
  expect(isTypoCandidate('١٠أيام')).toBe(false);
  expect(isTypoCandidate('can')).toBe(false);
  expect(isTypoCandidate('رقم')).toBe(false);
  expect(isTypoCandidate('from')).toBe(true);
  const message = 'Your SI-48213 is ok, see 2026-10-08';
  for (let seed = 0; seed < 100; seed++) {
    const words = wordsWithTypos(message, 1, createRandom(seed));
    expect(words.slice(1)).toEqual(['SI-48213', 'is', 'ok,', 'see', '2026-10-08']);
  }
});

test('the same seed gives the same variant', () => {
  expect(withTypo('registration', createRandom(9))).toBe(withTypo('registration', createRandom(9)));
  const message = 'أرى أن طلبك رقم SI-48213 تم استلامه وهو قيد المراجعة لدى إدارة المعاشات';
  expect(wordsWithTypos(message, 3, createRandom(4))).toEqual(wordsWithTypos(message, 3, createRandom(4)));
});

test('an Arabic message keeps the words around a typo unchanged', () => {
  const message = 'لا، جميع المستندات المطلوبة مرفقة بالفعل.';
  const words = message.split(' ');
  for (let seed = 0; seed < 50; seed++) {
    const typed = wordsWithTypos(message, 2, createRandom(seed));
    const changed = typed.flatMap((word, index) => word === words[index] ? [] : [index]);
    for (const index of changed) {
      expect(isOneEditVariant(words[index], typed[index])).toBe(true);
    }
  }
});

test('typos come at about one per set number of words', () => {
  const message = 'Thank you. I can see the registration from March, but the contributions for the last two months have not been paid yet.';
  const random = createRandom(1);
  let words = 0;
  let typos = 0;
  for (let index = 0; index < 2000; index++) {
    const typed = wordsWithTypos(message, 15, random);
    words += typed.length;
    typos += typed.filter((word, wordIndex) => word !== message.split(' ')[wordIndex]).length;
  }
  expect(words / typos).toBeGreaterThan(13.5);
  expect(words / typos).toBeLessThan(16.5);
});
