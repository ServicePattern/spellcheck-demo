import type { LLMRequestKind } from '../../src/assistant/types.ts';
import type { MessageSentEvent, MessageStartEvent, RoundEvent } from './agent.ts';
import type { Language } from './chats.ts';
import type { RequestRecord } from './recorder.ts';
import { TYPING_INPUTS, type Settings, type TargetName } from './settings.ts';
import type { ServerFacts, UpstreamCall } from './targets.ts';

export type EndReason = 'completed' | 'request cap' | 'interrupted';

export interface StagePlan {
  stage: number;
  agents: number;
  startMs: number;
  endMs: number;
}

export interface SourceCount {
  conversations: number;
  agentTurns: number;
}

export interface SourcesFacts {
  folder: string;
  files: string[];
  English: SourceCount;
  Arabic: SourceCount;
}

export interface RunFacts {
  startedAt: string;
  durationSeconds: number;
  endReason: EndReason;
  settings: Settings;
  target: TargetName;
  model: string | null;
  endpointHost: string | null;
  sources: SourcesFacts;
  commit: string;
  hasUncommittedChanges: boolean;
  stages: StagePlan[];
  server: ServerFacts | null;
}

export type ActivityEvent = RoundEvent | MessageStartEvent | MessageSentEvent;

type Figure = number | null;

export interface GroupFigures {
  requests: number;
  roundsPerSecond: Figure;
  usefulAnswerRate: Figure;
  abortedShare: Figure;
  timeoutShare: Figure;
  failedShare: Figure;
  unreadableShare: Figure;
  latencyP50Ms: Figure;
  latencyP95Ms: Figure;
  latencyP99Ms: Figure;
  emptyCompletionShare: Figure;
  inFlightMean: Figure;
  inFlightMax: Figure;
}

export interface TypingProduced {
  roundGapP25Ms: Figure;
  roundGapP50Ms: Figure;
  roundGapP75Ms: Figure;
  allowedP25Ms: Figure;
  allowedP50Ms: Figure;
  allowedP75Ms: Figure;
  messageTimeShare: Figure;
}

export interface StageFigures {
  stage: number;
  agents: number;
  all: GroupFigures;
  byKind: Record<LLMRequestKind, GroupFigures>;
  byLanguage: Record<Language, GroupFigures>;
  typing: TypingProduced;
  upstream: UpstreamFigures | null;
}

export interface UpstreamGroupFigures {
  calls: number;
  answeredShare: Figure;
  errorShare: Figure;
  latencyP50Ms: Figure;
  latencyP95Ms: Figure;
  latencyP99Ms: Figure;
  unusedShare: Figure;
  upstreamSeconds: number;
}

export interface UpstreamFigures {
  all: UpstreamGroupFigures;
  byKind: Record<LLMRequestKind, UpstreamGroupFigures>;
}

export interface AssumedInput {
  flag: string;
  value: number;
  isDefault: boolean;
}

export interface Report {
  facts: RunFacts;
  assumedInputs: AssumedInput[];
  stages: StageFigures[];
}

interface Window {
  startMs: number;
  endMs: number;
}

type RecordFilter = (record: RequestRecord) => boolean;

export function computeReport(
  records: RequestRecord[],
  events: ActivityEvent[],
  facts: RunFacts,
  upstreamCalls: UpstreamCall[] = [],
): Report {
  const warmupMs = facts.settings.run.warmupSeconds * 1000;
  return {
    facts,
    assumedInputs: assumedInputsOf(facts.settings),
    stages: facts.stages.map((plan) => {
      const window = {
        startMs: plan.startMs + warmupMs,
        endMs: plan.endMs,
      };
      const figuresFor = (filter: RecordFilter) => groupFigures(records, plan.stage, window, filter);
      return {
        stage: plan.stage,
        agents: plan.agents,
        all: figuresFor(() => true),
        byKind: {
          'spell-check': figuresFor((record) => record.kind === 'spell-check'),
          'auto-completion': figuresFor((record) => record.kind === 'auto-completion'),
        },
        byLanguage: {
          English: figuresFor((record) => record.language === 'English'),
          Arabic: figuresFor((record) => record.language === 'Arabic'),
        },
        typing: typingProduced(records, events, plan.stage, window),
        upstream: facts.target === 'server' ? upstreamFigures(upstreamCalls, records, plan.stage, window) : null,
      };
    }),
  };
}

