import "server-only";
import { cioBase, ProviderError, type CioRegion } from "../email-providers/core";
import { providerGet } from "../email-providers/http";
import { CIO_ACTIVITIES, CIO_BROADCASTS, CIO_BROADCAST_METRICS, CIO_CAMPAIGNS, CIO_CAMPAIGN_METRICS, CIO_GAP_MS, CIO_NEWSLETTERS, CIO_NEWSLETTER_METRICS, CIO_SEGMENTS, CIO_SEGMENT_COUNT, CIO_WORKSPACES, cioErrorText, parseAutomations, parseBroadcasts, parseEventActivities, parseNewsletters, parseSegmentCount, parseSegments, parseSeries, parseWorkspaces, unixOfDay, type CioEventPage, type CioSend, type CioWorkspace } from "./core";

// Customer.io's App API, read only (GET calls). The key travels as a Bearer token; the region picks the host. Calls are
// spaced inside the 10 a second limit and wait and retry on 429 (Retry-After) and 5xx.

export type Cio = { key: string; region: CioRegion };
const get = (c: Cio, path: string) => providerGet({ base: cioBase(c.region), path, headers: { Authorization: `Bearer ${c.key}` }, key: c.key, name: "Customer.io", errorText: cioErrorText, gapMs: CIO_GAP_MS });

export async function getWorkspace(c: Cio): Promise<CioWorkspace> {
  const w = parseWorkspaces(await get(c, CIO_WORKSPACES));
  if (!w) throw new ProviderError("Customer.io didn't say which workspace this key belongs to.", null);
  return w;
}

export const listAutomations = async (c: Cio) => parseAutomations(await get(c, CIO_CAMPAIGNS));
export const listBroadcasts = async (c: Cio): Promise<CioSend[]> => parseBroadcasts(await get(c, CIO_BROADCASTS));

/** One-time sends, newest first, until one older than `sinceIso` (or `pages` pages) */
export async function listNewsletters(c: Cio, sinceIso: string, pages = 6): Promise<CioSend[]> {
  const out: CioSend[] = [];
  let start: string | null = null;
  for (let i = 0; i < pages; i++) {
    const q = new URLSearchParams({ limit: "50", sort: "desc" });
    if (start) q.set("start", start);
    const page = parseNewsletters(await get(c, `${CIO_NEWSLETTERS}?${q}`));
    out.push(...page.rows);
    const oldest = page.rows.map((r) => r.sentAt).filter((x): x is string => Boolean(x)).sort()[0];
    if (!page.next || !page.rows.length || (oldest && oldest < sinceIso)) break;
    start = page.next;
  }
  return out;
}

/** An automation's daily counts from `startDay` to now (metrics version 2: res days, start and end in Unix seconds, UTC days) */
export async function automationDaily(c: Cio, id: string, startDay: string) {
  const q = new URLSearchParams({ version: "2", res: "days", start: String(unixOfDay(startDay)), end: String(Math.floor(Date.now() / 1000)) });
  return parseSeries(await get(c, `${CIO_CAMPAIGN_METRICS(id)}?${q}`));
}

/** A broadcast's or a one-time send's counts over its life (12 monthly steps added up by the caller; version 1's period and steps) */
export async function sendTotals(c: Cio, kind: "newsletter" | "broadcast", id: string) {
  const q = new URLSearchParams({ period: "months", steps: "12" });
  return parseSeries(await get(c, `${kind === "newsletter" ? CIO_NEWSLETTER_METRICS(id) : CIO_BROADCAST_METRICS(id)}?${q}`));
}

export const listSegments = async (c: Cio) => parseSegments(await get(c, CIO_SEGMENTS));
export const segmentCount = async (c: Cio, id: string) => parseSegmentCount(await get(c, CIO_SEGMENT_COUNT(id)));

/** The activities of one event name, newest page first; pass the previous answer's `next` to continue */
export async function eventPage(c: Cio, name: string, start: string | null): Promise<CioEventPage> {
  const q = new URLSearchParams({ type: "event", name, limit: "100" });
  if (start) q.set("start", start);
  return parseEventActivities(await get(c, `${CIO_ACTIVITIES}?${q}`));
}
