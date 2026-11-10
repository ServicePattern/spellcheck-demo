export type RandomPurpose = 'scripts' | 'typing' | 'typos' | 'rounds' | 'accepting' | 'start' | 'fake';

export interface Random {
  next(): number;
  integerBelow(limit: number): number;
  isChance(share: number): boolean;
  logNormal(median: number, spread: number): number;
  shuffled<Item>(items: readonly Item[]): Item[];
}

export function createRandomStream(seed: number, agentNumber: number, purpose: RandomPurpose): Random {
  return createRandom(hashToSeed(`${seed}:${agentNumber}:${purpose}`));
}

export function createRandom(seed: number): Random {
  const next = mulberry32(seed);
  const random: Random = {
    next,
    integerBelow: (limit) => Math.floor(next() * limit),
    isChance: (share) => next() < share,
    logNormal: (median, spread) => median * Math.exp(spread * standardNormal(next)),
    shuffled: (items) => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index--) {
        const otherIndex = random.integerBelow(index + 1);
        [result[index], result[otherIndex]] = [result[otherIndex], result[index]];
      }
      return result;
    },
  };
  return random;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(next: () => number): number {
  const uniform = 1 - next();
  return Math.sqrt(-2 * Math.log(uniform)) * Math.cos(2 * Math.PI * next());
}

function hashToSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
