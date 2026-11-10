import { parseArgs } from 'node:util';
import { DEFAULT_CHATS_FOLDER } from './chats.ts';

export type Target = 'llm' | 'fake';

export interface TypingSettings {
  debounceMs: number;
  timeoutMs: number;
  wordsPerMinute: number;
  burstWords: number;
  pauseMs: number;
  acceptShare: number;
  spellCheckOnlyShare: number;
  typoEvery: number;
  betweenMessagesMs: number;
  arabicShare: number;
}

export interface RunSettings {
  agentLevels: number[];
  target: Target;
  stageSeconds: number;
  warmupSeconds: number;
  seed: number;
  chatsFolder: string;
  maxRequests: number | undefined;
  outFolder: string;
  withTrace: boolean;
  model: string | undefined;
  url: string | undefined;
  fakeLatencyMs: number;
}

export interface Settings {
  typing: TypingSettings;
  run: RunSettings;
  setFlags: string[];
}

type NumberKind = 'share' | 'positive' | 'positive integer';

interface TypingInput {
  flag: string;
  key: keyof TypingSettings;
  kind: NumberKind;
  defaultValue: number;
}

export const TYPING_INPUTS: TypingInput[] = [
  {
    flag: 'debounce-ms',
    key: 'debounceMs',
    kind: 'positive',
    defaultValue: 1000,
  },
  {
    flag: 'timeout-ms',
    key: 'timeoutMs',
    kind: 'positive',
    defaultValue: 20000,
  },
  {
    flag: 'wpm',
    key: 'wordsPerMinute',
    kind: 'positive',
    defaultValue: 40,
  },
  {
    flag: 'burst-words',
    key: 'burstWords',
    kind: 'positive',
    defaultValue: 3,
  },
  {
    flag: 'pause-ms',
    key: 'pauseMs',
    kind: 'positive',
    defaultValue: 1800,
  },
  {
    flag: 'accept-share',
    key: 'acceptShare',
    kind: 'share',
    defaultValue: 0.26,
  },
  {
    flag: 'spell-check-only-share',
    key: 'spellCheckOnlyShare',
    kind: 'share',
    defaultValue: 0.1,
  },
  {
    flag: 'typo-every',
    key: 'typoEvery',
    kind: 'positive',
    defaultValue: 15,
  },
  {
    flag: 'between-messages-ms',
    key: 'betweenMessagesMs',
    kind: 'positive',
    defaultValue: 20000,
  },
  {
    flag: 'arabic-share',
    key: 'arabicShare',
    kind: 'share',
    defaultValue: 0.5,
  },
];

export const USAGE = `Usage: npm run load -- --agents <levels> [flags]

  --agents 2,5,10          agents per stage, rising (required)
  --target llm|fake        llm (default): LLM_URL, MODEL, LLM_API_KEY; fake: built-in, no network
  --stage 180              seconds per stage
  --warmup 30              seconds at the start of each stage left out of the figures
  --seed 1                 seed of the typing
  --chats <folder>         chat sources (default ${DEFAULT_CHATS_FOLDER})
  --max-requests <n>       stop once this many requests have been sent
  --out tools/load/runs    where run folders are made
  --trace                  also record the text sent and the raw answers
  --model, --url           override MODEL and LLM_URL
  --fake-latency-ms 600    median latency of the fake target

Typing inputs (assumed): ${TYPING_INPUTS.map((input) => `--${input.flag} ${input.defaultValue}`).join(', ')}`;

export function parseSettings(args: string[]): Settings {
  const { values } = parseFlags(args);
  const setFlags = Object.keys(values);
  const typing = Object.fromEntries(TYPING_INPUTS.map((input) => {
    return [input.key, readNumber(values[input.flag], input.flag, input.kind, input.defaultValue)];
  })) as unknown as TypingSettings;
  return {
    typing,
    run: readRunSettings(values),
    setFlags,
  };
}

type FlagValues = Record<string, string | boolean | undefined>;

function parseFlags(args: string[]): { values: FlagValues } {
  const stringFlags = [
    'agents',
    'target',
    'stage',
    'warmup',
    'seed',
    'chats',
    'max-requests',
    'out',
    'model',
    'url',
    'fake-latency-ms',
    ...TYPING_INPUTS.map((input) => input.flag),
  ];
  const options = Object.fromEntries(stringFlags.map((flag) => [flag, { type: 'string' as const }]));
  try {
    return parseArgs({
      args,
      options: { ...options, trace: { type: 'boolean' } },
      strict: true,
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
}

function readRunSettings(values: FlagValues): RunSettings {
  const stageSeconds = readNumber(values.stage, 'stage', 'positive', 180);
  const warmupSeconds = readWarmup(values.warmup, stageSeconds);
  return {
    agentLevels: readAgentLevels(values.agents),
    target: readTarget(values.target),
    stageSeconds,
    warmupSeconds,
    seed: readSeed(values.seed),
    chatsFolder: readText(values.chats) ?? DEFAULT_CHATS_FOLDER,
    maxRequests: values['max-requests'] === undefined
      ? undefined
      : readNumber(values['max-requests'], 'max-requests', 'positive integer', 0),
    outFolder: readText(values.out) ?? 'tools/load/runs',
    withTrace: values.trace === true,
    model: readText(values.model),
    url: readText(values.url),
    fakeLatencyMs: readNumber(values['fake-latency-ms'], 'fake-latency-ms', 'positive', 600),
  };
}

function readAgentLevels(value: string | boolean | undefined): number[] {
  if (typeof value !== 'string') {
    throw new Error(`--agents is required.\n\n${USAGE}`);
  }
  const levels = value.split(',').map((level) => readNumber(level.trim(), 'agents', 'positive integer', 0));
  const isRising = levels.every((level, index) => index === 0 || level > levels[index - 1]);
  if (!isRising) {
    throw new Error(`--agents levels must rise, got ${value}`);
  }
  return levels;
}

function readTarget(value: string | boolean | undefined): Target {
  if (value === undefined || value === 'llm' || value === 'fake') {
    return value ?? 'llm';
  }
  throw new Error(`--target must be llm or fake, got ${String(value)}`);
}

function readWarmup(value: string | boolean | undefined, stageSeconds: number): number {
  const warmupSeconds = value === undefined ? 30 : Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(warmupSeconds) || warmupSeconds < 0) {
    throw new Error(`--warmup must be a number of seconds, 0 or more, got ${String(value)}`);
  }
  if (warmupSeconds >= stageSeconds) {
    throw new Error(`--warmup must be less than --stage (${stageSeconds}), got ${warmupSeconds}`);
  }
  return warmupSeconds;
}

function readSeed(value: string | boolean | undefined): number {
  const seed = value === undefined ? 1 : Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(seed) || seed < 0) {
    throw new Error(`--seed must be a whole number, 0 or more, got ${String(value)}`);
  }
  return seed;
}

function readText(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readNumber(value: string | boolean | undefined, flag: string, kind: NumberKind, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  const number = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  const isValid = kind === 'share'
    ? number >= 0 && number <= 1
    : number > 0 && Number.isFinite(number) && (kind === 'positive' || Number.isInteger(number));
  if (!isValid) {
    throw new Error(`--${flag} must be ${describeKind(kind)}, got ${String(value)}`);
  }
  return number;
}

function describeKind(kind: NumberKind): string {
  if (kind === 'share') {
    return 'a share from 0 to 1';
  }
  return kind === 'positive' ? 'a positive number' : 'a positive whole number';
}
