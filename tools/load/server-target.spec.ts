import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createRealClock } from './clock.ts';
import { createServerClient, parseServerLine, startDemoServer } from './server-target.ts';
import { parseSettings } from './settings.ts';
import { createTarget, type LLMSettings } from './targets.ts';

test('an upstream line is read with its kind, duration and outcome', () => {
  expect(parseServerLine('spell-check: answered in 718 ms')).toEqual({ kind: 'spell-check', durationMs: 718 });
  expect(parseServerLine('auto-completion: HTTP 429: rate limited in 210 ms')).toEqual({
    kind: 'auto-completion',
    durationMs: 210,
    error: 'HTTP 429: rate limited',
  });
});

test('an error text holding " in " still gives the last duration', () => {
  expect(parseServerLine('spell-check: HTTP 400: model not available in region eu in 35 ms')).toEqual({
    kind: 'spell-check',
    durationMs: 35,
    error: 'HTTP 400: model not available in region eu',
  });
});

test('the start-up line and other lines are not upstream calls', () => {
  expect(parseServerLine('http://127.0.0.1:8787, serving /Users/x/dist/')).toBeUndefined();
  expect(parseServerLine('LLM_API_KEY is not set. Put it in .env (see .env.example).')).toBeUndefined();
  expect(parseServerLine('spell-check: answered in ms')).toBeUndefined();
  expect(parseServerLine('polish: answered in 12 ms')).toBeUndefined();
});

interface Received {
  url: string;
  authorization: string | undefined;
  body: string;
}

type Reply = (response: ServerResponse) => void;

