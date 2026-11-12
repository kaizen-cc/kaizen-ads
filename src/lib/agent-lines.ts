// Settings › AI agents is grouped by service line first: each line shows its agents, and clicking it opens them. The
// line of a role agent comes from this one small function, so a new role lands in a sensible place without a code change.

export type LineKey = "strategy" | "meta" | "google" | "tiktok" | "email" | "creative" | "copy";

export type Line = { key: LineKey; label: string; description: string };

/** The lines in the order they're shown */
export const LINES: readonly Line[] = [
  { key: "strategy", label: "Strategy and whole team", description: "The agents every line leans on: strategy and briefs, market research, and client briefings." },
  { key: "meta", label: "Meta Ads", description: "Media buying on Meta: audits, launches, fatigue checks and client reports." },
  { key: "google", label: "Google Ads", description: "Media buying on Google: account audits, launches and client reports." },
  { key: "tiktok", label: "TikTok Ads", description: "Media buying on TikTok: audits, launches and reports, parked until its skills are written." },
  { key: "email", label: "Email Marketing", description: "Email strategy, design and copy, and building in Klaviyo. Parked until the core and skills are written." },
  { key: "creative", label: "Creative", description: "Design and video: reviewing creative against the brand and the brief." },
  { key: "copy", label: "Copy", description: "Ad copy and video scripts, in each client's voice." },
];

const LINE_OF_ROLE: Record<string, LineKey> = {
  strategist: "strategy",
  market_analyst: "strategy",
  account_manager: "strategy",
  media_buyer: "meta",
  google_buyer: "google",
  tiktok_buyer: "tiktok",
  email_strategist: "email",
  email_creative: "email",
  email_builder: "email",
  creative_director: "creative",
  copywriter: "copy",
};

/** The service line a role agent belongs to; a role this doesn't know sits with the whole team */
export const lineOfRole = (roleKey: string | null | undefined): LineKey => LINE_OF_ROLE[roleKey ?? ""] ?? "strategy";

/** A line from a URL value (?line=email), or null when it isn't one */
export const parseLine = (v: string | null | undefined): LineKey | null => LINES.find((l) => l.key === v)?.key ?? null;

export const lineByKey = (k: LineKey): Line => LINES.find((l) => l.key === k)!;

export type LineSummary = Line & { roles: string[]; agents: number; online: number; parked: number };

/** Every line that has agents, with how many are online and how many are parked (offline) */
export function summarizeLines(roles: readonly { key: string; offline?: boolean | null }[]): LineSummary[] {
  return LINES.map((l) => {
    const mine = roles.filter((r) => lineOfRole(r.key) === l.key);
    const parked = mine.filter((r) => r.offline).length;
    return { ...l, roles: mine.map((r) => r.key), agents: mine.length, online: mine.length - parked, parked };
  }).filter((l) => l.agents > 0);
}
