import { expect, type Page } from '@playwright/test';
import type { Mistake } from '../assistant/llm';
import { DEBOUNCE_MS } from './hooks/useAssistant';
import { API_ROUTES } from './lib/llm-client';

export interface FakeAnswer {
  mistakes?: Mistake[];
  nextSentence?: string;
}

export const ACCEPT_WORD_KEY = process.platform === 'darwin' ? 'Alt+ArrowRight' : 'Control+ArrowRight';

const draftOf = (userMessage: string) => userMessage.split("Draft:\n")[1].split('\n\nComplete the draft')[0];

export async function openDemoPage(page: Page, answerFor: (draft: string) => FakeAnswer) {
  const userMessages: string[] = [];
  const spellCheckMessages: string[] = [];
  const autoCompletionMessages: string[] = [];
  await page.route('**/api/**', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { userMessage: string };
    const userMessage = body.userMessage;
    userMessages.push(userMessage);
    (route.request().url().endsWith(API_ROUTES['auto-completion']) ? autoCompletionMessages : spellCheckMessages).push(userMessage);
    const draft = draftOf(userMessage);
    const answer: FakeAnswer = {
      mistakes: [],
      nextSentence: '',
      ...answerFor(draft),
    };
    const llmReply = {
      mistakes: answer.mistakes?.map((mistake) => ({
        word: mistake.word,
        context: mistake.surroundingText,
        fixes: mistake.fixes,
        sure: mistake.isSure,
      })),
      nextSentence: answer.nextSentence,
    };
    await route.fulfill({ json: { answer: JSON.stringify(llmReply) } });
  });
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Agent message' });
  await expect(field).toHaveAttribute('contenteditable', 'true');
  const autoCompletion = page.locator('div.fixed[aria-hidden="true"]');
  return {
    field,
    userMessages,
    autoCompletionText: () => autoCompletion.textContent({ timeout: 1000 }).catch(() => null),
    spellCheckMessages,
    autoCompletionMessages,
    spellCheckDrafts: () => spellCheckMessages.map(draftOf),
    autoCompletionDrafts: () => autoCompletionMessages.map(draftOf),
    waitPastDebounce: () => page.waitForTimeout(DEBOUNCE_MS * 1.5),
  };
}
