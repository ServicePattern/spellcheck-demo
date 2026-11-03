import { PRESETS, type Preset } from './presets';

export interface AppSettings {
  withSpellCheck: boolean;
  withAutoCorrection: boolean;
  customDictionary: string;
  ignoredWords: string;
  withAutoCompletion: boolean;
  llmContext: string;
}

export function presetSettings(preset: Preset): Pick<AppSettings, 'llmContext' | 'customDictionary' | 'ignoredWords'> {
  return {
    llmContext: preset.llmContext,
    customDictionary: preset.customDictionary.join('\n'),
    ignoredWords: preset.ignoredWords.join('\n'),
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  withSpellCheck: true,
  withAutoCorrection: true,
  withAutoCompletion: true,
  ...presetSettings(PRESETS.English),
};

export const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);