function upstreamFigures(
  calls: UpstreamCall[],
  records: RequestRecord[],
  stage: number,
  window: Window,
): UpstreamFigures {
  const callsInWindow = calls.filter((call) => call.startedAtMs >= window.startMs && call.startedAtMs < window.endMs);
  const figuresFor = (kind?: LLMRequestKind) => {
    const isOfKind = (callKind: LLMRequestKind) => kind === undefined || callKind === kind;
    const received = records.filter((record) => {
      return isOfKind(record.kind) && isCounted(record, stage) && isReceivedByClient(record);
    }).length;
    return upstreamGroupFigures(callsInWindow.filter((call) => isOfKind(call.kind)), received);
  };
  return {
    all: figuresFor(),
    byKind: {
      'spell-check': figuresFor('spell-check'),
      'auto-completion': figuresFor('auto-completion'),
    },
  };
}

function isReceivedByClient(record: RequestRecord): boolean {
  if (record.outcome === 'failed') {
    return record.reason?.startsWith('HTTP ') ?? false;
  }
  return record.outcome === 'answered' || record.outcome === 'unreadable';
}

function upstreamGroupFigures(calls: UpstreamCall[], receivedByClient: number): UpstreamGroupFigures {
  const durations = calls.map((call) => call.durationMs);
  const errors = calls.filter((call) => call.error !== undefined).length;
  return {
    calls: calls.length,
    answeredShare: share(calls.length - errors, calls.length),
    errorShare: share(errors, calls.length),
    latencyP50Ms: nearestRank(durations, 50),
    latencyP95Ms: nearestRank(durations, 95),
    latencyP99Ms: nearestRank(durations, 99),
    unusedShare: share(Math.max(0, calls.length - receivedByClient), calls.length),
    upstreamSeconds: round(durations.reduce((sum, duration) => sum + duration, 0) / 1000, 1),
  };
}

function assumedInputsOf(settings: Settings): AssumedInput[] {
  return TYPING_INPUTS.map((input) => {
    return {
      flag: input.flag,
      value: settings.typing[input.key],
      isDefault: !settings.setFlags.includes(input.flag),
    };
  });
}

export function isCounted(record: RequestRecord, stage: number): boolean {
  return record.stage === stage && !record.isWarmup && record.outcome !== 'cut';
}

function groupFigures(records: RequestRecord[], stage: number, window: Window, filter: RecordFilter): GroupFigures {
  const group = records.filter(filter);
  const counted = group.filter((record) => isCounted(record, stage));
  const shareOf = (outcome: RequestRecord['outcome']) => {
    return share(counted.filter((record) => record.outcome === outcome).length, counted.length);
  };
  const latencies = counted
    .filter((record) => record.outcome === 'answered' || record.outcome === 'unreadable')
    .map((record) => record.latencyMs);
  const answeredCompletions = counted.filter((record) => {
    return record.kind === 'auto-completion' && record.outcome === 'answered';
  });
  const emptyCompletions = answeredCompletions.filter((record) => record.isCompletionEmpty).length;
  const roundsAfterWarmup = new Set(group
    .filter((record) => record.stage === stage && !record.isWarmup)
    .map((record) => `${record.agent}:${record.sentAtMs}`));
  const windowSeconds = (window.endMs - window.startMs) / 1000;
  const inFlight = requestsInFlight(group, window);
  return {
    requests: counted.length,
    roundsPerSecond: windowSeconds > 0 ? round(roundsAfterWarmup.size / windowSeconds, 2) : null,
    usefulAnswerRate: shareOf('answered'),
    abortedShare: shareOf('aborted'),
    timeoutShare: shareOf('timeout'),
    failedShare: shareOf('failed'),
    unreadableShare: shareOf('unreadable'),
    latencyP50Ms: nearestRank(latencies, 50),
    latencyP95Ms: nearestRank(latencies, 95),
    latencyP99Ms: nearestRank(latencies, 99),
    emptyCompletionShare: share(emptyCompletions, answeredCompletions.length),
    inFlightMean: inFlight.mean,
    inFlightMax: inFlight.max,
  };
}

