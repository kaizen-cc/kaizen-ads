// The senior buyer's playbook for one account: what he teaches on that platform, for that kind of business. Every
// distilled point carries the platform and the industry (our sub-vertical or vertical) and business model it came
// from. Points that only make sense for one kind of business are never taught to every buyer agent; they come with
// the account instead, closest first: its sub-vertical, then its vertical (the sub-vertical's siblings too), then
// accounts sold the same way (same business model). Plain functions, so the AI layer and the tests agree.

export type BuyerPlatform = "meta" | "google";
export type BusinessModel = "ecommerce" | "lead_gen" | "local" | "events" | "app";
export type PlaybookItem = {
  layer: "principle" | "rule" | "case" | "diagnostic" | "voice";
  body: string;
  platform: "meta" | "google" | "both" | "none";
  vertical_id: string | null;
  business_model: string | null;
  scope: "general" | "industry";
  confidence: number;
  at_seconds: number | null;
  tags: Record<string, unknown> | null;
};
export type VerticalNode = { id: string; name: string; parent_id: string | null };
export type PlaybookTarget = { platform: BuyerPlatform; verticalId: string | null; businessModel: BusinessModel | null };

/** A business model said in free text ("local service with online reservations", "lead gen (b2b)") as one of ours */
export function businessModelOf(text: string | null | undefined): BusinessModel | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim() || /^(unknown|n\/a|none|other)$/.test(t.trim())) return null;
  if (/\bapps?\b|app install/.test(t)) return "app";
  if (/ticket|\bevents?\b|festival|concert/.test(t)) return "events";
  if (/restaurant|reservation|venue|booking|bookable|ordering|walk-in|store visit|\blocal\b/.test(t) && !/lead/.test(t)) return "local";
  if (/lead|b2b|webinar|consult|quote|call|high-ticket|appointment/.test(t)) return "lead_gen";
  if (/e-?commerce|dtc|d2c|shopify|online store|online sales|subscription|purchase|course sales/.test(t)) return "ecommerce";
  if (/\blocal\b/.test(t)) return "local";
  return null;
}

/** Our clients' broad industry (clients.industry) as the way they sell */
export const MODEL_OF_INDUSTRY: Record<string, BusinessModel> = {
  ecommerce: "ecommerce",
  cpg: "ecommerce",
  restaurant: "local",
  hospitality: "local",
  entertainment: "local",
  fitness: "local",
  med_spa: "lead_gen",
  dental: "lead_gen",
  medical: "lead_gen",
  legal: "lead_gen",
  financial: "lead_gen",
  real_estate: "lead_gen",
  professional: "lead_gen",
  home_services: "lead_gen",
  automotive: "lead_gen",
  education: "lead_gen",
};

/** The cache key for a free-text industry */
export const industryKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

