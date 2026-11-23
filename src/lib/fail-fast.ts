/** Rejects if the work takes longer than `ms`, so a poll fails fast instead of holding a function and a DB connection */
export class SlowError extends Error {
  constructor(ms: number) {
    super(`took longer than ${ms}ms`);
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlowError(ms)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** How long the next poll waits: the usual gap, doubling with each failure or slow answer, up to `max` */
export function backoffDelay(base: number, failures: number, max = 5 * 60_000): number {
  return Math.min(max, base * 2 ** Math.min(failures, 8));
}
