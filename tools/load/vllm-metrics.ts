import type { Clock } from './clock.ts';

export type MetricKey =
  | 'running'
  | 'waiting'
  | 'cacheUsage'
  | 'promptTokens'
  | 'generationTokens'
  | 'prefixCacheQueries'
  | 'prefixCacheHits';

export type MetricValues = Partial<Record<MetricKey, number>>;

export interface MetricSource {
  key: MetricKey;
  candidates: string[];
  combine: 'sum' | 'mean';
}

export interface MetricReading {
  values: MetricValues;
  namesUsed: Partial<Record<MetricKey, string>>;
  notFound: MetricKey[];
}

export interface MetricSample {
  atMs: number;
  values?: MetricValues;
  error?: string;
}

export type FetchText = (url: string, signal: AbortSignal) => Promise<string>;

export interface SamplerOptions {
  url: string;
  clock: Clock;
  stopSignal: AbortSignal;
  fetchText: FetchText;
  onSample: (sample: MetricSample) => void;
}

export const METRIC_SOURCES: MetricSource[] = [
  {
    key: 'running',
    candidates: ['vllm:num_requests_running'],
    combine: 'sum',
  },
  {
    key: 'waiting',
    candidates: ['vllm:num_requests_waiting'],
    combine: 'sum',
  },
  {
    key: 'cacheUsage',
    candidates: ['vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc'],
    combine: 'mean',
  },
  {
    key: 'promptTokens',
    candidates: ['vllm:prompt_tokens_total'],
    combine: 'sum',
  },
  {
    key: 'generationTokens',
    candidates: ['vllm:generation_tokens_total'],
    combine: 'sum',
  },
  {
    key: 'prefixCacheQueries',
    candidates: ['vllm:prefix_cache_queries_total'],
    combine: 'sum',
  },
  {
    key: 'prefixCacheHits',
    candidates: ['vllm:prefix_cache_hits_total'],
    combine: 'sum',
  },
];

export const SAMPLE_INTERVAL_MS = 2000;
export const SAMPLE_TIMEOUT_MS = 1000;
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)(\s+\S+)?$/;

export function parsePrometheusText(text: string): Map<string, number[]> {
  const series = new Map<string, number[]>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const match = line && !line.startsWith('#') ? SAMPLE_LINE.exec(line) : null;
    const value = match ? Number(match[3]) : Number.NaN;
    if (match && Number.isFinite(value)) {
      series.set(match[1], [...(series.get(match[1]) ?? []), value]);
    }
  }
  return series;
}

export function readMetricValues(text: string): MetricReading {
  const series = parsePrometheusText(text);
  const reading: MetricReading = {
    values: {},
    namesUsed: {},
    notFound: [],
  };
  for (const source of METRIC_SOURCES) {
    const name = source.candidates.find((candidate) => series.has(candidate));
    const values = name ? series.get(name) ?? [] : [];
    if (!name || !values.length) {
      reading.notFound.push(source.key);
      continue;
    }
    const sum = values.reduce((total, value) => total + value, 0);
    reading.values[source.key] = source.combine === 'sum' ? sum : sum / values.length;
    reading.namesUsed[source.key] = name;
  }
  return reading;
}

export function metricsUrlFor(llmUrl: string, metricsUrl: string | undefined): string {
  return metricsUrl ?? new URL('/metrics', llmUrl).href;
}

export const fetchTextOverHttp: FetchText = async (url, signal) => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
};

export async function readMetricsBeforeRun(url: string, clock: Clock, fetchText: FetchText): Promise<MetricReading> {
  const failure = (why: string) => {
    return new Error(
      `No vLLM metrics at ${url} (${why}). Point --metrics-url at vLLM's /metrics, or leave out --vllm-metrics.`,
    );
  };
  let text: string;
  try {
    text = await fetchWithTimeout(url, clock, fetchText);
  } catch (error) {
    throw failure(reasonOf(error));
  }
  const reading = readMetricValues(text);
  if (reading.notFound.length === METRIC_SOURCES.length) {
    throw failure('none of the expected metrics found');
  }
  return reading;
}

export async function runSampler(options: SamplerOptions): Promise<void> {
  const { clock, stopSignal } = options;
  while (!stopSignal.aborted) {
    const atMs = clock.now();
    options.onSample(await readSample(options, Math.round(atMs)));
    try {
      await clock.sleep(Math.max(0, atMs + SAMPLE_INTERVAL_MS - clock.now()), stopSignal);
    } catch {
      return;
    }
  }
}

async function readSample(options: SamplerOptions, atMs: number): Promise<MetricSample> {
  try {
    const text = await fetchWithTimeout(options.url, options.clock, options.fetchText);
    return { atMs, values: readMetricValues(text).values };
  } catch (error) {
    return { atMs, error: reasonOf(error) };
  }
}

async function fetchWithTimeout(url: string, clock: Clock, fetchText: FetchText): Promise<string> {
  const timeout = new AbortController();
  const timerEnd = new AbortController();
  clock.sleep(SAMPLE_TIMEOUT_MS, timerEnd.signal).then(() => timeout.abort('timeout'), () => undefined);
  try {
    return await fetchText(url, timeout.signal);
  } catch (error) {
    throw timeout.signal.aborted ? new Error('timeout') : error;
  } finally {
    timerEnd.abort();
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
