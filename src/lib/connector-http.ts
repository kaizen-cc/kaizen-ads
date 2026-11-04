import "server-only";

// Shared by the media connectors (ElevenLabs, Higgsfield): one fetch with a timeout, and errors in words the
// screens can show as they are. Keys are only ever put in headers here; they never appear in an error or a log.

/** A connector failed in a way the person can understand (shown as is) */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** What a provider's HTTP status means to someone on the team */
export function friendlyStatus(provider: string, status: number, detail?: string | null): string {
  const d = detail ? ` (${detail.slice(0, 200)})` : "";
  if (status === 401 || status === 403) return `${provider} turned the key down. An exec needs to check the key in Vercel.`;
  if (status === 402) return `${provider} is out of credits. Top the account up and try again.`;
  if (status === 404) return `${provider} couldn't find that${d}.`;
  if (status === 408 || status === 504) return `${provider} took too long. Try again.`;
  if (status === 413) return `That's too big for ${provider}.`;
  if (status === 422 || status === 400) return `${provider} didn't accept the request${d}.`;
  if (status === 429) return `${provider} is busy or the plan's limit was reached. Wait a minute and try again.`;
  if (status >= 500) return `${provider} is having trouble right now. Try again in a few minutes.`;
  return `${provider} answered ${status}${d}.`;
}

/** The detail a provider put in an error body, if any (FastAPI-style `detail`, or `message`/`error`) */
export function detailOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 300) : null;
  const b = body as Record<string, unknown>;
  const d = b.detail ?? b.message ?? b.error;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => (x && typeof x === "object" ? String((x as Record<string, unknown>).msg ?? (x as Record<string, unknown>).message ?? "") : String(x))).filter(Boolean).join("; ") || null;
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    return typeof o.message === "string" ? o.message : typeof o.status === "string" ? o.status : null;
  }
  return null;
}

/** fetch with a timeout; a network failure or timeout becomes a ConnectorError */
export async function timedFetch(provider: string, url: string, init: RequestInit, ms: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms), cache: "no-store" });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new ConnectorError(`${provider} took too long. Try again.`, 408, true);
    throw new ConnectorError(`Couldn't reach ${provider}. Try again in a minute.`, null, true);
  }
}

/** A JSON call: parsed body, or a ConnectorError in plain words */
export async function fetchJson<T>(provider: string, url: string, init: RequestInit, ms: number): Promise<T> {
  const res = await timedFetch(provider, url, init, ms);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ConnectorError(friendlyStatus(provider, res.status, detailOf(body)), res.status, res.status === 429 || res.status >= 500);
  return body as T;
}

/** The message to show for anything a connector threw */
export const messageOf = (e: unknown, fallback = "Something went wrong. Try again.") => (e instanceof ConnectorError ? e.message : fallback);
