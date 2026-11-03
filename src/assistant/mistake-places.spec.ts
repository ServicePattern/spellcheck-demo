import { expect, test } from '@playwright/test';
import type { Mistake } from './llm';
import { findMistakesInText } from './mistake-places';

test('findMistakesInText places a mistake by its context, also in Arabic', () => {
  const you: Mistake = {
    word: 'you',
    surroundingText: 'you details',
    fixes: ['your'],
    isSure: true,
  };
  const places = findMistakesInText('to you and you details', [you]);
  expect(places.map((place) => [place.word, place.start, place.end])).toEqual([['you', 11, 14]]);

  const thanks: Mistake = {
    word: 'شكرا',
    surroundingText: 'شكرا لتواصلك',
    fixes: ['شكراً'],
    isSure: true,
  };
  const arabic = findMistakesInText('شكرا لتواصلك معنا', [thanks]);
  expect(arabic.map((place) => place.start)).toEqual([0]);
});

test('findMistakesInText drops a mistake whose word is twice in its context', () => {
  const the: Mistake = {
    word: 'the',
    surroundingText: 'the the form',
    fixes: ['the'],
    isSure: true,
  };
  expect(findMistakesInText('the the form', [the])).toEqual([]);
});

test('findMistakesInText places a mistake by its word alone when the context is not in the text but the word is there once', () => {
  const following: Mistake = {
    word: 'слевдвших',
    surroundingText: 'в течение слевдвших 3',
    fixes: ['следующих'],
    isSure: true,
  };
  const places = findMistakesInText('в течении слевдвших 3 дней', [following]);
  expect(places.map((place) => [place.word, place.start])).toEqual([['слевдвших', 10]]);
  expect(findMistakesInText('слевдвших и слевдвших', [following])).toEqual([]);
});

test('findMistakesInText matches any spaces in the context: a line break, several spaces, a no-break space', () => {
  const following: Mistake = {
    word: 'слевдвших',
    surroundingText: 'в течение слевдвших 3',
    fixes: ['следующих'],
    isSure: true,
  };
  const text = 'в течение слевдвших 3 дней, и в течение\u00A0 слевдвших \n3 рабочих дней';
  expect(findMistakesInText(text, [following]).map((place) => place.start)).toEqual([10, 41]);
});

test('findMistakesInText does not place a mistake inside a longer word, even when the context matches', () => {
  const hav: Mistake = {
    word: 'hav',
    surroundingText: 'WE hav',
    fixes: ['have'],
    isSure: true,
  };
  expect(findMistakesInText('WE have checked', [hav])).toEqual([]);
  expect(findMistakesInText('WE hav checked', [hav]).map((place) => place.start)).toEqual([3]);
});
