import { expect, test } from '@playwright/test';
import { PRESETS } from '../../src/app/lib/presets.ts';
import { requestContextFor, requestContextFromPreset } from './context.ts';

function blocksOf(llmContext: string): string[] {
  return llmContext.split('\n\n');
}

function withoutConversation(blocks: string[]): string[] {
  return blocks.filter((block) => !block.startsWith('Conversation:'));
}

test('the English context is the English preset with only its conversation replaced', () => {
  const turns = [{ speaker: 'Customer' as const, text: 'My employer says they registered me.' }];
  const { llmContext, customDictionary } = requestContextFor('English', turns);
  const blocks = blocksOf(llmContext);
  expect(blocks).toContain('Conversation:\nCustomer: My employer says they registered me.');
  expect(withoutConversation(blocks)).toEqual(withoutConversation(blocksOf(PRESETS.English.llmContext)));
  expect(blocks.length).toBe(blocksOf(PRESETS.English.llmContext).length);
  expect(llmContext).toContain('Canned responses:');
  expect(llmContext).toContain('Knowledge base:');
  expect(customDictionary).toEqual(PRESETS.English.customDictionary);
});

test('the Arabic context is the Arabic preset with its conversation replaced and its custom dictionary', () => {
  const turns = [{ speaker: 'Customer' as const, text: 'السلام عليكم، قدمت طلب معاش التقاعد.' }];
  const { llmContext, customDictionary } = requestContextFor('Arabic', turns);
  const blocks = blocksOf(llmContext);
  expect(blocks).toContain('Conversation:\nCustomer: السلام عليكم، قدمت طلب معاش التقاعد.');
  expect(withoutConversation(blocks)).toEqual(withoutConversation(blocksOf(PRESETS.Arabic.llmContext)));
  expect(customDictionary).toEqual(['أبشر', 'مدد']);
});

test('the conversation block keeps the order and the speakers of the turns', () => {
  const turns = [
    { speaker: 'Customer' as const, text: 'A' },
    { speaker: 'Agent' as const, text: 'B' },
    { speaker: 'Customer' as const, text: 'C' },
  ];
  expect(requestContextFor('English', turns).llmContext).toContain('Conversation:\nCustomer: A\nAgent: B\nCustomer: C\n\n');
});

test('a preset with no conversation block stops with its name', () => {
  const preset = {
    llmContext: 'Agent:\n- Name: Test\n\nCase fields:\n- Case number: 1',
    customDictionary: [],
    ignoredWords: [],
  };
  expect(() => requestContextFromPreset(preset, 'Arabic', [])).toThrow('Arabic preset');
});
