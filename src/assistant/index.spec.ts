import { expect, test } from '@playwright/test';
import { createAssistant, type AssistantOptions, type EditorControl, type KeyPress, type LLMClient, type TextSpan } from '.';

interface FakeLLMAnswer {
  mistakes: {
    word: string;
    context: string;
    fixes: string[];
    sure: boolean;
  }[];
  nextSentence: string;
}

function createTextEditorControl(text: string) {
  const memory = {
    text,
    caret: text.length,
    underlines: [] as TextSpan[],
  };
  const editorControl: EditorControl = {
    getText: () => memory.text,
    getCaret: () => memory.caret,
    setCaret: (offset) => {
      memory.caret = offset;
    },
    replaceText(start, end, inserted) {
      memory.text = memory.text.slice(0, start) + inserted + memory.text.slice(end);
      memory.caret = start + inserted.length;
    },
    showUnderlines: (spans) => {
      memory.underlines = spans;
    },
    showAutoCorrectedWords: () => {},
  };
  return { editorControl, memory };
}

function startAssistant(editorControl: EditorControl, answer: FakeLLMAnswer, optionsToChange: Partial<AssistantOptions> = {}) {
  const llmClient: LLMClient = {
    ask: async () => ({ answer: JSON.stringify(answer) }),
  };
  const options: AssistantOptions = {
    llmClient,
    spellCheckMode: 'auto-correction',
    withAutoCompletion: true,
    isMac: false,
    throttleMs: 10,
    customDictionary: [],
    ignoredWords: [],
    onIgnoredWordsChange: () => {},
    onCustomDictionaryChange: () => {},
    llmContext: '',
    onEvent: () => {},
    ...optionsToChange,
  };
  return createAssistant(editorControl, options);
}

test('without a DOM, a sure mistake is auto-corrected through the editor control', async () => {
  const { editorControl, memory } = createTextEditorControl('I will sen the form');
  const assistant = startAssistant(editorControl, {
    mistakes: [
      {
        word: 'sen',
        context: 'will sen the',
        fixes: ['send'],
        sure: true,
      },
    ],
    nextSentence: '',
  });
  assistant.handleInput({ inputType: 'insertText', data: 'm' });
  await expect.poll(() => memory.text).toBe('I will send the form');
  expect(memory.caret).toBe('I will send the form'.length);
  assistant.release();
});

test('a sure mistake on an ignored word is underlined but never auto-corrected', async () => {
  const { editorControl, memory } = createTextEditorControl('I will sen the form');
  const assistant = startAssistant(
    editorControl,
    {
      mistakes: [
        {
          word: 'sen',
          context: 'will sen the',
          fixes: ['send'],
          sure: true,
        },
      ],
      nextSentence: '',
    },
    { ignoredWords: ['sen'] },
  );
  assistant.handleInput({ inputType: 'insertText', data: 'm' });
  await expect.poll(() => memory.underlines).toEqual([{ start: 7, end: 10 }]);
  expect(memory.text).toBe('I will sen the form');
  assistant.release();
});

