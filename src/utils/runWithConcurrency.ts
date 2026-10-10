/**
 * Run `task` over `items` with at most `limit` in flight, and resolve when every
 * item has been handled.
 *
 * Results are discarded: the task records whatever it produced. That is the shape
 * this is for — overlapping the native round trips an import makes, where the
 * phases inside one item are partly serial (parse, refine, classify) and partly
 * not (a GPU bake), so two in flight let one item's serial phase run during
 * another's.
 *
 * Rejections are the caller's problem: wrap the task body if an item may fail
 * without failing the batch.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await task(items[index]);
      }
    }),
  );
}
