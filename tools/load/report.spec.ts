import { expect, test } from '@playwright/test';
import type { Outcome } from './agent.ts';
import type { RequestRecord } from './recorder.ts';
import {
  computeReport,
  renderJson,
  renderMarkdown,
  type ActivityEvent,
  type GroupFigures,
  type Report,
  type RunFacts,
} from './report.ts';
import { parseSettings } from './settings.ts';

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
  expect(markdown).toContain('| 75.0% | 20.0% | 3.0% | 1.0% | 1.0% |');
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
