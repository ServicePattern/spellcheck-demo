import type { Clock } from './clock.ts';
import type { LLMSettings } from './targets.ts';

export interface ProbeRecord {
  sentAtMs: number;
  roundTripMs: number;
  outcome: 'answered' | 'failed';
  reason?: string;
}

export interface ProbeResponse {
  status: number;
  body: string;
}

export interface ProbeRequest {
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export type ProbeFetch = (url: string, request: ProbeRequest) => Promise<ProbeResponse>;

export interface ProbeOptions {
  llm: LLMSettings;
  clock: Clock;
  stopSignal: AbortSignal;
  probeFetch: ProbeFetch;
  onProbe: (probe: ProbeRecord) => void;
}

export const PROBE_INTERVAL_MS = 10000;
export const PROBE_TIMEOUT_MS = 10000;

export const probeFetchOverHttp: ProbeFetch = async (url, request) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return { status: response.status, body: await response.text() };
};

export function probeBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 1,
    temperature: 0,
  });
}

export async function runProbes(options: ProbeOptions): Promise<void> {
  const { clock, stopSignal } = options;
  while (!stopSignal.aborted) {
    const sentAtMs = clock.now();
    const probe = await sendProbe(options, sentAtMs);
    if (!probe) {
      return;
    }
    options.onProbe(probe);
    try {
      await clock.sleep(Math.max(0, sentAtMs + PROBE_INTERVAL_MS - clock.now()), stopSignal);
    } catch {
      return;
    }
  }
}

async function sendProbe(options: ProbeOptions, sentAtMs: number): Promise<ProbeRecord | undefined> {
  const { clock, llm } = options;
  const timeout = new AbortController();
  const timerEnd = new AbortController();
  clock.sleep(PROBE_TIMEOUT_MS, timerEnd.signal).then(() => timeout.abort('timeout'), () => undefined);
  const ended = (outcome: ProbeRecord['outcome'], reason?: string): ProbeRecord => {
    const probe: ProbeRecord = {
      sentAtMs: Math.round(sentAtMs),
      roundTripMs: Math.round(clock.now() - sentAtMs),
      outcome,
    };
    if (reason !== undefined) {
      probe.reason = reason;
    }
    return probe;
  };
  try {
    const response = await options.probeFetch(llm.url, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: probeBody(llm.model),
      signal: AbortSignal.any([timeout.signal, options.stopSignal]),
    });
    if (response.status < 200 || response.status >= 300) {
      return ended('failed', `HTTP ${response.status}${errorMessageOf(response.body)}`);
    }
    return ended('answered');
  } catch (error) {
    if (options.stopSignal.aborted) {
      return undefined;
    }
    if (timeout.signal.aborted) {
      return ended('failed', 'timeout');
    }
    return ended('failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    timerEnd.abort();
  }
}

function errorMessageOf(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' ? `: ${message}` : '';
  } catch {
    return '';
  }
}