function requestsInFlight(records: RequestRecord[], window: Window): { mean: Figure; max: Figure } {
  const windowMs = window.endMs - window.startMs;
  if (windowMs <= 0) {
    return { mean: null, max: null };
  }
  const changes = records.flatMap((record) => {
    const startMs = Math.max(record.sentAtMs, window.startMs);
    const endMs = Math.min(record.sentAtMs + record.latencyMs, window.endMs);
    return startMs < endMs ? [{ atMs: startMs, step: 1 }, { atMs: endMs, step: -1 }] : [];
  });
  changes.sort((a, b) => a.atMs - b.atMs || a.step - b.step);
  let running = 0;
  let max = 0;
  let area = 0;
  let lastMs = window.startMs;
  for (const change of changes) {
    area += running * (change.atMs - lastMs);
    lastMs = change.atMs;
    running += change.step;
    max = Math.max(max, running);
  }
  return { mean: round(area / windowMs, 1), max };
}

function typingProduced(
  records: RequestRecord[],
  events: ActivityEvent[],
  stage: number,
  window: Window,
): TypingProduced {
  const gaps = roundGaps(events, window);
  const allowed = records.filter((record) => isCounted(record, stage)).map((record) => record.allowedMs);
  return {
    roundGapP25Ms: nearestRank(gaps, 25),
    roundGapP50Ms: nearestRank(gaps, 50),
    roundGapP75Ms: nearestRank(gaps, 75),
    allowedP25Ms: nearestRank(allowed, 25),
    allowedP50Ms: nearestRank(allowed, 50),
    allowedP75Ms: nearestRank(allowed, 75),
    messageTimeShare: messageTimeShare(events, window),
  };
}

function roundGaps(events: ActivityEvent[], window: Window): number[] {
  const lastRoundOfAgent = new Map<number, number>();
  const gaps: number[] = [];
  for (const event of events) {
    if (event.type !== 'round') {
      continue;
    }
    const previousAt = lastRoundOfAgent.get(event.agentNumber);
    const isInWindow = event.at >= window.startMs && event.at < window.endMs;
    if (previousAt !== undefined && isInWindow) {
      gaps.push(event.at - previousAt);
    }
    lastRoundOfAgent.set(event.agentNumber, event.at);
  }
  return gaps;
}

function messageTimeShare(events: ActivityEvent[], window: Window): Figure {
  const firstStartOfAgent = new Map<number, number>();
  const openMessageOfAgent = new Map<number, number>();
  let messageMs = 0;
  for (const event of events) {
    if (event.type === 'message-start') {
      if (!firstStartOfAgent.has(event.agentNumber)) {
        firstStartOfAgent.set(event.agentNumber, event.at);
      }
      openMessageOfAgent.set(event.agentNumber, event.at);
    }
    if (event.type === 'message') {
      messageMs += overlapMs(event.startedAt, event.sentAt, window);
      openMessageOfAgent.delete(event.agentNumber);
    }
  }
  for (const startedAt of openMessageOfAgent.values()) {
    messageMs += overlapMs(startedAt, window.endMs, window);
  }
  const activeMs = [...firstStartOfAgent.values()]
    .reduce((sum, firstStart) => sum + overlapMs(firstStart, window.endMs, window), 0);
  return share(messageMs, activeMs);
}

function overlapMs(startMs: number, endMs: number, window: Window): number {
  return Math.max(0, Math.min(endMs, window.endMs) - Math.max(startMs, window.startMs));
}

export function nearestRank(values: number[], percentile: number): Figure {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(percentile / 100 * sorted.length) - 1)]);
}

