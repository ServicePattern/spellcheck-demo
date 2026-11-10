import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { messageScriptsOf, parseChatSource, readChatSources } from './chats.ts';

test('an English chat is read into customer and agent turns without their labels', () => {
  const source = [
    'Customer: Hi, I applied three weeks ago.',
    'Agent: Hello, let me check the status.',
    'Agent: Your application is being reviewed.',
    '---',
  ].join('\n');
  expect(parseChatSource(source, 'en.txt')).toEqual([{
    language: 'English',
    sourceFile: 'en.txt',
    turns: [
      { speaker: 'Customer', text: 'Hi, I applied three weeks ago.' },
      { speaker: 'Agent', text: 'Hello, let me check the status.' },
      { speaker: 'Agent', text: 'Your application is being reviewed.' },
    ],
  }]);
});

test('an Arabic chat keeps its text exactly, Arabic punctuation included', () => {
  const source = [
    'العميل: السلام عليكم، قدمت طلب معاش التقاعد.',
    'الموظف: وعليكم السلام، دعني أتحقق من حالة طلبك.',
    '---',
  ].join('\n');
  const [conversation] = parseChatSource(source, 'ar.txt');
  expect(conversation.language).toBe('Arabic');
  expect(conversation.turns).toEqual([
    { speaker: 'Customer', text: 'السلام عليكم، قدمت طلب معاش التقاعد.' },
    { speaker: 'Agent', text: 'وعليكم السلام، دعني أتحقق من حالة طلبك.' },
  ]);
});

test('an Arabic turn with Latin text keeps it in place and stays Arabic', () => {
  const source = 'العميل: مرحبا\nالموظف: أرى أن طلبك رقم SI-48213 تم استلامه.\n';
  const [conversation] = parseChatSource(source, 'ar.txt');
  expect(conversation.language).toBe('Arabic');
  expect(conversation.turns[1].text).toBe('أرى أن طلبك رقم SI-48213 تم استلامه.');
});

test('comments and blank lines make no turn and no conversation', () => {
  const source = [
    '# Synthetic chats.',
    '# No real people.',
    '',
    'Customer: Hello.',
    'Agent: Hi.',
    '---',
    '',
    '',
    'Customer: Thanks.',
    'Agent: You are welcome.',
    '---',
    '',
  ].join('\n');
  const conversations = parseChatSource(source, 'en.txt');
  expect(conversations).toHaveLength(2);
  expect(conversations.map((conversation) => conversation.turns.length)).toEqual([2, 2]);
});

test('a conversation with no agent turn is dropped', () => {
  expect(parseChatSource('Customer: Hello?\n---\nCustomer: Anyone?\nAgent: Yes.\n', 'en.txt')).toHaveLength(1);
});

test('an unrecognized line stops reading, naming the file and the line number', () => {
  const source = '# comment\nCustomer: Hello.\nSupervisor: Hi.\n';
  expect(() => parseChatSource(source, 'support-en.txt')).toThrow('support-en.txt, line 3');
});

test('a missing folder or one with no .txt file is named with the --chats flag', async () => {
  await expect(readChatSources('/no/such/folder')).rejects.toThrow(/\/no\/such\/folder.*--chats/);
  const emptyFolder = await mkdtemp(join(tmpdir(), 'chats-'));
  await writeFile(join(emptyFolder, 'notes.md'), 'Agent: Hi.');
  await expect(readChatSources(emptyFolder)).rejects.toThrow(/--chats/);
});

test('a folder is read file by file, in name order', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chats-'));
  await writeFile(join(folder, 'b.txt'), 'العميل: مرحبا\nالموظف: أهلاً\n');
  await writeFile(join(folder, 'a.txt'), 'Customer: Hi\nAgent: Hello\n');
  const sources = await readChatSources(folder);
  expect(sources.files).toEqual(['a.txt', 'b.txt']);
  expect(sources.conversations.map((conversation) => conversation.language)).toEqual(['English', 'Arabic']);
});

test('the script of a later agent turn carries every turn before it, as written', () => {
  const [conversation] = parseChatSource('Customer: A\nAgent: B\nCustomer: C\nAgent: D\n', 'en.txt');
  const scripts = messageScriptsOf(conversation);
  expect(scripts.map((script) => script.message)).toEqual(['B', 'D']);
  expect(scripts[1].conversationSoFar).toEqual([
    { speaker: 'Customer', text: 'A' },
    { speaker: 'Agent', text: 'B' },
    { speaker: 'Customer', text: 'C' },
  ]);
});

test('the first agent turn of an Arabic conversation carries the customer turn alone', () => {
  const [conversation] = parseChatSource('العميل: السلام عليكم\nالموظف: وعليكم السلام\n', 'ar.txt');
  const [script] = messageScriptsOf(conversation);
  expect(script.language).toBe('Arabic');
  expect(script.conversationSoFar).toEqual([{ speaker: 'Customer', text: 'السلام عليكم' }]);
});
