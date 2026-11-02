import type { LLMClient, LLMRequestKind } from '../src/assistant/types.ts';
import { AUTO_COMPLETION_EXAMPLES, AUTO_COMPLETION_SYSTEM_MESSAGE } from './auto-completion-prompt.ts';
import { SPELL_CHECK_EXAMPLES, SPELL_CHECK_SYSTEM_MESSAGE } from './spell-check-prompt.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const PROMPTS: Record<LLMRequestKind, ChatMessage[]> = {
  'spell-check': [{ role: 'system', content: SPELL_CHECK_SYSTEM_MESSAGE }, ...SPELL_CHECK_EXAMPLES],
  'auto-completion': [{ role: 'system', content: AUTO_COMPLETION_SYSTEM_MESSAGE }, ...AUTO_COMPLETION_EXAMPLES],
};

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

export function createOpenAIChatClient(apiKey: string, model: string, url: string): LLMClient {
  const llmClient: LLMClient = {
    async ask(userMessage, signal, requestKind) {
      const messages: ChatMessage[] = [...PROMPTS[requestKind], { role: 'user', content: userMessage }];
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages,
          }),
          signal,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as ChatCompletion;
          return { error: `HTTP ${response.status}${body.error?.message ? `: ${body.error.message}` : ''}` };
        }
        const chatCompletion = (await response.json()) as ChatCompletion;
        const content = chatCompletion.choices?.[0]?.message?.content;
        return content ? { answer: content } : { error: 'empty answer' };
      } catch (error) {
        return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
    },
  };
  return llmClient;
}
