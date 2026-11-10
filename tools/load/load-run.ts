import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent, type AgentEvent } from './agent.ts';
import { messageScriptsOf, readChatSources, type ChatSources, type Language } from './chats.ts';
import type { Clock } from './clock.ts';
import { probeFetchOverHttp, runProbes, type ProbeFetch, type ProbeRecord } from './probe.ts';
import { createRandomStream } from './random.ts';
import { createJsonLinesFile, createRecorder, type RequestRecord, type StagePlace } from './recorder.ts';
import {
  computeReport,
  renderJson,
  renderMarkdown,
  stageTable,
  upstreamTable,
  type ActivityEvent,
  type EndReason,
  type Report,
  type SourceCount,
  type SourcesFacts,
  type StagePlan,
  type VllmFacts,
} from './report.ts';
import { parseSettings, type Settings } from './settings.ts';
import { createTarget, readLLMSettings, type LLMSettings, type Target } from './targets.ts';
import { createTypingModel } from './typing-model.ts';
import {
  fetchTextOverHttp,
  metricsUrlFor,
  readMetricsBeforeRun,
  runSampler,
  type FetchText,
  type MetricSample,
} from './vllm-metrics.ts';

export interface RepositoryFacts {
  commit: string;
  hasUncommittedChanges: boolean;
}

export interface LoadRunInput {
  args: string[];
  environment: Record<string, string | undefined>;
  clock: Clock;
  driveClock: () => Promise<void>;
  startedAt: Date;
  repository: RepositoryFacts;
  interruptSignal?: AbortSignal;
  log: (line: string) => void;
  fetchText?: FetchText;
  probeFetch?: ProbeFetch;
}

export interface LoadRunResult {
  folder: string;
  report: Report;
  sentRequests: number;
}

export const REPORT_MARKDOWN_FILE = 'report.md';
export const REPORT_JSON_FILE = 'report.json';
export const METRICS_FILE = 'metrics.jsonl';
export const PROBE_FILE = 'probe.jsonl';
const MAX_START_SPREAD_MS = 30000;

type StopReason = Exclude<EndReason, 'completed'> | 'end';

interface RunSetup {
  input: LoadRunInput;
  settings: Settings;
  sources: ChatSources;
  target: Target;
  llm: LLMSettings | undefined;
  vllm: VllmFacts | null;
}

interface StagesDone {
  folder: string;
  records: RequestRecord[];
  activity: ActivityEvent[];
  stagePlans: StagePlan[];
  stopReason: StopReason;
  samples: MetricSample[];
  probes: ProbeRecord[];
}

export async function runLoad(input: LoadRunInput): Promise<LoadRunResult> {
  const settings = parseSettings(input.args);
  const sources = await readChatSources(settings.run.chatsFolder);
  const isWatchingInstance = settings.run.withVllmMetrics || settings.run.withProbe;
  const llm = isWatchingInstance ? readLLMSettings(settings.run, input.environment) : undefined;
  const vllm = llm && settings.run.withVllmMetrics ? await checkMetrics(input, llm, settings.run.metricsUrl) : null;
  const target = await createTarget(settings.run, input.environment, input.clock, settings.typing.timeoutMs);
  const setup: RunSetup = {
    input,
    settings,
    sources,
    target,
    llm,
    vllm,
  };
  const sent = { count: 0 };
  let stagesDone: StagesDone;
  try {
    stagesDone = await runStagesOnTarget(setup, sent);
  } finally {
    await target.finish?.(sent.count);
  }
  return writeReport(setup, stagesDone, sent.count);
}

async function checkMetrics(input: LoadRunInput, llm: LLMSettings, metricsUrl: string | undefined): Promise<VllmFacts> {
  const url = metricsUrlFor(llm.url, metricsUrl);
  const reading = await readMetricsBeforeRun(url, input.clock, input.fetchText ?? fetchTextOverHttp);
  return {
    metricsUrl: url,
    metricsNotFound: reading.notFound,
    namesUsed: reading.namesUsed,
  };
}

