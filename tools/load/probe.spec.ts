import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createRealClock, createVirtualClock, type Clock } from './clock.ts';
import { probeFetchOverHttp, runProbes, type ProbeFetch, type ProbeRecord } from './probe.ts';

const LLM = {
  apiKey: 'probe-key',
  model: 'google/gemma-4-26B-A4B-it',
  url: 'http://127.0.0.1:8000/v1/chat/completions',
};

async function probesFor(untilMs: number, probeFetch: (clock: Clock) => ProbeFetch): Promise<ProbeRecord[]> {
  const { clock, runUntil, runUntilIdle } = createVirtualClock();
  const stop = new AbortController();
  const probes: ProbeRecord[] = [];
  const probing = runProbes({
    llm: LLM,
    clock,
    stopSignal: stop.signal,
    probeFetch: probeFetch(clock),
    onProbe: (probe) => probes.push(probe),
  });
  await runUntil(untilMs);
  stop.abort();
  await runUntilIdle();
  await probing;
  return probes;
}

test('a probe goes every 10 s, one at a time, with its round trip', async () => {
  const probes = await probesFor(59999, (clock) => {
    return async (_url, request) => {
      await clock.sleep(200, request.signal);
      return { status: 200, body: '{"choices":[{"message":{"content":"Hello"}}]}' };
    };
  });
  expect(probes).toHaveLength(6);
  expect(probes[0]).toEqual({
    sentAtMs: 0,
    roundTripMs: 200,
    outcome: 'answered',
  });
  expect(probes.map((probe) => probe.sentAtMs)).toEqual([0, 10000, 20000, 30000, 40000, 50000]);
});

test('a probe with no answer after 10 s is failed as a timeout, and an HTTP error is failed with its message', async () => {
  let count = 0;
  const probes = await probesFor(25000, (clock) => {
    return async (_url, request) => {
      count += 1;
      if (count === 1) {
        await clock.sleep(30000, request.signal);
      }
      return { status: 500, body: '{"error":{"message":"engine dead"}}' };
    };
  });
  expect(probes[0]).toEqual({
    sentAtMs: 0,
    roundTripMs: 10000,
    outcome: 'failed',
    reason: 'timeout',
  });
  expect(probes[1]).toMatchObject({
    sentAtMs: 10000,
    outcome: 'failed',
    reason: 'HTTP 500: engine dead',
  });
});

test('the probe is the smallest chat completion: one user message, one output token, the key', async () => {
  let received: { url: string; authorization?: string; body: string } | undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      received = {
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":[]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const stop = new AbortController();
  const probes: ProbeRecord[] = [];
  await runProbes({
    llm: { ...LLM, url },
    clock: createRealClock(),
    stopSignal: stop.signal,
    probeFetch: probeFetchOverHttp,
    onProbe: (probe) => {
      probes.push(probe);
      stop.abort();
    },
  });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  expect(probes[0].outcome).toBe('answered');
  expect(received?.url).toBe('/v1/chat/completions');
  expect(received?.authorization).toBe('Bearer probe-key');
  expect(JSON.parse(received?.body ?? '')).toEqual({
    model: 'google/gemma-4-26B-A4B-it',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 1,
    temperature: 0,
  });
});

test('a probe still running when the run ends is dropped at once, not recorded', async () => {
  const probes = await probesFor(15000, (clock) => {
    return async (_url, request) => {
      await clock.sleep(8000, request.signal);
      return { status: 200, body: '{}' };
    };
  });
  expect(probes.map((probe) => probe.sentAtMs)).toEqual([0]);
});
