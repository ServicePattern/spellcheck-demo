import { expect, test } from '@playwright/test';
import type { Mistake } from '../assistant/llm';
import { openDemoPage } from './demo-page';

const sureSen: Mistake = {
  word: 'sen',
  surroundingText: 'will sen the',
  fixes: ['send'],
  isSure: true,
};

const unsureSen: Mistake = {
  word: 'sen',
  surroundingText: 'will sen the',
  fixes: ['send', 'see'],
  isSure: false,
};

const underlinedCount = (page: import('@playwright/test').Page) => {
  return page.evaluate(() => CSS.highlights.get('bp-spell-check-error')?.size ?? 0);
};

test('a sure mistake is auto-corrected, Ctrl/Cmd+Z brings it back as an ignored word, redo un-ignores it, and neither asks again', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ mistakes: [sureSen] }));
  await demo.field.click();
  await page.keyboard.type('I will sen the form');
  await expect(demo.field).toHaveText('I will send the form');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(demo.field).toHaveText('I will sen the form');
  await expect(page.getByLabel('Ignored words')).toHaveValue('pls\nsen');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(demo.field).toHaveText('I will send the form');
  await expect(page.getByLabel('Ignored words')).toHaveValue('pls');
  await demo.waitPastDebounce();
  expect(demo.spellCheckMessages).toHaveLength(1);
});

test('after typing, redo is gone and an undone auto-correction stays ignored', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ mistakes: [sureSen] }));
  await demo.field.click();
  await page.keyboard.type('I will sen the form');
  await expect(demo.field).toHaveText('I will send the form');

  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('s');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(demo.field).toHaveText('I will sens the form');
  await expect(page.getByLabel('Ignored words')).toHaveValue('pls\nsen');
});

test('an unsure mistake is underlined and fixed from the popover, and picking a fix stops ignoring the word', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ mistakes: [unsureSen] }));
  await page.getByLabel('Ignored words').fill('sen');
  await page.waitForTimeout(700);
  await demo.field.click();
  await page.keyboard.type('I will sen the form');
  await expect.poll(() => underlinedCount(page)).toBe(1);

  await page.keyboard.press('Home');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.getByRole('listbox', { name: 'Spell check fixes' })).toBeVisible();
  await page.getByRole('option', { name: 'see' }).click();
  await expect(demo.field).toHaveText('I will see the form');
  await expect(page.getByLabel('Ignored words')).toHaveValue('');
});

test('Ignore and Add to dictionary update the word lists', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({
    mistakes: [
      unsureSen,
      {
        word: 'fomr',
        surroundingText: 'the fomr',
        fixes: ['form'],
        isSure: false,
      },
    ],
  }));
  await demo.field.click();
  await page.keyboard.type('I will sen the fomr');
  await expect.poll(() => underlinedCount(page)).toBe(2);

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('listbox', { name: 'Spell check fixes' })).toBeVisible();
  await page.getByRole('option', { name: 'Add to dictionary' }).click();
  await expect(page.getByLabel('Custom dictionary')).toHaveValue(/\nfomr$/);
  await expect.poll(() => underlinedCount(page)).toBe(1);

  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  await expect(page.getByRole('listbox', { name: 'Spell check fixes' })).toBeVisible();
  await page.getByRole('option', { name: 'Ignore' }).click();
  await expect(page.getByLabel('Ignored words')).toHaveValue('pls\nsen');
});

test('turning spell check off removes the underlines', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({ mistakes: [unsureSen] }));
  await demo.field.click();
  await page.keyboard.type('I will sen the form');
  await expect.poll(() => underlinedCount(page)).toBe(1);
  await page.getByRole('checkbox', { name: 'Spell check' }).uncheck();
  await expect.poll(() => underlinedCount(page)).toBe(0);
});

test('a fix that adds or merges words is underlined and picked as a whole', async ({ page }) => {
  const demo = await openDemoPage(page, () => ({
    mistakes: [
      {
        word: 'documents',
        surroundingText: 'and documents ready',
        fixes: ['documents are'],
        isSure: false,
      },
      {
        word: 'portal',
        surroundingText: 'from portal when',
        fixes: ['the portal'],
        isSure: false,
      },
      {
        word: 'will be',
        surroundingText: 'it will be convenient',
        fixes: ['is'],
        isSure: true,
      },
    ],
  }));
  await demo.field.click();
  await page.keyboard.type('I checked your file and documents ready you can download them from portal when it will be convenient for you');
  await expect(demo.field).toHaveText('I checked your file and documents ready you can download them from portal when it is convenient for you');
  await expect.poll(() => underlinedCount(page)).toBe(2);

  await page.keyboard.press('Home');
  for (let i = 0; i < 'I checked your file and docu'.length; i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.getByRole('listbox', { name: 'Spell check fixes' })).toBeVisible();
  await page.getByRole('option', { name: 'documents are' }).click();
  await expect(demo.field).toHaveText('I checked your file and documents are ready you can download them from portal when it is convenient for you');
});