/** Which platform(s) an agent buys on, for its playbook; null: not a buyer agent (or a call that must stay as it is) */
const PLATFORM_OF: Partial<Record<string, BuyerPlatform>> = { auditor: "meta", launcher: "meta", fatigue: "meta", reporter: "meta", google_auditor: "google", google_launcher: "google", google_reporter: "google" };
// Calls that read or file the teachings themselves, or sort and classify, don't get the playbook
const NO_PLAYBOOK = ["loom ", "insight ", "sprint merge", "keyword relevance", "google policy check", "chat team change", "launch rules pattern", "joint report message", "recap deck map"];
export function playbookPlatforms(agent: string, label: string): BuyerPlatform[] {
  const p = PLATFORM_OF[agent];
  if (!p) return [];
  const l = label.toLowerCase();
  if (NO_PLAYBOOK.some((x) => l.startsWith(x))) return [];
  // The full business audit reads Meta and Google together
  if (l.startsWith("business audit")) return ["meta", "google"];
  return [p];
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const source = (i: PlaybookItem) => (i.at_seconds == null ? "[Loom]" : `[Loom ${clock(i.at_seconds)}]`);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * How close a point is to the account: 1 its sub-vertical, 2 its vertical (or a sibling sub-vertical), 3 the same
 * business model, 0 not this kind of business. Platform must be the account's or both.
 */
export function tierOf(i: PlaybookItem, t: PlaybookTarget, verticals: VerticalNode[]): 0 | 1 | 2 | 3 {
  if (i.platform !== t.platform && i.platform !== "both") return 0;
  const byId = new Map(verticals.map((v) => [v.id, v]));
  const mine = t.verticalId ? byId.get(t.verticalId) : undefined;
  const parentId = mine ? (mine.parent_id ?? mine.id) : null;
  if (i.vertical_id && mine) {
    if (i.vertical_id === mine.id) return 1;
    const theirs = byId.get(i.vertical_id);
    const theirParent = theirs ? (theirs.parent_id ?? theirs.id) : null;
    if (parentId && theirParent === parentId) return 2;
  }
  if (t.businessModel && i.business_model === t.businessModel) return 3;
  return 0;
}

/** The ordered pick: closest tier first, industry-only points before general ones (those are in the skills already), best supported first */
export function rankPlaybook(items: PlaybookItem[], t: PlaybookTarget, verticals: VerticalNode[]) {
  return items
    .filter((i) => i.layer !== "voice" && i.body.trim())
    .map((i) => ({ i, tier: tierOf(i, t, verticals) }))
    .filter((x) => x.tier > 0)
    .sort((a, b) => a.tier - b.tier || (a.i.scope === b.i.scope ? 0 : a.i.scope === "industry" ? -1 : 1) || b.i.confidence - a.i.confidence);
}

const TIER_NAME = { 1: "this sub-vertical", 2: "this vertical", 3: "same business model" } as const;
const LAYER_WORD = { principle: "Belief", rule: "Rule", diagnostic: "Check", case: "Case", voice: "Voice" } as const;

/**
 * The block an agent reads (about 3.5k characters at most): the rules, checks and beliefs he gives for this kind of
 * business on this platform, and the 3 to 5 closest cases (situation, read, action, outcome), each with its Loom moment.
 * "" when he has nothing on this kind of business yet.
 */
export function playbookText(items: PlaybookItem[], t: PlaybookTarget, verticals: VerticalNode[], industry: string, max = 3500) {
  const ranked = rankPlaybook(items, t, verticals);
  if (!ranked.length) return "";
  const head = `<senior_buyer_playbook platform="${t.platform}" industry="${industry.replace(/"/g, "'")}">\nHow Kaizen's senior buyer buys ${t.platform === "google" ? "Google Ads" : "Meta"} for businesses like this one, from his Loom audits: closest first (this sub-vertical, then its vertical, then accounts sold the same way). (n) is how many of his videos say it. Apply what fits this account and say which point you're using.\n`;
  const foot = `</senior_buyer_playbook>`;
  const cases = ranked.filter((x) => x.i.layer === "case").slice(0, 5);
  const points = ranked.filter((x) => x.i.layer !== "case");
  const caseLine = (x: (typeof ranked)[number]) => {
    const g = x.i.tags ?? {};
    const parts = [str(g.situation) || x.i.body.split("\n")[0].replace(/^Situation:\s*/, ""), str(g.read) && `read: ${str(g.read)}`, str(g.action) && `did: ${str(g.action)}`, str(g.outcome) && `outcome: ${str(g.outcome)}`].filter(Boolean) as string[];
    return `- (${TIER_NAME[x.tier as 1 | 2 | 3]}) ${parts.map((p) => p.slice(0, 220)).join(" → ")} ${source(x.i)}\n`;
  };
  // Cases get up to ~40% of the room, at least three when there are three; points fill the rest
  let caseText = "";
  for (const [n, x] of cases.entries()) {
    const line = caseLine(x);
    if (n >= 3 && caseText.length + line.length > max * 0.4) break;
    if (caseText.length + line.length > max * 0.55) break;
    caseText += line;
  }
  let pointText = "";
  const room = max - head.length - foot.length - (caseText ? caseText.length + 30 : 0) - 40;
  for (const x of points) {
    const line = `- ${LAYER_WORD[x.i.layer]} (${x.i.confidence}, ${TIER_NAME[x.tier as 1 | 2 | 3]}): ${x.i.body.replace(/\s+/g, " ").slice(0, 320)} ${source(x.i)}\n`;
    if (pointText.length + line.length > room) continue;
    pointText += line;
  }
  return `${head}${pointText ? `\nRules, checks and beliefs:\n${pointText}` : ""}${caseText ? `\nCases he walked through:\n${caseText}` : ""}${foot}`;
}
