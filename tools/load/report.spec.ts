import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Outcome } from './agent.ts';
import type { RequestRecord } from './recorder.ts';
import {
  computeReport,
  isContextLengthRejection,
  renderJson,
  renderMarkdown,
  type ActivityEvent,
  type GroupFigures,
  type Report,
  type RunFacts,
  type UpstreamGroupFigures,
} from './report.ts';
import { parseSettings } from './settings.ts';
import type { ProbeRecord } from './probe.ts';
import type { UpstreamCall } from './targets.ts';
import type { MetricSample } from './vllm-metrics.ts';

const STAGE_FLAGS = ['--target', 'fake', '--agents', '5', '--stage', '120', '--warmup', '20'];

function factsFor(flags: string[], stages: RunFacts['stages']): RunFacts {
  const settings = parseSettings(flags);
  return {
    startedAt: '2026-11-10T12:00:00.000Z',
    durationSeconds: stages.at(-1) ? stages.at(-1)!.endMs / 1000 : 0,
    endReason: 'completed',
    settings,
    target: settings.run.target,
    model: null,
    endpointHost: null,
    sources: {
      folder: '../SpellCheckingPrototype/eval/completion/sources',
      files: ['support-ar.txt', 'support-en.txt'],
      English: { conversations: 43, agentTurns: 137 },
      Arabic: { conversations: 55, agentTurns: 173 },
    },
    commit: 'c4a2482',
    hasUncommittedChanges: false,
    stages,
    server: null,
    vllm: null,
  };
}

const ONE_STAGE = factsFor(STAGE_FLAGS, [{
  stage: 1,
  agents: 5,
  startMs: 0,
  endMs: 120000,
}]);

let nextSentAt = 20000;

function record(outcome: Outcome, overrides: Partial<RequestRecord> = {}): RequestRecord {
  nextSentAt += 100;
  return {
    stage: 1,
    agent: 1,
    kind: 'spell-check',
    language: 'English',
    sentAtMs: nextSentAt,
    outcome,
    latencyMs: 500,
    allowedMs: 1600,
    userMessageChars: 3000,
    answerChars: outcome === 'answered' ? 20 : 0,
    isWarmup: false,
    ...overrides,
  };
}

function many(count: number, outcome: Outcome, overrides: Partial<RequestRecord> = {}): RequestRecord[] {
  return Array.from({ length: count }, () => record(outcome, overrides));
}

function allOf(records: RequestRecord[], events: ActivityEvent[] = [], facts = ONE_STAGE): GroupFigures {
  return computeReport(records, events, facts).stages[0].all;
}

const OUTCOME_MIX = [
  ...many(150, 'answered'),
  ...many(40, 'aborted'),
  ...many(6, 'timeout'),
  ...many(2, 'failed'),
  ...many(2, 'unreadable'),
];

test('shares of outcomes are of counted requests', () => {
  const figures = allOf(OUTCOME_MIX);
  expect(figures).toMatchObject({
    requests: 200,
    usefulAnswerRate: 0.75,
    abortedShare: 0.2,
    timeoutShare: 0.03,
    failedShare: 0.01,
    unreadableShare: 0.01,
  });
  const markdown = renderMarkdown(computeReport(OUTCOME_MIX, [], ONE_STAGE));
  expect(markdown).toContain('| 1 | 5 | 200 |');
  expect(markdown).toContain('| 75.0% | 20.0% | 3.0% | 1.0% | 1.0% | 0.0% |');
});

test('requests sent in warm-up and requests cut are in no figure', () => {
  const warmup = many(30, 'aborted', {
    isWarmup: true,
    sentAtMs: 12000,
    latencyMs: 100,
  });
  const cut = many(4, 'cut');
  expect(allOf([...OUTCOME_MIX, ...warmup, ...cut])).toMatchObject({
    requests: 200,
    usefulAnswerRate: 0.75,
    abortedShare: 0.2,
  });
});

test('latency percentiles are nearest rank over answered and unreadable requests', () => {
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  const records = [
    ...latencies.map((latencyMs, index) => record(index % 3 ? 'answered' : 'unreadable', { latencyMs })),
    record('aborted', { latencyMs: 5000 }),
    record('timeout', { latencyMs: 20000 }),
  ];
  expect(allOf(records)).toMatchObject({
    latencyP50Ms: 500,
    latencyP95Ms: 1000,
    latencyP99Ms: 1000,
  });
});

