import { parseArgs } from 'node:util';
import { createRealClock } from './clock.ts';
import type { LLMSettings } from './targets.ts';
import { metricsUrlFor, readMetricsBeforeRun, readMetricValues, type FetchText } from './vllm-metrics.ts';

export type AbortVerdict = 'reach' | 'do not reach' | 'unclear';

export interface RunningCounts {
  before: number;
  atAbort: number;
  oneSecondAfter: number;
  threeSecondsAfter: number;
}

export interface AbortCheckTiming {
  abortAfterMs: number;
  firstReadAfterMs: number;
  secondReadAfterMs: number;
}

export interface AbortCheckOptions {
  llm: LLMSettings;
  metricsUrl: string;
  fetchText: FetchText;
  log: (line: string) => void;
  timing?: AbortCheckTiming;
}

export const ABORT_CHECK_REQUESTS = 20;
export const ABORT_CHECK_MAX_TOKENS = 600;
const DEFAULT_TIMING: AbortCheckTiming = {
  abortAfterMs: 2000,
  firstReadAfterMs: 1000,
  secondReadAfterMs: 3000,
};
const DO_NOT_REACH_MARGIN = 10;
const LONG_ANSWER_PROMPT = 'Write a long, detailed story about a lighthouse keeper, at least 500 words.';

export function judgeAbortCheck(counts: RunningCounts): AbortVerdict {
  if (counts.atAbort < counts.before + DO_NOT_REACH_MARGIN) {
    return 'unclear';
  }
  if (counts.threeSecondsAfter <= counts.before) {
    return 'reach';
  }
  return counts.threeSecondsAfter >= counts.before + DO_NOT_REACH_MARGIN ? 'do not reach' : 'unclear';
}

export function abortCheckBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: LONG_ANSWER_PROMPT }],
    max_tokens: ABORT_CHECK_MAX_TOKENS,
    temperature: 0.7,
  });
}

export async function runAbortCheck(options: AbortCheckOptions): Promise<AbortVerdict> {
  const timing = options.timing ?? DEFAULT_TIMING;
  const startedAt = performance.now();
  const readRunning = async (moment: string) => {
    const text = await options.fetchText(options.metricsUrl, AbortSignal.timeout(2000));
    const running = readMetricValues(text).values.running;
    if (running === undefined) {
      throw new Error(`vllm:num_requests_running not found at ${options.metricsUrl}`);
    }
    const elapsedMs = String(Math.round(performance.now() - startedAt)).padStart(5);
    options.log(`${moment.padEnd(22)} at ${elapsedMs} ms: ${running} running`);
    return running;
  };
  await readMetricsBeforeRun(options.metricsUrl, createRealClock(), options.fetchText);
  const before = await readRunning('before sending');
  const controller = new AbortController();
  const requests = Array.from({ length: ABORT_CHECK_REQUESTS }, () => {
    return fetch(options.llm.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.llm.apiKey}` },
      body: abortCheckBody(options.llm.model),
      signal: controller.signal,
    }).then((response) => response.text()).catch(() => undefined);
  });
  await wait(timing.abortAfterMs);
  const atAbort = await readRunning('just before the abort');
  controller.abort();
  await Promise.all(requests);
  await wait(timing.firstReadAfterMs);
  const oneSecondAfter = await readRunning('after the abort');
  await wait(timing.secondReadAfterMs - timing.firstReadAfterMs);
  const threeSecondsAfter = await readRunning('later after the abort');
  const verdict = judgeAbortCheck({
    before,
    atAbort,
    oneSecondAfter,
    threeSecondsAfter,
  });
  options.log(verdictLine(verdict));
  return verdict;
}

function verdictLine(verdict: AbortVerdict): string {
  if (verdict === 'reach') {
    return 'Aborts reach vLLM: the aborted generations stopped.';
  }
  if (verdict === 'do not reach') {
    return 'Aborts do not reach vLLM: the aborted generations kept running.';
  }
  return 'Unclear: the generations were not all running at the abort, or only some of them stopped.';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(args: string[], environment: Record<string, string | undefined>): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
      model: { type: 'string' },
      'metrics-url': { type: 'string' },
    },
  });
  const llm: LLMSettings = {
    apiKey: environment.LLM_API_KEY ?? '',
    model: values.model ?? environment.MODEL ?? '',
    url: values.url ?? environment.LLM_URL ?? '',
  };
  if (!llm.apiKey || !llm.model || !URL.canParse(llm.url)) {
    throw new Error('Set LLM_API_KEY, MODEL and LLM_URL in .env or the environment (or pass --model and --url).');
  }
  const metricsUrl = metricsUrlFor(llm.url, values['metrics-url']);
  console.log(
    `Abort check: ${ABORT_CHECK_REQUESTS} generations of up to ${ABORT_CHECK_MAX_TOKENS} tokens to ${llm.url}`,
  );
  await runAbortCheck({
    llm,
    metricsUrl,
    fetchText: async (url, signal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text();
    },
    log: (line) => console.log(line),
  });
}
