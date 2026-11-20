// The escalation ladder, one for every service line (owner, Nov 20 2026; the pure rules, tested in
// tests/escalation-ladder.test.ts). An alert goes to whoever owns the item first (the strategist, buyer or maker).
// Only after 48 hours with nothing done does it reach that line's lead or head, and what the lead gets is a drafted
// Slack message nudging the teammate who's behind (sent as the lead, from their own Slack), never the work itself.
// An item marked "waiting on client" (src/lib/item-comments.ts) doesn't climb while it waits.

export const LADDER_HOURS = 48;

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
  const days = Math.max(2, Math.round(o.hours / 24));
  const about = o.client ? `${o.client}: ${o.what}` : o.what;
  return `Hey ${first(o.teammate)}, checking in on ${about}. It's been about ${days} days with nothing moving on it. Where are you at? If you're stuck or swamped, tell me and I'll help you sort it out today.`;
}

/** The stable key a nudge is kept under (one per item and teammate) */
export const nudgeKey = (itemKey: string) => `nudge:${itemKey}`.slice(0, 200);