test('figures are also given per request kind and per language', () => {
  const records = [
    ...many(3, 'answered', { kind: 'spell-check', language: 'English' }),
    ...many(1, 'aborted', { kind: 'auto-completion', language: 'English' }),
    ...many(2, 'answered', { kind: 'auto-completion', language: 'Arabic' }),
    ...many(2, 'timeout', { kind: 'spell-check', language: 'Arabic' }),
  ];
  const [stage] = computeReport(records, [], ONE_STAGE).stages;
  expect(stage.all.requests).toBe(8);
  expect(stage.byKind['spell-check']).toMatchObject({ requests: 5, usefulAnswerRate: 0.6 });
  expect(stage.byKind['auto-completion']).toMatchObject({ requests: 3, abortedShare: 0.3333 });
  expect(stage.byLanguage.English).toMatchObject({ requests: 4, usefulAnswerRate: 0.75 });
  expect(stage.byLanguage.Arabic).toMatchObject({ requests: 4, timeoutShare: 0.5 });
  const markdown = renderMarkdown(computeReport(records, [], ONE_STAGE));
  for (const heading of ['all requests', 'spell check', 'auto-completion', 'English', 'Arabic']) {
    expect(markdown).toContain(`## Stages: ${heading}`);
  }
});

test('with nothing answered the latencies are absent, not zero', () => {
  const figures = allOf(many(5, 'aborted'));
  expect(figures.latencyP50Ms).toBeNull();
  expect(figures.latencyP99Ms).toBeNull();
  expect(figures.emptyCompletionShare).toBeNull();
  const empty = allOf([]);
  expect(empty.requests).toBe(0);
  expect(empty.usefulAnswerRate).toBeNull();
  expect(renderMarkdown(computeReport([], [], ONE_STAGE))).toContain('| 1 | 5 | 0 | 0 | — | — |');
});

test('rounds per second count the rounds started after warm-up over the stage time less the warm-up', () => {
  const records = Array.from({ length: 50 }, (_, index) => {
    const sentAtMs = 20000 + index * 2000;
    return [
      record('answered', { sentAtMs }),
      record('answered', { sentAtMs, kind: 'auto-completion' }),
    ];
  }).flat();
  const warmup = record('answered', { sentAtMs: 1000, isWarmup: true });
  expect(allOf([...records, warmup]).roundsPerSecond).toBe(0.5);
});

test('empty completions are a share of answered auto-completions', () => {
  const records = [
    ...many(3, 'answered', { kind: 'auto-completion', isCompletionEmpty: true }),
    ...many(1, 'answered', { kind: 'auto-completion', isCompletionEmpty: false }),
    ...many(4, 'aborted', { kind: 'auto-completion' }),
    ...many(4, 'answered', { kind: 'spell-check', mistakeCount: 1 }),
  ];
  expect(allOf(records).emptyCompletionShare).toBe(0.75);
});

test('requests in flight are averaged over the stage time less the warm-up, with the highest count', () => {
  const records = [
    record('answered', { sentAtMs: 30000, latencyMs: 50000 }),
    record('aborted', { sentAtMs: 40000, latencyMs: 20000 }),
    record('cut', { sentAtMs: 110000, latencyMs: 10000 }),
    record('aborted', { sentAtMs: 15000, latencyMs: 15000, isWarmup: true }),
  ];
  expect(allOf(records)).toMatchObject({ inFlightMean: 0.9, inFlightMax: 2 });
});

test('the typing produced gives the gaps between rounds, the allowed time and the time on a message', () => {
  const events: ActivityEvent[] = [
    { type: 'message-start', agentNumber: 1, at: 0 },
    { type: 'round', agentNumber: 1, at: 15000 },
    { type: 'round', agentNumber: 1, at: 22000 },
    { type: 'round', agentNumber: 1, at: 26000 },
    { type: 'round', agentNumber: 1, at: 36000 },
    {
      type: 'message',
      agentNumber: 1,
      startedAt: 0,
      sentAt: 50000,
    },
    { type: 'message-start', agentNumber: 1, at: 70000 },
    { type: 'message-start', agentNumber: 2, at: 60000 },
    { type: 'round', agentNumber: 2, at: 61000 },
    { type: 'round', agentNumber: 2, at: 66000 },
  ];
  const records = [1000, 1600, 2600, 5000].map((allowedMs) => record('answered', { allowedMs }));
  const { typing } = computeReport(records, events, ONE_STAGE).stages[0];
  expect(typing).toMatchObject({
    roundGapP25Ms: 4000,
    roundGapP50Ms: 5000,
    roundGapP75Ms: 7000,
    allowedP25Ms: 1000,
    allowedP50Ms: 1600,
    allowedP75Ms: 2600,
  });
  expect(typing.messageTimeShare).toBe(round4((30000 + 50000 + 60000) / (100000 + 60000)));
});

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

