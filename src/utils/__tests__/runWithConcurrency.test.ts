import test from 'node:test';
import assert from 'node:assert/strict';

import { runWithConcurrency } from '../runWithConcurrency';

/** Yield without a clock: a resolved promise is enough for the pool to hand the
 *  other worker its item. */
async function yieldToPool(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('every item runs, in hand-out order, with at most `limit` in flight', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;

  await runWithConcurrency(items, 2, async (item) => {
    started.push(item);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await yieldToPool();
    inFlight -= 1;
  });

  assert.deepEqual(started.slice().sort((a, b) => a - b), items, 'every item ran');
  assert.deepEqual(started, items, 'work is handed out in the input order');
  // Two workers exist, so the peak is two unless the pool over-subscribes; a
  // seven-item queue is enough that the limit, not the queue, is what bounds it.
  assert.equal(peak, 2, `expected two in flight, saw ${peak}`);
});

test('a limit above the item count simply runs them all', async () => {
  const seen: number[] = [];
  await runWithConcurrency([1, 2], 8, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen, [1, 2]);
});

test('an empty list resolves without running anything', async () => {
  let calls = 0;
  await runWithConcurrency([], 4, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);
});

test('a rejected task rejects the batch', async () => {
  await assert.rejects(
    runWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('item 2 failed');
    }),
    /item 2 failed/,
  );
});
