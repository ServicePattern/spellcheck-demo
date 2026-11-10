import { expect, test } from '@playwright/test';
import { buildSpellCheckMessage } from '../../src/assistant/llm.ts';
import type { LLMClient, LLMRequestKind } from '../../src/assistant/types.ts';
import { runAgent, type AgentEvent, type RequestEnd } from './agent.ts';
import type { Conversation, Language, Turn } from './chats.ts';
import { createVirtualClock, type Clock } from './clock.ts';
import { requestContextFor } from './context.ts';
import { parseSettings } from './settings.ts';
import { createTypingModel, type TypingModel } from './typing-model.ts';

const SETTINGS = parseSettings(['--agents', '1']).typing;
const MS_PER_CHARACTER = 100;
const SHORT_PAUSE_MS = 500;

interface Plan {
  language?: Language;
  bursts?: number[];
  pauses?: number[];
  spellCheckOnly?: boolean[];
  accepts?: boolean[];
  typos?: Record<string, string>;
  caret?: number;
}

interface Reply {
  latencyMs: number;
  answer?: string;
  error?: string;
}

type Responder = (kind: LLMRequestKind, userMessage: string) => Reply;

function scriptedModel(plan: Plan): TypingModel {
  const bursts = [...(plan.bursts ?? [])];
  const pauses = [...(plan.pauses ?? [])];
  const spellCheckOnly = [...(plan.spellCheckOnly ?? [])];
  const accepts = [...(plan.accepts ?? [])];
  let conversationIndex = 0;
  return {
    language: plan.language ?? 'English',
    wordsPerMinute: 40,
    typedWords: (message) => message.split(' ').map((word) => plan.typos?.[word] ?? word),
    wordsInNextBurst: () => bursts.shift() ?? 100,
    burstMs: (characterCount) => characterCount * MS_PER_CHARACTER,
    pauseMs: () => pauses.shift() ?? SHORT_PAUSE_MS,
    betweenMessagesMs: () => 20000,
    isSpellCheckOnlyRound: () => spellCheckOnly.shift() ?? false,
    spellCheckOnlyCaret: () => plan.caret ?? 0,
    isCompletionAccepted: () => accepts.shift() ?? false,
    nextConversation: (conversations) => conversations[conversationIndex++ % conversations.length],
  };
}

function scriptedClient(clock: Clock, respond: Responder): LLMClient {
  return {
    async ask(userMessage, signal, requestKind) {
      const reply = respond(requestKind, userMessage);
      try {
        await clock.sleep(reply.latencyMs, signal);
      } catch {
        return { error: 'AbortError: aborted' };
      }
      return reply.error === undefined ? { answer: reply.answer ?? '' } : { error: reply.error };
    },
  };
}

function conversationOf(language: Language, ...texts: string[]): Conversation {
  const turns: Turn[] = texts.map((text, index) => {
    return { speaker: index % 2 === 0 ? 'Customer' : 'Agent', text };
  });
  return {
    language,
    sourceFile: 'test.txt',
    turns,
  };
}

const answerFor: Responder = (kind) => {
  const answer = kind === 'spell-check' ? '{"mistakes": []}' : '{"nextSentence": " for you."}';
  return { latencyMs: 900, answer };
};

interface Run {
  events: AgentEvent[];
  requests: RequestEnd[];
  bursts: { at: number; draft: string }[];
  rounds: number[];
}

async function runFor(
  untilMs: number,
  model: TypingModel,
  conversations: Conversation[],
  respond: Responder = answerFor,
  settings = SETTINGS,
): Promise<Run> {
  const { clock, runUntil, runUntilIdle } = createVirtualClock();
  const stop = new AbortController();
  const events: AgentEvent[] = [];
  const running = runAgent({
    agentNumber: 1,
    model,
    settings,
    conversations,
    clock,
    llmClient: scriptedClient(clock, respond),
    stopSignal: stop.signal,
    takeRequestPermit: () => true,
    onEvent: (event) => events.push(event),
  });
  await runUntil(untilMs);
  stop.abort('stop');
  await runUntilIdle();
  await running;
  return {
    events,
    requests: events.flatMap((event) => event.type === 'request' ? [event.request] : []),
    bursts: events.flatMap((event) => event.type === 'burst' ? [{ at: event.at, draft: event.draft }] : []),
    rounds: events.flatMap((event) => event.type === 'round' ? [event.at] : []),
  };
}

