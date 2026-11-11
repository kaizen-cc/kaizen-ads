// Runs work a few at a time, never more than `limit` at once, and never starts an item that wouldn't finish before the
// deadline (its estimated cost from now): those are handed back as `skipped`, for the next run to pick up first. Pure
// apart from the clock, which can be passed in for tests. An item that throws is recorded under `failed`, never stops
// the rest.

export type BoundedResult<T, R> = { done: { item: T; result: R }[]; failed: { item: T; error: string }[]; skipped: T[] };

export async function runBounded<T, R>(
  items: T[],
  opts: { limit: number; deadline?: number; cost?: (item: T) => number; now?: () => number },
  fn: (item: T) => Promise<R>,
): Promise<BoundedResult<T, R>> {
  const now = opts.now ?? Date.now;
  const limit = Math.max(1, Math.floor(opts.limit));
  const out: BoundedResult<T, R> = { done: [], failed: [], skipped: [] };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (opts.deadline != null && now() + (opts.cost?.(item) ?? 0) > opts.deadline) {
        out.skipped.push(item);
        continue;
      }
      try {
        out.done.push({ item, result: await fn(item) });
      } catch (e) {
        out.failed.push({ item, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
