// Klaviyo (email and SMS) in Kaizen Ads, the plain parts kept apart from the network and the database so they can be
// tested: what a pasted private key must look like, reading the Accounts answer, reading Reporting API answers (values
// and series, in the shapes Klaviyo has used), when to wait and retry after a refusal, the daily rollup, and the short
// line every agent reads. Read only: nothing here (or anywhere in Kaizen Ads) sends, edits or schedules in Klaviyo.

/**
 * The API revision every call is pinned to. 2026-07-15 is the last stable revision before the omnichannel campaign
 * model (2026-10-15), so campaigns keep send_time, status, audiences and their messages' subject lines in one place.
 * Klaviyo keeps a revision working for two years after the next one ships.
 */
export const KLAVIYO_REVISION = "2026-07-15";
export const KLAVIYO_BASE = "https://a.klaviyo.com";

/** The read-only scopes a connection needs (Klaviyo › Settings › API keys › Create private key › Custom) */
export const KLAVIYO_SCOPES = ["accounts:read", "campaigns:read", "flows:read", "lists:read", "segments:read", "metrics:read"] as const;

export const BACKFILL_DAYS = 90;

// ─── The key ───────────────────────────────────────────────────────────────

/** A private API key as pasted: trimmed, quotes and a "Klaviyo-API-Key " prefix taken off */
export function cleanKey(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Klaviyo-API-Key\s+/i, "")
    .trim();
}

/** Why a pasted key can't be a Klaviyo private key, or null when it looks right */
export function keyProblem(raw: string): string | null {
  const k = cleanKey(raw);
  if (!k) return "Paste the private API key.";
  if (/^[A-Za-z0-9]{6}$/.test(k)) return "That's the public key (site ID). Paste a private API key: it starts with pk_.";
  if (!k.startsWith("pk_")) return "A Klaviyo private API key starts with pk_.";
  if (!/^pk_[A-Za-z0-9_]{16,120}$/.test(k)) return "That doesn't look like a whole private API key. Copy it again from Klaviyo.";
  return null;
}

export const keyLast4 = (raw: string) => cleanKey(raw).slice(-4);

/** Any Klaviyo private key out of a text before it's saved, logged or shown */
export function redactKey(text: string, key?: string | null): string {
  let out = String(text ?? "");
  if (key && key.length >= 8) out = out.split(key).join("[redacted]");
  return out.replace(/\bpk_[A-Za-z0-9_]{8,}/g, "pk_[redacted]");
}

// ─── The account ───────────────────────────────────────────────────────────

export type KlaviyoAccount = { id: string; name: string | null; timezone: string | null; currency: string | null; testAccount: boolean };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** GET /api/accounts: the account the key belongs to (data is a list of one; a single object is read too) */
export function parseAccount(json: unknown): KlaviyoAccount | null {
  const data = obj(json).data;
  const first = obj(Array.isArray(data) ? data[0] : data);
  const id = str(first.id);
  if (!id) return null;
  const a = obj(first.attributes);
  const contact = obj(a.contact_information);
  return { id, name: str(contact.organization_name) ?? str(contact.default_sender_name), timezone: str(a.timezone), currency: str(a.preferred_currency), testAccount: a.test_account === true };
}

/** What Klaviyo's error answer says, short (never the key) */
export function errorText(status: number, json: unknown): string {
  const first = obj((obj(json).errors as unknown[] | undefined)?.[0]);
  const detail = str(first.detail) ?? str(first.title);
  if (status === 401 || status === 400) return detail && !/api key/i.test(detail) ? `Klaviyo refused the key: ${detail}` : "Klaviyo refused this key. Check it was copied whole and hasn't been deleted.";
  if (status === 403) return `This key can't read everything Kaizen Ads needs. Make a new private key with read access to ${KLAVIYO_SCOPES.join(", ")}.`;
  if (status === 429) return "Klaviyo is rate limiting this account right now. It's tried again on the next sync.";
  return `Klaviyo answered ${status}${detail ? `: ${detail}` : ""}`;
}

// ─── Waiting and retrying ──────────────────────────────────────────────────

export type RetryDecision = { retry: true; waitMs: number } | { retry: false; reason: string };