const REGISTRATION = conversationOf(
  'English',
  'My employer registered me.',
  'Thank you. I can see the registration from March.',
);

test('a burst adds whole words and takes its characters at the agent speed', async () => {
  const run = await runFor(1300, scriptedModel({ bursts: [3] }), [REGISTRATION]);
  expect(run.bursts[0]).toEqual({ at: 12 * MS_PER_CHARACTER, draft: 'Thank you. I' });
});

test('a pause shorter than the debounce sends nothing and typing goes on after it', async () => {
  const run = await runFor(4000, scriptedModel({ bursts: [3, 2], pauses: [700] }), [REGISTRATION]);
  expect(run.rounds).toEqual([]);
  expect(run.requests).toEqual([]);
  expect(run.bursts[1]).toEqual({ at: 1200 + 700 + 8 * MS_PER_CHARACTER, draft: 'Thank you. I can see' });
});

test('a typo stays in every later draft of the message', async () => {
  const model = scriptedModel({ bursts: [7, 1, 1], typos: { registration: 'registartion' } });
  const run = await runFor(20000, model, [REGISTRATION]);
  const drafts = run.bursts.map((burst) => burst.draft);
  expect(drafts).toEqual([
    'Thank you. I can see the registartion',
    'Thank you. I can see the registartion from',
    'Thank you. I can see the registartion from March.',
  ]);
});

test('a pause past the debounce sends both requests at the debounce and resumes at the pause end', async () => {
  const run = await runFor(6000, scriptedModel({ bursts: [3, 2], pauses: [2600] }), [REGISTRATION]);
  expect(run.rounds).toEqual([1200 + 1000]);
  expect(run.requests.map((request) => [request.kind, request.sentAt, request.allowedMs])).toEqual([
    ['spell-check', 2200, 1600],
    ['auto-completion', 2200, 1600],
  ]);
  expect(run.bursts[1].at).toBe(1200 + 2600 + 8 * MS_PER_CHARACTER);
});

test('the spell check user message ends with the draft and the caret, after the context and the dictionary', async () => {
  const model = scriptedModel({ bursts: [7], pauses: [2600], typos: { registration: 'registartion' } });
  const run = await runFor(7000, model, [REGISTRATION]);
  const spellCheck = run.requests.find((request) => request.kind === 'spell-check');
  const { llmContext, customDictionary } = requestContextFor('English', REGISTRATION.turns.slice(0, 1));
  expect(spellCheck?.userMessage).toBe(
    `${llmContext}\n\nCustom dictionary:\n- Absher\n- Mudad\n\nDraft:\nThank you. I can see the registartion‸`,
  );
  expect(spellCheck?.userMessage).toBe(buildSpellCheckMessage({
    draft: 'Thank you. I can see the registartion',
    caretOffset: 37,
    llmContext,
    customDictionary,
  }));
});

test('the Arabic auto-completion user message holds the Arabic context, the draft and the instruction', async () => {
  const conversation = conversationOf(
    'Arabic',
    'السلام عليكم، قدمت طلب معاش التقاعد.',
    'وعليكم السلام، دعني أتحقق من حالة طلبك.',
  );
  const model = scriptedModel({
    language: 'Arabic',
    bursts: [4],
    pauses: [2600],
  });
  const run = await runFor(5000, model, [conversation]);
  const autoCompletion = run.requests.find((request) => request.kind === 'auto-completion');
  expect(autoCompletion?.language).toBe('Arabic');
  expect(autoCompletion?.userMessage).toBe([
    requestContextFor('Arabic', conversation.turns.slice(0, 1)).llmContext,
    'Draft:\nوعليكم السلام، دعني أتحقق‸',
    'Complete the draft at ‸ with one short sentence.',
  ].join('\n\n'));
  expect(autoCompletion?.userMessage).toContain('Customer: السلام عليكم، قدمت طلب معاش التقاعد.');
});