test('assumed inputs list the set ones apart from the defaults, in their own section', () => {
  const facts = factsFor([...STAGE_FLAGS, '--wpm', '55'], ONE_STAGE.stages);
  const report = computeReport([], [], facts);
  expect(report.assumedInputs.find((input) => input.flag === 'wpm')).toEqual({
    flag: 'wpm',
    value: 55,
    isDefault: false,
  });
  expect(report.assumedInputs.filter((input) => input.isDefault)).toHaveLength(9);
  const markdown = renderMarkdown(report);
  const assumed = markdown.slice(markdown.indexOf('## Assumed inputs'), markdown.indexOf('## Run facts'));
  expect(assumed).toContain('| --wpm | 55 | set |');
  expect(assumed).toContain('| --pause-ms | 1800 | default |');
  expect(markdown.indexOf('## Assumed inputs')).toBeGreaterThan(markdown.indexOf('## Typing produced'));
});

test('a fake run says at its top that the latencies are the fake\'s, an llm run names its model and host', () => {
  const fake = renderMarkdown(computeReport([], [], ONE_STAGE));
  expect(fake.split('\n').slice(0, 4).join('\n')).toContain('the answers and latencies came from the built-in fake');
  const llmFacts = factsFor(['--agents', '3'], ONE_STAGE.stages);
  const llm = renderMarkdown(computeReport([], [], {
    ...llmFacts,
    model: 'gemini-3.5-flash-lite',
    endpointHost: 'generativelanguage.googleapis.com',
  }));
  expect(llm).not.toContain('built-in fake');
  expect(llm).toContain('model `gemini-3.5-flash-lite` at generativelanguage.googleapis.com');
});

test('the report names the run facts and how the run ended', () => {
  const markdown = renderMarkdown(computeReport([], [], { ...ONE_STAGE, endReason: 'request cap' }));
  expect(markdown).toContain('stopped by the request cap');
  expect(markdown).toContain('Seed: 1');
  expect(markdown).toContain('Commit: c4a2482');
  expect(markdown).toContain('English: 43 conversations, 137 agent turns');
  expect(markdown).toContain('Arabic: 55 conversations, 173 agent turns');
});

function twoStageReport(): Report {
  const facts = factsFor(['--target', 'fake', '--agents', '2,5', '--stage', '60'], [
    {
      stage: 1,
      agents: 2,
      startMs: 0,
      endMs: 60000,
    },
    {
      stage: 2,
      agents: 5,
      startMs: 60000,
      endMs: 120000,
    },
  ]);
  const records = [
    ...many(7, 'answered', { stage: 1, sentAtMs: 40000, latencyMs: 733 }),
    ...many(2, 'aborted', { stage: 1, sentAtMs: 45000, kind: 'auto-completion' }),
    ...many(9, 'answered', { stage: 2, sentAtMs: 100000, language: 'Arabic', latencyMs: 1234 }),
    ...many(3, 'timeout', { stage: 2, sentAtMs: 101000, latencyMs: 20000 }),
    ...many(1, 'unreadable', { stage: 2, sentAtMs: 102000, kind: 'auto-completion' }),
  ];
  return computeReport(records, [], facts);
}

function expectedRow(stage: number, agents: number, figures: GroupFigures): string {
  const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const plain = (value: number | null) => value === null ? '—' : String(value);
  return `| ${[
    stage,
    agents,
    figures.requests,
    plain(figures.roundsPerSecond),
    percent(figures.usefulAnswerRate),
    percent(figures.abortedShare),
    percent(figures.timeoutShare),
    percent(figures.failedShare),
    percent(figures.unreadableShare),
    percent(figures.contextLengthShare),
    plain(figures.latencyP50Ms),
    plain(figures.latencyP95Ms),
    plain(figures.latencyP99Ms),
    percent(figures.emptyCompletionShare),
    plain(figures.inFlightMean),
    plain(figures.inFlightMax),
  ].join(' | ')} |`;
}

