// The escalation ladder, one for every service line (owner, Nov 20 2026; the pure rules, tested in
// tests/escalation-ladder.test.ts). An alert goes to whoever owns the item first (the strategist, buyer or maker).
// Only after 48 hours with nothing done does it reach that line's lead or head, and what the lead gets is a drafted
// Slack message nudging the teammate who's behind (sent as the lead, from their own Slack), never the work itself.
// An item marked "waiting on client" (src/lib/item-comments.ts) doesn't climb while it waits.

export const LADDER_HOURS = 48;

/**
 * Each signal carries its own wait and rung. An unanswered client message (Slack or email) reaches the Client Success
 * Coordinator after 48 hours without a response (owner, Nov 23 2026; it was 12 business hours); everything else climbs
 * to the line's lead after 48 hours. Either way the execs hear only after another 48 hours with nothing moving (rung 3).
 */
export type Wait = { hours: number; business?: boolean };
export const CLIENT_REPLY_WAIT: Wait = { hours: 48 };
export const DEFAULT_WAIT: Wait = { hours: LADDER_HOURS };
/** The Client Success Coordinator: who an unanswered client message climbs to */
export const CLIENT_REPLY_ROLE = "customer_success";

const nyClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false });
/** Business hours (weekdays 8am to 6pm New York) between two moments, to the quarter hour, up to two weeks */
export function businessHoursBetween(from: Date, to: Date): number {
  let n = 0;
  const step = 15 * 60_000;
  const end = Math.min(to.getTime(), from.getTime() + 14 * 86_400_000);
  for (let t = from.getTime(); t < end; t += step) {
    const parts = nyClock.formatToParts(new Date(t));
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    if (wd !== "Sat" && wd !== "Sun" && h >= 8 && h < 18) n += 0.25;
  }
  return n;
}

/** Whether an item has waited long enough on its own rule */
export function waitedOut(since: string, wait: Wait = DEFAULT_WAIT, now = new Date()): boolean {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return false;
  return wait.business ? businessHoursBetween(new Date(t), now) >= wait.hours : hasClimbed(since, now, wait.hours);
}

export type Line = "creative" | "email" | "social" | "meta" | "google";

/** Who each role answers to, nearest first: a maker's lead, then the line's head. Execs and heads answer to nobody here. */
export const LADDER: Record<string, readonly string[]> = {
  graphic_designer: ["lead_graphic_designer", "head_of_creative"],
  video_editor: ["lead_video_editor", "head_of_creative"],
  lead_graphic_designer: ["head_of_creative"],
  lead_video_editor: ["head_of_creative"],
  copywriter: ["head_of_creative"],
  media_buyer: ["head_of_meta"],
  tiktok_buyer: ["head_of_meta"],
  google_buyer: ["head_of_google"],
  email_strategist: ["head_of_email"],
  email_designer: ["head_of_email"],
  email_builder: ["head_of_email"],
  social_media_manager: ["head_of_social"],
};

export const LINE_OF_ROLE: Record<string, Line> = {
  graphic_designer: "creative",
  video_editor: "creative",
  lead_graphic_designer: "creative",
  lead_video_editor: "creative",
  copywriter: "creative",
  head_of_creative: "creative",
  media_buyer: "meta",
  tiktok_buyer: "meta",
  head_of_meta: "meta",
  google_buyer: "google",
  head_of_google: "google",
  email_strategist: "email",
  email_designer: "email",
  email_builder: "email",
  head_of_email: "email",
  social_media_manager: "social",
  head_of_social: "social",
};

/** The roles an item on this person climbs to, nearest first (empty: nobody above them on a line) */
export const ladderFor = (role: string | null | undefined): readonly string[] => LADDER[String(role ?? "")] ?? [];

/**
 * The lead who hears: the nearest rung with someone active in it. A video editor's item reaches the lead video editor,
 * or the Head of Creative when there's no lead video editor.
 */
export function leadFor(role: string | null | undefined, active: readonly { id: string; role: string }[], ownerId?: string): { id: string; role: string } | null {
  for (const r of ladderFor(role)) {
    const p = active.find((a) => a.role === r && a.id !== ownerId);
    if (p) return p;
  }
  return null;
}

/** Whether an item untouched since `since` has climbed: 48 hours with nothing done */
export function hasClimbed(since: string | Date, now = new Date(), hours = LADDER_HOURS): boolean {
  const t = typeof since === "string" ? Date.parse(since) : since.getTime();
  return Number.isFinite(t) && now.getTime() - t >= hours * 3_600_000;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * The lead's card: a short Slack DM to the teammate, in the lead's voice, about the one thing that's behind. Plain and
 * friendly, never a dump of the work: what it is, how long it's been, and an ask for an update or a hand.
 */
export function nudgeDraft(o: { teammate: string; what: string; client?: string | null; hours: number; kind?: string }): string {
  const about = o.client ? `${o.client}: ${o.what}` : o.what;
  // A client waiting on a reply: same day, in hours
  if (o.kind === "client_reply") return `Hey ${first(o.teammate)}, ${about} is still waiting on a reply from us (about ${Math.max(1, Math.round(o.hours))} hours now). Can you get back to them today? If you're stuck on what to say, tell me and I'll help.`;
  const days = Math.max(2, Math.round(o.hours / 24));
  return `Hey ${first(o.teammate)}, checking in on ${about}. It's been about ${days} days with nothing moving on it. Where are you at? If you're stuck or swamped, tell me and I'll help you sort it out today.`;
}

/** The stable key a nudge is kept under (one per item and teammate) */
export const nudgeKey = (itemKey: string) => `nudge:${itemKey}`.slice(0, 200);

/** Whether a role is a lead on the ladder (a teammate's stuck work climbs to them) */
export const isLadderLead = (role: string | null | undefined): boolean => Object.values(LADDER).some((rungs) => rungs.includes(String(role ?? "")));

/**
 * Which service line a stuck item belongs to, so it reaches only the execs on that line (owner, Nov 25 2026: the email
 * exec saw Meta step-ins): the owner's role decides (a buyer, a designer, an email strategist); an item an exec or a
 * coordinator owns belongs to the line of the owner's own focus that the client buys (an exec's reply to a Meta client
 * is Meta), else their first focus line, else the lead's role. Null only when nothing says (it then reaches nobody but
 * the owner's "All lines").
 */
export function stuckLine(o: { ownerRole?: string | null; ownerFocus?: readonly string[] | null; clientLines?: readonly string[] | null; leadRole?: string | null }): string | null {
  const byRole = o.ownerRole ? LINE_OF_ROLE[o.ownerRole] : undefined;
  if (byRole) return byRole;
  const focus = (o.ownerFocus ?? []).filter((f) => f !== "creative_performance");
  const buys = new Set(o.clientLines ?? []);
  const fromFocus = focus.find((f) => buys.has(f)) ?? focus[0];
  if (fromFocus) return fromFocus;
  return (o.leadRole ? LINE_OF_ROLE[o.leadRole] : undefined) ?? null;
}