test('a spell check only round sends one spell check with the caret inside the draft', async () => {
  const model = scriptedModel({
    bursts: [5],
    pauses: [2600],
    spellCheckOnly: [true],
    caret: 5,
  });
  const run = await runFor(5000, model, [REGISTRATION]);
  expect(run.requests.map((request) => request.kind)).toEqual(['spell-check']);
  expect(run.requests[0].userMessage.endsWith('Draft:\nThank‸ you. I can see')).toBe(true);
});

const TYPO_REGISTRATION = {
  word: 'registartion',
  context: 'the registartion',
  fixes: ['registration'],
};
const TYPO_MARCH = {
  word: 'Mrach',
  context: 'from Mrach',
  fixes: ['March'],
};

test('an answer before the agent resumes is answered, with its latency and the allowed time', async () => {
  const respond: Responder = (kind) => {
    return kind === 'spell-check'
      ? { latencyMs: 850, answer: JSON.stringify({ mistakes: [TYPO_REGISTRATION, TYPO_MARCH] }) }
      : { latencyMs: 900, answer: '{"nextSentence": ""}' };
  };
  const run = await runFor(5000, scriptedModel({ bursts: [3], pauses: [2600] }), [REGISTRATION], respond);
  expect(run.requests[0]).toMatchObject({
    kind: 'spell-check',
    outcome: 'answered',
    latencyMs: 850,
    allowedMs: 1600,
    language: 'English',
    mistakeCount: 2,
  });
  expect(run.requests[1]).toMatchObject({
    kind: 'auto-completion',
    outcome: 'answered',
    latencyMs: 900,
    isCompletionEmpty: true,
  });
});

test('an answer that comes after the agent resumes is aborted at the resume', async () => {
  const run = await runFor(5000, scriptedModel({ bursts: [3], pauses: [2600] }), [REGISTRATION], () => {
    return { latencyMs: 5000, answer: '{"mistakes": []}' };
  });
  expect(run.requests.map((request) => [request.outcome, request.latencyMs])).toEqual([
    ['aborted', 1600],
    ['aborted', 1600],
  ]);
});

test('in one round the spell check can answer in time while the auto-completion is aborted', async () => {
  const respond: Responder = (kind) => {
    return kind === 'spell-check'
      ? { latencyMs: 900, answer: '{"mistakes": []}' }
      : { latencyMs: 3000, answer: '{"nextSentence": " for you."}' };
  };
  const run = await runFor(5000, scriptedModel({ bursts: [3], pauses: [2600] }), [REGISTRATION], respond);
  expect(run.requests.map((request) => [request.kind, request.outcome])).toEqual([
    ['spell-check', 'answered'],
    ['auto-completion', 'aborted'],
  ]);
});

test('a request with no answer within the timeout ends as a timeout in a long pause', async () => {
  const run = await runFor(60000, scriptedModel({ bursts: [3], pauses: [46000] }), [REGISTRATION], () => {
    return { latencyMs: 60000, answer: '{}' };
  });
  expect(run.requests.map((request) => [request.outcome, request.latencyMs, request.allowedMs])).toEqual([
    ['timeout', 20000, 45000],
    ['timeout', 20000, 45000],
  ]);
});

test('an error from the target is failed with its reason, an answer that is not JSON is unreadable', async () => {
  const respond: Responder = (kind) => {
    return kind === 'spell-check'
      ? { latencyMs: 300, error: 'HTTP 429: rate limited' }
      : { latencyMs: 400, answer: 'Sure! Here is a sentence.' };
  };
  const run = await runFor(5000, scriptedModel({ bursts: [3], pauses: [2600] }), [REGISTRATION], respond);
  expect(run.requests[0]).toMatchObject({
    outcome: 'failed',
    reason: 'HTTP 429: rate limited',
    latencyMs: 300,
  });
  expect(run.requests[1]).toMatchObject({
    outcome: 'unreadable',
    latencyMs: 400,
    answerChars: 'Sure! Here is a sentence.'.length,
  });
});

test('requests running when the run stops are cut', async () => {
  const run = await runFor(3000, scriptedModel({ bursts: [3], pauses: [2600] }), [REGISTRATION], () => {
    return { latencyMs: 5000, answer: '{}' };
  });
  expect(run.requests.map((request) => [request.outcome, request.latencyMs])).toEqual([['cut', 800], ['cut', 800]]);
});