test('every figure in report.md is in report.json with the same value, for every stage', () => {
  const report = twoStageReport();
  const markdown = renderMarkdown(report);
  const json = JSON.parse(renderJson(report)) as Report;
  expect(json.stages).toHaveLength(2);
  for (const stage of json.stages) {
    const groups = [
      stage.all,
      stage.byKind['spell-check'],
      stage.byKind['auto-completion'],
      stage.byLanguage.English,
      stage.byLanguage.Arabic,
    ];
    for (const figures of groups) {
      expect(markdown).toContain(expectedRow(stage.stage, stage.agents, figures));
    }
  }
  expect(json.facts.settings.run.seed).toBe(1);
  expect(json.facts.target).toBe('fake');
});

test('no stage is marked as passed or failed and no capacity is named', () => {
  const markdown = renderMarkdown(twoStageReport());
  expect(markdown).not.toMatch(/\bpass(ed)?\b|\bverdict\b|\bknee\b|\bcapacity\b|✓|✗|❌|✅/i);
  expect(markdown.match(/\bfail\w*/gi)?.every((word) => word === 'Failed')).toBe(true);
});

function serverFacts(): RunFacts {
  const facts = factsFor(['--target', 'server', '--agents', '3', '--stage', '180', '--warmup', '30'], [{
    stage: 1,
    agents: 3,
    startMs: 0,
    endMs: 180000,
  }]);
  return {
    ...facts,
    model: 'gemini-3.5-flash-lite',
    endpointHost: 'generativelanguage.googleapis.com',
    server: {
      port: 51234,
      ending: 'stopped by the loader',
      requestsWithoutUpstreamLine: 2,
      otherLines: ['http://127.0.0.1:51234, serving /x/dist/'],
    },
  };
}

function upstreamCall(kind: UpstreamCall['kind'], startedAtMs: number, durationMs: number, error?: string): UpstreamCall {
  const call: UpstreamCall = {
    kind,
    startedAtMs,
    durationMs,
  };
  if (error !== undefined) {
    call.error = error;
  }
  return call;
}

test('unused upstream calls are the calls less the requests the client received', () => {
  nextSentAt = 40000;
  const records = [
    ...many(20, 'answered', { kind: 'spell-check' }),
    ...many(12, 'answered', { kind: 'auto-completion' }),
    ...many(10, 'aborted', { kind: 'spell-check' }),
    ...many(18, 'aborted', { kind: 'auto-completion' }),
  ];
  const calls = [
    ...Array.from({ length: 30 }, (_, index) => upstreamCall('spell-check', 40000 + index * 1000, 700)),
    ...Array.from({ length: 30 }, (_, index) => upstreamCall('auto-completion', 40000 + index * 1000, 800)),
  ];
  const [stage] = computeReport(records, [], serverFacts(), { upstreamCalls: calls }).stages;
  expect(stage.all.requests).toBe(60);
  expect(stage.upstream?.all).toMatchObject({
    calls: 60,
    unusedShare: 0.4667,
    answeredShare: 1,
    errorShare: 0,
    latencyP50Ms: 700,
    upstreamSeconds: 45,
  });
  expect(stage.upstream?.byKind['spell-check']).toMatchObject({ calls: 30, unusedShare: 0.3333 });
  expect(stage.upstream?.byKind['auto-completion']).toMatchObject({ calls: 30, unusedShare: 0.6 });
  expect(renderMarkdown(computeReport(records, [], serverFacts(), { upstreamCalls: calls }))).toContain('| 46.7% | 45 |');
});

test('upstream calls started in warm-up are left out, errors are counted, and a 502 counts as received', () => {
  nextSentAt = 40000;
  const records = [
    record('failed', { reason: 'HTTP 502: HTTP 429: rate limited' }),
    record('failed', { reason: 'TypeError: fetch failed' }),
    record('answered'),
  ];
  const calls = [
    upstreamCall('spell-check', 10000, 500),
    upstreamCall('spell-check', 40100, 300, 'HTTP 429: rate limited'),
    upstreamCall('spell-check', 40200, 900),
    upstreamCall('spell-check', 40300, 1200),
  ];
  const upstream = computeReport(records, [], serverFacts(), { upstreamCalls: calls }).stages[0].upstream;
  expect(upstream?.all).toMatchObject({
    calls: 3,
    errorShare: 0.3333,
    unusedShare: 0.3333,
    latencyP50Ms: 900,
    latencyP99Ms: 1200,
  });
});

