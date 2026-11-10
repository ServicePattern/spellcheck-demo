export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface VirtualClock {
  clock: Clock;
  runUntil(timeMs: number): Promise<void>;
  runUntilIdle(): Promise<void>;
}

interface Sleeper {
  wakeAt: number;
  order: number;
  wake: () => void;
}

export function createRealClock(): Clock {
  const startedAt = performance.now();
  return {
    now: () => performance.now() - startedAt,
    sleep: (ms, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, Math.max(0, ms));
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

export function createVirtualClock(): VirtualClock {
  let now = 0;
  let nextOrder = 0;
  const sleepers: Sleeper[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          sleepers.splice(sleepers.indexOf(sleeper), 1);
          reject(signal?.reason);
        };
        const sleeper: Sleeper = {
          wakeAt: now + Math.max(0, ms),
          order: nextOrder++,
          wake: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        sleepers.push(sleeper);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };

  async function runUntil(timeMs: number): Promise<void> {
    await settle();
    while (true) {
      const earliest = earliestSleeper();
      if (!earliest || earliest.wakeAt > timeMs) {
        break;
      }
      wakeSleeper(earliest);
      await settle();
    }
    now = Math.max(now, timeMs);
    await settle();
  }

  async function runUntilIdle(): Promise<void> {
    await settle();
    while (true) {
      const earliest = earliestSleeper();
      if (!earliest) {
        break;
      }
      wakeSleeper(earliest);
      await settle();
    }
  }

  function earliestSleeper(): Sleeper | undefined {
    return sleepers.reduce<Sleeper | undefined>((earliest, sleeper) => {
      const isEarlier = !earliest || sleeper.wakeAt < earliest.wakeAt
        || (sleeper.wakeAt === earliest.wakeAt && sleeper.order < earliest.order);
      return isEarlier ? sleeper : earliest;
    }, undefined);
  }

  function wakeSleeper(sleeper: Sleeper): void {
    sleepers.splice(sleepers.indexOf(sleeper), 1);
    now = sleeper.wakeAt;
    sleeper.wake();
  }

  return {
    clock,
    runUntil,
    runUntilIdle,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