/**
 * After an answer: whether to try again and how long to wait first. A 429 waits what Retry-After says (a little more,
 * never past maxWaitMs: then it stops and the next sync picks it up); 5xx and network failures back off exponentially
 * with jitter; anything else is final. Gives up after maxAttempts.
 */
export function retryDecision(input: { status: number | null; retryAfter?: string | null; attempt: number; maxAttempts?: number; maxWaitMs?: number; random?: () => number }): RetryDecision {
  const { status, attempt } = input;
  const maxAttempts = input.maxAttempts ?? 4;
  const maxWait = input.maxWaitMs ?? 65_000;
  const rnd = input.random ?? Math.random;
  if (status != null && status < 400) return { retry: false, reason: "ok" };
  if (attempt >= maxAttempts) return { retry: false, reason: "gave up after retries" };
  if (status === 429) {
    const secs = Number(String(input.retryAfter ?? "").trim());
    const wait = Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs * 1000) + 250 : Math.min(maxWait, 2000 * 2 ** attempt);
    if (wait > maxWait) return { retry: false, reason: "rate limited for longer than this run can wait" };
    return { retry: true, waitMs: wait };
  }
  if (status == null || status >= 500) {
    const ra = Number(String(input.retryAfter ?? "").trim());
    const base = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
    const wait = Math.min(maxWait, Math.round(base + rnd() * 500));
    return { retry: true, waitMs: wait };
  }
  return { retry: false, reason: `final ${status}` };
}

/** How long to wait before the next Reporting API call: its steady limit is 2 a minute per account */
export const REPORT_GAP_MS = 31_000;
export function reportWait(lastAt: number | null, now: number, gap = REPORT_GAP_MS): number {
  if (lastAt == null) return 0;
  return Math.max(0, lastAt + gap - now);
}

// ─── Reporting API answers ─────────────────────────────────────────────────

export const REPORT_STATS = ["recipients", "delivered", "opens_unique", "open_rate", "clicks_unique", "click_rate", "unsubscribes", "bounced", "spam_complaints", "conversions", "conversion_value"] as const;
/** The series report takes counts only: rates are worked out from them */
export const SERIES_STATS = ["recipients", "delivered", "opens_unique", "clicks_unique", "conversions", "conversion_value"] as const;

export type Stats = { recipients: number; delivered: number; opensUnique: number; clicksUnique: number; unsubscribes: number; bounced: number; spamComplaints: number; conversions: number; revenue: number };
export const emptyStats = (): Stats => ({ recipients: 0, delivered: 0, opensUnique: 0, clicksUnique: 0, unsubscribes: 0, bounced: 0, spamComplaints: 0, conversions: 0, revenue: 0 });

const n = (v: unknown) => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
};

export function addStats(a: Stats, b: Stats): Stats {
  return { recipients: a.recipients + b.recipients, delivered: a.delivered + b.delivered, opensUnique: a.opensUnique + b.opensUnique, clicksUnique: a.clicksUnique + b.clicksUnique, unsubscribes: a.unsubscribes + b.unsubscribes, bounced: a.bounced + b.bounced, spamComplaints: a.spamComplaints + b.spamComplaints, conversions: a.conversions + b.conversions, revenue: a.revenue + b.revenue };
}

/** Open and click rate as fractions of delivered (recipients when delivered isn't there), null with nothing sent */
export function rates(s: Stats): { openRate: number | null; clickRate: number | null } {
  const base = s.delivered || s.recipients;
  return base ? { openRate: s.opensUnique / base, clickRate: s.clicksUnique / base } : { openRate: null, clickRate: null };
}

function statsOf(raw: unknown): Stats {
  const s = obj(raw);
  const delivered = n(s.delivered);
  const recipients = n(s.recipients);
  // Some answers carry only the rate: turned back into a count so messages add up
  const base = delivered || recipients;
  const opens = s.opens_unique != null ? n(s.opens_unique) : s.open_rate != null ? Math.round(n(s.open_rate) * base) : 0;
  const clicks = s.clicks_unique != null ? n(s.clicks_unique) : s.click_rate != null ? Math.round(n(s.click_rate) * base) : 0;
  return { recipients, delivered, opensUnique: opens, clicksUnique: clicks, unsubscribes: n(s.unsubscribes ?? s.unsubscribe_uniques), bounced: n(s.bounced), spamComplaints: n(s.spam_complaints), conversions: n(s.conversions), revenue: n(s.conversion_value) };
}