test('with no upstream calls the upstream figures are absent, and never below zero unused', () => {
  const [stage] = computeReport(many(4, 'answered'), [], serverFacts(), { upstreamCalls: [] }).stages;
  expect(stage.upstream?.all).toEqual({
    calls: 0,
    answeredShare: null,
    errorShare: null,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencyP99Ms: null,
    unusedShare: null,
    upstreamSeconds: 0,
  });
  const oneCall = [upstreamCall('spell-check', 40000, 100)];
  const fewerCalls = computeReport(many(4, 'answered'), [], serverFacts(), { upstreamCalls: oneCall });
  expect(fewerCalls.stages[0].upstream?.all.unusedShare).toBe(0);
});

test('a run with another target has no upstream section', () => {
  const report = computeReport(OUTCOME_MIX, [], ONE_STAGE, { upstreamCalls: [upstreamCall('spell-check', 40000, 100)] });
  expect(report.stages[0].upstream).toBeNull();
  expect(renderMarkdown(report)).not.toContain('Upstream');
});

test('every upstream figure in report.md matches report.json, and the server facts are stated', () => {
  nextSentAt = 40000;
  const records = [...many(7, 'answered'), ...many(3, 'aborted', { kind: 'auto-completion' })];
  const calls = [
    ...Array.from({ length: 7 }, (_, index) => upstreamCall('spell-check', 40000 + index * 500, 600 + index * 10)),
    ...Array.from({ length: 4 }, (_, index) => {
      return upstreamCall('auto-completion', 42000 + index * 500, 900, index ? undefined : 'empty answer');
    }),
  ];
  const report = computeReport(records, [], serverFacts(), { upstreamCalls: calls });
  const markdown = renderMarkdown(report);
  const json = JSON.parse(renderJson(report)) as Report;
  const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const plain = (value: number | null) => value === null ? '—' : String(value);
  const stage = json.stages[0];
  const groups: [string, UpstreamGroupFigures | undefined][] = [
    ['all', stage.upstream?.all],
    ['spell check', stage.upstream?.byKind['spell-check']],
    ['auto-completion', stage.upstream?.byKind['auto-completion']],
  ];
  for (const [name, figures] of groups) {
    expect(figures).toBeDefined();
    const row = [
      1,
      name,
      figures?.calls,
      percent(figures?.answeredShare ?? null),
      percent(figures?.errorShare ?? null),
      plain(figures?.latencyP50Ms ?? null),
      plain(figures?.latencyP95Ms ?? null),
      plain(figures?.latencyP99Ms ?? null),
      percent(figures?.unusedShare ?? null),
      figures?.upstreamSeconds,
    ];
    expect(markdown).toContain(`| ${row.join(' | ')} |`);
  }
  const upstreamAt = markdown.indexOf('## Upstream calls made by the server');
  expect(upstreamAt).toBeGreaterThan(markdown.indexOf('## Stages: Arabic'));
  expect(markdown).toContain('Server: port 51234, stopped by the loader');
  expect(markdown).toContain('Requests with no upstream line in the server\'s log: 2');
  expect(json.facts.server?.otherLines).toEqual(['http://127.0.0.1:51234, serving /x/dist/']);
});

function instanceFacts(flags: string[]): RunFacts {
  const facts = factsFor(['--agents', '10,25,50', '--stage', '180', '--warmup', '30', ...flags], [
    {
      stage: 1,
      agents: 10,
      startMs: 0,
      endMs: 180000,
    },
    {
      stage: 2,
      agents: 25,
      startMs: 180000,
      endMs: 360000,
    },
    {
      stage: 3,
      agents: 50,
      startMs: 360000,
      endMs: 540000,
    },
  ]);
  return {
    ...facts,
    vllm: flags.includes('--vllm-metrics')
      ? {
        metricsUrl: 'http://127.0.0.1:8000/metrics',
        metricsNotFound: ['prefixCacheQueries'],
        namesUsed: {},
      }
      : null,
  };
}

function sample(atMs: number, values: MetricSample['values']): MetricSample {
  return { atMs, values };
}

