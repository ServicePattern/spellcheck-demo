import { expect, test } from '@playwright/test';
import { ACCEPT_WORD_KEY, openDemoPage } from './demo-page';

const autoCompletionAfterReceived = (draft: string) => ({ nextSentence: draft.endsWith('received‸') ? ' and will be done.' : '' });

test('Tab accepts the auto-completion as one insert', async ({ page }) => {
  const demo = await openDemoPage(page, autoCompletionAfterReceived);
  await demo.field.click();
  await page.keyboard.type('Your request was received');
  await expect.poll(demo.autoCompletionText).toBe(' and will be done.');
  await page.keyboard.press('Tab');
  await expect(demo.field).toHaveText('Your request was received and will be done.');
  await expect.poll(demo.autoCompletionText).toBe(null);
});

test('typing what the auto-completion says or accepting one word keeps the rest, with no new request', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ nextSentence: ' and will be done.' }));
  await demo.field.click();
  await page.keyboard.type('Your request was received');
  await expect.poll(demo.autoCompletionText).toBe(' and will be done.');

  await page.keyboard.press(ACCEPT_WORD_KEY);
  await expect.poll(demo.autoCompletionText).toBe(' will be done.');
  await page.keyboard.type(' will');
  await expect.poll(demo.autoCompletionText).toBe(' be done.');
  await demo.waitPastDebounce();
  expect(demo.autoCompletionMessages).toHaveLength(1);
});

test('typing something else or Escape hides the auto-completion', async ({ page }) => {
  const demo = await openDemoPage(page, autoCompletionAfterReceived);
  await demo.field.click();
  await page.keyboard.type('Your request was received');
  await expect.poll(demo.autoCompletionText).toBe(' and will be done.');
  await page.keyboard.press('Escape');
  await expect.poll(demo.autoCompletionText).toBe(null);

  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await expect.poll(demo.autoCompletionText).toBe(' and will be done.');
  await page.keyboard.type(' but');
  await expect.poll(demo.autoCompletionText).toBe(null);
});

test('Enter moves the auto-completion to the new line without its leading space, with no new request', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ nextSentence: ' your request has been received.' }));
  await demo.field.click();
  await page.keyboard.type('Dear Sasha,');
  await expect.poll(demo.autoCompletionText).toBe(' your request has been received.');

  await page.keyboard.press('Enter');
  await expect.poll(demo.autoCompletionText).toBe('your request has been received.');
  await page.keyboard.press('Enter');
  await page.keyboard.press(ACCEPT_WORD_KEY);
  await expect.poll(demo.autoCompletionText).toBe(' request has been received.');
  await demo.waitPastDebounce();
  expect(demo.autoCompletionMessages).toHaveLength(1);
});

test('the auto-completion shows at the end of an earlier line, and the model sees the caret there', async ({ page }) => {
  const demo = await openDemoPage(page, (draft) => ({ nextSentence: draft.includes('Sasha,‸') ? ' your request has been received.' : '' }));
  await demo.field.click();
  await page.keyboard.type('Hi Sasha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Best regards, Daniel');
  await expect.poll(() => demo.autoCompletionDrafts().at(-1)).toBe('Hi Sasha\nBest regards, Daniel‸');

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.type(',');
  await expect.poll(demo.autoCompletionText).toBe(' your request has been received.');
  expect(demo.autoCompletionDrafts().at(-1)).toBe('Hi Sasha,‸\nBest regards, Daniel');
  await page.keyboard.press('Tab');
  await expect(demo.field).toHaveText(/^Hi Sasha, your request has been received\.\s*Best regards, Daniel$/);
});

test('no auto-completion is asked for with text after the caret on its line', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ nextSentence: ' never shown' }));
  await demo.field.click();
  await page.keyboard.type('Hi Sasha');
  await expect.poll(() => demo.spellCheckMessages.length).toBe(1);
  expect(demo.autoCompletionMessages).toHaveLength(1);
  await page.keyboard.press('Home');
  await page.keyboard.type('X');
  await expect.poll(() => demo.spellCheckMessages.length).toBe(2);
  expect(demo.spellCheckDrafts()[1]).toBe('X‸Hi Sasha');
  expect(demo.autoCompletionMessages).toHaveLength(1);
});

test('Escape while the debounce runs cancels the request', async ({ page }) => {
  const demo = await openDemoPage(page, autoCompletionAfterReceived);
  await demo.field.click();
  await page.keyboard.type('Your request was received');
  await page.keyboard.press('Escape');
  await demo.waitPastDebounce();
  expect(demo.userMessages).toHaveLength(0);
  await expect.poll(demo.autoCompletionText).toBe(null);
});
