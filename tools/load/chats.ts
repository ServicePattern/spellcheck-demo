import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Language = 'English' | 'Arabic';
export type Speaker = 'Customer' | 'Agent';

export interface Turn {
  speaker: Speaker;
  text: string;
}

export interface Conversation {
  language: Language;
  sourceFile: string;
  turns: Turn[];
}

export interface MessageScript {
  language: Language;
  message: string;
  conversationSoFar: Turn[];
}

export interface ChatSources {
  folder: string;
  files: string[];
  conversations: Conversation[];
}

export const DEFAULT_CHATS_FOLDER = '../SpellCheckingPrototype/eval/completion/sources';

interface TurnLabel {
  label: string;
  speaker: Speaker;
  language: Language;
}

const LABELS: TurnLabel[] = [
  {
    label: 'Customer:',
    speaker: 'Customer',
    language: 'English',
  },
  {
    label: 'Agent:',
    speaker: 'Agent',
    language: 'English',
  },
  {
    label: 'العميل:',
    speaker: 'Customer',
    language: 'Arabic',
  },
  {
    label: 'الموظف:',
    speaker: 'Agent',
    language: 'Arabic',
  },
];

export async function readChatSources(folder: string): Promise<ChatSources> {
  const files = (await listTextFiles(folder)).sort();
  const conversations: Conversation[] = [];
  for (const file of files) {
    conversations.push(...parseChatSource(await readFile(join(folder, file), 'utf8'), file));
  }
  return {
    folder,
    files,
    conversations,
  };
}

async function listTextFiles(folder: string): Promise<string[]> {
  const missingMessage = `No chat sources: the folder ${folder} does not exist or holds no .txt file.`
    + ' Set the folder with --chats.';
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    throw new Error(missingMessage);
  }
  const textFiles = names.filter((name) => name.endsWith('.txt'));
  if (!textFiles.length) {
    throw new Error(missingMessage);
  }
  return textFiles;
}

export function parseChatSource(text: string, sourceFile: string): Conversation[] {
  const conversations: Conversation[] = [];
  let turns: Turn[] = [];
  let language: Language = 'English';
  const endConversation = () => {
    if (turns.some((turn) => turn.speaker === 'Agent')) {
      conversations.push({
        language,
        sourceFile,
        turns,
      });
    }
    turns = [];
  };
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    if (line === '---') {
      endConversation();
      return;
    }
    const labelled = LABELS.find(({ label }) => line.startsWith(label));
    if (!labelled) {
      throw new Error(`${sourceFile}, line ${index + 1}: not a turn, a comment or ---`);
    }
    if (!turns.length) {
      language = labelled.language;
    }
    turns.push({ speaker: labelled.speaker, text: line.slice(labelled.label.length).trim() });
  });
  endConversation();
  return conversations;
}

export function messageScriptsOf(conversation: Conversation): MessageScript[] {
  return conversation.turns.flatMap((turn, index) => {
    if (turn.speaker !== 'Agent') {
      return [];
    }
    return [{
      language: conversation.language,
      message: turn.text,
      conversationSoFar: conversation.turns.slice(0, index),
    }];
  });
}
