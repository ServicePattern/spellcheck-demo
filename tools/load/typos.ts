import type { Random } from './random.ts';

const MIN_LETTERS = 4;

export function isTypoCandidate(word: string): boolean {
  if (/\p{Nd}/u.test(word)) {
    return false;
  }
  return Array.from(word).filter(isLetter).length >= MIN_LETTERS;
}

export function withTypo(word: string, random: Random): string {
  const characters = Array.from(word);
  const letterIndexes = characters.flatMap((character, index) => isLetter(character) ? [index] : []);
  const swappable = letterIndexes.filter((index) => {
    return isLetter(characters[index + 1] ?? '') && characters[index] !== characters[index + 1];
  });
  const edits = swappable.length ? ['swap', 'drop', 'double'] : ['drop', 'double'];
  const edit = edits[random.integerBelow(edits.length)];
  if (edit === 'swap') {
    const index = swappable[random.integerBelow(swappable.length)];
    [characters[index], characters[index + 1]] = [characters[index + 1], characters[index]];
  } else {
    const index = letterIndexes[random.integerBelow(letterIndexes.length)];
    characters.splice(index, 1, ...(edit === 'drop' ? [] : [characters[index], characters[index]]));
  }
  return characters.join('');
}

export function wordsWithTypos(message: string, typoEvery: number, random: Random): string[] {
  const words = message.split(/\s+/).filter(Boolean);
  const candidateCount = words.filter(isTypoCandidate).length;
  const typoChance = candidateCount ? Math.min(1, words.length / typoEvery / candidateCount) : 0;
  return words.map((word) => {
    return isTypoCandidate(word) && random.isChance(typoChance) ? withTypo(word, random) : word;
  });
}

function isLetter(character: string): boolean {
  return /\p{L}/u.test(character);
}