const BANK = conversationOf(
  'English',
  'How do I change my bank account?',
  'You can update your bank details online in a few steps.',
);

function completing(nextSentence: string): Responder {
  return (kind) => {
    return kind === 'spell-check'
      ? { latencyMs: 900, answer: '{"mistakes": []}' }
      : { latencyMs: 500, answer: JSON.stringify({ nextSentence }) };
  };
}

test('an accepted completion moves the draft ahead by its words and starts a new pause', async () => {
  const model = scriptedModel({
    bursts: [4],
    pauses: [2600, 2600],
    accepts: [true],
  });
  const run = await runFor(7000, model, [BANK], completing(' bank details online in.'));
  const burstEnd = 19 * MS_PER_CHARACTER;
  expect(run.rounds).toEqual([burstEnd + 1000, burstEnd + 1000 + 500 + 1000]);
  expect(run.requests[0]).toMatchObject({
    kind: 'spell-check',
    outcome: 'aborted',
    allowedMs: 500,
  });
  const secondRound = run.requests.filter((request) => request.sentAt === run.rounds[1]);
  expect(secondRound[0].userMessage.endsWith('Draft:\nYou can update your bank details online in‸')).toBe(true);
});

test('an empty completion is not accepted and typing resumes at the pause end', async () => {
  const model = scriptedModel({
    bursts: [4, 1],
    pauses: [2600],
    accepts: [true],
  });
  const run = await runFor(7000, model, [BANK], completing(''));
  expect(run.rounds).toHaveLength(1);
  expect(run.bursts[1]).toEqual({ at: 1900 + 2600 + 5 * MS_PER_CHARACTER, draft: 'You can update your bank' });
});

test('a completion longer than the rest of the message makes the draft the whole message', async () => {
  const model = scriptedModel({
    bursts: [9],
    pauses: [2600, 2600],
    accepts: [true],
  });
  const run = await runFor(12000, model, [BANK], completing(' a few steps from your profile page.'));
  const lastSpellCheck = run.requests.filter((request) => request.kind === 'spell-check').at(-1);
  expect(lastSpellCheck?.userMessage.endsWith('Draft:\nYou can update your bank details online in a few steps.‸')).toBe(true);
  const message = run.events.find((event) => event.type === 'message');
  expect(message).toBeDefined();
});

test('the next turn starts from an empty draft after the time between messages and carries the conversation so far', async () => {
  const conversation = conversationOf('English', 'A question.', 'First answer.', 'A follow-up.', 'Second answer here.');
  const model = scriptedModel({ bursts: [2, 1], pauses: [500, 2600] });
  const run = await runFor(40000, model, [conversation]);
  const message = run.events.find((event) => event.type === 'message');
  expect(message).toMatchObject({ startedAt: 0, sentAt: 13 * MS_PER_CHARACTER + 500 });
  const secondTurnStart = 13 * MS_PER_CHARACTER + 500 + 20000;
  expect(run.bursts[1]).toEqual({ at: secondTurnStart + 6 * MS_PER_CHARACTER, draft: 'Second' });
  expect(run.requests[0].userMessage).toContain('Conversation:\nCustomer: A question.\nAgent: First answer.\nCustomer: A follow-up.\n\n');
  expect(run.requests[0].userMessage).toContain('Draft:\nSecond‸');
});

test('an Arabic agent takes only Arabic conversations', async () => {
  const conversations = [
    conversationOf('English', 'Hello.', 'Hi, how can I help?'),
    conversationOf('Arabic', 'السلام عليكم', 'وعليكم السلام، كيف أساعدك؟'),
    conversationOf('English', 'Thanks.', 'You are welcome.'),
    conversationOf('Arabic', 'شكراً لك', 'العفو، هل هناك شيء آخر؟'),
  ];
  const model = createTypingModel({ ...SETTINGS, arabicShare: 1 }, 3, 1);
  const run = await runFor(600000, model, conversations, answerFor);
  expect(run.bursts.length).toBeGreaterThan(10);
  expect(run.bursts.every((burst) => /\p{Script=Arabic}/u.test(burst.draft))).toBe(true);
  expect(run.requests.every((request) => request.language === 'Arabic')).toBe(true);
});
