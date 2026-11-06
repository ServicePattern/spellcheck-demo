import { spellCheckWithLLM, autoCompleteWithLLM } from './llm';
import type { AssistantContext, AssistantState, KeyPress, TextInput } from './types';
import { autoCompletionFollowsTyping, handleAutoCompletionKey, hideAutoCompletion, hideAutoCompletionIfCaretMoved, showAutoCompletion } from './auto-completion';
import { displayAndAutoCorrectMistakes, noticeRedo, noticeUndo, openPopoverAtCaret, redrawUnderlines } from './spell-check';

const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

function updateRequestStatus(context: AssistantContext) {
  const requestStatus: AssistantState['requestStatus'] = context.typing.runningRequest
    ? { kind: 'request' }
    : context.typing.requestTimer
      ? {
          kind: 'debounce',
          startedAt: context.typing.debounceStartedAt,
          durationMs: context.options.debounceMs,
        }
      : undefined;
  if (JSON.stringify(context.getState().requestStatus) === JSON.stringify(requestStatus)) {
    return;
  }
  context.debug('typing', `request status ${requestStatus?.kind ?? 'off'}`);
  context.setState({ requestStatus });
}

function abortRunningRequest(context: AssistantContext, why: string) {
  if (context.typing.runningRequest) {
    context.debug('typing', `${why}: the running request is aborted`);
    context.typing.runningRequest.abort();
    context.typing.runningRequest = undefined;
  }
}

export function cancelPendingRequest(context: AssistantContext) {
  if (context.typing.requestTimer) {
    context.debug('typing', 'Escape: the debounce timer is cleared');
    clearTimeout(context.typing.requestTimer);
    context.typing.requestTimer = undefined;
  }
  abortRunningRequest(context, 'Escape');
  updateRequestStatus(context);
}

function scheduleLLMRequest(context: AssistantContext) {
  abortRunningRequest(context, 'text changed');
  if (context.options.spellCheckMode === 'off' && !context.options.withAutoCompletion) {
    context.debug('typing', 'spell check and auto-completion are off: no request');
    return;
  }
  if (!context.editorControl.getText().trim()) {
    context.debug('typing', 'the field is empty: no request');
    clearTimeout(context.typing.requestTimer);
    context.typing.requestTimer = undefined;
    context.typing.lastSentText = '';
    updateRequestStatus(context);
    return;
  }
  context.debug('typing', context.typing.requestTimer ? `typing continues: debounce timer restarted (${context.options.debounceMs} ms)` : `debounce timer started: request in ${context.options.debounceMs} ms unless typing continues`);
  clearTimeout(context.typing.requestTimer);
  context.typing.requestTimer = setTimeout(() => void sendLLMRequest(context), context.options.debounceMs);
  context.typing.debounceStartedAt = Date.now();
  updateRequestStatus(context);
}

async function sendLLMRequest(context: AssistantContext) {

  clearTimeout(context.typing.requestTimer);
  context.typing.requestTimer = undefined;

  const sentText = context.editorControl.getText();
  const caret = context.editorControl.getCaret();
  context.typing.lastSentText = sentText;

  if (!sentText.trim()) {
    context.debug('typing', 'debounce over, but the field is empty: nothing to send');
    updateRequestStatus(context);
    return;
  }

  const shouldSpellCheck = context.options.spellCheckMode !== 'off';
  const shouldAskAutoCompletion = canAskAutoCompletion(context, sentText, caret);
  if (!shouldSpellCheck && !shouldAskAutoCompletion) {
    context.debug('typing', 'debounce over, but spell check is off and no auto-completion can be asked for here: nothing to send');
    updateRequestStatus(context);
    return;
  }
  context.debug('typing', `debounce over: sending the draft (${[shouldSpellCheck && 'spell check', shouldAskAutoCompletion && 'auto-completion'].filter(Boolean).join(' + ')})`, {
    draft: sentText,
    caret,
  });

  const request = new AbortController();
  context.typing.runningRequest = request;
  updateRequestStatus(context);

  const expected: ExpectedField = { text: sentText, caret };

  const [isSpellCheckDone, isAutoCompletionDone] = await Promise.all([
    shouldSpellCheck ? askSpellCheck(context, expected, request.signal) : true,
    shouldAskAutoCompletion ? askAutoCompletion(context, expected, request.signal) : true,
  ]);

  if (request.signal.aborted) {
    context.debug('typing', 'answers dropped: the request was aborted');
    return;
  }

  context.typing.runningRequest = undefined;

  if (!isSpellCheckDone || !isAutoCompletionDone) {
    context.debug('typing', `failed: ${[!isSpellCheckDone && 'spell check', !isAutoCompletionDone && 'auto-completion'].filter(Boolean).join(' and ')}`);
    context.setState({ requestStatus: { kind: 'failed' } });
    setTimeout(() => updateRequestStatus(context), 2000);
    return;
  }

  updateRequestStatus(context);
}

