import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { LLMClient, LLMRequestKind, LLMResult } from '../../src/assistant/types.ts';
import { API_ROUTES } from '../../src/app/lib/llm-client.ts';
import type { Clock } from './clock.ts';
import type { LLMSettings, ServerFacts, Target, UpstreamCall } from './targets.ts';

export interface ParsedUpstreamLine {
  kind: LLMRequestKind;
  durationMs: number;
  error?: string;
}

export interface Credentials {
  user: string;
  password: string;
}

const UPSTREAM_LINE = /^(spell-check|auto-completion): (.*) in (\d+) ms$/;

export function parseServerLine(line: string): ParsedUpstreamLine | undefined {
  const match = UPSTREAM_LINE.exec(line.trim());
  if (!match) {
    return undefined;
  }
  const [, kind, outcome, duration] = match;
  const parsed: ParsedUpstreamLine = {
    kind: kind as LLMRequestKind,
    durationMs: Number(duration),
  };
  if (outcome !== 'answered') {
    parsed.error = outcome;
  }
  return parsed;
}

export function createServerClient(baseUrl: string, credentials: Credentials): LLMClient {
  const authorization = basicAuthorization(credentials);
  return {
    async ask(userMessage, signal, requestKind) {
      try {
        const response = await fetch(new URL(API_ROUTES[requestKind], baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authorization },
          body: JSON.stringify({ userMessage }),
          signal,
        });
        const body = (await response.json().catch(() => ({}))) as Partial<{ answer: string, error: string }>;
        if (!response.ok) {
          return { error: `HTTP ${response.status}${body.error ? `: ${body.error}` : ''}` };
        }
        const result: LLMResult<string> = body.answer
          ? { answer: body.answer }
          : { error: body.error ?? 'empty answer' };
        return result;
      } catch (error) {
        return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
    },
  };
}

export interface DemoServer {
  pid: number | undefined;
  port: number;
  baseUrl: string;
  credentials: Credentials;
  upstreamCalls: UpstreamCall[];
  otherLines: string[];
  ending(): string | undefined;
  waitForUpstreamLines(count: number, maxMs: number): Promise<void>;
  stop(): Promise<void>;
}

export interface DemoServerOptions {
  llm: LLMSettings;
  clock: Clock;
  port?: number;
  startTimeoutMs?: number;
}

const SERVER_ENTRY = fileURLToPath(new URL('../../server/index.ts', import.meta.url));
const START_TIMEOUT_MS = 15000;
const KILL_AFTER_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const FINISH_EXTRA_MS = 5000;

export async function startServerTarget(llm: LLMSettings, requestTimeoutMs: number, clock: Clock): Promise<Target> {
  const server = await startDemoServer({ llm, clock });
  const client = createServerClient(server.baseUrl, server.credentials);
  let requestsWithoutUpstreamLine = 0;
  return {
    name: 'server',
    model: llm.model,
    endpointHost: new URL(llm.url).host,
    clientForAgent: () => client,
    finish: async (sentRequests) => {
      await server.waitForUpstreamLines(sentRequests, requestTimeoutMs + FINISH_EXTRA_MS);
      requestsWithoutUpstreamLine = Math.max(0, sentRequests - server.upstreamCalls.length);
      await server.stop();
    },
    facts: () => {
      const facts: ServerFacts = {
        port: server.port,
        ending: server.ending() ?? 'still running',
        requestsWithoutUpstreamLine,
        otherLines: server.otherLines,
      };
      return { server: facts, upstreamCalls: server.upstreamCalls };
    },
  };
}

export async function startDemoServer(options: DemoServerOptions): Promise<DemoServer> {
  const port = options.port ?? await findFreePort();
  const credentials: Credentials = {
    user: `load-${randomBytes(4).toString('hex')}`,
    password: randomBytes(18).toString('base64url'),
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_ENTRY], {
    env: serverEnvironment(options.llm, port, credentials),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killOnExit = () => child.kill('SIGKILL');
  process.on('exit', killOnExit);
  const upstreamCalls: UpstreamCall[] = [];
  const otherLines: string[] = [];
  const lineListeners = new Set<() => void>();
  let exitDescription: string | undefined;
  let isStopping = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      process.off('exit', killOnExit);
      const how = signal ? `signal ${signal}` : `code ${code}`;
      exitDescription = isStopping ? 'stopped by the loader' : `exited on its own with ${how}`;
      lineListeners.forEach((listener) => listener());
      resolve();
    });
  });
  const onLine = (line: string) => {
    const parsed = parseServerLine(line);
    if (parsed) {
      upstreamCalls.push(toUpstreamCall(parsed, options.clock.now()));
    } else if (line.trim()) {
      otherLines.push(line);
    }
    lineListeners.forEach((listener) => listener());
  };
  readLines(child, onLine);
  const stop = async () => {
    if (exitDescription) {
      return;
    }
    isStopping = true;
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
    await exited;
    clearTimeout(killer);
  };
  const isListening = () => otherLines.some((line) => line.startsWith(`http://127.0.0.1:${port}`));
  const baseUrl = `http://127.0.0.1:${port}/`;
  try {
    const startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    await waitUntil(isListening, startTimeoutMs, lineListeners, () => !!exitDescription);
    await confirmOwnServer(baseUrl, credentials);
  } catch (error) {
    await stop();
    const printed = otherLines.join('\n') || '(nothing)';
    throw new Error(`The demo server did not start (${(error as Error).message}). It printed:\n${printed}`);
  }
  return {
    pid: child.pid,
    port,
    baseUrl,
    credentials,
    upstreamCalls,
    otherLines,
    ending: () => exitDescription,
    waitForUpstreamLines: async (count, maxMs) => {
      const hasAll = () => upstreamCalls.length >= count;
      await waitUntil(hasAll, maxMs, lineListeners, () => !!exitDescription).catch(() => undefined);
    },
    stop,
  };
}

async function confirmOwnServer(baseUrl: string, credentials: Credentials): Promise<void> {
  const notOurs = `port ${new URL(baseUrl).port} did not answer as the server started for this run`;
  try {
    const response = await fetch(new URL(API_ROUTES['spell-check'], baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: basicAuthorization(credentials) },
      body: '{}',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status !== 400) {
      throw new Error(notOurs);
    }
  } catch {
    throw new Error(notOurs);
  }
}

function basicAuthorization(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
}

function serverEnvironment(llm: LLMSettings, port: number, credentials: Credentials): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    PORT: String(port),
    LLM_API_KEY: llm.apiKey,
    MODEL: llm.model,
    LLM_URL: llm.url,
    BASIC_AUTH_USER: credentials.user,
    BASIC_AUTH_PASSWORD: credentials.password,
  };
}

function toUpstreamCall(parsed: ParsedUpstreamLine, endedAtMs: number): UpstreamCall {
  const call: UpstreamCall = {
    kind: parsed.kind,
    startedAtMs: endedAtMs - parsed.durationMs,
    durationMs: parsed.durationMs,
  };
  if (parsed.error !== undefined) {
    call.error = parsed.error;
  }
  return call;
}

function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) {
      createInterface({ input: stream }).on('line', onLine);
    }
  }
}

function waitUntil(
  isDone: () => boolean,
  maxMs: number,
  listeners: Set<() => void>,
  hasExited: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (isDone()) {
        finish();
        resolve();
      } else if (hasExited()) {
        finish();
        reject(new Error('the server exited'));
      }
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('timed out'));
    }, maxMs);
    const finish = () => {
      clearTimeout(timer);
      listeners.delete(check);
    };
    listeners.add(check);
    check();
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
