import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DEFAULT_CHATS_FOLDER, messageScriptsOf, readChatSources } from './chats.ts';

test('the real chat sources give 137 English and 173 Arabic agent turns', async () => {
  test.skip(
    !existsSync(DEFAULT_CHATS_FOLDER),
    `The chat sources are not at ${DEFAULT_CHATS_FOLDER}: the sibling project is not checked out next to this one.`,
  );
  const { files, conversations } = await readChatSources(DEFAULT_CHATS_FOLDER);
  expect(files).toEqual(['support-ar.txt', 'support-en.txt']);
  const scriptsOf = (language: string) => conversations
    .filter((conversation) => conversation.language === language)
    .flatMap(messageScriptsOf);
  expect(scriptsOf('English')).toHaveLength(137);
  expect(scriptsOf('Arabic')).toHaveLength(173);
});