function watchInstance(setup: RunSetup, folder: string, stopSignal: AbortSignal) {
  const { input, llm, vllm } = setup;
  const samples: MetricSample[] = [];
  const probes: ProbeRecord[] = [];
  const watchers: Promise<void>[] = [];
  if (vllm) {
    const file = createJsonLinesFile(join(folder, METRICS_FILE));
    watchers.push(runSampler({
      url: vllm.metricsUrl,
      clock: input.clock,
      stopSignal,
      fetchText: input.fetchText ?? fetchTextOverHttp,
      onSample: (sample) => {
        samples.push(sample);
        file.write(sample);
      },
    }).finally(() => file.close()));
  }
  if (llm && setup.settings.run.withProbe) {
    const file = createJsonLinesFile(join(folder, PROBE_FILE));
    watchers.push(runProbes({
      llm,
      clock: input.clock,
      stopSignal,
      probeFetch: input.probeFetch ?? probeFetchOverHttp,
      onProbe: (probe) => {
        probes.push(probe);
        file.write(probe);
      },
    }).finally(() => file.close()));
  }
  return {
    samples,
    probes,
    watching: Promise.all(watchers),
  };
}

async function runStagesOnTarget(setup: RunSetup, sent: { count: number }): Promise<StagesDone> {
  const { input, settings, sources, target } = setup;
  const folder = await makeRunFolder(settings.run.outFolder, input.startedAt);
  const { clock } = input;
  const stageMs = settings.run.stageSeconds * 1000;
  const warmupMs = settings.run.warmupSeconds * 1000;
  const placeOf = (sentAt: number): StagePlace => {
    const stageIndex = Math.min(Math.floor(sentAt / stageMs), settings.run.agentLevels.length - 1);
    return { stage: stageIndex + 1, isWarmup: sentAt - stageIndex * stageMs < warmupMs };
  };
  const recorder = createRecorder(folder, settings.run.withTrace, placeOf);
  const activity: ActivityEvent[] = [];
  const stop = new AbortController();
  const stopWith = (reason: StopReason) => {
    if (!stop.signal.aborted) {
      stop.abort(reason);
    }
  };
  input.interruptSignal?.addEventListener('abort', () => stopWith('interrupted'), { once: true });
  const takeRequestPermit = () => {
    if (stop.signal.aborted || sent.count >= (settings.run.maxRequests ?? Infinity)) {
      return false;
    }
    sent.count++;
    if (sent.count === settings.run.maxRequests) {
      stopWith('request cap');
    }
    return true;
  };
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'request') {
      recorder.record(event.request);
    } else if (event.type !== 'burst') {
      activity.push(event);
    }
  };
  input.log(`Load run: ${settingsSummary(settings)}. Run folder: ${folder}`);

  const agents: Promise<void>[] = [];
  const stagePlans: StagePlan[] = [];
  const runStages = async () => {
    for (const [stageIndex, level] of settings.run.agentLevels.entries()) {
      if (stop.signal.aborted) {
        break;
      }
      const startMs = stageIndex * stageMs;
      stagePlans.push({
        stage: stageIndex + 1,
        agents: level,
        startMs,
        endMs: startMs + stageMs,
      });
      input.log(`Stage ${stageIndex + 1}: ${level} agents`);
      for (let agentNumber = agents.length + 1; agentNumber <= level; agentNumber++) {
        agents.push(startAgent(agentNumber, startMs));
      }
      await clock.sleep(startMs + stageMs - clock.now(), stop.signal).catch(() => undefined);
    }
    const endedAt = clock.now();
    stopWith('end');
    const lastPlan = stagePlans.at(-1);
    if (lastPlan) {
      lastPlan.endMs = Math.min(lastPlan.endMs, endedAt);
    }
    await Promise.all(agents);
  };
  const startAgent = async (agentNumber: number, stageStartMs: number) => {
    const spreadMs = Math.min(warmupMs > 0 ? warmupMs : stageMs / 4, MAX_START_SPREAD_MS);
    const delayMs = createRandomStream(settings.run.seed, agentNumber, 'start').next() * spreadMs;
    try {
      await clock.sleep(stageStartMs + delayMs - clock.now(), stop.signal);
    } catch {
      return;
    }
    await runAgent({
      agentNumber,
      model: createTypingModel(settings.typing, settings.run.seed, agentNumber),
      settings: settings.typing,
      conversations: sources.conversations,
      clock,
      llmClient: target.clientForAgent(agentNumber),
      stopSignal: stop.signal,
      takeRequestPermit,
      onEvent,
    });
  };
  const instance = watchInstance(setup, folder, stop.signal);
  await Promise.all([runStages(), instance.watching, input.driveClock()]);
  await recorder.close();
  return {
    samples: instance.samples,
    probes: instance.probes,
    folder,
    records: recorder.records,
    activity,
    stagePlans,
    stopReason: stop.signal.reason as StopReason,
  };
}

