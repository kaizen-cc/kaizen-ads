// Ads Lab's address: which platform (?line=) and which tab (?tab=) are open, so back and forward step through them
// and a pasted link opens the same view. Meta is the default and has no ?line=.

export type IdeasLine = "meta" | "google" | "tiktok";
export type IdeasTab = "fame" | "winners" | "market" | "verticals" | "copy";

const TABS: IdeasTab[] = ["fame", "winners", "market", "verticals", "copy"];
/** TikTok has no public ad library API for US ads: only our own clients' winners, so only these two */
export const TIKTOK_TABS: IdeasTab[] = ["fame", "winners"];

/** The platform asked for; TikTok only while there's TikTok data (otherwise Meta) */
export function ideasLine(asked: unknown, hasTikTok: boolean): IdeasLine {
  if (asked === "google") return "google";
  if (asked === "tiktok" && hasTikTok) return "tiktok";
  return "meta";
}

/** The tab asked for, within what the platform has (TikTok: Hall of Fame and Live winners) */
export function ideasTab(asked: unknown, line: IdeasLine): IdeasTab {
  const t = TABS.includes(asked as IdeasTab) ? (asked as IdeasTab) : "fame";
  return line === "tiktok" && !TIKTOK_TABS.includes(t) ? "fame" : t;
}

/** The address for a tab on a platform, keeping the client picked (if any) */
export function ideasHref(tab: IdeasTab, line: IdeasLine, client?: unknown): string {
  const q = new URLSearchParams();
  if (line !== "meta") q.set("line", line);
  q.set("tab", line === "tiktok" && !TIKTOK_TABS.includes(tab) ? "fame" : tab);
  if (typeof client === "string" && client) q.set("client", client);
  return `/ideas?${q.toString()}`;
}
