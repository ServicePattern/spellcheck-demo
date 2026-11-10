import { expect, test } from '@playwright/test';
import { parseSettings } from './settings.ts';

test('every flag has its default', () => {
  const settings = parseSettings(['--target', 'fake', '--agents', '2', '--stage', '60']);
  expect(settings.typing).toEqual({
    debounceMs: 1000,
    timeoutMs: 20000,
    wordsPerMinute: 40,
    burstWords: 3,
    pauseMs: 1800,
    acceptShare: 0.26,
    spellCheckOnlyShare: 0.1,
    typoEvery: 15,
    betweenMessagesMs: 20000,
    arabicShare: 0.5,
  });
  expect(settings.run).toEqual({
    agentLevels: [2],
    target: 'fake',
    stageSeconds: 60,
    warmupSeconds: 30,
    seed: 1,
    chatsFolder: '../SpellCheckingPrototype/eval/completion/sources',
    maxRequests: undefined,
    outFolder: 'tools/load/runs',
    withTrace: false,
    model: undefined,
    url: undefined,
    fakeLatencyMs: 600,
  });
  expect(settings.setFlags).toEqual(['target', 'agents', 'stage']);
});

test('the target is llm unless set', () => {
  expect(parseSettings(['--agents', '1']).run.target).toBe('llm');
});

test('flags are read into their settings', () => {
  const settings = parseSettings([
    '--agents', '2,5,10',
    '--wpm', '55',
    '--accept-share', '0',
    '--warmup', '0',
    '--seed', '7',
    '--max-requests', '50',
    '--trace',
    '--model', 'gemini-3.5-flash-lite',
  ]);
  expect(settings.run.agentLevels).toEqual([2, 5, 10]);
  expect(settings.typing.wordsPerMinute).toBe(55);
  expect(settings.typing.acceptShare).toBe(0);
  expect(settings.run.warmupSeconds).toBe(0);
  expect(settings.run.seed).toBe(7);
  expect(settings.run.maxRequests).toBe(50);
  expect(settings.run.withTrace).toBe(true);
  expect(settings.run.model).toBe('gemini-3.5-flash-lite');
  expect(settings.setFlags).toContain('wpm');
});

test('without --agents the usage is shown', () => {
  expect(() => parseSettings(['--target', 'fake'])).toThrow(/--agents is required[\s\S]*Usage: npm run load/);
});

test('agent levels must rise', () => {
  expect(() => parseSettings(['--agents', '10,5'])).toThrow('--agents levels must rise');
  expect(() => parseSettings(['--agents', '5,5'])).toThrow('--agents levels must rise');
});

const badValues: [string[], string][] = [
  [['--accept-share', '1.5'], '--accept-share must be a share from 0 to 1'],
  [['--arabic-share=-0.1'], '--arabic-share must be a share from 0 to 1'],
  [['--spell-check-only-share', 'some'], '--spell-check-only-share must be a share'],
  [['--wpm', '0'], '--wpm must be a positive number'],
  [['--pause-ms=-5'], '--pause-ms must be a positive number'],
  [['--pause-ms', '-5'], "Option '--pause-ms' argument is ambiguous"],
  [['--timeout-ms', 'abc'], '--timeout-ms must be a positive number'],
  [['--debounce-ms', ''], '--debounce-ms must be a positive number'],
  [['--stage', '0'], '--stage must be a positive number'],
  [['--max-requests', '2.5'], '--max-requests must be a positive whole number'],
  [['--agents', '2,x'], '--agents must be a positive whole number'],
  [['--agents', '0'], '--agents must be a positive whole number'],
  [['--fake-latency-ms', 'Infinity'], '--fake-latency-ms must be a positive number'],
  [['--seed', '1.5'], '--seed must be a whole number'],
  [['--warmup=-1'], '--warmup must be a number of seconds'],
  [['--warmup', '60', '--stage', '60'], '--warmup must be less than --stage'],
  [['--target', 'server'], '--target must be llm or fake'],
  [['--speed', '3'], "Unknown option '--speed'"],
];

for (const [flags, message] of badValues) {
  test(`a bad value is named: ${flags.join(' ')}`, () => {
    const args = flags.includes('--agents') ? flags : ['--agents', '2', ...flags];
    expect(() => parseSettings(args)).toThrow(message);
  });
}