/** The results list wherever the answer keeps it: data.attributes.results, data[0].attributes.results, or results */
function resultsOf(json: unknown): unknown[] {
  const root = obj(json);
  const data = root.data;
  const d = obj(Array.isArray(data) ? data[0] : data);
  const list = obj(d.attributes).results ?? d.results ?? obj(root.attributes).results ?? root.results;
  return Array.isArray(list) ? list : [];
}

export type ValuesRow = { id: string; channel: string | null; stats: Stats; messages: number };

/**
 * A campaign-values or flow-values report, one row per campaign (or flow) with its messages added up (an A/B test or a
 * flow's emails come back one row each). Rows with no id are dropped.
 */
export function parseValuesReport(json: unknown, kind: "campaign" | "flow"): ValuesRow[] {
  const idKey = kind === "campaign" ? "campaign_id" : "flow_id";
  const by = new Map<string, ValuesRow>();
  for (const r of resultsOf(json)) {
    const row = obj(r);
    const g = obj(row.groupings);
    const id = str(g[idKey]) ?? str(row[idKey]);
    if (!id) continue;
    const stats = statsOf(row.statistics);
    const channel = str(g.send_channel);
    const had = by.get(id);
    if (had) by.set(id, { id, channel: had.channel === channel ? channel : had.channel ?? channel, stats: addStats(had.stats, stats), messages: had.messages + 1 });
    else by.set(id, { id, channel, stats, messages: 1 });
  }
  return [...by.values()];
}

/** The next page of a report, when Klaviyo says there is one */
export function nextLink(json: unknown): string | null {
  const root = obj(json);
  return str(obj(root.links).next) ?? str(obj(obj(root.data).links).next);
}

export type SeriesRow = { id: string; days: { date: string; stats: Stats }[] };

/**
 * A flow-series report (interval daily): per flow, each day's counts. The days are read from date_times (or dates),
 * kept as the account's own calendar day (the date part as Klaviyo writes it). Statistics are arrays lined up with
 * those days; messages of one flow are added up.
 */
export function parseSeriesReport(json: unknown, idKey = "flow_id"): SeriesRow[] {
  const root = obj(json);
  const data = root.data;
  const attrs = obj(obj(Array.isArray(data) ? data[0] : data).attributes);
  const times = (attrs.date_times ?? attrs.dates ?? root.date_times ?? []) as unknown[];
  const days = (Array.isArray(times) ? times : []).map((t) => String(t ?? "").slice(0, 10));
  const by = new Map<string, Map<string, Stats>>();
  for (const r of resultsOf(json)) {
    const row = obj(r);
    const id = str(obj(row.groupings)[idKey]) ?? str(row[idKey]);
    if (!id) continue;
    const s = obj(row.statistics);
    const m = by.get(id) ?? new Map<string, Stats>();
    days.forEach((date, i) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const at = (k: string) => (Array.isArray(s[k]) ? (s[k] as unknown[])[i] : undefined);
      const day = statsOf({ recipients: at("recipients"), delivered: at("delivered"), opens_unique: at("opens_unique"), clicks_unique: at("clicks_unique"), unsubscribes: at("unsubscribes"), bounced: at("bounced"), spam_complaints: at("spam_complaints"), conversions: at("conversions"), conversion_value: at("conversion_value") });
      m.set(date, addStats(m.get(date) ?? emptyStats(), day));
    });
    by.set(id, m);
  }
  return [...by.entries()].map(([id, m]) => ({ id, days: [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, stats]) => ({ date, stats })) }));
}

/** A flow's counts added up over the days from `from` (YYYY-MM-DD, inclusive) on */
export function sumSince(row: SeriesRow, from: string): Stats {
  return row.days.filter((d) => d.date >= from).reduce((a, d) => addStats(a, d.stats), emptyStats());
}

// ─── Campaigns and flows as listed ─────────────────────────────────────────

export type CampaignInfo = { id: string; name: string; channel: "email" | "sms" | string; status: string | null; sendTime: string | null; audienceIds: string[]; subject: string | null; previewText: string | null; archived: boolean };

