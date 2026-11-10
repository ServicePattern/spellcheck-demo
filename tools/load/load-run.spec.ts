import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createRealClock, createVirtualClock, type Clock } from './clock.ts';
import { runLoad, type LoadRunResult } from './load-run.ts';
import type { RequestRecord } from './recorder.ts';
import type { Report } from './report.ts';

const ENGLISH_CHATS = [
  'Customer: Hi, I applied for my retirement pension three weeks ago.',
  'Agent: Hello, and thank you for reaching out. Let me check the status of your application for you.',
  'Customer: Is there anything missing?',
  'Agent: No, all the required documents are already attached. You will receive a text message soon.',
  '---',
  'Customer: How do I change the bank account for my pension?',
  'Agent: You can update your bank details online in a few steps from the Profile section.',
  '---',
].join('\n');

const ARABIC_CHATS = [
  'العميل: السلام عليكم، قدمت طلب معاش التقاعد قبل ثلاثة أسابيع.',
  'الموظف: وعليكم السلام، وشكراً لتواصلك معنا. دعني أتحقق من حالة طلبك الآن.',
  'العميل: هل ينقصني شيء؟',
  'الموظف: لا، جميع المستندات المطلوبة مرفقة بالفعل. ستصلك رسالة نصية فور صدور القرار.',
  '---',
].join('\n');

async function chatsFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'load-chats-'));
  await writeFile(join(folder, 'support-en.txt'), ENGLISH_CHATS);
  await writeFile(join(folder, 'support-ar.txt'), ARABIC_CHATS);
  return folder;
}

interface VirtualRunOptions {
  interruptAtMs?: number;
  environment?: Record<string, string>;
}

async function virtualRun(args: string[], options: VirtualRunOptions = {}): Promise<LoadRunResult> {
  const { clock, runUntilIdle } = createVirtualClock();
  const interrupt = new AbortController();
  if (options.interruptAtMs !== undefined) {
    void clock.sleep(options.interruptAtMs).then(() => interrupt.abort());
  }
  const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
  return runLoad({
    args: [...args, '--chats', await chatsFolder(), '--out', out],
    environment: options.environment ?? {},
    clock,
    driveClock: runUntilIdle,
    startedAt: new Date('2026-11-10T12:00:00.000Z'),
    repository: { commit: 'abc1234', hasUncommittedChanges: true },
    interruptSignal: interrupt.signal,
    log: () => undefined,
  });
}

