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
    withVllmMetrics: false,
    metricsUrl: undefined,
    withProbe: false,
    pricePerHour: undefined,
    gpuSsh: undefined,
  });
  expect(settings.setFlags).toEqual(['target', 'agents', 'stage']);
});

test('the target is llm unless set, and server and fake can be set', () => {
  expect(parseSettings(['--agents', '1']).run.target).toBe('llm');
  expect(parseSettings(['--agents', '1', '--target', 'server']).run.target).toBe('server');
  expect(parseSettings(['--agents', '1', '--target', 'fake']).run.target).toBe('fake');
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

test('the vLLM flags are read for the llm and server targets', () => {
  const run = parseSettings([
    '--agents', '3',
    '--target', 'server',
    '--vllm-metrics',
    '--metrics-url', 'http://127.0.0.1:8000/metrics',
    '--probe',
    '--price', '1.43',
  ]).run;
  expect(run).toMatchObject({
    withVllmMetrics: true,
    metricsUrl: 'http://127.0.0.1:8000/metrics',
    withProbe: true,
    pricePerHour: 1.43,
  });
  expect(parseSettings(['--agents', '1', '--target', 'fake', '--price', '2']).run.pricePerHour).toBe(2);
});

test('the GPU address is read with any target', () => {
  const run = parseSettings(['--agents', '1', '--target', 'fake', '--gpu-ssh', 'root@73.97.224.215:16559']).run;
  expect(run.gpuSsh).toEqual({
    user: 'root',
    host: '73.97.224.215',
    port: 16559,
  });
});

const badValues: [string[], string][] = [
  [['--gpu-ssh', 'root@73.97.224.215'], '--gpu-ssh must be <user>@<host>:<port>'],
  [['--gpu-ssh', 'root@host:0'], '--gpu-ssh must be <user>@<host>:<port> with a port from 1 to 65535, got root@host:0'],
  [['--gpu-ssh', 'root@host:70000'], 'got root@host:70000'],
  [['--gpu-ssh', 'host:22'], '--gpu-ssh must be <user>@<host>:<port>'],
  [['--target', 'fake', '--vllm-metrics'], '--vllm-metrics needs the llm or server target, not fake'],
  [['--target', 'fake', '--probe', '--metrics-url', 'http://x/metrics'], '--metrics-url, --probe needs the llm or server target'],
  [['--metrics-url', 'not a url'], '--metrics-url is not a URL'],
  [['--price', '0'], '--price must be a positive number'],
  [['--price', 'abc'], '--price must be a positive number'],
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
  [['--target', 'vllm'], '--target must be llm, server or fake'],
  [['--speed', '3'], "Unknown option '--speed'"],
];

for (const [flags, message] of badValues) {
  test(`a bad value is named: ${flags.join(' ')}`, () => {
    const args = flags.includes('--agents') ? flags : ['--agents', '2', ...flags];
    expect(() => parseSettings(args)).toThrow(message);
  });
}