/**
 * GET /api/campaigns with include=campaign-messages: each campaign, its audiences (list and segment ids) and its first
 * message's subject line and preview text. Reads the message content where each revision kept it (attributes.content,
 * or attributes.definition.content).
 */
export function parseCampaigns(json: unknown, channel: string): CampaignInfo[] {
  const root = obj(json);
  const included = (Array.isArray(root.included) ? root.included : []).map(obj);
  const messages = new Map(included.filter((i) => i.type === "campaign-message").map((i) => [String(i.id), obj(i.attributes)]));
  const list = Array.isArray(root.data) ? root.data : [];
  return list.map((raw) => {
    const c = obj(raw);
    const a = obj(c.attributes);
    const aud = obj(a.audiences);
    const msgIds = ((obj(obj(c.relationships)["campaign-messages"]).data as unknown[] | undefined) ?? []).map((m) => String(obj(m).id));
    const msg = msgIds.map((id) => messages.get(id)).find(Boolean) ?? {};
    const def = obj(msg.definition);
    const content = obj(msg.content ?? def.content);
    return {
      id: String(c.id ?? ""),
      name: str(a.name) ?? "(untitled)",
      channel: str(msg.channel) ?? str(def.channel) ?? channel,
      status: str(a.status),
      sendTime: str(a.send_time) ?? str(a.scheduled_at),
      audienceIds: (Array.isArray(aud.included) ? aud.included : []).map(String),
      subject: str(content.subject),
      previewText: str(content.preview_text),
      archived: a.archived === true,
    };
  }).filter((c) => c.id);
}

export type FlowInfo = { id: string; name: string; status: string | null; triggerType: string | null; archived: boolean };
export function parseFlows(json: unknown): FlowInfo[] {
  const list = obj(json).data;
  return (Array.isArray(list) ? list : []).map((raw) => {
    const f = obj(raw);
    const a = obj(f.attributes);
    return { id: String(f.id ?? ""), name: str(a.name) ?? "(untitled)", status: str(a.status), triggerType: str(a.trigger_type), archived: a.archived === true };
  }).filter((f) => f.id);
}

export type AudienceInfo = { id: string; kind: "list" | "segment"; name: string; profileCount: number | null; updated: string | null };
export function parseAudiences(json: unknown, kind: "list" | "segment"): AudienceInfo[] {
  const list = obj(json).data;
  const rows = Array.isArray(list) ? list : list ? [list] : [];
  return rows.map((raw) => {
    const x = obj(raw);
    const a = obj(x.attributes);
    const count = a.profile_count;
    return { id: String(x.id ?? ""), kind, name: str(a.name) ?? "(untitled)", profileCount: count == null ? null : n(count), updated: str(a.updated) };
  }).filter((x) => x.id);
}

/** The "Placed Order" metric's id among the account's metrics (Shopify's, else any integration's) */
export function placedOrderId(json: unknown): string | null {
  const list = obj(json).data;
  const rows = (Array.isArray(list) ? list : []).map(obj).filter((m) => str(obj(m.attributes).name)?.toLowerCase() === "placed order");
  const shopify = rows.find((m) => /shopify/i.test(String(obj(obj(m.attributes).integration).name ?? "")));
  return str((shopify ?? rows[0])?.id) ?? null;
}

// ─── The daily rollup ──────────────────────────────────────────────────────

/** A calendar day in a time zone (IANA; New York when it's missing or unknown) */
export function dayIn(iso: string, tz: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
}

export type DayTotal = { date: string; campaignRevenue: number; flowRevenue: number; revenue: number; campaignRecipients: number; flowRecipients: number; sends: number; campaignsSent: number; conversions: number };

/**
 * Each day's email and SMS totals for the account: campaigns count on the day they were sent (in the account's time
 * zone), flows on the day Klaviyo's daily series puts them. Days outside [from, to] are left out; days in between with
 * nothing are kept at zero so a quiet day reads as quiet, not missing.
 */
