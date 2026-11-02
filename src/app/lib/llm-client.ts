import type { LLMClient, LLMRequestKind, LLMResult } from '../../assistant';

export const API_ROUTES: Record<LLMRequestKind, string> = {
  'spell-check': 'api/autocorrection',
  'auto-completion': 'api/autocompletion',
};

export const apiLLMClient: LLMClient = {
  async ask(userMessage, signal, requestKind) {
    try {
      const response = await fetch(API_ROUTES[requestKind], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage }),
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as Partial<{ answer: string, error: string }>;
      if (!response.ok) {
        return { error: `HTTP ${response.status}${body.error ? `: ${body.error}` : ''}` };
      }
      const result: LLMResult<string> = body.answer ? { answer: body.answer } : { error: body.error ?? 'empty answer' };
      return result;
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  },
};
