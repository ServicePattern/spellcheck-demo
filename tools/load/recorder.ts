import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LLMRequestKind } from '../../src/assistant/types.ts';
import type { Outcome, RequestEnd } from './agent.ts';
import type { Language } from './chats.ts';

export interface StagePlace {
  stage: number;
  isWarmup: boolean;
}

export interface RequestRecord {
  stage: number;
  agent: number;
  kind: LLMRequestKind;
  language: Language;
  sentAtMs: number;
  outcome: Outcome;
  latencyMs: number;
  allowedMs: number;
  userMessageChars: number;
  answerChars: number;
  isWarmup: boolean;
  mistakeCount?: number;
  isCompletionEmpty?: boolean;
  reason?: string;
}

export interface TraceLine {
  stage: number;
  agent: number;
  kind: LLMRequestKind;
  sentAtMs: number;
  outcome: Outcome;
  userMessage: string;
  rawAnswer: string | null;
}

export interface Recorder {
  records: RequestRecord[];
  record(request: RequestEnd): void;
  close(): Promise<void>;
}

export const REQUESTS_FILE = 'requests.jsonl';
export const TRACE_FILE = 'trace.jsonl';

export function toRequestRecord(request: RequestEnd, place: StagePlace): RequestRecord {
  const record: RequestRecord = {
    stage: place.stage,
    agent: request.agentNumber,
    kind: request.kind,
    language: request.language,
    sentAtMs: Math.round(request.sentAt),
    outcome: request.outcome,
    latencyMs: Math.round(request.latencyMs),
    allowedMs: Math.round(request.allowedMs),
    userMessageChars: request.userMessageChars,
    answerChars: request.answerChars,
    isWarmup: place.isWarmup,
  };
  if (request.mistakeCount !== undefined) {
    record.mistakeCount = request.mistakeCount;
  }
  if (request.isCompletionEmpty !== undefined) {
    record.isCompletionEmpty = request.isCompletionEmpty;
  }
  if (request.reason !== undefined) {
    record.reason = request.reason;
  }
  return record;
}

export function toTraceLine(request: RequestEnd, place: StagePlace): TraceLine {
  return {
    stage: place.stage,
    agent: request.agentNumber,
    kind: request.kind,
    sentAtMs: Math.round(request.sentAt),
    outcome: request.outcome,
    userMessage: request.userMessage,
    rawAnswer: request.rawAnswer ?? null,
  };
}

export function createRecorder(folder: string, withTrace: boolean, placeOf: (sentAt: number) => StagePlace): Recorder {
  const requestsFile = createWriteStream(join(folder, REQUESTS_FILE));
  const traceFile = withTrace ? createWriteStream(join(folder, TRACE_FILE)) : undefined;
  const records: RequestRecord[] = [];
  return {
    records,
    record: (request) => {
      const place = placeOf(request.sentAt);
      const record = toRequestRecord(request, place);
      records.push(record);
      requestsFile.write(`${JSON.stringify(record)}\n`);
      traceFile?.write(`${JSON.stringify(toTraceLine(request, place))}\n`);
    },
    close: async () => {
      await Promise.all([endStream(requestsFile), traceFile && endStream(traceFile)]);
    },
  };
}

export interface JsonLinesFile {
  write(line: unknown): void;
  close(): Promise<void>;
}

export function createJsonLinesFile(path: string): JsonLinesFile {
  const stream = createWriteStream(path);
  return {
    write: (line) => {
      stream.write(`${JSON.stringify(line)}\n`);
    },
    close: () => endStream(stream),
  };
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(resolve);
  });
}