export function rollupDays(input: { campaigns: { sendTime: string | null; stats: Stats }[]; flows: SeriesRow[]; tz: string | null; from: string; to: string }): DayTotal[] {
  const days = new Map<string, DayTotal>();
  const blank = (date: string): DayTotal => ({ date, campaignRevenue: 0, flowRevenue: 0, revenue: 0, campaignRecipients: 0, flowRecipients: 0, sends: 0, campaignsSent: 0, conversions: 0 });
  for (let d = input.from; d <= input.to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.set(d, blank(d));
  for (const c of input.campaigns) {
    if (!c.sendTime) continue;
    const t = days.get(dayIn(c.sendTime, input.tz));
    if (!t) continue;
    t.campaignRevenue += c.stats.revenue;
    t.campaignRecipients += c.stats.recipients;
    t.campaignsSent += 1;
    t.conversions += c.stats.conversions;
  }
  for (const f of input.flows)
    for (const d of f.days) {
      const t = days.get(d.date);
      if (!t) continue;
      t.flowRevenue += d.stats.revenue;
      t.flowRecipients += d.stats.recipients;
      t.conversions += d.stats.conversions;
    }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return [...days.values()].map((t) => ({ ...t, campaignRevenue: r2(t.campaignRevenue), flowRevenue: r2(t.flowRevenue), revenue: r2(t.campaignRevenue + t.flowRevenue), sends: t.campaignRecipients + t.flowRecipients, conversions: r2(t.conversions) }));
}

// ─── What the page and the agents read ─────────────────────────────────────

export type EmailWindow = { revenue: number; campaignRevenue: number; flowRevenue: number; sends: number; campaignsSent: number; openRate: number | null; clickRate: number | null };
export type EmailCampaignLine = { name: string; channel: string; sendTime: string | null; subject: string | null; recipients: number; openRate: number | null; clickRate: number | null; revenue: number; conversions: number };

const money = (x: number, cur: string) => `${cur === "USD" || !cur ? "$" : `${cur} `}${Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

/**
 * The compact Klaviyo line every agent that reads a client gets: the last 30 days' attributed revenue (against the 30
 * before), open and click rates, and the last 3 campaigns with their subject and result. Empty when there's nothing.
 */
export function emailContextLine(input: { account: string | null; currency: string | null; now: EmailWindow; before: EmailWindow | null; recent: EmailCampaignLine[]; storeRevenue?: number | null; through?: string | null }): string {
  const { now, before, recent } = input;
  if (!now.sends && !now.revenue && !recent.length) return "";
  const cur = input.currency ?? "USD";
  const change = before && before.revenue ? ` (${now.revenue >= before.revenue ? "+" : ""}${Math.round(((now.revenue - before.revenue) / before.revenue) * 100)}% vs the 30 days before)` : "";
  const share = input.storeRevenue ? `, ${Math.round((now.revenue / input.storeRevenue) * 100)}% of the store's revenue` : "";
  const lines = [
    `Email and SMS (Klaviyo${input.account ? `, ${input.account}` : ""}; read only${input.through ? `, data through ${input.through}` : ""}):`,
    `- Last 30 days: ${money(now.revenue, cur)} attributed revenue${change}${share} (campaigns ${money(now.campaignRevenue, cur)}, flows ${money(now.flowRevenue, cur)}), ${now.campaignsSent} campaigns sent, ${now.sends.toLocaleString("en-US")} messages, open rate ${pct(now.openRate)}, click rate ${pct(now.clickRate)}`,
    ...recent.slice(0, 3).map((c) => `- ${c.sendTime ? c.sendTime.slice(0, 10) : "unsent"} ${c.channel === "sms" ? "SMS" : "email"} "${c.name}"${c.subject ? `, subject "${c.subject.slice(0, 90)}"` : ""}: ${c.recipients.toLocaleString("en-US")} recipients, open ${pct(c.openRate)}, click ${pct(c.clickRate)}, ${money(c.revenue, cur)} from ${Math.round(c.conversions)} orders`),
  ];
  return lines.join("\n");
}

// ─── Sync health: plain errors, each client's state, and how much to read ─────

/** The read scopes, as a person reads them in Klaviyo's key screen */
export const KLAVIYO_SCOPE_NAMES = "Accounts, Campaigns, Flows, Lists, Segments and Metrics";

export type KlaviyoPlainError = { message: string; fix: string; severity: "bad" | "warn" };

