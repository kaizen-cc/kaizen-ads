// Integration health, the pure part: whether each connection a client's work relies on (Meta, Google, TikTok, Klaviyo
// and the other email platforms, Shopify, GoHighLevel and the other CRMs, Motion) is connected, fresh and error-free.
// Read on Sync health, on the client page, and the afternoon before a client call (src/lib/integration-health/precall.ts),
// so a disconnected Motion or a stale Meta pull is fixed before the call, not found during it.

export type IntegrationKind = "meta" | "google" | "tiktok" | "klaviyo" | "brevo" | "customerio" | "shopify" | "crm" | "motion";
export type HealthState = "ok" | "stale" | "error" | "disconnected";

export const KIND_LABEL: Record<IntegrationKind, string> = { meta: "Meta Ads", google: "Google Ads", tiktok: "TikTok Ads", klaviyo: "Klaviyo", brevo: "Brevo", customerio: "Customer.io", shopify: "Shopify", crm: "CRM", motion: "Motion" };

/** Hours without a fresh read before a connection counts as stale (the syncs run hourly to every few hours) */
export const STALE_HOURS: Record<IntegrationKind, number> = { meta: 30, google: 36, tiktok: 36, klaviyo: 30, brevo: 30, customerio: 30, shopify: 30, crm: 36, motion: 48 };

export type Reading = {
  kind: IntegrationKind;
  label?: string | null;
  /** The record exists and says connected (a row marked disconnected or revoked is not) */
  connected: boolean;
  status?: string | null;
  error?: string | null;
  /** The last good read (a sync time, or the newest day of data) */
  lastAt?: string | null;
  /** The token runs out at (Motion's OAuth token) */
  expiresAt?: string | null;
  /** The connection refreshes its own token (an expired access token alone isn't a problem) */
  refreshes?: boolean;
};

export type Health = { kind: IntegrationKind; label: string; state: HealthState; detail: string };

const AUTH = /unauthori[sz]ed|\b401\b|\b403\b|revoked|invalid (?:api )?key|invalid_grant|expired|forbidden|not authenticated|reconnect|permission|access token|oauth/i;

const hoursSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 3_600_000;
const ago = (h: number) => (h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);

/** One connection's health, worst first: disconnected, erroring, stale, fine */
export function healthOf(r: Reading, now = new Date()): Health {
  const label = r.label || KIND_LABEL[r.kind];
  const base = { kind: r.kind, label };
  const status = String(r.status ?? "").toLowerCase();
  if (!r.connected || /disconnect|revoked|uninstall|removed|inactive/.test(status)) return { ...base, state: "disconnected", detail: `${label} isn't connected${status && status !== "connected" ? ` (${status})` : ""}` };
  if (r.error && r.error.trim()) return { ...base, state: AUTH.test(r.error) ? "disconnected" : "error", detail: `${label}: ${r.error.replace(/\s+/g, " ").trim().slice(0, 160)}` };
  if (r.expiresAt && Date.parse(r.expiresAt) < now.getTime() && !r.refreshes) return { ...base, state: "disconnected", detail: `${label}'s access ran out ${ago(hoursSince(r.expiresAt, now))} ago: reconnect it` };
  if (!r.lastAt) return { ...base, state: "stale", detail: `${label} hasn't been read yet` };
  const h = hoursSince(r.lastAt, now);
  if (h > STALE_HOURS[r.kind]) return { ...base, state: "stale", detail: `${label} last read ${ago(h)} ago` };
  return { ...base, state: "ok", detail: `${label} read ${ago(Math.max(0, h))} ago` };
}

export const isProblem = (h: Health) => h.state !== "ok";
const RANK: Record<HealthState, number> = { disconnected: 0, error: 1, stale: 2, ok: 3 };
export const sortHealth = (hs: readonly Health[]) => [...hs].sort((a, b) => RANK[a.state] - RANK[b.state] || a.label.localeCompare(b.label));

// ─── Tomorrow's client calls ────────────────────────────────────────────────

export type CalEvent = { id: string; summary?: string | null; start?: string | null; attendees?: { email?: string | null }[] | null; status?: string | null };
export type ClientMatch = { id: string; name: string; emails: readonly string[]; domains: readonly string[] };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const GENERIC = /^(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|proton(mail)?)\./;

/**
 * Which client a calendar event is a call with: one of its contacts invited (their email, or their company's own
 * domain), else the client's name in the title. Internal-only events (nobody outside Kaizen) never match by name alone
 * unless the title names the client. Cancelled events never match.
 */
export function clientOfEvent(ev: CalEvent, clients: readonly ClientMatch[], ownDomain = "kaizenmarketing.agency"): ClientMatch | null {
  if (String(ev.status ?? "") === "cancelled") return null;
  const guests = (ev.attendees ?? []).map((a) => String(a.email ?? "").toLowerCase()).filter((e) => e && !e.endsWith(`@${ownDomain}`) && !e.endsWith("resource.calendar.google.com"));
  for (const c of clients) {
    if (guests.some((g) => c.emails.includes(g))) return c;
    if (guests.some((g) => { const d = g.split("@")[1] ?? ""; return Boolean(d) && !GENERIC.test(`${d}.`) && c.domains.includes(d); })) return c;
  }
  const title = fold(String(ev.summary ?? ""));
  if (!title) return null;
  // The longest client name first ("Crust Pizza - Gleannloch" before "Crust Pizza")
  const byLength = [...clients].filter((c) => fold(c.name).length >= 4).sort((a, b) => b.name.length - a.name.length);
  return byLength.find((c) => new RegExp(`(^|[^a-z0-9])${fold(c.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(title)) ?? null;
}