async function writeReport(setup: RunSetup, stagesDone: StagesDone, sentRequests: number): Promise<LoadRunResult> {
  const { input, settings, sources, target } = setup;
  const { folder, stopReason } = stagesDone;
  const targetFacts = target.facts?.();
  const report = computeReport(stagesDone.records, stagesDone.activity, {
    startedAt: input.startedAt.toISOString(),
    durationSeconds: Math.round(input.clock.now() / 100) / 10,
    endReason: stopReason === 'end' ? 'completed' : stopReason,
    settings,
    target: target.name,
    model: target.model ?? null,
    endpointHost: target.endpointHost ?? null,
    sources: sourcesFacts(sources),
    commit: input.repository.commit,
    hasUncommittedChanges: input.repository.hasUncommittedChanges,
    stages: stagesDone.stagePlans,
    server: targetFacts?.server ?? null,
    vllm: setup.vllm,
  }, {
    upstreamCalls: targetFacts?.upstreamCalls,
    samples: stagesDone.samples,
    probes: stagesDone.probes,
  });
  await writeFile(join(folder, REPORT_MARKDOWN_FILE), renderMarkdown(report));
  await writeFile(join(folder, REPORT_JSON_FILE), renderJson(report));
  input.log(`\n${stageTable(report, (stage) => stage.all)}\n`);
  if (report.facts.server) {
    input.log(`Upstream calls made by the server:\n\n${upstreamTable(report)}\n`);
  }
  input.log(`Run ended: ${report.facts.endReason}. ${sentRequests} requests sent.`);
  input.log(`Report: ${join(folder, REPORT_MARKDOWN_FILE)}`);
  return {
    folder,
    report,
    sentRequests,
  };
}

function settingsSummary(settings: Settings): string {
  const run = settings.run;
  return `${run.target} target, agents ${run.agentLevels.join(',')}, ${run.stageSeconds} s stages, seed ${run.seed}`;
}

async function makeRunFolder(outFolder: string, startedAt: Date): Promise<string> {
  await mkdir(outFolder, { recursive: true });
  const name = startedAt.toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; ; attempt++) {
    const folder = join(outFolder, attempt ? `${name}-${attempt}` : name);
    try {
      await mkdir(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

function sourcesFacts(sources: ChatSources): SourcesFacts {
  const countOf = (language: Language): SourceCount => {
    const conversations = sources.conversations.filter((conversation) => conversation.language === language);
    return {
      conversations: conversations.length,
      agentTurns: conversations.flatMap(messageScriptsOf).length,
    };
  };
  return {
    folder: sources.folder,
    files: sources.files,
    English: countOf('English'),
    Arabic: countOf('Arabic'),
  };
}