async function recordsOf(folder: string): Promise<RequestRecord[]> {
  const text = await readFile(join(folder, 'requests.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RequestRecord);
}

test('three stages add agents up to each level and write the run folder', async () => {
  const result = await virtualRun(['--target', 'fake', '--agents', '2,5,10', '--stage', '120', '--warmup', '20']);
  expect((await readdir(result.folder)).sort()).toEqual(['report.json', 'report.md', 'requests.jsonl']);
  const report = JSON.parse(await readFile(join(result.folder, 'report.json'), 'utf8')) as Report;
  expect(report.stages.map((stage) => stage.agents)).toEqual([2, 5, 10]);
  expect(report.facts.durationSeconds).toBe(360);
  expect(report.facts.endReason).toBe('completed');
  const records = await recordsOf(result.folder);
  const agentsOf = (stage: number) => {
    return new Set(records.filter((record) => record.stage === stage).map((record) => record.agent));
  };
  expect(Math.max(...agentsOf(1))).toBe(2);
  expect(Math.max(...agentsOf(2))).toBe(5);
  expect(Math.max(...agentsOf(3))).toBe(10);
  expect(records.some((record) => record.isWarmup)).toBe(true);
  expect(records.every((record) => !record.isWarmup || (record.sentAtMs % 120000) < 20000)).toBe(true);
  expect(report.stages.every((stage) => stage.all.requests > 0)).toBe(true);
});

test('the report holds the run facts and the folder never holds the key', async () => {
  const environment = { LLM_API_KEY: 'secret-key-123' };
  const args = ['--target', 'fake', '--agents', '2', '--stage', '60', '--seed', '9'];
  const result = await virtualRun(args, { environment });
  const { facts } = result.report;
  expect(facts).toMatchObject({
    target: 'fake',
    model: null,
    endpointHost: null,
    commit: 'abc1234',
    hasUncommittedChanges: true,
    startedAt: '2026-11-10T12:00:00.000Z',
  });
  expect(facts.settings.run.seed).toBe(9);
  expect(facts.sources.files).toEqual(['support-ar.txt', 'support-en.txt']);
  expect(facts.sources.English).toEqual({ conversations: 2, agentTurns: 3 });
  expect(facts.sources.Arabic).toEqual({ conversations: 1, agentTurns: 2 });
  expect(result.report.stages[0].all.requests).toBeGreaterThan(0);
  for (const file of await readdir(result.folder)) {
    expect(await readFile(join(result.folder, file), 'utf8')).not.toContain('secret-key-123');
  }
});

test('the request cap sends exactly that many requests, cuts the running ones and says why the run ended', async () => {
  const result = await virtualRun(['--target', 'fake', '--agents', '3', '--stage', '180', '--max-requests', '50']);
  const records = await recordsOf(result.folder);
  expect(result.sentRequests).toBe(50);
  expect(records).toHaveLength(50);
  expect(records.some((record) => record.outcome === 'cut')).toBe(true);
  expect(result.report.facts.endReason).toBe('request cap');
  expect(result.report.facts.durationSeconds).toBeLessThan(180);
  expect(await readFile(join(result.folder, 'report.md'), 'utf8')).toContain('stopped by the request cap');
});

test('an interrupt in the second stage cuts the running requests and reports what ran', async () => {
  const result = await virtualRun(['--target', 'fake', '--agents', '2,4,6', '--stage', '60', '--warmup', '10'], {
    interruptAtMs: 90000,
  });
  const records = await recordsOf(result.folder);
  expect(result.report.facts.endReason).toBe('interrupted');
  expect(result.report.facts.durationSeconds).toBe(90);
  expect(result.report.stages.map((stage) => stage.agents)).toEqual([2, 4]);
  expect(records.every((record) => record.stage <= 2)).toBe(true);
  const cut = records.filter((record) => record.outcome === 'cut');
  expect(cut.every((record) => record.sentAtMs + record.latencyMs === 90000)).toBe(true);
  expect(await readFile(join(result.folder, 'report.md'), 'utf8')).toContain('interrupted from the keyboard');
});

test('the same seed writes the same request record, another seed a different one', async () => {
  const args = ['--target', 'fake', '--agents', '3', '--stage', '60'];
  const first = await virtualRun([...args, '--seed', '7']);
  const second = await virtualRun([...args, '--seed', '7']);
  const other = await virtualRun([...args, '--seed', '8']);
  const firstRecord = await readFile(join(first.folder, 'requests.jsonl'), 'utf8');
  expect(firstRecord.length).toBeGreaterThan(0);
  expect(await readFile(join(second.folder, 'requests.jsonl'), 'utf8')).toBe(firstRecord);
  expect(await readFile(join(other.folder, 'requests.jsonl'), 'utf8')).not.toBe(firstRecord);
});

test('agents 1 and 2 send the same requests whether 2 or 5 agents run', async () => {
  const args = ['--target', 'fake', '--stage', '60', '--seed', '7'];
  const two = await recordsOf((await virtualRun([...args, '--agents', '2'])).folder);
  const five = await recordsOf((await virtualRun([...args, '--agents', '5'])).folder);
  const ofFirstTwo = (records: RequestRecord[]) => records.filter((record) => record.agent <= 2);
  expect(ofFirstTwo(five)).toEqual(ofFirstTwo(two));
});

test('with --trace a trace file holds the text sent', async () => {
  const result = await virtualRun(['--target', 'fake', '--agents', '1', '--stage', '60', '--trace']);
  const files = (await readdir(result.folder)).sort();
  expect(files).toEqual(['report.json', 'report.md', 'requests.jsonl', 'trace.jsonl']);
  expect(await readFile(join(result.folder, 'trace.jsonl'), 'utf8')).toContain('Draft:');
  expect(await readFile(join(result.folder, 'requests.jsonl'), 'utf8')).not.toContain('Draft:');
});

async function unreachableLLMUrl(): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

test('through the real server with an unreachable LLM every request fails with a 502 and has an upstream line', async () => {
  const key = 'test-key-not-real-0123';
  const logged: string[] = [];
  const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
  const result = await runLoad({
    args: [
      '--target', 'server',
      '--agents', '1',
      '--stage', '10',
      '--warmup', '1',
      '--wpm', '400',
      '--chats', await chatsFolder(),
      '--out', out,
    ],
    environment: {
      LLM_API_KEY: key,
      MODEL: 'test-model',
      LLM_URL: await unreachableLLMUrl(),
    },
    clock: createRealClock(),
    driveClock: async () => undefined,
    startedAt: new Date('2026-11-10T12:00:00.000Z'),
    repository: { commit: 'abc1234', hasUncommittedChanges: false },
    log: (line) => logged.push(line),
  });
  const records = await recordsOf(result.folder);
  expect(records.length).toBeGreaterThan(0);
  const notCut = records.filter((record) => record.outcome !== 'cut');
  expect(notCut.length).toBeGreaterThan(0);
  expect(notCut.every((record) => record.outcome === 'failed' && record.reason?.startsWith('HTTP 502'))).toBe(true);
  const { server } = result.report.facts;
  expect(server).toMatchObject({
    ending: 'stopped by the loader',
    requestsWithoutUpstreamLine: 0,
  });
  expect(server?.otherLines[0]).toContain(`http://127.0.0.1:${server?.port}`);
  expect((await readdir(result.folder)).sort()).toEqual(['report.json', 'report.md', 'requests.jsonl']);
  const everything = [logged.join('\n'), ...await Promise.all((await readdir(result.folder)).map((file) => {
    return readFile(join(result.folder, file), 'utf8');
  }))].join('\n');
  expect(everything).not.toContain(key);
  expect(everything).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}|load-[0-9a-f]{8}/);
});

