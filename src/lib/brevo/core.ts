// Brevo (API v3) in Kaizen OS: the plain parts, kept apart from the network and the database so they can be tested.
// Every endpoint and field below was checked against https://developers.brevo.com (the page for each is named beside
// its constant). Read only: nothing here sends, edits or schedules anything in Brevo.

import { emptyStats, type CampaignInfo, type Stats } from "../klaviyo/core";

export const BREVO_BASE = "https://api.brevo.com";

/** GET /v3/account: the key's account (organization_id, companyName, ...). https://developers.brevo.com/reference/get-account */
export const BREVO_ACCOUNT = "/v3/account";
/**
 * GET /v3/emailCampaigns: query limit (default 50), offset, sort, status, startDate and endDate (both, UTC, not in the
 * future), statistics=globalStats (the last 6 months only), excludeHtmlContent. Response { campaigns, count }. The sent
 * date is `sentDate`, and statistics.globalStats has sent, delivered, hardBounces, softBounces, uniqueViews, viewed,
 * uniqueClicks, clickers, complaints, unsubscriptions, appleMppOpens. https://developers.brevo.com/reference/get-email-campaigns
 */
export const BREVO_EMAIL_CAMPAIGNS = "/v3/emailCampaigns";
/** GET /v3/emailCampaigns/{id}: one campaign with htmlContent, subject, previewText. https://developers.brevo.com/reference/get-email-campaign */
export const BREVO_EMAIL_CAMPAIGN = (id: string) => `/v3/emailCampaigns/${encodeURIComponent(id)}`;
/** GET /v3/smsCampaigns: limit (default 500, max 1000), offset, status, startDate and endDate, sort. https://developers.brevo.com/reference/get-sms-campaigns */
export const BREVO_SMS_CAMPAIGNS = "/v3/smsCampaigns";
/** GET /v3/contacts/lists: limit, offset, sort; { count, lists: [{ id, name, uniqueSubscribers, totalSubscribers }] }. https://developers.brevo.com/reference/get-lists */
export const BREVO_LISTS = "/v3/contacts/lists";
/** GET /v3/contacts/segments: limit (max 50), offset; { count, segments: [{ id, segmentName, updatedAt }] }. https://developers.brevo.com/reference/get-segments */
export const BREVO_SEGMENTS = "/v3/contacts/segments";
/**
 * GET /v3/ecommerce/attribution/metrics: periodFrom and periodTo (RFC3339), emailCampaignId[], smsCampaignId[],
 * automationWorkflowEmailId[], automationWorkflowSmsId[]. Response { results: [{ conversionSource, id, ordersCount,
 * revenue, averageBasket }], totals }. https://developers.brevo.com/reference/get_ecommerce-attribution-metrics
 */
export const BREVO_ATTRIBUTION = "/v3/ecommerce/attribution/metrics";

/**
 * Brevo's limits (https://developers.brevo.com/docs/api-limits): every endpoint above outside /v3/contacts and /v3/smtp
 * is 100 requests an hour on the general tier, /v3/contacts is 36,000 an hour (10 a second). A read is therefore a handful
 * of calls: full about 10, recent about 3. Rate limit headers are x-sib-ratelimit-limit, -remaining and -reset.
 */
export const BREVO_PAGE = 50;
export const BREVO_ATTRIBUTION_BATCH = 25;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
};

/** The error text of a Brevo answer ({ code, message }), short */
export function brevoErrorText(status: number, json: unknown): string {
  const message = str(obj(json).message);
  // Brevo's "block unknown IP addresses" security setting refuses calls from our servers (their addresses change)
  if (status === 401 && /\bip\b|ip address|unrecogni[sz]ed/i.test(message ?? "")) return "Brevo blocked the call because of the account's IP security. In their Brevo account: Security › Authorised IPs, turn off blocking unknown IP addresses for the API, then Sync now.";
  if (status === 401) return "Brevo refused this key. Check it was copied whole and hasn't been deleted.";
  if (status === 403) return `Brevo says this key can't read that${message ? ` (${message})` : ""}. Create a new API key and paste it here.`;
  if (status === 429) return "Brevo is rate limiting this account right now. It's tried again on the next sync.";
  if (status === 400) return `Brevo couldn't answer: ${message ?? "bad request"}`;
  return `Brevo answered ${status}${message ? `: ${message}` : ""}`;
}

export type BrevoAccount = { id: string; name: string | null; email: string | null };
export function parseBrevoAccount(json: unknown): BrevoAccount | null {
  const a = obj(json);
  const id = str(a.organization_id) ?? str(a.user_id);
  if (!id) return null;
  const company = str(a.companyName);
  const person = [str(a.firstName), str(a.lastName)].filter(Boolean).join(" ");
  return { id, name: company ?? (person || null), email: str(a.email) };
}

/** The status Brevo uses ("sent", "in_process", "archive"...) as the shared tables say it */
const STATUS: Record<string, string> = { sent: "Sent", queued: "Scheduled", draft: "Draft", in_process: "Sending", inprocess: "Sending", archive: "Archived", suspended: "Suspended", in_review: "In review", cancelled: "Cancelled" };
const statusOf = (s: unknown) => {
  const v = str(s);
  return v ? (STATUS[v.toLowerCase()] ?? v) : null;
};