async function withStub(reply: Reply, run: (baseUrl: string, received: Received[]) => Promise<void>): Promise<void> {
  const received: Received[] = [];
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      reply(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, received);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(status: number, body: unknown): Reply {
  return (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };
}

const CREDENTIALS = { user: 'load-user', password: 'p4ss' };
const signal = () => new AbortController().signal;

test('each kind goes to its route with the Basic auth header and the user message as the page sends it', async () => {
  await withStub(json(200, { answer: '{"mistakes": []}' }), async (baseUrl, received) => {
    const client = createServerClient(baseUrl, CREDENTIALS);
    const arabic = 'Draft:\nوعليكم السلام، دعني أتحقق‸';
    expect(await client.ask('Draft:\nThank you‸', signal(), 'spell-check')).toEqual({ answer: '{"mistakes": []}' });
    await client.ask(arabic, signal(), 'auto-completion');
    expect(received.map((request) => request.url)).toEqual(['/api/autocorrection', '/api/autocompletion']);
    expect(received[0].authorization).toBe(`Basic ${Buffer.from('load-user:p4ss').toString('base64')}`);
    expect(JSON.parse(received[1].body)).toEqual({ userMessage: arabic });
  });
});

const responses: [string, Reply, string][] = [
  ['200 with an empty answer', json(200, { answer: '' }), 'empty answer'],
  ['502 with an error', json(502, { error: 'HTTP 429: rate limited' }), 'HTTP 502: HTTP 429: rate limited'],
  ['401 with no body', (response) => response.writeHead(401).end(), 'HTTP 401'],
  [
    'an HTML 400',
    (response) => response.writeHead(400, { 'Content-Type': 'text/html' }).end('<pre>SyntaxError</pre>'),
    'HTTP 400',
  ],
];

for (const [name, reply, error] of responses) {
  test(`a server response is read as the page reads it: ${name}`, async () => {
    await withStub(reply, async (baseUrl) => {
      const result = await createServerClient(baseUrl, CREDENTIALS).ask('Draft:\nHi‸', signal(), 'spell-check');
      expect(result).toEqual({ error });
    });
  });
}

test('a closed port is an error, not a throw', async () => {
  let closedPort = 0;
  await withStub(json(200, {}), async (baseUrl) => {
    closedPort = Number(new URL(baseUrl).port);
  });
  const client = createServerClient(`http://127.0.0.1:${closedPort}/`, CREDENTIALS);
  const result = await client.ask('Hi', signal(), 'spell-check');
  expect(result).toEqual({ error: 'TypeError: fetch failed' });
});

test('an abort ends the request at once and closes its connection', async () => {
  let isConnectionClosed = false;
  const neverAnswer: Reply = (response) => {
    response.on('close', () => {
      isConnectionClosed = true;
    });
  };
  await withStub(neverAnswer, async (baseUrl) => {
    const controller = new AbortController();
    const asking = createServerClient(baseUrl, CREDENTIALS).ask('Hi', controller.signal, 'auto-completion');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const abortedAt = performance.now();
    controller.abort();
    expect(await asking).toEqual({ error: expect.stringContaining('AbortError') });
    expect(performance.now() - abortedAt).toBeLessThan(100);
    await expect.poll(() => isConnectionClosed).toBe(true);
  });
});

async function closedLocalUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

async function unreachableLLM(): Promise<LLMSettings> {
  return {
    apiKey: 'test-key-not-real',
    model: 'test-model',
    url: await closedLocalUrl(),
  };
}

test('the real server starts, forwards to the LLM, logs the upstream call and is stopped', async () => {
  const server = await startDemoServer({ llm: await unreachableLLM(), clock: createRealClock() });
  try {
    const client = createServerClient(server.baseUrl, server.credentials);
    const result = await client.ask('Draft:\nوعليكم السلام‸', signal(), 'auto-completion');
    expect(result).toEqual({ error: 'HTTP 502: TypeError: fetch failed' });
    await server.waitForUpstreamLines(1, 5000);
    const call = expect.objectContaining({ kind: 'auto-completion', error: 'TypeError: fetch failed' });
    expect(server.upstreamCalls).toEqual([call]);
    expect(server.otherLines[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${server.port}, serving `));
    const wrongLogin = createServerClient(server.baseUrl, { user: 'x', password: 'y' });
    expect(await wrongLogin.ask('Hi', signal(), 'spell-check')).toEqual({ error: 'HTTP 401' });
  } finally {
    await server.stop();
  }
  expect(server.ending()).toBe('stopped by the loader');
  expect(() => process.kill(server.pid ?? 0, 0)).toThrow();
  const afterStop = await createServerClient(server.baseUrl, server.credentials).ask('Hi', signal(), 'spell-check');
  expect(afterStop).toEqual({ error: 'TypeError: fetch failed' });
});

test('a server that cannot take its port stops the start with its own output', async () => {
  const connections: Socket[] = [];
  const taken = createServer((socket) => connections.push(socket));
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  const { port } = taken.address() as AddressInfo;
  try {
    const starting = startDemoServer({ llm: await unreachableLLM(), clock: createRealClock(), port });
    const message = `did not start (port ${port} did not answer as the server started for this run)`;
    await expect(starting).rejects.toThrow(message);
  } finally {
    connections.forEach((socket) => socket.destroy());
    await new Promise((resolve) => taken.close(resolve));
  }
});

test('a server killed during a run is reported as exited, and later requests fail', async () => {
  const server = await startDemoServer({ llm: await unreachableLLM(), clock: createRealClock() });
  process.kill(server.pid ?? 0, 'SIGKILL');
  await expect.poll(() => server.ending()).toBe('exited on its own with signal SIGKILL');
  const result = await createServerClient(server.baseUrl, server.credentials).ask('Hi', signal(), 'spell-check');
  expect(result).toEqual({ error: 'TypeError: fetch failed' });
  await server.stop();
  expect(server.ending()).toBe('exited on its own with signal SIGKILL');
});

test('the server target is named in the missing settings and starts no server', async () => {
  const run = parseSettings(['--agents', '1', '--target', 'server']).run;
  await expect(createTarget(run, {}, createRealClock(), 20000)).rejects.toThrow(
    'The server target needs LLM_API_KEY, MODEL (or --model), LLM_URL (or --url)',
  );
});

test('the server target waits for the last upstream lines, then stops the server and gives its facts', async () => {
  const llm = await unreachableLLM();
  const run = parseSettings(['--agents', '1', '--target', 'server']).run;
  const target = await createTarget(run, {
    LLM_API_KEY: llm.apiKey,
    MODEL: llm.model,
    LLM_URL: llm.url,
  }, createRealClock(), 100);
  const client = target.clientForAgent(1);
  await Promise.all([
    client.ask('Draft:\nHello‸', signal(), 'spell-check'),
    client.ask('Draft:\nHello‸', signal(), 'auto-completion'),
  ]);
  await target.finish?.(3);
  const facts = target.facts?.();
  expect(facts?.upstreamCalls).toHaveLength(2);
  expect(facts?.server).toMatchObject({
    ending: 'stopped by the loader',
    requestsWithoutUpstreamLine: 1,
  });
  expect(JSON.stringify(facts)).not.toContain(llm.apiKey);
});
