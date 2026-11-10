import { execFileSync } from 'node:child_process';
import { resolveExtensionlessImportsAsTs } from '../resolve-extensionless-imports.ts';

resolveExtensionlessImportsAsTs();

const { runLoad } = await import('./load-run.ts');
const { createRealClock } = await import('./clock.ts');

const interrupt = new AbortController();
process.once('SIGINT', () => {
  console.log('\nInterrupted: ending running requests and writing the report.');
  interrupt.abort();
});

try {
  await runLoad({
    args: process.argv.slice(2),
    environment: process.env,
    clock: createRealClock(),
    driveClock: async () => undefined,
    startedAt: new Date(),
    repository: repositoryFacts(),
    interruptSignal: interrupt.signal,
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function repositoryFacts(): { commit: string; hasUncommittedChanges: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    return { commit, hasUncommittedChanges: status.trim() !== '' };
  } catch {
    return { commit: 'unknown', hasUncommittedChanges: false };
  }
}
