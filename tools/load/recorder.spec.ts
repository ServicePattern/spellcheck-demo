import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { RequestEnd } from './agent.ts';
import { createRecorder, REQUESTS_FILE, TRACE_FILE } from './recorder.ts';

const DRAFT = 'Thank you. I can see the registartion';
const RAW_ANSWER = '{"mistakes": [{"word": "registartion", "context": "the registartion", "fixes": ["registration"]}]}';

const SPELL_CHECK: RequestEnd = {
  agentNumber: 3,
  kind: 'spell-check',
  language: 'English',
  sentAt: 42200.4,
  outcome: 'answered',
  latencyMs: 850.2,
  allowedMs: 1600,
  userMessageChars: 2900,
  answerChars: RAW_ANSWER.length,
  mistakeCount: 1,
  userMessage: `Conversation:\nCustomer: Hello\n\nDraft:\n${DRAFT}‸`,
  rawAnswer: RAW_ANSWER,
};

const FAILED: RequestEnd = {
  agentNumber: 1,
  kind: 'auto-completion',
  language: 'Arabic',
  sentAt: 12000,
  outcome: 'failed',
  latencyMs: 300,
  allowedMs: 2000,
  userMessageChars: 2400,
  answerChars: 0,
  reason: 'HTTP 429: rate limited',
  userMessage: 'Draft:\nوعليكم السلام‸',
};

async function recordInto(withTrace: boolean): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'recorder-'));
  const recorder = createRecorder(folder, withTrace, (sentAt) => {
    return { stage: sentAt > 30000 ? 2 : 1, isWarmup: sentAt < 20000 };
  });
  recorder.record(SPELL_CHECK);
  recorder.record(FAILED);
  await recorder.close();
  expect(recorder.records).toHaveLength(2);
  return folder;
}

async function linesOf(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

test('a record has every field of the request, with its stage and warm-up', async () => {
  const folder = await recordInto(false);
  const [answered, failed] = await linesOf(join(folder, REQUESTS_FILE));
  expect(answered).toEqual({
    stage: 2,
    agent: 3,
    kind: 'spell-check',
    language: 'English',
    sentAtMs: 42200,
    outcome: 'answered',
    latencyMs: 850,
    allowedMs: 1600,
    userMessageChars: 2900,
    answerChars: RAW_ANSWER.length,
    isWarmup: false,
    mistakeCount: 1,
  });
  expect(failed).toMatchObject({
    stage: 1,
    outcome: 'failed',
    reason: 'HTTP 429: rate limited',
    isWarmup: true,
  });
});

test('without the trace no record holds draft, context or answer text, and no trace file is made', async () => {
  const folder = await recordInto(false);
  const text = await readFile(join(folder, REQUESTS_FILE), 'utf8');
  for (const piece of [DRAFT, 'registartion', 'Customer: Hello', 'وعليكم', '‸']) {
    expect(text).not.toContain(piece);
  }
  expect(await readdir(folder)).toEqual([REQUESTS_FILE]);
});

test('with the trace a separate file holds each user message and raw answer', async () => {
  const folder = await recordInto(true);
  const [answered, failed] = await linesOf(join(folder, TRACE_FILE));
  expect(answered).toMatchObject({
    agent: 3,
    userMessage: SPELL_CHECK.userMessage,
    rawAnswer: RAW_ANSWER,
  });
  expect(failed).toMatchObject({ userMessage: 'Draft:\nوعليكم السلام‸', rawAnswer: null });
  expect(await readFile(join(folder, REQUESTS_FILE), 'utf8')).not.toContain('registartion');
});
