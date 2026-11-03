import type { Mistake } from './llm';
import type { PlacedMistake } from './mistake-places';

export type TextDirection = 'ltr' | 'rtl';

export type DebugArea = 'assistant' | 'typing' | 'llm' | 'spell-check' | 'auto-correction' | 'auto-completion';

export interface TextSpan {
  start: number;
  end: number;
}

export interface EditorControl {
  getText(): string;
  getCaret(): number | undefined;
  setCaret(offset: number): void;
  replaceText(start: number, end: number, text: string): void;
  showUnderlines(spans: TextSpan[]): void;
  showAutoCorrectedWords(spans: TextSpan[]): void;
}

export type LLMResult<T> = { answer: T } | { error: string };

export type LLMRequestKind = 'spell-check' | 'auto-completion';

export interface LLMClient {
  ask(userMessage: string, signal: AbortSignal, requestKind: LLMRequestKind): Promise<LLMResult<string>>;
}

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface TextInput {
  inputType: string;
  data: string | null;
}

export interface PopoverState {
  word: string;
  start: number;
  end: number;
  direction: TextDirection;
  fixes: string[];
}

export interface AutoCompletionState {
  text: string;
  caretOffset: number;
  textWhenShown: string;
  direction: TextDirection;
}

export interface AssistantState {
  popover?: PopoverState;
  autoCompletion?: AutoCompletionState;
  requestStatus?:
    | {
        kind: 'throttle';
        startedAt: number;
        durationMs: number;
      }
    | { kind: 'request' }
    | { kind: 'failed' };
}

export const INITIAL_STATE: AssistantState = {};

export interface AssistantEvent {
  area: DebugArea;
  message: string;
  details?: unknown;
}

export interface AssistantOptions {
  llmClient: LLMClient;
  spellCheckMode: 'off' | 'underline' | 'auto-correction';
  withAutoCompletion: boolean;
  isMac: boolean;
  throttleMs: number;
  customDictionary: string[];
  ignoredWords: string[];
  onIgnoredWordsChange: (words: string[]) => void;
  onCustomDictionaryChange: (words: string[]) => void;
  llmContext: string;
  onEvent: (event: AssistantEvent) => void;
}

export interface SpellCheckData {
  mistakes: Mistake[];
  mistakesOnFinishedWords: Mistake[];
  fixByOriginal: Map<string, string>;
  undoneAutoCorrections: { original: string; fix: string }[];
  openPopover?: { place: PlacedMistake; caretBefore?: number };
}

export interface TypingData {
  requestTimer?: ReturnType<typeof setTimeout>;
  runningRequest?: AbortController;
  throttleStartedAt: number;
  lastSentText: string;
  isComposing: boolean;
}

export interface AssistantContext {
  editorControl: EditorControl;
  options: AssistantOptions;
  debug(area: DebugArea, message: string, details?: unknown): void;
  getState(): AssistantState;
  setState(patch: Partial<AssistantState>): void;
  isAutoCorrecting: boolean;
  autoCorrectedFlashTimer?: ReturnType<typeof setTimeout>;
  ignoredWords: string[];
  customDictionary: Set<string>;
  spellCheck: SpellCheckData;
  typing: TypingData;
}
