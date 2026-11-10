import { createOpenAIChatClient } from '../../server/openai-chat-client.ts';
import type { LLMClient } from '../../src/assistant/types.ts';
import type { Clock } from './clock.ts';
import { createRandomStream } from './random.ts';
import type { RunSettings } from './settings.ts';

export interface Target {
  name: RunSettings['target'];
  model: string | undefined;
  endpointHost: string | undefined;
  clientForAgent(agentNumber: number): LLMClient;
}

export const FAKE_LATENCY_SPREAD = 0.5;
export const FAKE_EMPTY_COMPLETION_SHARE = 0.1;
const FAKE_WORDS_PER_MISTAKE = 15;
const FAKE_COMPLETIONS: Record<'English' | 'Arabic', string[]> = {
  English: [
    ' for you.',
    ' and get back to you shortly.',
    ' within five working days.',
    ' Is there anything else I can help you with?',
  ],
  Arabic: [
    ' لك.',
    ' وسأعود إليك قريباً.',
    ' خلال خمسة أيام عمل.',
    ' هل هناك شيء آخر أستطيع مساعدتك فيه؟',
  ],
};

type Environment = Record<string, string | undefined>;

export function createTarget(run: RunSettings, environment: Environment, clock: Clock): Target {
  return run.target === 'fake' ? createFakeTarget(run, clock) : createLLMTarget(run, environment);
}

export function createLLMTarget(run: RunSettings, environment: Environment): Target {
  const apiKey = environment.LLM_API_KEY ?? '';
  const model = run.model ?? environment.MODEL ?? '';
  const url = run.url ?? environment.LLM_URL ?? '';
  const missing = [
    ...(apiKey ? [] : ['LLM_API_KEY']),
    ...(model ? [] : ['MODEL (or --model)']),
    ...(url ? [] : ['LLM_URL (or --url)']),
  ];
  if (missing.length) {
    throw new Error(`The llm target needs ${missing.join(', ')}: set them in .env or the environment.`);
  }
  if (!URL.canParse(url)) {
    throw new Error(`LLM_URL is not a URL: ${url}`);
  }
  const llmClient = createOpenAIChatClient(apiKey, model, url);
  return {
    name: 'llm',
    model,
    endpointHost: new URL(url).host,
    clientForAgent: () => llmClient,
  };
}

export function createFakeTarget(run: RunSettings, clock: Clock): Target {
  return {
    name: 'fake',
    model: undefined,
    endpointHost: undefined,
    clientForAgent: (agentNumber) => createFakeClient(run.seed, agentNumber, run.fakeLatencyMs, clock),
  };
}

function createFakeClient(seed: number, agentNumber: number, latencyMs: number, clock: Clock): LLMClient {
  const random = createRandomStream(seed, agentNumber, 'fake');
  return {
    async ask(userMessage, signal, requestKind) {
      const latency = random.logNormal(latencyMs, FAKE_LATENCY_SPREAD);
      const answer = requestKind === 'spell-check'
        ? fakeSpellCheckAnswer(draftOf(userMessage), random.next())
        : fakeAutoCompletionAnswer(draftOf(userMessage), random.next());
      try {
        await clock.sleep(latency, signal);
      } catch (error) {
        return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
      return { answer };
    },
  };
}

function draftOf(userMessage: string): string {
  const draftStart = userMessage.lastIndexOf('Draft:\n');
  const draftWithRest = draftStart === -1 ? '' : userMessage.slice(draftStart + 'Draft:\n'.length);
  return draftWithRest.split('\n\n')[0].replace('‸', '');
}

function fakeSpellCheckAnswer(draft: string, draw: number): string {
  const words = draft.split(/\s+/).filter((word) => word.length >= 4);
  const mistakeCount = Math.min(words.length, Math.round(words.length / FAKE_WORDS_PER_MISTAKE + draw * 0.5));
  const mistakes = words.slice(0, mistakeCount).map((word) => {
    return {
      word,
      context: word,
      fixes: [word],
      sure: false,
    };
  });
  return JSON.stringify({ mistakes });
}

function fakeAutoCompletionAnswer(draft: string, draw: number): string {
  if (draw < FAKE_EMPTY_COMPLETION_SHARE) {
    return JSON.stringify({ nextSentence: '' });
  }
  const completions = FAKE_COMPLETIONS[/\p{Script=Arabic}/u.test(draft) ? 'Arabic' : 'English'];
  const index = Math.floor(
    (draw - FAKE_EMPTY_COMPLETION_SHARE) / (1 - FAKE_EMPTY_COMPLETION_SHARE) * completions.length,
  );
  return JSON.stringify({ nextSentence: completions[Math.min(index, completions.length - 1)] });
}