function share(part: number, whole: number): Figure {
  return whole > 0 ? round(part / whole, 4) : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const ABSENT = '—';

export function formatShare(value: Figure): string {
  return value === null ? ABSENT : `${(value * 100).toFixed(1)}%`;
}

export function formatNumber(value: Figure): string {
  return value === null ? ABSENT : String(value);
}

const GROUP_COLUMNS: [string, (figures: GroupFigures) => string][] = [
  ['Requests', (figures) => String(figures.requests)],
  ['Rounds/s', (figures) => formatNumber(figures.roundsPerSecond)],
  ['Useful answers', (figures) => formatShare(figures.usefulAnswerRate)],
  ['Aborted', (figures) => formatShare(figures.abortedShare)],
  ['Timeout', (figures) => formatShare(figures.timeoutShare)],
  ['Failed', (figures) => formatShare(figures.failedShare)],
  ['Unreadable', (figures) => formatShare(figures.unreadableShare)],
  ['p50 ms', (figures) => formatNumber(figures.latencyP50Ms)],
  ['p95 ms', (figures) => formatNumber(figures.latencyP95Ms)],
  ['p99 ms', (figures) => formatNumber(figures.latencyP99Ms)],
  ['Empty completions', (figures) => formatShare(figures.emptyCompletionShare)],
  ['In flight mean', (figures) => formatNumber(figures.inFlightMean)],
  ['In flight max', (figures) => formatNumber(figures.inFlightMax)],
];

const UPSTREAM_COLUMNS: [string, (figures: UpstreamGroupFigures) => string][] = [
  ['Upstream calls', (figures) => String(figures.calls)],
  ['Answered', (figures) => formatShare(figures.answeredShare)],
  ['Errors', (figures) => formatShare(figures.errorShare)],
  ['p50 ms', (figures) => formatNumber(figures.latencyP50Ms)],
  ['p95 ms', (figures) => formatNumber(figures.latencyP95Ms)],
  ['p99 ms', (figures) => formatNumber(figures.latencyP99Ms)],
  ['Unused by the client', (figures) => formatShare(figures.unusedShare)],
  ['Upstream time s', (figures) => String(figures.upstreamSeconds)],
];

const UPSTREAM_GROUPS: [string, (upstream: UpstreamFigures) => UpstreamGroupFigures][] = [
  ['all', (upstream) => upstream.all],
  ['spell check', (upstream) => upstream.byKind['spell-check']],
  ['auto-completion', (upstream) => upstream.byKind['auto-completion']],
];

export function upstreamTable(report: Report): string {
  return table(
    ['Stage', 'Requests', ...UPSTREAM_COLUMNS.map(([heading]) => heading)],
    report.stages.flatMap((stage) => {
      const { upstream } = stage;
      if (!upstream) {
        return [];
      }
      return UPSTREAM_GROUPS.map(([group, figuresOf]) => {
        return [String(stage.stage), group, ...UPSTREAM_COLUMNS.map(([, cell]) => cell(figuresOf(upstream)))];
      });
    }),
  );
}

function upstreamSection(report: Report): string[] {
  if (report.facts.target !== 'server') {
    return [];
  }
  return [
    '## Upstream calls made by the server',
    '',
    'Measured from the server\'s own log: one line per upstream call, counted in the stage where it started, '
      + 'after the warm-up. "Unused by the client" are calls the server finished for a client that had stopped waiting '
      + '(aborted, timed out or cut): upstream calls less the counted requests whose answer the client received.',
    '',
    upstreamTable(report),
    '',
  ];
}

const TYPING_COLUMNS: [string, (typing: TypingProduced) => string][] = [
  ['Round gap p25 ms', (typing) => formatNumber(typing.roundGapP25Ms)],
  ['Round gap p50 ms', (typing) => formatNumber(typing.roundGapP50Ms)],
  ['Round gap p75 ms', (typing) => formatNumber(typing.roundGapP75Ms)],
  ['Allowed p25 ms', (typing) => formatNumber(typing.allowedP25Ms)],
  ['Allowed p50 ms', (typing) => formatNumber(typing.allowedP50Ms)],
  ['Allowed p75 ms', (typing) => formatNumber(typing.allowedP75Ms)],
  ['Time on a message', (typing) => formatShare(typing.messageTimeShare)],
];

const END_REASONS: Record<EndReason, string> = {
  'completed': 'every stage ran to its end',
  'request cap': 'stopped by the request cap (--max-requests)',
  'interrupted': 'interrupted from the keyboard',
};

export function stageTable(report: Report, figuresOf: (stage: StageFigures) => GroupFigures): string {
  return table(
    ['Stage', 'Agents', ...GROUP_COLUMNS.map(([heading]) => heading)],
    report.stages.map((stage) => {
      return [String(stage.stage), String(stage.agents), ...GROUP_COLUMNS.map(([, cell]) => cell(figuresOf(stage)))];
    }),
  );
}

export function renderMarkdown(report: Report): string {
  const { facts } = report;
  const run = facts.settings.run;
  const fakeNotice = facts.target === 'fake'
    ? [
      '> **Target `fake`:** the answers and latencies came from the built-in fake. They mean nothing about any model.',
      '',
    ]
    : [];
  return [
    `# Load run ${facts.startedAt}`,
    '',
    ...fakeNotice,
    `Target \`${facts.target}\``
      + `${facts.model ? `, model \`${facts.model}\`` : ''}`
      + `${facts.endpointHost ? ` at ${facts.endpointHost}` : ''}.`,
    `Run ended: ${END_REASONS[facts.endReason]}, after ${facts.durationSeconds} s.`,
    '',
    `Counted requests: sent after the stage's first ${run.warmupSeconds} s of warm-up,`
      + ' and not cut by the end of the run.',
    'Shares are of counted requests; latencies are of answered and unreadable ones. "—" means nothing to compute.',
    '',
    '## Stages: all requests',
    '',
    stageTable(report, (stage) => stage.all),
    '',
    '## Stages: spell check',
    '',
    stageTable(report, (stage) => stage.byKind['spell-check']),
    '',
    '## Stages: auto-completion',
    '',
    stageTable(report, (stage) => stage.byKind['auto-completion']),
    '',
    '## Stages: English',
    '',
    stageTable(report, (stage) => stage.byLanguage.English),
    '',
    '## Stages: Arabic',
    '',
    stageTable(report, (stage) => stage.byLanguage.Arabic),
    '',
    ...upstreamSection(report),
    '## Typing produced',
    '',
    'What the assumed typing inputs produced: the gap between the starts of one agent\'s successive rounds, '
      + 'the time each counted request had before the agent resumed, and the share of time agents spent on a message.',
    '',
    table(
      ['Stage', ...TYPING_COLUMNS.map(([heading]) => heading)],
      report.stages.map((stage) => [String(stage.stage), ...TYPING_COLUMNS.map(([, cell]) => cell(stage.typing))]),
    ),
    '',
    '## Assumed inputs',
    '',
    'Assumptions, not measurements.',
    '',
    table(
      ['Input', 'Value', 'Source'],
      report.assumedInputs.map((input) => {
        return [`--${input.flag}`, String(input.value), input.isDefault ? 'default' : 'set'];
      }),
    ),
    '',
    '## Run facts',
    '',
    ...runFactLines(facts).map((line) => `- ${line}`),
    '',
  ].join('\n');
}

