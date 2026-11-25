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

/**
 * A background poll's JSON, or null if it failed, wasn't ok, or took longer than `ms`. Its timer stops as soon as the
 * answer is read, and a non-ok answer's body is let go, so nothing is aborted after the fact. (AbortSignal.timeout
 * keeps running after the reply arrives and errors an unread body later, which Chrome surfaces as an uncaught
 * "TimeoutError: signal timed out" on whatever page is open.)
 */
export async function pollJson<T>(url: string, init: RequestInit, ms: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
