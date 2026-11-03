import { useSettings } from '../providers/SettingsProvider';
import { Checkbox } from './Checkbox';

export function AssistantToggles() {
  const { settings, updateSettings } = useSettings();
  return (
    <>
      <div className="flex items-center gap-2 rounded-md border border-slate-300 py-0.5 pl-2 pr-0.5">
        <Checkbox label="Spell check" isChecked={settings.withSpellCheck} onChange={(withSpellCheck) => updateSettings({ withSpellCheck })} />
        <div className="rounded bg-slate-100 px-2 py-0.5">
          <Checkbox
            label="Auto-correction"
            isChecked={settings.withAutoCorrection}
            isDisabled={!settings.withSpellCheck}
            onChange={(withAutoCorrection) => updateSettings({ withAutoCorrection })}
          />
        </div>
      </div>
      <Checkbox label="Auto-completion" isChecked={settings.withAutoCompletion} onChange={(withAutoCompletion) => updateSettings({ withAutoCompletion })} />
    </>
  );
}
