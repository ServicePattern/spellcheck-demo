import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createVirtualClock } from './clock.ts';
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
