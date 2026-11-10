import { PRESETS, type Preset } from '../../src/app/lib/presets.ts';
import type { Language, Turn } from './chats.ts';

export interface RequestContext {
  llmContext: string;
  customDictionary: string[];
}

const BLOCK_SEPARATOR = '\n\n';
const CONVERSATION_HEADING = 'Conversation:';

export function requestContextFor(language: Language, conversationSoFar: Turn[]): RequestContext {
  return requestContextFromPreset(PRESETS[language], language, conversationSoFar);
}

export function requestContextFromPreset(
  preset: Preset,
  presetName: string,
  conversationSoFar: Turn[],
): RequestContext {
  const blocks = preset.llmContext.split(BLOCK_SEPARATOR);
  const conversationIndex = blocks.findIndex((block) => block.startsWith(CONVERSATION_HEADING));
  if (conversationIndex === -1) {
    throw new Error(`The ${presetName} preset has no ${CONVERSATION_HEADING} block to put the conversation in.`);
  }
  const conversationLines = conversationSoFar.map((turn) => `${turn.speaker}: ${turn.text}`);
  blocks[conversationIndex] = [CONVERSATION_HEADING, ...conversationLines].join('\n');
  return {
    llmContext: blocks.join(BLOCK_SEPARATOR),
    customDictionary: preset.customDictionary,
  };
}
