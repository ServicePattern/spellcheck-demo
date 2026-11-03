import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createAssistant, INITIAL_STATE, type Assistant, type AssistantOptions } from '../../assistant';
import { isMac } from '../lib/browser';
import { createContentEditableEditorControl } from '../lib/content-editable-editor-control';
import { apiLLMClient } from '../lib/llm-client';
import { lines } from '../lib/settings';
import { useDebugger } from '../providers/DebuggerProvider';
import { useSettings } from '../providers/SettingsProvider';

export const THROTTLE_MS = 1000;

const noSubscription = () => () => {};
const initialState = () => INITIAL_STATE;

export function useAssistant(fieldRef: RefObject<HTMLElement | null>) {
  const { appliedSettings: settings, updateSettings } = useSettings();
  const { onEvent } = useDebugger();
  const options = useMemo(() => {
    const assistantOptions: AssistantOptions = {
      spellCheckMode: !settings.withSpellCheck
        ? 'off'
        : settings.withAutoCorrection
          ? 'auto-correction'
          : 'underline',
      customDictionary: lines(settings.customDictionary),
      ignoredWords: lines(settings.ignoredWords),
      onIgnoredWordsChange: (words) => updateSettings({ ignoredWords: words.join('\n') }),
      onCustomDictionaryChange: (words) => updateSettings({ customDictionary: words.join('\n') }),
      withAutoCompletion: settings.withAutoCompletion,
      isMac,
      throttleMs: THROTTLE_MS,
      llmClient: apiLLMClient,
      llmContext: settings.llmContext,
      onEvent,
    };
    return assistantOptions;
  }, [settings, onEvent, updateSettings]);

  const [assistant, setAssistant] = useState<Assistant>();
  const appliedOptions = useRef(options);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) {
      return;
    }
    const created = createAssistant(createContentEditableEditorControl(field), options);
    appliedOptions.current = options;
    setAssistant(created);
    return () => {
      created.release();
      setAssistant(undefined);
    };
  }, [fieldRef]);

  useEffect(() => {
    if (!assistant || appliedOptions.current === options) {
      return;
    }
    appliedOptions.current = options;
    assistant.updateOptions(options);
  }, [assistant, options]);

  const state = useSyncExternalStore(assistant?.subscribe ?? noSubscription, assistant?.getState ?? initialState);
  return { assistant, state };
}
