import { expect, test } from '@playwright/test';
import { createVirtualClock, type Clock } from './clock.ts';
import {
  metricsUrlFor,
  parsePrometheusText,
  readMetricsBeforeRun,
  readMetricValues,
  runSampler,
  type FetchText,
  type MetricSample,
} from './vllm-metrics.ts';

const VLLM_TEXT = `# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="google/gemma-4-26B-A4B-it"} 3.0
vllm:num_requests_running{engine="1",model_name="google/gemma-4-26B-A4B-it"} 2.0
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine="0",model_name="google/gemma-4-26B-A4B-it"} 4.0
vllm:num_requests_waiting{engine="1",model_name="google/gemma-4-26B-A4B-it"} 0.0
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.5
vllm:kv_cache_usage_perc{engine="1",model_name="m"} 0.25
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{engine="0",model_name="m"} 120000.0
vllm:prompt_tokens_created{engine="0",model_name="m"} 1.7627e+09
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{engine="0",model_name="m"} 3000.0
vllm:e2e_request_latency_seconds_bucket{le="+Inf",model_name="a b"} 12 1700000000000
`;

test('the Prometheus text gives the values of each series, comments and timestamps left out', () => {
  const series = parsePrometheusText(VLLM_TEXT);
  expect(series.get('vllm:num_requests_running')).toEqual([3, 2]);
  expect(series.get('vllm:e2e_request_latency_seconds_bucket')).toEqual([12]);
  expect(series.has('# TYPE vllm:num_requests_running gauge')).toBe(false);
});

test('requests and counters are summed across engines, cache usage averaged, missing metrics named', () => {
  const reading = readMetricValues(VLLM_TEXT);
  expect(reading.values).toEqual({
    running: 5,
    waiting: 4,
    cacheUsage: 0.375,
    promptTokens: 120000,
    generationTokens: 3000,
  });
  expect(reading.notFound).toEqual(['prefixCacheQueries', 'prefixCacheHits']);
  expect(reading.namesUsed.cacheUsage).toBe('vllm:kv_cache_usage_perc');
});

test('the older cache usage name is used when the newer one is absent', () => {
  const reading = readMetricValues('vllm:gpu_cache_usage_perc{model_name="m"} 0.8\n');
  expect(reading.values.cacheUsage).toBe(0.8);
  expect(reading.namesUsed.cacheUsage).toBe('vllm:gpu_cache_usage_perc');
});

test('the metrics URL defaults to /metrics on the origin of LLM_URL', () => {
  const llmUrl = 'http://127.0.0.1:8000/v1/chat/completions';
  expect(metricsUrlFor(llmUrl, undefined)).toBe('http://127.0.0.1:8000/metrics');
  expect(metricsUrlFor(llmUrl, 'http://10.0.0.2:9000/m')).toBe('http://10.0.0.2:9000/m');
});

function fakeFetch(clock: Clock, slowReads: number[] = []): FetchText {
  let reads = 0;
  return async (_url, signal) => {
    reads += 1;
    await clock.sleep(slowReads.includes(reads) ? 5000 : 50, signal);
    return `vllm:num_requests_running{engine="0"} ${reads}\nvllm:generation_tokens_total ${reads * 100}\n`;
  };
}

test('samples are read every 2 s, and a read that times out is recorded as failed and sampling goes on', async () => {
  const { clock, runUntil, runUntilIdle } = createVirtualClock();
  const stop = new AbortController();
  const samples: MetricSample[] = [];
  const sampling = runSampler({
    url: 'http://127.0.0.1:8000/metrics',
    clock,
    stopSignal: stop.signal,
    fetchText: fakeFetch(clock, [10]),
    onSample: (sample) => samples.push(sample),
  });
  await runUntil(59999);
  stop.abort();
  await runUntilIdle();
  await sampling;
  expect(samples).toHaveLength(30);
  expect(samples.map((sample) => sample.atMs).slice(0, 4)).toEqual([0, 2000, 4000, 6000]);
  expect(samples[9]).toEqual({ atMs: 18000, error: 'timeout' });
  expect(samples[10]).toEqual({ atMs: 20000, values: { running: 11, generationTokens: 1100 } });
});

test('the read before the run stops it when the endpoint has no vLLM metrics, naming the URL and the flag', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const notFound: FetchText = async () => {
    throw new Error('HTTP 404');
  };
  const reading = readMetricsBeforeRun('https://generativelanguage.googleapis.com/metrics', clock, notFound);
  void runUntilIdle();
  await expect(reading).rejects.toThrow(
    'No vLLM metrics at https://generativelanguage.googleapis.com/metrics (HTTP 404). Point --metrics-url',
  );
  const other: FetchText = async () => 'process_cpu_seconds_total 12\n';
  await expect(readMetricsBeforeRun('http://127.0.0.1:9100/metrics', clock, other)).rejects.toThrow(
    'none of the expected metrics found',
  );
  const vllm: FetchText = async () => VLLM_TEXT;
  expect((await readMetricsBeforeRun('http://127.0.0.1:8000/metrics', clock, vllm)).notFound).toEqual([
    'prefixCacheQueries',
    'prefixCacheHits',
  ]);
});