interface ExpectedField {
  text: string;
  caret: number | undefined;
}

function isUntouched(context: AssistantContext, expected: ExpectedField): boolean {
  return context.editorControl.getText() === expected.text && context.editorControl.getCaret() === expected.caret;
}

async function askSpellCheck(context: AssistantContext, expected: ExpectedField, signal: AbortSignal): Promise<boolean> {
  const result = await spellCheckWithLLM(
    context,
    {
      draft: expected.text,
      caretOffset: expected.caret,
      llmContext: context.options.llmContext,
      customDictionary: [...context.customDictionary],
    },
    signal,
  );
  if (signal.aborted) {
    return false;
  }
  if ('error' in result) {
    context.debug('spell-check', `request failed: ${result.error}`);
    return false;
  }
  const wasUntouched = isUntouched(context, expected);
  displayAndAutoCorrectMistakes(context, result.answer, expected);
  if (wasUntouched) {
    expected.text = context.editorControl.getText();
    expected.caret = context.editorControl.getCaret();
  }
  return true;
}

async function askAutoCompletion(context: AssistantContext, expected: ExpectedField, signal: AbortSignal): Promise<boolean> {
  const draft = expected.text;
  const caret = expected.caret!;
  const result = await autoCompleteWithLLM(
    context,
    {
      draft,
      caretOffset: caret,
      isCaretOnNewLine: draft.slice(0, caret).endsWith('\n'),
      llmContext: context.options.llmContext,
    },
    signal,
  );
  if (signal.aborted) {
    return false;
  }
  if ('error' in result) {
    context.debug('auto-completion', `request failed: ${result.error}`);
    return false;
  }
  if (!isUntouched(context, expected)) {
    context.debug('typing', 'auto-completion dropped: the text or the caret moved while waiting');
    return true;
  }
  showAutoCompletion(context, result.answer, expected.caret!);
  return true;
}

function canAskAutoCompletion(context: AssistantContext, text: string, caret: number | undefined): boolean {
  // isComposing: an input method (Japanese, Chinese, accent keys) is still building the last word.
  if (!context.options.withAutoCompletion || caret === undefined || context.typing.isComposing) {
    return false;
  }
  const restOfCaretLine = text.slice(caret).split('\n')[0];
  return restOfCaretLine.trim() === '';
}

function openPopover(context: AssistantContext) {
  if (openPopoverAtCaret(context)) {
    hideAutoCompletion(context);
  }
}

export function handleInput(context: AssistantContext, event: TextInput) {
  context.debug('typing', `input: ${event.inputType}${event.data ? ` ${JSON.stringify(event.data)}` : ''}`);
  if (event.inputType === 'historyUndo') {
    noticeUndo(context);
  } else if (event.inputType === 'historyRedo') {
    noticeRedo(context);
  } else {
    context.spellCheck.undoneAutoCorrections = [];
  }
  const isTypingAutoCompletion = autoCompletionFollowsTyping(context, event);
  if (!isTypingAutoCompletion && !context.isAutoCorrecting) {
    hideAutoCompletion(context);
  }
  redrawUnderlines(context);
  if (context.isAutoCorrecting) {
    context.debug('typing', 'auto-correction changed the text, not the user: no new request');
    return;
  }
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
    context.debug('typing', 'undo or redo: no new request');
    return;
  }
  if (isTypingAutoCompletion && context.getState().autoCompletion) {
    context.debug('typing', 'the input followed the auto-completion and some of it is left: no new request');
    return;
  }
  if (
    event.inputType.startsWith('delete') &&
    context.editorControl.getText().trimEnd() === context.typing.lastSentText.trimEnd()
  ) {
    context.debug('typing', 'only trailing spaces were removed since the last request: no new request');
    return;
  }
  scheduleLLMRequest(context);
}

export function handleKeyDown(context: AssistantContext, event: KeyPress): boolean {
  if (event.key === 'Escape') {
    cancelPendingRequest(context);
  }
  return handleAutoCompletionKey(context, event);
}

export function handleKeyUp(context: AssistantContext, event: KeyPress) {
  if (CARET_KEYS.has(event.key) && !event.shiftKey && !context.spellCheck.openPopover) {
    openPopover(context);
  }
}

export function handleClick(context: AssistantContext) {
  setTimeout(() => openPopover(context), 0);
}

export function handleSelectionChange(context: AssistantContext) {
  hideAutoCompletionIfCaretMoved(context);
  redrawUnderlines(context);
}

export function handleCompositionStart(context: AssistantContext) {
  context.typing.isComposing = true;
  hideAutoCompletion(context);
}

export function handleCompositionEnd(context: AssistantContext) {
  context.typing.isComposing = false;
}

export function stopCheckWhileTyping(context: AssistantContext) {
  clearTimeout(context.typing.requestTimer);
  context.typing.runningRequest?.abort();
  hideAutoCompletion(context);
}
