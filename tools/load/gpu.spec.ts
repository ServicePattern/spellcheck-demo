import { expect, test } from '@playwright/test';
import { createRealClock } from './clock.ts';
import {
  GPU_FACTS_COMMAND,
  parseGpuFacts,
  parseGpuLine,
  readGpuFacts,
  sshCommandFor,
  startGpuSession,
  type CommandFor,
  type GpuReading,
} from './gpu.ts';

const FACTS_OUTPUT = 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 580.95.05, 97887\n';

test('an nvidia-smi CSV line gives the GPU index and its values', () => {
  expect(parseGpuLine('0, 87, 88123, 97887, 412.50, 71')).toEqual({
    index: 0,
    values: {
      utilizationPercent: 87,
      memoryUsedMiB: 88123,
      memoryTotalMiB: 97887,
      powerWatts: 412.5,
      temperatureCelsius: 71,
    },
  });
});

test('a value of [N/A] is left out and the others are kept', () => {
  expect(parseGpuLine('0, 12, 1024, 97887, [N/A], 40')).toEqual({
    index: 0,
    values: {
      utilizationPercent: 12,
      memoryUsedMiB: 1024,
      memoryTotalMiB: 97887,
      temperatureCelsius: 40,
    },
  });
});

test('a line with the wrong number of fields is a failed reading with its text', () => {
  expect(parseGpuLine('0, 87, 88123')).toEqual({ error: 'unreadable nvidia-smi line: 0, 87, 88123' });
  expect(parseGpuLine('Failed to initialize NVML: Driver/library version mismatch')).toEqual({
    error: 'unreadable nvidia-smi line: Failed to initialize NVML: Driver/library version mismatch',
  });
});

test('the GPU facts give the name, the driver, the count and the total memory', () => {
  expect(parseGpuFacts(FACTS_OUTPUT)).toEqual({
    name: 'NVIDIA RTX PRO 6000 Blackwell Workstation Edition',
    driver: '580.95.05',
    gpuCount: 1,
    memoryTotalMiB: 97887,
  });
  expect(parseGpuFacts('NVIDIA H100, 570.1, 81559\nNVIDIA H100, 570.1, 81559\n')?.memoryTotalMiB).toBe(163118);
  expect(parseGpuFacts('bash: nvidia-smi: command not found\n')).toBeUndefined();
});

test('the ssh command uses batch mode, the vast.ai known hosts, the port and the remote command', () => {
  const address = {
    user: 'root',
    host: '73.97.224.215',
    port: 16559,
  };
  const { command, args } = sshCommandFor(address)(GPU_FACTS_COMMAND);
  expect(command).toBe('ssh');
  expect(args).toContain('BatchMode=yes');
  expect(args).toContain('StrictHostKeyChecking=accept-new');
  expect(args.find((arg) => arg.startsWith('UserKnownHostsFile='))).toMatch(/\.config\/vastai\/known_hosts$/);
  expect(args.slice(-4)).toEqual(['-p', '16559', 'root@73.97.224.215', GPU_FACTS_COMMAND]);
});

function standIn(script: string): CommandFor {
  return () => {
    return { command: process.execPath, args: ['-e', script] };
  };
}

test('the GPU facts are read through the command, and a failure names --gpu-ssh and the error', async () => {
  const facts = await readGpuFacts(standIn(`process.stdout.write(${JSON.stringify(FACTS_OUTPUT)})`));
  expect(facts.name).toBe('NVIDIA RTX PRO 6000 Blackwell Workstation Edition');
  const refused = standIn([
    'console.error("ssh: connect to host 10.0.0.9 port 22: Connection refused");',
    'process.exit(255);',
  ].join(' '));
  await expect(readGpuFacts(refused)).rejects.toThrow(
    '--gpu-ssh: could not read the GPU (ssh: connect to host 10.0.0.9 port 22: Connection refused)',
  );
  const missing: CommandFor = () => {
    return { command: '/no/such/ssh', args: [] };
  };
  await expect(readGpuFacts(missing)).rejects.toThrow('--gpu-ssh: could not read the GPU (spawn /no/such/ssh ENOENT)');
});

const SAMPLING_SCRIPT = `
let count = 0;
const timer = setInterval(() => {
  count += 1;
  console.log('0, ' + (count * 10) + ', ' + (1000 * count) + ', 97887, ' + (count === 2 ? '[N/A]' : '300.5') + ', 60');
  if (count === 3) {
    console.log('garbage');
  }
}, 50);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
`;

test('a session delivers timed readings until it is stopped, and leaves no process', async () => {
  const readings: GpuReading[] = [];
  const session = startGpuSession({
    commandFor: standIn(SAMPLING_SCRIPT),
    clock: createRealClock(),
    onReading: (reading) => readings.push(reading),
  });
  await expect.poll(() => readings.length, { timeout: 5000 }).toBeGreaterThanOrEqual(5);
  await session.stop();
  expect(session.ended()).toBeUndefined();
  expect(readings[0]).toMatchObject({ index: 0, values: { utilizationPercent: 10, powerWatts: 300.5 } });
  expect(readings[1].values?.powerWatts).toBeUndefined();
  expect(readings.find((reading) => reading.error)).toMatchObject({ error: 'unreadable nvidia-smi line: garbage' });
  expect(readings.every((reading) => Number.isInteger(reading.atMs))).toBe(true);
  const countAfterStop = readings.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(readings.length).toBe(countAfterStop);
});

test('a session that ends on its own is recorded with when and why', async () => {
  const dropping = standIn([
    'console.log("0, 50, 1000, 97887, 300, 60");',
    'console.error("Connection to 73.97.224.215 closed by remote host.");',
    'process.exit(255);',
  ].join(' '));
  const readings: GpuReading[] = [];
  const session = startGpuSession({
    commandFor: dropping,
    clock: createRealClock(),
    onReading: (reading) => readings.push(reading),
  });
  await expect.poll(() => session.ended(), { timeout: 5000 }).toBeDefined();
  expect(session.ended()?.reason).toBe('ended with code 255: Connection to 73.97.224.215 closed by remote host.');
  expect(readings).toHaveLength(1);
  await session.stop();
});
