import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Clock } from './clock.ts';
import type { SshAddress } from './settings.ts';

export interface GpuValues {
  utilizationPercent?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
}

export interface GpuReading {
  atMs: number;
  index?: number;
  values?: GpuValues;
  error?: string;
}

export interface GpuFacts {
  name: string;
  driver: string;
  gpuCount: number;
  memoryTotalMiB: number;
}

export interface GpuSessionEnd {
  atMs: number;
  reason: string;
}

export interface CommandLine {
  command: string;
  args: string[];
}

export type CommandFor = (remoteCommand: string) => CommandLine;

export interface GpuSession {
  ended(): GpuSessionEnd | undefined;
  stop(): Promise<void>;
}

export interface GpuSessionOptions {
  commandFor: CommandFor;
  clock: Clock;
  onReading: (reading: GpuReading) => void;
}

export const GPU_SAMPLE_COMMAND = 'nvidia-smi '
  + '--query-gpu=index,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu '
  + '--format=csv,noheader,nounits -l 2';
export const GPU_FACTS_COMMAND = 'nvidia-smi '
  + '--query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits';
const FACTS_TIMEOUT_MS = 15000;
const KILL_AFTER_MS = 3000;
const KNOWN_HOSTS = join(homedir(), '.config', 'vastai', 'known_hosts');

export function sshCommandFor(address: SshAddress): CommandFor {
  return (remoteCommand) => {
    mkdirSync(dirname(KNOWN_HOSTS), { recursive: true });
    return {
      command: 'ssh',
      args: [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30',
        '-p', String(address.port),
        `${address.user}@${address.host}`,
        remoteCommand,
      ],
    };
  };
}

export function parseGpuLine(line: string): { index: number; values: GpuValues } | { error: string } {
  const fields = line.split(',').map((field) => field.trim());
  const index = Number(fields[0]);
  if (fields.length !== 6 || !Number.isInteger(index)) {
    return { error: `unreadable nvidia-smi line: ${line.trim()}` };
  }
  const [, utilization, memoryUsed, memoryTotal, power, temperature] = fields.map(numberOrUndefined);
  const values: GpuValues = {};
  assignIfNumber(values, 'utilizationPercent', utilization);
  assignIfNumber(values, 'memoryUsedMiB', memoryUsed);
  assignIfNumber(values, 'memoryTotalMiB', memoryTotal);
  assignIfNumber(values, 'powerWatts', power);
  assignIfNumber(values, 'temperatureCelsius', temperature);
  return { index, values };
}

export function parseGpuFacts(output: string): GpuFacts | undefined {
  const rows = output.split('\n')
    .map((line) => line.split(',').map((field) => field.trim()))
    .filter((row) => row.length === 3);
  const memories = rows.map((row) => Number(row[2]));
  if (!rows.length || memories.some((memory) => !Number.isFinite(memory))) {
    return undefined;
  }
  return {
    name: rows[0][0],
    driver: rows[0][1],
    gpuCount: rows.length,
    memoryTotalMiB: memories.reduce((sum, memory) => sum + memory, 0),
  };
}

export function readGpuFacts(commandFor: CommandFor): Promise<GpuFacts> {
  const { command, args } = commandFor(GPU_FACTS_COMMAND);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    const fail = (why: string) => reject(new Error(`--gpu-ssh: could not read the GPU (${why})`));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(`no answer within ${FACTS_TIMEOUT_MS / 1000} s`);
    }, FACTS_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error.message);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const facts = code === 0 ? parseGpuFacts(output) : undefined;
      if (facts) {
        resolve(facts);
      } else {
        fail(errorOutput.trim() || `exit code ${code}, output: ${output.trim() || '(none)'}`);
      }
    });
  });
}

export function startGpuSession(options: GpuSessionOptions): GpuSession {
  const { command, args } = options.commandFor(GPU_SAMPLE_COMMAND);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const killOnExit = () => child.kill('SIGKILL');
  process.on('exit', killOnExit);
  let sessionEnd: GpuSessionEnd | undefined;
  let isStopping = false;
  let lastErrorLine = '';
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    const atMs = Math.round(options.clock.now());
    const parsed = parseGpuLine(line);
    options.onReading('error' in parsed ? { atMs, error: parsed.error } : { atMs, ...parsed });
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    if (line.trim()) {
      lastErrorLine = line.trim();
    }
  });
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      process.off('exit', killOnExit);
      sessionEnd = {
        atMs: Math.round(options.clock.now()),
        reason: `could not start: ${error.message}`,
      };
      resolve();
    });
    child.once('exit', (code, signal) => {
      process.off('exit', killOnExit);
      if (!isStopping) {
        const how = signal ? `signal ${signal}` : `code ${code}`;
        sessionEnd = {
          atMs: Math.round(options.clock.now()),
          reason: `ended with ${how}${lastErrorLine ? `: ${lastErrorLine}` : ''}`,
        };
      }
      resolve();
    });
  });
  return {
    ended: () => sessionEnd,
    stop: async () => {
      if (sessionEnd || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      isStopping = true;
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
      await exited;
      clearTimeout(killer);
    },
  };
}

function numberOrUndefined(field: string): number | undefined {
  const value = Number(field);
  return field !== '' && Number.isFinite(value) ? value : undefined;
}

function assignIfNumber(values: GpuValues, key: keyof GpuValues, value: number | undefined): void {
  if (value !== undefined) {
    values[key] = value;
  }
}
