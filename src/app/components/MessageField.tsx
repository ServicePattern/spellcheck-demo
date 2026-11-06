import { useEffect, useRef, useState } from 'react';
import { isMac } from '../lib/browser';
import { useAssistant } from '../hooks/useAssistant';
import { useSettings } from '../providers/SettingsProvider';
import { AssistantToggles } from './AssistantToggles';
import { AutoCompletionText } from './AutoCompletionText';
import { DebounceRing } from './DebounceRing';
import { FixesPopover } from './FixesPopover';

export function MessageField() {
  const { appliedSettings: settings } = useSettings();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);
  const { assistant, state } = useAssistant(fieldRef);

  useEffect(() => {
    if (!assistant) {
      return;
    }
    const handleSelectionChange = () => {
      const anchor = document.getSelection()?.anchorNode;
      if (anchor && fieldRef.current?.contains(anchor)) {
        assistant.handleSelectionChange();
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [assistant]);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <div className="mr-auto flex items-center gap-2">
          <h2 className="text-lg font-semibold">Message field</h2>
          <span role="status" className="flex items-center gap-1.5 text-sm text-slate-500">
            {state.requestStatus?.kind === 'debounce' ? (
              <>
                <DebounceRing key={state.requestStatus.startedAt} durationMs={state.requestStatus.durationMs} />
                Waiting for you to stop typing…
              </>
            ) : state.requestStatus?.kind === 'request' ? (
              <>
                <span aria-hidden="true" className="size-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                Checking with the LLM…
              </>
            ) : state.requestStatus?.kind === 'failed' ? (
              <span className="text-red-600">
                <span aria-hidden="true" className="font-bold">✕</span> LLM request failed
              </span>
            ) : null}
          </span>
        </div>
        <AssistantToggles />
      </div>
      <div className="relative">
        <div
          ref={fieldRef}
          contentEditable
          spellCheck={!settings.withSpellCheck}
          dir="auto"
          role="textbox"
          aria-multiline="true"
          aria-label="Agent message"
          aria-placeholder="Type your message to the customer…"
          className={`relative min-h-40 resize-y overflow-auto rounded-lg border border-slate-300 bg-white p-3 text-base shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${isEmpty ? 'before:pointer-events-none before:absolute before:text-slate-400 before:content-[attr(aria-placeholder)]' : ''}`}
          onInput={(e) => {
            setIsEmpty(!e.currentTarget.textContent);
            assistant?.handleInput(e.nativeEvent as InputEvent);
          }}
          onKeyDown={(e) => {
            if (assistant?.handleKeyDown(e.nativeEvent)) {
              e.preventDefault();
              e.nativeEvent.stopImmediatePropagation();
            }
          }}
          onKeyUp={(e) => assistant?.handleKeyUp(e.nativeEvent)}
          onMouseUp={() => assistant?.handleClick()}
          onCompositionStart={() => assistant?.handleCompositionStart()}
          onCompositionEnd={() => assistant?.handleCompositionEnd()}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
        />
      </div>
      <dl className="grid grid-cols-[auto_auto] justify-start items-center gap-x-3 gap-y-1 text-sm text-slate-600 [&_dt]:flex [&_dt]:justify-end [&_dt]:gap-1 [&_kbd]:rounded [&_kbd]:border [&_kbd]:border-b-2 [&_kbd]:border-slate-300 [&_kbd]:bg-slate-50 [&_kbd]:px-1.5 [&_kbd]:font-mono [&_kbd]:text-xs">
        <dt>
          <kbd>Tab</kbd>
        </dt>
        <dd>accept auto-completion</dd>
        <dt>
          <kbd>{isMac ? 'Option' : 'Ctrl'}</kbd>+<kbd>→</kbd>
        </dt>
        <dd>accept one word of auto-completion</dd>
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>hide auto-completion / close fixes popup / cancel LLM request</dd>
        <dt>
          <kbd>↑</kbd>/<kbd>↓</kbd>,<kbd>Enter</kbd>
        </dt>
        <dd>pick a fix in fixes popup</dd>
        <dt>
          <kbd>{isMac ? 'Cmd' : 'Ctrl'}</kbd>+<kbd>Z</kbd>
        </dt>
        <dd>undo auto-correction (the original word is added to ignored words)</dd>
      </dl>
      {assistant && (
        <>
          {state.autoCompletion && isFocused && <AutoCompletionText autoCompletion={state.autoCompletion} fieldRef={fieldRef} />}
          {state.popover && (
            <FixesPopover
              key={`${state.popover.start}:${state.popover.end}`}
              popover={state.popover}
              fieldRef={fieldRef}
              onPick={assistant.pickFix}
              onIgnore={assistant.ignoreWord}
              onAddToDictionary={assistant.addToDictionary}
              onClose={assistant.closePopover}
            />
          )}
        </>
      )}
    </section>
  );
}