test('the vLLM figures of a stage come from its samples after warm-up', () => {
  const samples = [
    sample(370000, { waiting: 50, generationTokens: 1 }),
    sample(391000, {
      waiting: 0,
      running: 20,
      cacheUsage: 0.2,
      generationTokens: 120000,
      promptTokens: 1000,
    }),
    sample(442000, {
      waiting: 4,
      running: 30,
      cacheUsage: 0.4,
    }),
    { atMs: 460000, error: 'timeout' },
    sample(490000, {
      waiting: 12,
      running: 40,
      cacheUsage: 0.9,
    }),
    sample(539000, {
      waiting: 8,
      running: 30,
      cacheUsage: 0.5,
      generationTokens: 150000,
      promptTokens: 1000,
    }),
  ];
  const facts = instanceFacts(['--vllm-metrics']);
  const stage = computeReport([], [], facts, { samples }).stages[2];
  expect(stage.vllm).toEqual({
    samplesRead: 4,
    samplesFailed: 1,
    runningMean: 30,
    runningMax: 40,
    waitingMean: 6,
    waitingMax: 12,
    cacheUsageMean: 0.5,
    cacheUsageMax: 0.9,
    promptTokensPerSecond: 0,
    generationTokensPerSecond: 202.7,
    prefixCacheHitRate: null,
  });
});

test('a counter that went down leaves its rate absent, and one sample is too few for a rate', () => {
  const facts = instanceFacts(['--vllm-metrics']);
  const reset = computeReport([], [], facts, {
    samples: [sample(40000, { generationTokens: 9000 }), sample(170000, { generationTokens: 200 })],
  }).stages[0];
  expect(reset.vllm?.generationTokensPerSecond).toBeNull();
  const single = computeReport([], [], facts, { samples: [sample(40000, { generationTokens: 9000 })] }).stages[0];
  expect(single.vllm?.generationTokensPerSecond).toBeNull();
  expect(single.vllm?.waitingMean).toBeNull();
});

test('the prefix cache hit rate is the increase of hits over the increase of queries', () => {
  const facts = instanceFacts(['--vllm-metrics']);
  const stage = computeReport([], [], facts, {
    samples: [
      sample(40000, { prefixCacheQueries: 10000, prefixCacheHits: 6000 }),
      sample(170000, { prefixCacheQueries: 30000, prefixCacheHits: 22000 }),
    ],
  }).stages[0];
  expect(stage.vllm?.prefixCacheHitRate).toBe(0.8);
});

function probe(sentAtMs: number, roundTripMs: number, outcome: ProbeRecord['outcome'] = 'answered'): ProbeRecord {
  return {
    sentAtMs,
    roundTripMs,
    outcome,
  };
}

test('the probe round trip of a stage is over its probes after warm-up', () => {
  const probes = [
    probe(10000, 5000),
    ...[180, 190, 200, 210, 950].map((roundTripMs, index) => probe(40000 + index * 10000, roundTripMs)),
    probe(100000, 10000, 'failed'),
  ];
  const stage = computeReport([], [], instanceFacts(['--probe']), { probes }).stages[0];
  expect(stage.probe).toEqual({
    probes: 6,
    failed: 1,
    roundTripP50Ms: 200,
    roundTripP95Ms: 950,
    roundTripMaxMs: 950,
  });
  const allFailed = computeReport([], [], instanceFacts(['--probe']), { probes: [probe(40000, 10000, 'failed')] });
  expect(allFailed.stages[0].probe).toEqual({
    probes: 1,
    failed: 1,
    roundTripP50Ms: null,
    roundTripP95Ms: null,
    roundTripMaxMs: null,
  });
});

test('context-length rejections are counted apart and stay failed', () => {
  const contextError = 'HTTP 400: This model\'s maximum context length is 8192 tokens. However, you requested 9120 tokens';
  const records = [
    ...many(194, 'answered'),
    ...many(2, 'failed', { reason: contextError }),
    ...many(1, 'failed', { reason: 'HTTP 502: ' + contextError }),
    ...many(3, 'failed', { reason: 'HTTP 429: rate limited' }),
  ];
  expect(allOf(records)).toMatchObject({
    requests: 200,
    failedShare: 0.03,
    contextLengthShare: 0.015,
  });
  const twoOfSix = [...many(194, 'answered'), ...many(2, 'failed', { reason: contextError }), ...many(4, 'failed')];
  expect(allOf(twoOfSix)).toMatchObject({ failedShare: 0.03, contextLengthShare: 0.01 });
});

