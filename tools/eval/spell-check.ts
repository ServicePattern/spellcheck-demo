import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { parseArgs } from 'node:util';
import type { Mistake } from '../../src/assistant/llm.ts';

resolveExtensionlessImportsAsTs();

const { buildSpellCheckMessage, parseMistakes } = await import('../../src/assistant/llm.ts');
const { PRESETS } = await import('../../src/app/lib/presets.ts');
const { createOpenAIChatClient } = await import('../../server/openai-chat-client.ts');

interface ExpectedMistake {
  word: string;
  fixes: string[];
  sure?: boolean;
}

interface EvalCase {
  name: string;
  preset: string;
  draft: string;
  caretOffset?: number;
  expected: ExpectedMistake[];
}

interface RunResult {
  caseName: string;
  ms: number;
  error?: string;
  rawAnswer?: string;
  missed: string[];
  extra: Mistake[];
  wrongFix: Mistake[];
  wrongSure: Mistake[];
  foundCount: number;
  expectedCount: number;
  reportedCount: number;
}

const LLM_TIMEOUT_MS = 20000;

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    model: { type: 'string' },
    url: { type: 'string' },
    filter: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const apiKey = process.env.LLM_API_KEY ?? '';
const model = args.model ?? process.env.MODEL ?? '';
const url = args.url ?? process.env.LLM_URL ?? '';
if (!apiKey || !model || !url) {
  console.error('Set LLM_API_KEY, MODEL and LLM_URL in .env or the environment (or pass --model and --url).');
  process.exit(1);
}
const llmClient = createOpenAIChatClient(apiKey, model, url);
const runs = Number(args.runs);
const concurrency = Number(args.concurrency);

const allCases = JSON.parse(await readFile(new URL('./spell-check-cases.json', import.meta.url), 'utf8')) as EvalCase[];
const cases = allCases.filter((evalCase) => !args.filter || evalCase.name.includes(args.filter));
console.log(`${cases.length} cases × ${runs} runs, model ${model}, url ${url}\n`);

const jobs = cases.flatMap((evalCase) => Array.from({ length: runs }, () => () => runCase(evalCase)));
const results = await runWithLimit(jobs, concurrency, (done) => {
  process.stderr.write(`\r${done}/${jobs.length} runs`);
});
process.stderr.write('\r'.padEnd(30) + '\r');
printResults(cases, results);

async function runCase(evalCase: EvalCase): Promise<RunResult> {
  const preset = PRESETS[evalCase.preset];
  if (!preset) {
    throw new Error(`${evalCase.name}: unknown preset ${evalCase.preset}`);
  }
  const userMessage = buildSpellCheckMessage({
    draft: evalCase.draft,
    caretOffset: evalCase.caretOffset ?? evalCase.draft.length,
    llmContext: preset.llmContext,
    customDictionary: preset.customDictionary,
  });
  const startedAt = performance.now();
  const reply = await llmClient.ask(userMessage, AbortSignal.timeout(LLM_TIMEOUT_MS), 'spell-check');
  const ms = Math.round(performance.now() - startedAt);
  const empty: RunResult = {
    caseName: evalCase.name,
    ms,
    missed: evalCase.expected.map((expected) => expected.word),
    extra: [],
    wrongFix: [],
    wrongSure: [],
    foundCount: 0,
    expectedCount: evalCase.expected.length,
    reportedCount: 0,
  };
  if ('error' in reply) {
    return { ...empty, error: reply.error };
  }
  const mistakes = parseMistakes(reply.answer);
  if (mistakes === null) {
    return { ...empty, error: 'unreadable answer', rawAnswer: reply.answer };
  }
  return { ...score(evalCase, mistakes), caseName: evalCase.name, ms, rawAnswer: reply.answer };
}

