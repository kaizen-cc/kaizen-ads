import "server-only";
import { retryDecision } from "../klaviyo/core";
import { ProviderError, redactSecret } from "./core";

// One GET against a provider's API, for Brevo and Customer.io: waits and retries on 429 (Retry-After) and 5xx with the
// same backoff Klaviyo's calls use, keeps a small gap between calls per key, and never lets the key into an error.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastCall = new Map<string, number>();

export async function providerGet(o: { base: string; path: string; headers: Record<string, string>; key: string; name: string; errorText: (status: number, json: unknown) => string; gapMs?: number }): Promise<unknown> {
  const url = o.path.startsWith("http") ? o.path : `${o.base}${o.path}`;
  // Only the provider's own host is ever called
  if (!url.startsWith(o.base)) throw new ProviderError(`Refused a link outside ${o.name}'s API.`, null);
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(o.key) ?? 0) + (o.gapMs ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(o.key, Date.now());
    let status: number | null = null;
    let retryAfter: string | null = null;
    let json: unknown = null;
    try {
      const res = await fetch(url, { method: "GET", headers: { accept: "application/json", ...o.headers }, cache: "no-store", signal: AbortSignal.timeout(45_000) });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      json = await res.json().catch(() => null);
      if (res.ok) return json;
    } catch (e) {
      if (attempt >= 3) throw new ProviderError(redactSecret(`${o.name} didn't answer: ${e instanceof Error ? e.message : String(e)}`, o.key), null);
    }
    const next = retryDecision({ status, retryAfter, attempt, maxWaitMs: 30_000 });
    if (!next.retry) throw new ProviderError(redactSecret(status ? o.errorText(status, json) : `${o.name} didn't answer.`, o.key), status);
    await sleep(next.waitMs);
  }
}
