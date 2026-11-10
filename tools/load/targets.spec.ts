import { expect, test } from '@playwright/test';
import {
  buildAutoCompletionMessage,
  buildSpellCheckMessage,
  parseAutoCompletion,
  parseMistakes,
} from '../../src/assistant/llm.ts';
import { createVirtualClock } from './clock.ts';
import { requestContextFor } from './context.ts';
import { parseSettings } from './settings.ts';
import { createLLMTarget, createTarget } from './targets.ts';

const FAKE_RUN = parseSettings(['--agents', '1', '--target', 'fake', '--seed', '3']).run;
const LLM_RUN = parseSettings(['--agents', '1']).run;

function spellCheckMessage(draft: string): string {
  const { llmContext, customDictionary } = requestContextFor('English', []);
  return buildSpellCheckMessage({
    draft,
    caretOffset: draft.length,
    llmContext,
    customDictionary,
  });
}

function autoCompletionMessage(draft: string): string {
  return buildAutoCompletionMessage({
    draft,
    caretOffset: draft.length,
    isCaretOnNewLine: false,
    llmContext: requestContextFor('Arabic', []).llmContext,
  });
}

test('the fake answers each kind with JSON the assistant parses', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const client = (await createTarget(FAKE_RUN, {}, clock, 20000)).clientForAgent(1);
  const draft = 'Thank you. I can see the registartion from March, but the contributions for the last two months have not been paid yet';
  const answers: string[] = [];
  for (let index = 0; index < 40; index++) {
    void client.ask(spellCheckMessage(draft), new AbortController().signal, 'spell-check').then((result) => {
      answers.push('answer' in result ? result.answer : result.error);
    });
  }
  await runUntilIdle();
  for (const answer of answers) {
    const mistakes = parseMistakes(answer);
    expect(mistakes).not.toBeNull();
    for (const mistake of mistakes ?? []) {
      expect(draft).toContain(mistake.word);
    }
  }
  expect(answers.some((answer) => parseMistakes(answer)?.length)).toBe(true);
});

test('the fake completes in the draft language, with some empty completions', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const client = (await createTarget(FAKE_RUN, {}, clock, 20000)).clientForAgent(2);
  const completions: (string | null)[] = [];
  for (let index = 0; index < 200; index++) {
    const message = autoCompletionMessage('وعليكم السلام، دعني أتحقق');
    void client.ask(message, new AbortController().signal, 'auto-completion')
      .then((result) => completions.push('answer' in result ? parseAutoCompletion(result.answer) : null));
  }
  await runUntilIdle();
  expect(completions).not.toContain(null);
  const empty = completions.filter((completion) => completion === '').length;
  expect(empty).toBeGreaterThan(5);
  expect(empty).toBeLessThan(40);
  expect(completions.filter(Boolean).every((completion) => /\p{Script=Arabic}/u.test(completion ?? ''))).toBe(true);
});

test('fake latencies come from the seed, centered on the set median', async () => {
  const latencies = async (seed: number) => {
    const { clock, runUntilIdle } = createVirtualClock();
    const run = { ...FAKE_RUN, seed };
    const client = (await createTarget(run, {}, clock, 20000)).clientForAgent(1);
    const ends: number[] = [];
    for (let index = 0; index < 501; index++) {
      void client.ask(spellCheckMessage('Hello there'), new AbortController().signal, 'spell-check')
        .then(() => ends.push(clock.now()));
    }
    await runUntilIdle();
    return ends;
  };
  const first = await latencies(3);
  expect(await latencies(3)).toEqual(first);
  expect(await latencies(4)).not.toEqual(first);
  const median = [...first].sort((a, b) => a - b)[250];
  expect(median).toBeGreaterThan(540);
  expect(median).toBeLessThan(660);
});

test('an aborted fake request ends at the abort time with an error', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const run = { ...FAKE_RUN, fakeLatencyMs: 60000 };
  const client = (await createTarget(run, {}, clock, 20000)).clientForAgent(1);
  const controller = new AbortController();
  let endedAt = -1;
  let result: unknown;
  void client.ask(spellCheckMessage('Hello there'), controller.signal, 'spell-check').then((answer) => {
    endedAt = clock.now();
    result = answer;
  });
  void clock.sleep(1600).then(() => controller.abort());
  await runUntilIdle();
  expect(endedAt).toBe(1600);
  expect(result).toHaveProperty('error');
});

test('the llm target names every missing setting', () => {
  expect(() => createLLMTarget(LLM_RUN, {})).toThrow('LLM_API_KEY, MODEL (or --model), LLM_URL (or --url)');
  expect(() => createLLMTarget(LLM_RUN, { LLM_API_KEY: 'key', LLM_URL: 'https://example.com/v1' })).toThrow('MODEL');
  const environment = { LLM_API_KEY: 'key', MODEL: 'm' };
  expect(() => createLLMTarget(LLM_RUN, environment)).toThrow(/needs LLM_URL/);
  expect(() => createLLMTarget({ ...LLM_RUN, url: 'not a url' }, environment)).toThrow('LLM_URL is not a URL');
});

test('the llm target takes --model and --url over the environment and names the host, never the key', () => {
  const environment = {
    LLM_API_KEY: 'secret-key',
    MODEL: 'from-env',
    LLM_URL: 'https://env.example.com/v1/chat/completions',
  };
  const run = {
    ...LLM_RUN,
    model: 'gemini-3.5-flash-lite',
    url: 'https://hosted.example.com:8443/v1',
  };
  const target = createLLMTarget(run, environment);
  expect(target.model).toBe('gemini-3.5-flash-lite');
  expect(target.endpointHost).toBe('hosted.example.com:8443');
  expect(JSON.stringify(target)).not.toContain('secret-key');
});
