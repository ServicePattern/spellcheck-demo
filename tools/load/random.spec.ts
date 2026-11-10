import { expect, test } from '@playwright/test';
import { createRandomStream } from './random.ts';

function draws(seed: number, agentNumber: number, count: number): number[] {
  const random = createRandomStream(seed, agentNumber, 'typing');
  return Array.from({ length: count }, () => random.next());
}

test('a stream repeats for the same seed, agent and purpose', () => {
  expect(draws(7, 1, 20)).toEqual(draws(7, 1, 20));
});

test('streams differ by seed, agent and purpose', () => {
  expect(draws(7, 1, 5)).not.toEqual(draws(8, 1, 5));
  expect(draws(7, 1, 5)).not.toEqual(draws(7, 2, 5));
  const typos = createRandomStream(7, 1, 'typos');
  expect(Array.from({ length: 5 }, () => typos.next())).not.toEqual(draws(7, 1, 5));
});

test('draws are between 0 and 1', () => {
  const values = draws(3, 4, 10000);
  expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...values)).toBeLessThan(1);
});

test('a log-normal draw has its median at the given value and a long tail', () => {
  const random = createRandomStream(1, 1, 'typing');
  const values = Array.from({ length: 20000 }, () => random.logNormal(1800, 0.6)).sort((a, b) => a - b);
  const median = values[values.length / 2];
  expect(median).toBeGreaterThan(1700);
  expect(median).toBeLessThan(1900);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  expect(mean).toBeGreaterThan(median);
  expect(values[0]).toBeGreaterThan(0);
});

test('a chance draw comes true at about its share', () => {
  const random = createRandomStream(2, 1, 'accepting');
  const hits = Array.from({ length: 20000 }, () => random.isChance(0.26)).filter(Boolean).length;
  expect(hits / 20000).toBeGreaterThan(0.24);
  expect(hits / 20000).toBeLessThan(0.28);
});

test('a shuffle keeps every item and repeats for the same stream', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const shuffled = createRandomStream(5, 1, 'scripts').shuffled(items);
  expect([...shuffled].sort()).toEqual(items);
  expect(createRandomStream(5, 1, 'scripts').shuffled(items)).toEqual(shuffled);
});