function vllmMetricsText(running: number): string {
  return [
    '# TYPE vllm:num_requests_running gauge',
    `vllm:num_requests_running{engine="0",model_name="m"} ${running}`,
    'vllm:num_requests_waiting{engine="0",model_name="m"} 0',
    'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.1',
    `vllm:prompt_tokens_total{engine="0",model_name="m"} ${running * 1000}`,
    `vllm:generation_tokens_total{engine="0",model_name="m"} ${running * 50}`,
  ].join('\n');
}

function fakeVllmFetch(clock: Clock, calls: { chat: number; probes: number; metrics: number }): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/metrics')) {
      calls.metrics += 1;
      return new Response(vllmMetricsText(calls.chat % 7));
    }
    const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
    const isProbe = body.max_tokens === 1;
    if (isProbe) {
      calls.probes += 1;
    } else {
      calls.chat += 1;
    }
    try {
      await clock.sleep(isProbe ? 150 : 600, init?.signal ?? undefined);
    } catch {
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    const content = isProbe ? 'Hi' : '{"mistakes": []}';
    return Response.json({ choices: [{ message: { content } }] });
  };
}

test('with vLLM metrics and the probe the run writes both files, keeps probes outside the cap and never the key', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const calls = {
    chat: 0,
    probes: 0,
    metrics: 0,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeVllmFetch(clock, calls);
  try {
    const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
    const key = 'vllm-test-key-123456';
    const result = await runLoad({
      args: [
        '--agents', '3',
        '--stage', '180',
        '--vllm-metrics',
        '--probe',
        '--price', '1.43',
        '--max-requests', '50',
        '--chats', await chatsFolder(),
        '--out', out,
      ],
      environment: {
        LLM_API_KEY: key,
        MODEL: 'google/gemma-4-26B-A4B-it',
        LLM_URL: 'http://127.0.0.1:8000/v1/chat/completions',
      },
      clock,
      driveClock: runUntilIdle,
      startedAt: new Date('2026-11-10T12:00:00.000Z'),
      repository: { commit: 'abc1234', hasUncommittedChanges: false },
      log: () => undefined,
    });
    const files = (await readdir(result.folder)).sort();
    expect(files).toEqual(['metrics.jsonl', 'probe.jsonl', 'report.json', 'report.md', 'requests.jsonl']);
    expect(result.sentRequests).toBe(50);
    expect(await recordsOf(result.folder)).toHaveLength(50);
    expect(calls.chat).toBe(50);
    expect(calls.probes).toBeGreaterThan(2);
    const probeLines = (await readFile(join(result.folder, 'probe.jsonl'), 'utf8')).trim().split('\n');
    expect(probeLines.length).toBe(calls.probes);
    expect(JSON.parse(probeLines[0])).toEqual({
      sentAtMs: 0,
      roundTripMs: 150,
      outcome: 'answered',
    });
    const sampleLines = (await readFile(join(result.folder, 'metrics.jsonl'), 'utf8')).trim().split('\n');
    expect(sampleLines.length).toBeGreaterThan(5);
    expect(JSON.parse(sampleLines[1])).toMatchObject({ atMs: 2000, values: { waiting: 0, cacheUsage: 0.1 } });
    expect(result.report.facts.vllm).toEqual({
      metricsUrl: 'http://127.0.0.1:8000/metrics',
      metricsNotFound: ['prefixCacheQueries', 'prefixCacheHits'],
      namesUsed: {
        running: 'vllm:num_requests_running',
        waiting: 'vllm:num_requests_waiting',
        cacheUsage: 'vllm:kv_cache_usage_perc',
        promptTokens: 'vllm:prompt_tokens_total',
        generationTokens: 'vllm:generation_tokens_total',
      },
    });
    for (const file of files) {
      expect(await readFile(join(result.folder, file), 'utf8')).not.toContain(key);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('with vLLM metrics pointed at an endpoint without them the run stops before any request and makes no folder', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Not Found', { status: 404 });
  try {
    const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
    const { clock, runUntilIdle } = createVirtualClock();
    const running = runLoad({
      args: ['--agents', '1', '--vllm-metrics', '--chats', await chatsFolder(), '--out', out],
      environment: {
        LLM_API_KEY: 'k',
        MODEL: 'gemini-3.5-flash-lite',
        LLM_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      },
      clock,
      driveClock: runUntilIdle,
      startedAt: new Date('2026-11-10T12:00:00.000Z'),
      repository: { commit: 'abc1234', hasUncommittedChanges: false },
      log: () => undefined,
    });
    await expect(running).rejects.toThrow(
      'No vLLM metrics at https://generativelanguage.googleapis.com/metrics (HTTP 404). Point --metrics-url',
    );
    expect(await readdir(out)).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const GPU_STAND_IN = [
  'const isFacts = process.argv[1].includes("name,driver_version");',
  'if (isFacts) {',
  '  console.log("NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 580.95.05, 97887");',
  '} else {',
  '  console.log("0, 35, 52000, 97887, 210.5, 55");',
  '  setInterval(() => console.log("0, 40, 52100, 97887, 220.0, 56"), 20);',
  '  process.on("SIGTERM", () => process.exit(0));',
  '}',
].join('\n');

function gpuStandIn(script: string) {
  return (remoteCommand: string) => {
    return { command: process.execPath, args: ['-e', script, remoteCommand] };
  };
}

async function gpuRun(script: string, out: string, withMeter: boolean) {
  const { clock, runUntilIdle } = createVirtualClock();
  let stageReads = 0;
  return runLoad({
    args: [
      '--target', 'fake',
      '--agents', '2,4',
      '--stage', '60',
      '--warmup', '10',
      '--gpu-ssh', 'root@127.0.0.1:2222',
      '--chats', await chatsFolder(),
      '--out', out,
    ],
    environment: {},
    clock,
    driveClock: runUntilIdle,
    startedAt: new Date('2026-11-10T12:00:00.000Z'),
    repository: { commit: 'abc1234', hasUncommittedChanges: false },
    log: () => undefined,
    gpuCommandFor: gpuStandIn(script),
    loopDelayMeter: withMeter
      ? {
        reset: () => undefined,
        read: () => {
          stageReads += 1;
          return { p99Ms: 10 * stageReads, maxMs: 25 * stageReads };
        },
      }
      : undefined,
  });
}

test('with --gpu-ssh the run checks the GPU first, writes gpu.jsonl and names the GPU in its facts', async () => {
  const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
  const result = await gpuRun(GPU_STAND_IN, out, true);
  expect(await readdir(result.folder)).toContain('gpu.jsonl');
  expect(result.report.facts.gpu).toEqual({
    name: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
    driver: '580.95.05',
    gpuCount: 1,
    memoryTotalMiB: 97887,
    sessionEnd: null,
  });
  expect(result.report.facts.stages.map((stage) => stage.loopDelay)).toEqual([
    { p99Ms: 10, maxMs: 25 },
    { p99Ms: 20, maxMs: 50 },
  ]);
  expect(result.report.facts.settings.run.gpuSsh).toEqual({
    user: 'root',
    host: '127.0.0.1',
    port: 2222,
  });
});

test('without a meter the loop delay is absent, and a GPU check that fails leaves no run folder', async () => {
  const out = await mkdtemp(join(tmpdir(), 'load-runs-'));
  const withoutMeter = await gpuRun(GPU_STAND_IN, out, false);
  expect(withoutMeter.report.facts.stages.every((stage) => stage.loopDelay === undefined)).toBe(true);
  const emptyOut = await mkdtemp(join(tmpdir(), 'load-runs-'));
  const refused = 'console.error("ssh: connect to host 127.0.0.1 port 2222: Connection refused"); process.exit(255);';
  await expect(gpuRun(refused, emptyOut, false)).rejects.toThrow(
    '--gpu-ssh: could not read the GPU (ssh: connect to host 127.0.0.1 port 2222: Connection refused)',
  );
  expect(await readdir(emptyOut)).toEqual([]);
});