test('with a price each stage shows its cost per agent-hour, and the price is an assumed input', () => {
  const report = computeReport([], [], instanceFacts(['--price', '1.43']));
  expect(report.stages.map((stage) => stage.costPerAgentHour)).toEqual([0.143, 0.057, 0.029]);
  expect(report.assumedInputs.at(-1)).toEqual({
    flag: 'price',
    value: 1.43,
    isDefault: false,
  });
  const markdown = renderMarkdown(report);
  expect(markdown).toContain('| 3 | 50 | $0.029 |');
  expect(markdown).toContain('| --price | 1.43 | set |');
});

test('without the flags the report has no vLLM, probe or cost section', () => {
  const report = computeReport(OUTCOME_MIX, [], ONE_STAGE, {
    samples: [sample(40000, { running: 1 })],
    probes: [probe(40000, 200)],
  });
  expect(report.stages[0]).toMatchObject({
    vllm: null,
    probe: null,
    costPerAgentHour: null,
  });
  const markdown = renderMarkdown(report);
  for (const heading of ['## vLLM', '## Probe', '## Cost']) {
    expect(markdown).not.toContain(heading);
  }
});

test('every vLLM, probe and cost figure in report.md matches report.json', () => {
  const samples = [
    sample(40000, {
      waiting: 1,
      running: 5,
      cacheUsage: 0.25,
      promptTokens: 0,
      generationTokens: 0,
    }),
    sample(170000, {
      waiting: 3,
      running: 9,
      cacheUsage: 0.35,
      promptTokens: 390000,
      generationTokens: 13000,
    }),
  ];
  const probes = [probe(40000, 230), probe(50000, 260)];
  const facts = instanceFacts(['--vllm-metrics', '--probe', '--price', '1.43']);
  const report = computeReport(many(5, 'answered'), [], facts, { samples, probes });
  const markdown = renderMarkdown(report);
  const json = JSON.parse(renderJson(report)) as Report;
  const percent = (value: number | null) => value === null ? '—' : (value * 100).toFixed(1) + '%';
  const plain = (value: number | null) => value === null ? '—' : String(value);
  for (const stage of json.stages) {
    const vllm = stage.vllm;
    expect(vllm).not.toBeNull();
    const vllmRow = [
      stage.stage,
      stage.agents,
      vllm?.samplesRead,
      vllm?.samplesFailed,
      plain(vllm?.runningMean ?? null),
      plain(vllm?.runningMax ?? null),
      plain(vllm?.waitingMean ?? null),
      plain(vllm?.waitingMax ?? null),
      percent(vllm?.cacheUsageMean ?? null),
      percent(vllm?.cacheUsageMax ?? null),
      plain(vllm?.promptTokensPerSecond ?? null),
      plain(vllm?.generationTokensPerSecond ?? null),
      percent(vllm?.prefixCacheHitRate ?? null),
    ];
    expect(markdown).toContain('| ' + vllmRow.join(' | ') + ' |');
    const probeRow = [
      stage.stage,
      stage.agents,
      stage.probe?.probes,
      stage.probe?.failed,
      plain(stage.probe?.roundTripP50Ms ?? null),
      plain(stage.probe?.roundTripP95Ms ?? null),
      plain(stage.probe?.roundTripMaxMs ?? null),
      plain(stage.all.latencyP50Ms),
    ];
    expect(markdown).toContain('| ' + probeRow.join(' | ') + ' |');
    expect(markdown).toContain('| ' + stage.stage + ' | ' + stage.agents + ' | $' + stage.costPerAgentHour?.toFixed(3) + ' |');
  }
  expect(json.stages[0].vllm?.promptTokensPerSecond).toBe(3000);
  expect(markdown).toContain('Metrics not found: prefixCacheQueries.');
});

test('vLLM v0.31.0 context-length error, as served by a real instance, is counted as a context-length rejection', () => {
  const fixture = new URL('./fixtures/vllm-0.31.0-context-length.json', import.meta.url);
  const body = JSON.parse(readFileSync(fixture, 'utf8')) as { error: { message: string } };
  const failed = record('failed', { reason: 'HTTP 400: ' + body.error.message });
  expect(isContextLengthRejection(failed)).toBe(true);
  expect(isContextLengthRejection(record('failed', { reason: 'HTTP 429: rate limited' }))).toBe(false);
});