/**
 * What a Klaviyo failure means, in plain words, with the fix. `status` is the connection's status ("invalid" once
 * Klaviyo refused the key). Never repeats a key: the stored errors are already redacted, and this only reads them.
 */
export function plainKlaviyoError(raw: string | null | undefined, status?: string | null): KlaviyoPlainError | null {
  const text = String(raw ?? "").trim();
  if (status === "invalid" || /refused (this |the )?key|Klaviyo refused/i.test(text))
    return { message: "Klaviyo refused the key: it was revoked or deleted", fix: "Create a new read-only private key in their Klaviyo and paste it here.", severity: "bad" };
  if (!text) return null;
  if (/No Placed Order/i.test(text))
    return { message: "No Placed Order metric yet, so revenue can't be read", fix: "Connect their store (Shopify or another) inside Klaviyo. Campaigns, flows and lists still sync.", severity: "warn" };
  if (/can't read everything|\b403\b|lacks|permission/i.test(text))
    return { message: "The key lacks Read access on something Kaizen reads", fix: `Create a new read-only key with Read on ${KLAVIYO_SCOPE_NAMES}, and paste it here.`, severity: "bad" };
  if (/key can't be read|can't be decrypted|TOKEN_ENCRYPTION_KEY/i.test(text))
    return { message: "The saved key can't be unlocked", fix: "Paste the key again (the encryption key in Vercel changed since it was saved).", severity: "bad" };
  if (/rate limit|\b429\b/i.test(text)) return { message: "Klaviyo is rate limiting this account", fix: "Nothing to do: it tries again on the next run.", severity: "bad" };
  if (/didn't answer|fetch failed|timed? ?out|ECONNRESET|answered 5\d\d/i.test(text)) return { message: "Klaviyo didn't answer", fix: "Nothing to do: it tries again on the next run.", severity: "bad" };
  if (/^Saving klaviyo_/i.test(text)) return { message: "The numbers were read but couldn't be saved", fix: "It tries again on the next run. If it keeps failing, the Klaviyo migration may be missing.", severity: "bad" };
  return { message: text.replace(/^Klaviyo answered /i, "Klaviyo answered ").slice(0, 200), fix: "Sync it again; if it keeps failing, replace the key with a new read-only one.", severity: "bad" };
}

export type KlaviyoClientState = "connected" | "behind" | "pending" | "failing" | "missing";

/** A day and a bit with no successful read is behind (the same line Sync health uses everywhere) */
export const KLAVIYO_BEHIND_MS = 26 * 3_600_000;

/** Where one client's Klaviyo stands, from its connection (null when there's none) */
export function klaviyoClientState(conn: { status: string; lastSyncedAt: string | null; error: string | null } | null, now = Date.now()): { state: KlaviyoClientState; error: KlaviyoPlainError | null } {
  if (!conn) return { state: "missing", error: null };
  const error = plainKlaviyoError(conn.error, conn.status);
  if (error?.severity === "bad") return { state: "failing", error };
  if (!conn.lastSyncedAt) return { state: "pending", error };
  return { state: now - Date.parse(conn.lastSyncedAt) > KLAVIYO_BEHIND_MS ? "behind" : "connected", error };
}

export type KlaviyoWindow = "recent" | "full";

/** The full window (120 days of campaigns, 90 of days, lists and segments) at most this often; recent the rest */
export const FULL_EVERY_MS = 20 * 3_600_000;

/**
 * How much a run reads for one client: "full" when it has never had a full read, or its last one is FULL_EVERY_MS
 * old; otherwise "recent" (today and yesterday's totals, the last 7 days' campaigns, flows' 30 days).
 */
export function pickKlaviyoWindow(input: { lastFullAt: string | null; now?: number; everyMs?: number }): KlaviyoWindow {
  if (!input.lastFullAt) return "full";
  const at = Date.parse(input.lastFullAt);
  if (!Number.isFinite(at)) return "full";
  return (input.now ?? Date.now()) - at >= (input.everyMs ?? FULL_EVERY_MS) ? "full" : "recent";
}

/** About how long a client's read takes (the Reporting API allows 2 queries a minute per account), for the run's budget */
export const klaviyoCostMs = (w: KlaviyoWindow) => (w === "full" ? 210_000 : 110_000);