function runFactLines(facts: RunFacts): string[] {
  const run = facts.settings.run;
  const { sources } = facts;
  return [
    `Started: ${facts.startedAt}, duration ${facts.durationSeconds} s`,
    `Seed: ${run.seed}`,
    `Stages: ${facts.stages.map((stage) => `${stage.agents} agents`).join(', ')},`
      + ` ${run.stageSeconds} s each, ${run.warmupSeconds} s warm-up`,
    `Target: ${facts.target}; model: ${facts.model ?? ABSENT}; endpoint host: ${facts.endpointHost ?? ABSENT}`,
    `Request cap: ${run.maxRequests ?? 'none'}; request timeout: ${facts.settings.typing.timeoutMs} ms`,
    `Commit: ${facts.commit}${facts.hasUncommittedChanges ? ' with uncommitted changes' : ''}`,
    `Chat sources: ${sources.folder} (${sources.files.join(', ')})`,
    `English: ${sources.English.conversations} conversations, ${sources.English.agentTurns} agent turns`,
    `Arabic: ${sources.Arabic.conversations} conversations, ${sources.Arabic.agentTurns} agent turns`,
    ...serverFactLines(facts.server),
  ];
}

function serverFactLines(server: ServerFacts | null): string[] {
  if (!server) {
    return [];
  }
  return [
    `Server: port ${server.port}, ${server.ending}`,
    `Requests with no upstream line in the server's log: ${server.requestsWithoutUpstreamLine}`,
    ...server.otherLines.map((line) => `Server printed: \`${line}\``),
  ];
}

function table(headings: string[], rows: string[][]): string {
  return [
    `| ${headings.join(' | ')} |`,
    `|${headings.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
