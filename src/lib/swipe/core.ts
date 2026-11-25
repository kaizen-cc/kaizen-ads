// The swipe bot's plain rules (no server imports; tested in tests/swipe.test.ts, and the browser runner in
// scripts/swipe-runner.mjs keeps the same CAPTCHA and robots rules). Which brand an email belongs to (its plus-address),
// what it followed (signup, browse, cart, checkout) and how long after, how emails group into flows, when a brand has
// gone silent, and the slugs and addresses brands are signed up with.

export const SWIPE_DOMAIN = "kaizenmarketing.agency";
export const SWIPE_LOCAL = "swipe";
export const SILENT_DAYS = 14;

/** A brand's slug: lowercase letters and digits, 2 to 40 */
export const slugOf = (name: string) => name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "").slice(0, 40);

/** The address a brand signs up with: swipe+<slug>@kaizenmarketing.agency (one identity per brand) */
export const addressOf = (slug: string) => `${SWIPE_LOCAL}+${slug}@${SWIPE_DOMAIN}`;

/** The brand an email was sent to, from any of its recipient headers ("swipe+glossier@…" → "glossier") */
export function slugFromRecipients(...headers: (string | null | undefined)[]): string | null {
  for (const h of headers) {
    const m = new RegExp(`${SWIPE_LOCAL}\\+([a-z0-9]{2,40})@${SWIPE_DOMAIN.replace(/\./g, "\\.")}`, "i").exec(String(h ?? ""));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export type FlowType = "welcome" | "browse" | "cart" | "checkout" | "winback" | "campaign" | "transactional" | "other";
export const FLOW_TYPES: readonly FlowType[] = ["welcome", "browse", "cart", "checkout", "winback", "campaign", "transactional", "other"];
export const FLOW_LABEL: Record<FlowType, string> = { welcome: "Welcome", browse: "Browse abandon", cart: "Cart abandon", checkout: "Checkout abandon", winback: "Winback", campaign: "Campaign", transactional: "Transactional", other: "Other" };
export const isFlowType = (v: unknown): v is FlowType => typeof v === "string" && (FLOW_TYPES as readonly string[]).includes(v);

export type Triggers = { signup: string | null; browse: string | null; cart: string | null; checkout: string | null };

/** The last thing the bot did before an email arrived, and how many hours before (the email's place in a flow) */
export function triggerOf(receivedAt: string, t: Triggers): { kind: keyof Triggers | null; hours: number | null } {
  const at = Date.parse(receivedAt);
  let best: { kind: keyof Triggers; ms: number } | null = null;
  for (const k of ["signup", "browse", "cart", "checkout"] as const) {
    const v = t[k] ? Date.parse(t[k]!) : NaN;
    if (Number.isFinite(v) && v <= at && (!best || v > best.ms)) best = { kind: k, ms: v };
  }
  return best ? { kind: best.kind, hours: Math.round(((at - best.ms) / 3_600_000) * 100) / 100 } : { kind: null, hours: null };
}

/** What a trigger would set off, as the flow type to expect (the classifier decides; this is its hint) */
export const expectedFlow: Record<keyof Triggers, FlowType> = { signup: "welcome", browse: "browse", cart: "cart", checkout: "checkout" };

export type FlowEmail = { id: string; brand: string; type: FlowType; at: string; trigger: string | null };

/**
 * Emails into flows: per brand and type, a flow starts at its first email and takes every later one of the same type
 * within 21 days of the previous; campaigns are each their own. Steps in order, with the hours between them.
 */
export function groupFlows(emails: readonly FlowEmail[]): { brand: string; type: FlowType; startedAt: string; ids: string[]; gapsHours: number[] }[] {
  const out: { brand: string; type: FlowType; startedAt: string; ids: string[]; gapsHours: number[]; last: number }[] = [];
  const sorted = [...emails].sort((a, b) => a.at.localeCompare(b.at));
  for (const e of sorted) {
    const t = Date.parse(e.at);
    const open = e.type === "campaign" ? null : [...out].reverse().find((f) => f.brand === e.brand && f.type === e.type && t - f.last <= 21 * 86_400_000);
    if (open) {
      open.gapsHours.push(Math.round(((t - open.last) / 3_600_000) * 10) / 10);
      open.ids.push(e.id);
      open.last = t;
    } else out.push({ brand: e.brand, type: e.type, startedAt: e.at, ids: [e.id], gapsHours: [], last: t });
  }
  return out.map((f) => ({ brand: f.brand, type: f.type, startedAt: f.startedAt, ids: f.ids, gapsHours: f.gapsHours }));
}

/** "3 emails: right away, +1 day, +3 days" */
export function cadenceText(gapsHours: readonly number[], firstOffsetHours: number | null): string {
  const fmt = (h: number) => (h < 1 ? "right away" : h < 36 ? `+${Math.round(h)}h` : `+${Math.round(h / 24)} days`);
  const parts = [firstOffsetHours == null ? "start" : fmt(firstOffsetHours)];
  let acc = firstOffsetHours ?? 0;
  for (const g of gapsHours) {
    acc += g;
    parts.push(fmt(acc));
  }
  return `${gapsHours.length + 1} email${gapsHours.length ? "s" : ""}: ${parts.join(", ")}`;
}

/** A brand that has sent nothing 14 days after signing up */
export const isSilent = (b: { signed_up_at: string | null; emails: number }, now = Date.now()) => Boolean(b.signed_up_at) && b.emails === 0 && now - Date.parse(b.signed_up_at!) > SILENT_DAYS * 86_400_000;

// ─── The browser runner's rules ─────────────────────────────────────────────

/** A CAPTCHA or a bot wall on the page: the bot stops there and asks a human (never solves or bypasses it) */
export const CAPTCHA = /(recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|captcha-delivery|px-captcha|arkoselabs|funcaptcha|g-recaptcha|h-captcha|cf-chl|are you a robot|verify you are human|press (?:&|and) hold)/i;

/** robots.txt: whether a path is allowed for any user agent (the "*" group; longest rule wins) */
export function robotsAllows(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim());
  const rules: { allow: boolean; path: string }[] = [];
  // Groups: one or more User-agent lines, then their rules; only the "*" group's rules apply
  let agents: string[] = [];
  let listing = false;
  for (const l of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!listing) agents = [];
      listing = true;
      agents.push(v.toLowerCase());
    } else if (k === "allow" || k === "disallow") {
      listing = false;
      if (agents.includes("*") && v) rules.push({ allow: k === "allow", path: v });
    }
  }
  const match = rules.filter((r) => {
    const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return re.test(path);
  });
  if (!match.length) return true;
  match.sort((a, b) => b.path.length - a.path.length || (a.allow ? -1 : 1));
  return match[0].allow;
}
