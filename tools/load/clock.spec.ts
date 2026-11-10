import { expect, test } from '@playwright/test';
import { createRealClock, createVirtualClock } from './clock.ts';

test('virtual sleeps wake in time order, at their wake time', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const woken: string[] = [];
  const sleepThen = async (ms: number, name: string) => {
    await clock.sleep(ms);
    woken.push(`${name}@${clock.now()}`);
  };
  void sleepThen(300, 'c');
  void sleepThen(100, 'a');
  void sleepThen(200, 'b');
  void sleepThen(100, 'a2');
  await runUntilIdle();
  expect(woken).toEqual(['a@100', 'a2@100', 'b@200', 'c@300']);
});

test('sleeps started while the clock runs wake at their own time', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const woken: number[] = [];
  const chain = async () => {
    await clock.sleep(1000);
    woken.push(clock.now());
    await clock.sleep(1600);
    woken.push(clock.now());
  };
  void chain();
  void clock.sleep(2000).then(() => woken.push(clock.now()));
  await runUntilIdle();
  expect(woken).toEqual([1000, 2000, 2600]);
});

test('running until a time stops there and leaves later sleeps waiting', async () => {
  const { clock, runUntil } = createVirtualClock();
  let isWoken = false;
  void clock.sleep(5000).then(() => {
    isWoken = true;
  });
  await runUntil(4000);
  expect(clock.now()).toBe(4000);
  expect(isWoken).toBe(false);
  await runUntil(5000);
  expect(isWoken).toBe(true);
});

test('an aborted virtual sleep rejects at once, at the abort time', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const controller = new AbortController();
  const ended: string[] = [];
  void clock.sleep(10000, controller.signal).catch(() => ended.push(`aborted@${clock.now()}`));
  void clock.sleep(1600).then(() => controller.abort());
  await runUntilIdle();
  expect(ended).toEqual(['aborted@1600']);
  await expect(clock.sleep(10, controller.signal)).rejects.toBeDefined();
});

test('a virtual hour passes in milliseconds', async () => {
  const { clock, runUntilIdle } = createVirtualClock();
  const tick = async () => {
    while (clock.now() < 3600000) {
      await clock.sleep(1000);
    }
  };
  const startedAt = performance.now();
  void tick();
  await runUntilIdle();
  expect(clock.now()).toBe(3600000);
  expect(performance.now() - startedAt).toBeLessThan(2000);
});

test('the real clock sleeps and an aborted sleep rejects at once', async () => {
  const clock = createRealClock();
  const startedAt = clock.now();
  await clock.sleep(30);
  expect(clock.now() - startedAt).toBeGreaterThanOrEqual(29);
  const controller = new AbortController();
  const sleeping = clock.sleep(60000, controller.signal);
  const abortedAt = clock.now();
  controller.abort();
  await expect(sleeping).rejects.toBeDefined();
  expect(clock.now() - abortedAt).toBeLessThan(50);
});
