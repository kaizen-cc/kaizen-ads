// How long each block of a page's data takes, in development only: `[perf] client page · kpis 182ms`. Wrap a
// promise (or a function returning one) and get the same value back; nothing is logged in production.
const dev = process.env.NODE_ENV === "development";

export function timed<T>(scope: string, label: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const p = typeof work === "function" ? work() : work;
  if (!dev) return p;
  const start = performance.now();
  return p.finally(() => console.log(`[perf] ${scope} · ${label} ${Math.round(performance.now() - start)}ms`));
}