test('without a DOM, the auto-completion shows in the state and Tab inserts it', async () => {
  const { editorControl, memory } = createTextEditorControl('Your request was received');
  const assistant = startAssistant(editorControl, { mistakes: [], nextSentence: ' and will be done.' });
  assistant.handleInput({ inputType: 'insertText', data: 'd' });
  await expect.poll(() => assistant.getState().autoCompletion?.text).toBe(' and will be done.');

  const tab: KeyPress = {
    key: 'Tab',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  expect(assistant.handleKeyDown(tab)).toBe(true);
  expect(memory.text).toBe('Your request was received and will be done.');
  assistant.release();
});

test('the auto-completion stays when a later spell check answer auto-corrects a word before the caret', async () => {
  const { editorControl, memory } = createTextEditorControl('I will sen the form');
  let answerSpellCheck = () => {};
  const llmClient: LLMClient = {
    ask: (userMessage) => {
      return userMessage.includes('Complete the draft at ‸')
        ? Promise.resolve({ answer: JSON.stringify({ nextSentence: ' today.' }) })
        : new Promise((resolve) => {
            answerSpellCheck = () => resolve({
              answer: JSON.stringify({
                mistakes: [
                  {
                    word: 'sen',
                    context: 'will sen the',
                    fixes: ['send'],
                    sure: true,
                  },
                ],
              }),
            });
          });
    },
  };
  const assistant = startAssistant(editorControl, { mistakes: [], nextSentence: '' }, { llmClient });
  const replaceTextSilently = editorControl.replaceText;
  editorControl.replaceText = (start, end, inserted) => {
    replaceTextSilently(start, end, inserted);
    assistant.handleInput({ inputType: 'insertReplacementText', data: inserted });
  };
  assistant.handleInput({ inputType: 'insertText', data: 'm' });
  await expect.poll(() => assistant.getState().autoCompletion?.text).toBe(' today.');

  answerSpellCheck();
  await expect.poll(() => memory.text).toBe('I will send the form');
  assistant.handleSelectionChange();
  expect(assistant.getState().autoCompletion).toMatchObject({ text: ' today.', caretOffset: 'I will send the form'.length });
  assistant.release();
});

test('the auto-completion shows as soon as it arrives, even when the spell check hangs and then fails', async () => {
  const { editorControl } = createTextEditorControl('Your request was received');
  let failSpellCheck = () => {};
  const llmClient: LLMClient = {
    ask: (userMessage) => {
      return userMessage.includes('Complete the draft at ‸')
        ? Promise.resolve({ answer: JSON.stringify({ nextSentence: ' and will be done.' }) })
        : new Promise((resolve) => {
            failSpellCheck = () => resolve({ error: 'timed out' });
          });
    },
  };
  const assistant = startAssistant(editorControl, { mistakes: [], nextSentence: '' }, { llmClient });
  assistant.handleInput({ inputType: 'insertText', data: 'd' });
  await expect.poll(() => assistant.getState().autoCompletion?.text).toBe(' and will be done.');
  expect(assistant.getState().requestStatus).toEqual({ kind: 'request' });

  failSpellCheck();
  await expect.poll(() => assistant.getState().requestStatus).toEqual({ kind: 'failed' });
  expect(assistant.getState().autoCompletion?.text).toBe(' and will be done.');
  assistant.release();
});

test('typing during the throttle does not restart it, and a change during a request sends one more request when it finishes', async () => {
  const { editorControl, memory } = createTextEditorControl('Hello');
  const sentDrafts: string[] = [];
  let answer = () => {};
  const llmClient: LLMClient = {
    ask: (userMessage) => {
      if (userMessage.includes('Complete the draft at ‸')) {
        return Promise.resolve({ answer: JSON.stringify({ nextSentence: '' }) });
      }
      sentDrafts.push(editorControl.getText());
      return new Promise((resolve) => {
        answer = () => resolve({ answer: JSON.stringify({ mistakes: [] }) });
      });
    },
  };
  const assistant = startAssistant(editorControl, { mistakes: [], nextSentence: '' }, { llmClient, throttleMs: 100 });

  assistant.handleInput({ inputType: 'insertText', data: 'o' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  memory.text = 'Hello t';
  assistant.handleInput({ inputType: 'insertText', data: 't' });
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(sentDrafts).toEqual(['Hello t']);

  memory.text = 'Hello th';
  assistant.handleInput({ inputType: 'insertText', data: 'h' });
  memory.text = 'Hello the';
  assistant.handleInput({ inputType: 'insertText', data: 'e' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(sentDrafts).toEqual(['Hello t']);

  answer();
  await expect.poll(() => sentDrafts).toEqual(['Hello t', 'Hello the']);
  answer();
  await expect.poll(() => assistant.getState().requestStatus).toBeUndefined();
  expect(sentDrafts).toEqual(['Hello t', 'Hello the']);
  assistant.release();
});