export type BrevoCampaign = CampaignInfo & { stats: Stats | null; listIds: string[] };

/** A campaign's audiences as the shared audience ids: lists and segments never share an id */
export const brevoListId = (id: unknown) => `list-${String(id)}`;
export const brevoSegmentId = (id: unknown) => `segment-${String(id)}`;

/**
 * GET /v3/emailCampaigns (or /v3/smsCampaigns) answers, each campaign with its numbers. Opens and clicks are the
 * unique ones (uniqueViews, uniqueClicks), bounces are hard plus soft, unsubscribes are `unsubscriptions` and spam
 * complaints are `complaints`. An SMS campaign has no opens or clicks (sent, delivered, bounces, unsubscriptions, answered).
 * A campaign that was never sent has no sentDate, so no send time and nothing to count.
 */
export function parseBrevoCampaigns(json: unknown, channel: "email" | "sms"): BrevoCampaign[] {
  return arr(obj(json).campaigns)
    .map((raw): BrevoCampaign | null => {
      const c = obj(raw);
      const id = str(c.id);
      if (!id) return null;
      const rec = obj(c.recipients);
      const listIds = [...arr(rec.lists).map(brevoListId), ...arr(rec.segments).map(brevoSegmentId)];
      const g = obj(obj(c.statistics).globalStats);
      const sms = obj(c.statistics);
      const has = Object.keys(channel === "email" ? g : sms).length > 0;
      const base = channel === "email" ? g : sms;
      const sent = n(base.sent);
      const delivered = n(base.delivered);
      const stats: Stats | null = has
        ? { ...emptyStats(), recipients: sent, delivered, opensUnique: channel === "email" ? n(g.uniqueViews) : 0, clicksUnique: channel === "email" ? n(g.uniqueClicks) : 0, unsubscribes: n(base.unsubscriptions), bounced: n(base.hardBounces) + n(base.softBounces), spamComplaints: channel === "email" ? n(g.complaints) : 0 }
        : null;
      return {
        id,
        name: str(c.name) ?? "(untitled)",
        channel,
        status: statusOf(c.status),
        sendTime: str(c.sentDate) ?? str(c.scheduledAt),
        audienceIds: listIds,
        listIds,
        subject: str(c.subject) ?? str(c.subjectA),
        previewText: str(c.previewText),
        archived: str(c.status)?.toLowerCase() === "archive",
        body: channel === "sms" ? str(c.content) : null,
        stats,
      };
    })
    .filter((c): c is BrevoCampaign => c !== null);
}

/** GET /v3/contacts/lists and /v3/contacts/segments in the shared audience shape (segments carry no count) */
export function parseBrevoAudiences(json: unknown, kind: "list" | "segment"): { id: string; kind: "list" | "segment"; name: string; profileCount: number | null; updated: string | null }[] {
  const rows = arr(obj(json)[kind === "list" ? "lists" : "segments"]);
  return rows
    .map((raw) => {
      const x = obj(raw);
      const id = str(x.id);
      if (!id) return null;
      // totalSubscribers is being phased out (it will read 0): uniqueSubscribers is the count to trust
      const count = x.uniqueSubscribers != null ? n(x.uniqueSubscribers) : null;
      return { id: kind === "list" ? brevoListId(id) : brevoSegmentId(id), kind, name: str(x.name) ?? str(x.segmentName) ?? "(untitled)", profileCount: kind === "list" ? count : null, updated: str(x.updatedAt) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/** Total entries a list answer says it has (count), to know when the last page was read */
export const brevoCount = (json: unknown): number => n(obj(json).count);

export type Attribution = { orders: number; revenue: number };

/** GET /v3/ecommerce/attribution/metrics: per campaign, keyed `${conversionSource}:${id}` (a source is that pair) */
export function parseAttribution(json: unknown): Map<string, Attribution> {
  const out = new Map<string, Attribution>();
  for (const raw of arr(obj(json).results)) {
    const r = obj(raw);
    const src = str(r.conversionSource);
    const id = str(r.id);
    if (!src || !id) continue;
    out.set(`${src}:${id}`, { orders: n(r.ordersCount), revenue: Math.round(n(r.revenue) * 100) / 100 });
  }
  return out;
}

/** The query for the attribution call: ids per source, as Brevo's array parameters */
export function attributionQuery(email: string[], sms: string[]): string {
  const q = new URLSearchParams();
  for (const id of email) q.append("emailCampaignId[]", id);
  for (const id of sms) q.append("smsCampaignId[]", id);
  return q.toString();
}

/** startDate and endDate for a campaign list: both, UTC milliseconds, neither in the future */
export function brevoRange(fromIso: string, now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now.getTime() - 1000);
  return { startDate: new Date(fromIso).toISOString(), endDate: end.toISOString() };
}

/** What the page of a campaign gives for a preview: the HTML, the subject and the preview text */
export function parseBrevoCampaignContent(json: unknown): { subject: string | null; previewText: string | null; html: string | null } {
  const c = obj(json);
  return { subject: str(c.subject) ?? str(c.subjectA), previewText: str(c.previewText), html: str(c.htmlContent) };
}
