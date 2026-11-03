import type { TextDirection } from './types';

export interface WordPlace {
  word: string;
  start: number;
  end: number;
}

const LETTERS = /[\p{L}\p{M}]+/gu;
export const escapeForRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const NOT_AFTER_WORD_CHAR = '(?<![\\p{L}\\p{M}\\p{N}])';
export const NOT_BEFORE_WORD_CHAR = '(?![\\p{L}\\p{M}\\p{N}])';

export function findWordPlaces(text: string, words: Iterable<string>): WordPlace[] {
  const places: WordPlace[] = [];
  for (const word of words) {
    const wholeWord = new RegExp(`${NOT_AFTER_WORD_CHAR}${escapeForRegExp(word)}${NOT_BEFORE_WORD_CHAR}`, 'gu');
    for (const match of text.matchAll(wholeWord)) {
      places.push({
        word,
        start: match.index,
        end: match.index + word.length,
      });
    }
  }
  return places.sort((first, second) => first.start - second.start);
}

export function directionOfLastWord(text: string): TextDirection {
  const lastWord = text.match(LETTERS)?.at(-1) ?? '';
  return /\p{Script=Arabic}/u.test(lastWord) ? 'rtl' : 'ltr';
}
