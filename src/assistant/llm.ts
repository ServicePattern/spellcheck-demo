import type { AssistantContext, LLMRequestKind, LLMResult } from './types';

const LLM_TIMEOUT_MS = 20000;

export interface SpellCheckRequest {
  draft: string;
  caretOffset: number | undefined;
  llmContext: string;
  customDictionary: string[];
}

export interface AutoCompletionRequest {
  draft: string;
  caretOffset: number;
  isCaretOnNewLine: boolean;
  llmContext: string;
}

export interface Mistake {
  word: string;
  surroundingText: string;
  fixes: string[];
  isSure: boolean;
}

export async function spellCheckWithLLM(context: AssistantContext, request: SpellCheckRequest, signal: AbortSignal): Promise<LLMResult<Mistake[]>> {
  const userMessage = buildSpellCheckMessage(request);
  context.debug('llm', 'spell check: request', { draft: request.draft, userMessage });

  const reply = await askWithTimeout(context, userMessage, signal, 'spell-check');
  context.debug('llm', 'spell check: raw reply', reply);

  if ('error' in reply) {
    return reply;
  }
  const mistakes = parseMistakes(reply.answer);
  return mistakes === null ? { error: `unreadable answer: ${reply.answer}` } : { answer: mistakes };
}

export async function autoCompleteWithLLM(context: AssistantContext, request: AutoCompletionRequest, signal: AbortSignal): Promise<LLMResult<string>> {
  const userMessage = buildAutoCompletionMessage(request);
  context.debug('llm', 'auto-completion: request', { draft: request.draft, userMessage });
  const reply = await askWithTimeout(context, userMessage, signal, 'auto-completion');
  context.debug('llm', 'auto-completion: raw reply', reply);
  if ('error' in reply) {
    return reply;
  }
  const autoCompletion = parseAutoCompletion(reply.answer);
  return autoCompletion === null ? { error: `unreadable answer: ${reply.answer}` } : { answer: autoCompletion };
}

async function askWithTimeout(context: AssistantContext, userMessage: string, signal: AbortSignal, requestKind: LLMRequestKind): Promise<LLMResult<string>> {
  const startedAt = performance.now();
  try {
    const reply = await context.options.llmClient.ask(userMessage, AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]), requestKind);
    context.debug('llm', `${'error' in reply ? 'failed' : 'answered'} after ${Math.round(performance.now() - startedAt)} ms`);
    return reply;
  } catch (error) {
    context.debug('llm', `failed after ${Math.round(performance.now() - startedAt)} ms: ${String(error)}`);
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

export function buildSpellCheckMessage(request: SpellCheckRequest): string {
  return [
    request.llmContext,
    bulletList('Custom dictionary', request.customDictionary),
    `Draft:\n${draftWithCaret(request.draft, request.caretOffset)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  function bulletList(title: string, items: string[]): string {
    return items.length ? `${title}:\n${items.map((item) => `- ${item}`).join('\n')}` : '';
  }
}

export function buildAutoCompletionMessage(request: AutoCompletionRequest): string {
  return [
    request.llmContext,
    `Draft:\n${draftWithCaret(request.draft, request.caretOffset)}`,
    `Complete the draft at ‸ with one short sentence.${request.isCaretOnNewLine ? ' The writer is on a new line: start a new sentence with no leading space.' : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function draftWithCaret(draft: string, caretOffset: number | undefined): string {
  if (caretOffset === undefined) {
    return draft;
  }
  return `${draft.slice(0, caretOffset)}‸${draft.slice(caretOffset)}`;
}

export function parseMistakes(reply: string): Mistake[] | null {
  try {
    const parsed = JSON.parse(reply) as { mistakes?: unknown };
    return Array.isArray(parsed.mistakes) ? parsed.mistakes.flatMap(toMistake) : [];
  } catch {
    return null;
  }
}

export function parseAutoCompletion(reply: string): string | null {
  try {
    const parsed = JSON.parse(reply) as { nextSentence?: unknown };
    return typeof parsed.nextSentence === 'string' ? parsed.nextSentence : '';
  } catch {
    return null;
  }
}

function toMistake(raw: Partial<Record<'word' | 'context' | 'fixes' | 'sure', unknown>> | null): Mistake[] {
  if (typeof raw?.word !== 'string' || typeof raw.context !== 'string' || !Array.isArray(raw.fixes)) {
    return [];
  }
  const fixes = raw.fixes.filter((fix): fix is string => typeof fix === 'string');
  if (!fixes.length) {
    return [];
  }
  const mistake: Mistake = {
    word: raw.word,
    surroundingText: raw.context,
    fixes,
    isSure: raw.sure === true,
  };
  return [mistake];
}