function score(evalCase: EvalCase, mistakes: Mistake[]): Omit<RunResult, 'caseName' | 'ms'> {
  const remaining = [...evalCase.expected];
  const extra: Mistake[] = [];
  const wrongFix: Mistake[] = [];
  const wrongSure: Mistake[] = [];
  for (const mistake of mistakes) {
    const index = remaining.findIndex((expected) => sameWord(expected.word, mistake.word));
    if (index === -1) {
      extra.push(mistake);
      continue;
    }
    const [expected] = remaining.splice(index, 1);
    if (!mistake.fixes.some((fix) => expected.fixes.some((wanted) => sameWord(wanted, fix)))) {
      wrongFix.push(mistake);
    }
    if (expected.sure !== undefined && expected.sure !== mistake.isSure) {
      wrongSure.push(mistake);
    }
  }
  return {
    missed: remaining.map((expected) => expected.word),
    extra,
    wrongFix,
    wrongSure,
    foundCount: evalCase.expected.length - remaining.length,
    expectedCount: evalCase.expected.length,
    reportedCount: mistakes.length,
  };
}

function sameWord(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isPass(result: RunResult): boolean {
  return (
    !result.error &&
    !result.missed.length &&
    !result.extra.length &&
    !result.wrongFix.length &&
    !result.wrongSure.length
  );
}

function isDangerous(mistake: Mistake): boolean {
  return mistake.isSure;
}

function printResults(evalCases: EvalCase[], allResults: RunResult[]): void {
  for (const evalCase of evalCases) {
    const caseResults = allResults.filter((result) => result.caseName === evalCase.name);
    const marks = caseResults.map((result) => (result.error ? '!' : isPass(result) ? '✓' : '✗')).join('');
    console.log(`${marks.padEnd(runs)}  ${evalCase.name}`);
    for (const result of caseResults) {
      if (isPass(result)) {
        continue;
      }
      const notes = [
        result.error && `error: ${result.error}`,
        result.missed.length && `missed: ${result.missed.join(', ')}`,
        result.extra.length && `extra: ${result.extra.map(describe).join(', ')}`,
        result.wrongFix.length && `wrong fix: ${result.wrongFix.map(describe).join(', ')}`,
        result.wrongSure.length && `wrong sure: ${result.wrongSure.map(describe).join(', ')}`,
      ].filter(Boolean);
      console.log(`      ${notes.join('; ')}`);
      if (args.verbose && result.rawAnswer) {
        console.log(`      raw: ${result.rawAnswer}`);
      }
    }
  }

  const answered = allResults.filter((result) => !result.error);
  const expectedTotal = sum(answered, (result) => result.expectedCount);
  const foundTotal = sum(answered, (result) => result.foundCount);
  const reportedTotal = sum(answered, (result) => result.reportedCount);
  const wrongFixTotal = sum(answered, (result) => result.wrongFix.length);
  const dangerous = answered.flatMap((result) => [...result.extra, ...result.wrongFix].filter(isDangerous)).length;
  const latencies = allResults.map((result) => result.ms).sort((a, b) => a - b);
  const percentile = (p: number) => {
    const index = Math.min(
      latencies.length - 1,
      Math.floor((latencies.length * p) / 100)
    );
    return latencies[index] ?? 0;
  };
  const passCount = allResults.filter(isPass).length;

  console.log('');
  console.log(`pass rate       ${percent(passCount, allResults.length)}  (${passCount}/${allResults.length} runs)`);
  console.log(`recall          ${percent(foundTotal, expectedTotal)}  (expected mistakes found)`);
  console.log(`precision       ${percent(foundTotal, reportedTotal)}  (reports that were expected)`);
  console.log(`fix accuracy    ${percent(foundTotal - wrongFixTotal, foundTotal)}  (found mistakes with an accepted fix)`);
  console.log(`wrong sure      ${sum(answered, (result) => result.wrongSure.length)}`);
  console.log(`dangerous       ${dangerous}  (sure: true on a wrong report or a wrong fix)`);
  console.log(`errors          ${allResults.length - answered.length}`);
  console.log(`latency ms      p50 ${percentile(50)}, p95 ${percentile(95)}, max ${latencies.at(-1) ?? 0}`);
}

function describe(mistake: Mistake): string {
  return `${mistake.word} → ${mistake.fixes.join('/')}${mistake.isSure ? ' (sure)' : ''}`;
}

function percent(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : 'n/a';
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

async function runWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onProgress: (done: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
      onProgress(++done);
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveExtensionlessImportsAsTs(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const isRelativeWithoutExtension = specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier);
        if (isRelativeWithoutExtension) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });
}
