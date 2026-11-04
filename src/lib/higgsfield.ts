import "server-only";
import { ConnectorError, fetchJson, timedFetch } from "@/lib/connector-http";
import { hfOutputs, hfRequest, hfStatus, type MediaJobStatus } from "@/lib/media-models";

// Higgsfield over its public API (https://docs.higgsfield.ai): a request is submitted to a model's path, runs on
// Higgsfield's side, and its status is asked for until it's done; the result links expire, so finished files are
// copied into our storage straight away (src/lib/ai-media-jobs.ts). Auth is "Key <id>:<secret>" from
// HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Vercel; it only ever goes in the Authorization header.

const BASE = "https://api.higgsfield.ai";
const NAME = "Higgsfield";

export const higgsfieldConfigured = () => Boolean(process.env.HIGGSFIELD_API_KEY && process.env.HIGGSFIELD_API_SECRET);

function auth() {
  const id = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!id || !secret) throw new ConnectorError("Higgsfield isn't connected yet. An exec needs to add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Vercel.");
  return `Key ${id}:${secret}`;
}

type Submitted = { status?: string; request_id?: string; status_url?: string; cancel_url?: string };
type StatusBody = {
  status?: string;
  request_id?: string;
  images?: { url?: string }[] | null;
  video?: { url?: string } | null;
  audio?: { url?: string } | null;
  error?: string | null;
  detail?: unknown;
};

/** Sends one generation. Returns Higgsfield's request id (kept on the job) */
export async function submit(modelKey: string, input: { prompt?: string | null; options?: Record<string, unknown> | null; referenceUrl?: string | null }, idempotencyKey?: string) {
  const req = hfRequest(modelKey, input);
  if (!req.ok) throw new ConnectorError(req.error);
  const r = await fetchJson<Submitted>(
    NAME,
    `${BASE}${req.path}`,
    { method: "POST", headers: { authorization: auth(), "content-type": "application/json", accept: "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, body: JSON.stringify(req.body) },
    30_000,
  );
  if (!r.request_id) throw new ConnectorError("Higgsfield didn't start it. Try again.", null, true);
  return { requestId: r.request_id, status: hfStatus(r.status ?? "queued"), path: req.path, body: req.body };
}

export type Progress = { status: MediaJobStatus; outputs: { url: string; kind: "image" | "video" | "audio" }[]; error: string | null };

/** Where a request is */
export async function status(requestId: string): Promise<Progress> {
  const r = await fetchJson<StatusBody>(NAME, `${BASE}/requests/${encodeURIComponent(requestId)}/status`, { headers: { authorization: auth(), accept: "application/json" } }, 20_000);
  const s = hfStatus(r.status);
  const error =
    r.status === "nsfw"
      ? "Higgsfield's safety filter stopped it. Reword the prompt (or use another reference) and try again."
      : s === "failed"
        ? typeof r.error === "string" && r.error
          ? `Higgsfield couldn't make it: ${r.error.slice(0, 200)}`
          : "Higgsfield couldn't make it. Try again or try another model."
        : null;
  return { status: s, outputs: s === "ready" ? hfOutputs(r) : [], error };
}

/** Stops a request still waiting in Higgsfield's queue (once it's running it can't be stopped) */
export async function cancel(requestId: string) {
  const res = await timedFetch(NAME, `${BASE}/requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST", headers: { authorization: auth() } }, 15_000);
  return res.status === 202 || res.ok;
}

const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/** A reference image into Higgsfield's storage: returns the public link a model takes as image_url */
export async function uploadReference(bytes: Buffer | Uint8Array, contentType: string): Promise<string> {
  const type = UPLOAD_TYPES.find((t) => t === contentType.toLowerCase());
  if (!type) throw new ConnectorError("References can be JPG, PNG, WebP or GIF.");
  if (bytes.byteLength > 20 * 1024 * 1024) throw new ConnectorError("That reference is over 20 MB. Use a smaller image.");
  const u = await fetchJson<{ public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }>(
    NAME,
    `${BASE}/files/generate-upload-url`,
    { method: "POST", headers: { authorization: auth(), "content-type": "application/json" }, body: JSON.stringify({ content_type: type }) },
    15_000,
  );
  if (!u.upload_url || !u.public_url) throw new ConnectorError("Higgsfield didn't take the reference. Try again.", null, true);
  const put = await timedFetch(NAME, u.upload_url, { method: "PUT", headers: { "content-type": type, ...(u.upload_headers ?? {}) }, body: new Uint8Array(bytes) }, 60_000);
  if (!put.ok) throw new ConnectorError("The reference didn't upload to Higgsfield. Try again.", put.status, true);
  return u.public_url;
}

/** A finished file from Higgsfield's link (they expire, so it's copied as soon as it's ready) */
export async function download(url: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!/^https:\/\//.test(url)) throw new ConnectorError("Higgsfield sent a link that isn't secure.");
  const res = await timedFetch(NAME, url, {}, 180_000);
  if (!res.ok) throw new ConnectorError("The finished file couldn't be fetched from Higgsfield. Try again.", res.status, true);
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim() || (/\.mp4(\?|$)/i.test(url) ? "video/mp4" : /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg");
  return { bytes, mime };
}

/**
 * For Settings › Connections: Higgsfield has no balance endpoint, so this checks the key with a request id that
 * can't exist: 404 means the key was accepted, 401/403 that it wasn't.
 */
export async function higgsfieldStatus(): Promise<{ configured: boolean; reachable: boolean; error: string | null }> {
  if (!higgsfieldConfigured()) return { configured: false, reachable: false, error: null };
  try {
    const res = await timedFetch(NAME, `${BASE}/requests/00000000-0000-0000-0000-000000000000/status`, { headers: { authorization: auth(), accept: "application/json" } }, 10_000);
    if (res.status === 401 || res.status === 403) return { configured: true, reachable: false, error: "Higgsfield turned the key down. Check the key ID and secret in Vercel." };
    if (res.status >= 500) return { configured: true, reachable: false, error: "Higgsfield is having trouble right now." };
    return { configured: true, reachable: true, error: null };
  } catch (e) {
    return { configured: true, reachable: false, error: e instanceof ConnectorError ? e.message : "Couldn't reach Higgsfield." };
  }
}
