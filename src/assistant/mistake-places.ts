import type { Mistake } from './llm';
import { escapeForRegExp, findWordPlaces, NOT_AFTER_WORD_CHAR, NOT_BEFORE_WORD_CHAR, type WordPlace } from './words';

export interface PlacedMistake extends WordPlace {
  mistake: Mistake;
}

const withAnySpaces = (text: string) => escapeForRegExp(text).replace(/\s+/g, '\\s+');

export function findMistakesInText(text: string, mistakes: Mistake[]): PlacedMistake[] {
  const placesByStart = new Map<number, PlacedMistake>();
  for (const mistake of mistakes) {
    const wordsInSurroundingText = findWordPlaces(mistake.surroundingText, [mistake.word]);
    if (wordsInSurroundingText.length !== 1) {
      continue;
    }
    const wordInSurroundingText = wordsInSurroundingText[0];
    const before = withAnySpaces(mistake.surroundingText.slice(0, wordInSurroundingText.start));
    const after = withAnySpaces(mistake.surroundingText.slice(wordInSurroundingText.end));
    const surroundingTextPattern = new RegExp(`(${before})${NOT_AFTER_WORD_CHAR}${escapeForRegExp(mistake.word)}${NOT_BEFORE_WORD_CHAR}${after}`, 'gu');
    const starts = [...text.matchAll(surroundingTextPattern)].map((match) => match.index + match[1].length);
    const wordsInText = findWordPlaces(text, [mistake.word]);
    if (!starts.length && wordsInText.length === 1) {
      starts.push(wordsInText[0].start);
    }
    for (const start of starts) {
      placesByStart.set(start, {
        word: mistake.word,
        start,
        end: start + mistake.word.length,
        mistake,
      });
    }
  }
  return [...placesByStart.values()].sort((first, second) => first.start - second.start);
}
