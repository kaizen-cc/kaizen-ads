import type { Sections } from "@/lib/reports/write";
import { combineParts, engagementChain, type RateParts } from "@/lib/social/rate";
import type { SocialMetrics, SocialNumbers } from "./core";

// What a person adds to an organic social report that the numbers and the writer can't: the strategist's own findings.
//   Team notes   a note on the report, and one on each takeaway card. The AI writer is given them and works them in; they always
//                print on the report and the live page, labeled as the team's notes (never passed off as written by the app).
//   Overrides    a number the strategist enters for the period when Meta didn't report it (reach, views, interactions, followers),
//                with who and when. It replaces the missing figure for the period, the rate is worked out again from it, and the
//                report shows a small note that it was entered by the team.
// Both live in the report's sections (JSON), so no schema change; an AI rewrite carries them over untouched.

export type OverrideKey = "reach" | "views" | "interactions" | "followers";
export const OVERRIDE_KEYS: readonly OverrideKey[] = ["reach", "views", "interactions", "followers"];
export const OVERRIDE_LABEL: Record<OverrideKey, string> = { reach: "Reach", views: "Views", interactions: "Interactions", followers: "Followers" };

/** One figure the team entered by hand for the report's period */
export type MetricOverride = { key: OverrideKey; value: number; /** Who entered it (a name, shown to the team only) */ by: string; /** When, an ISO moment */ at: string; /** Why, in the team's words (optional) */ why?: string };

/** The longest a team note may be; the PDF card and the page both hold it */
export const TEAM_NOTE_MAX = 1200;
export const CARD_NOTE_MAX = 400;

/** Words safe for a client to read: no em or en dashes, no stray spacing */
export const plainNote = (s: string | null | undefined): string =>
  (s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type TeamFindings = { notes: string; cards: string[]; overrides: MetricOverride[] };

/** The team's findings on a report's sections, cleaned (empty when it has none) */
export function teamFindingsOf(sections: Pick<Sections, "teamNotes" | "cardNotes" | "overrides"> | null | undefined): TeamFindings {
  const overrides = (sections?.overrides ?? []).filter((o) => OVERRIDE_KEYS.includes(o.key) && Number.isFinite(o.value) && o.value >= 0);
  return { notes: plainNote(sections?.teamNotes).slice(0, TEAM_NOTE_MAX), cards: (sections?.cardNotes ?? []).map((c) => plainNote(c).slice(0, CARD_NOTE_MAX)), overrides };
}

export const hasTeamFindings = (sections: Pick<Sections, "teamNotes" | "cardNotes" | "overrides"> | null | undefined): boolean => {
  const f = teamFindingsOf(sections);
  return Boolean(f.notes || f.cards.some(Boolean) || f.overrides.length);
};

const dayWord = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "";
};

/** The small note under a figure the team entered ("Reach entered by the Kaizen team on Nov 18: Meta didn't report it for this period."). Never a person's name: the client reads this. */
export function overrideNote(o: MetricOverride, opts: { whiteLabel?: boolean } = {}): string {
  const who = opts.whiteLabel ? "the team" : "the Kaizen team";
  const on = dayWord(o.at);
  const why = plainNote(o.why);
  return `${OVERRIDE_LABEL[o.key]} entered by ${who}${on ? ` on ${on}` : ""}: ${why ? why.replace(/[.\s]+$/, "") : "Meta didn't report it for this period"}.`;
}

/** What the team entered, for the team's own list (with who and when) */
export const overrideLine = (o: MetricOverride): string => `${OVERRIDE_LABEL[o.key]} ${Math.round(o.value).toLocaleString("en-US")}, entered by ${o.by || "someone"}${dayWord(o.at) ? ` on ${dayWord(o.at)}` : ""}${o.why ? ` (${plainNote(o.why)})` : ""}`;

/**
 * The report's metrics with the team's overrides laid on the period: each entered figure replaces what Meta gave (or left out),
 * and the engagement rate is worked out again down the chain from them. Last period is read on the same basis so the two stay
 * like with like. Returns the same object when there is nothing to apply.
 */
export function applyOverrides(m: SocialMetrics, overrides: MetricOverride[] | null | undefined): SocialMetrics {
  const list = (overrides ?? []).filter((o) => OVERRIDE_KEYS.includes(o.key) && Number.isFinite(o.value) && o.value >= 0);
  if (!list.length) return m;
  const latest = new Map<OverrideKey, MetricOverride>();
  for (const o of list) {
    const was = latest.get(o.key);
    if (!was || o.at >= was.at) latest.set(o.key, o);
  }
  const now: SocialNumbers = { ...m.now };
  for (const [k, o] of latest) now[k] = o.value;
  const r = engagementChain({ interactions: now.interactions, reach: now.reach, views: now.views, followers: now.followers, posts: now.posts, fromPosts: null });
  now.rate = r.rate;
  now.rateBasis = r.basis;
  now.rateParts = r.parts;
  now.reachFrom = latest.has("reach") ? "meta" : now.reachFrom;
  // Last period on the basis this period now has
  const prior = m.before.rateParts ?? (m.before.reach && m.before.interactions != null ? { reach: { top: m.before.interactions, den: m.before.reach } } : {});
  const back = combineParts([prior as RateParts], { only: r.basis });
  const before: SocialNumbers = { ...m.before, rate: back.rate, rateBasis: back.basis };
  return { ...m, now, before, insightsRead: m.insightsRead || now.reach != null || now.rate != null, overrides: [...latest.values()] };
}

/** The sections' team findings and overrides laid on the metrics: the one call every drawing of a social report makes */
export const withTeamFindings = (m: SocialMetrics, sections: Pick<Sections, "overrides"> | null | undefined): SocialMetrics => applyOverrides(m, sections?.overrides);

/** An AI rewrite's new sections with the team's findings carried over exactly (the writer is told them, but never owns them) */
export function carryTeamFindings(prev: Sections | null | undefined, next: Sections): Sections {
  if (!prev) return next;
  const keep: Partial<Sections> = {};
  if (prev.teamNotes?.trim()) keep.teamNotes = prev.teamNotes;
  if (prev.cardNotes?.some((c) => c?.trim())) keep.cardNotes = prev.cardNotes;
  if (prev.overrides?.length) keep.overrides = prev.overrides;
  return { ...next, ...keep };
}

/** What the writer is told: the team's notes and entered figures, to work in and never contradict */
export function teamFindingsPrompt(sections: Pick<Sections, "teamNotes" | "cardNotes" | "overrides"> | null | undefined): string {
  const f = teamFindingsOf(sections);
  if (!f.notes && !f.cards.some(Boolean) && !f.overrides.length) return "";
  const lines = [
    `<team_notes note="written by the social strategist: real findings from the person who runs the account. Work them into the report where they belong (the takeaways, the summary, what we learned) in your own plain words, never contradict them, never invent detail beyond them. The app prints them on the report as the team's notes, so don't repeat them word for word.">`,
    f.notes ? f.notes : "",
    ...f.cards.map((c, i) => (c ? `- on takeaway ${i + 1}: ${c}` : "")),
    ...f.overrides.map((o) => `- figure entered by the team for this period (Meta didn't report it): ${OVERRIDE_LABEL[o.key]} = ${Math.round(o.value)}${o.why ? ` (${plainNote(o.why)})` : ""}; the numbers above already use it`),
    `</team_notes>`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * A saved report's team findings, cleaned and stamped: notes cut to their length, one entered figure per metric (whole, never
 * negative), and each figure that is new or changed stamped with who entered it and when (never taken from the browser).
 */
export function tidyTeamFindings(prev: Sections | null | undefined, next: Sections, by: string, nowIso: string): Sections {
  const was = new Map((prev?.overrides ?? []).map((o) => [o.key, o]));
  const seen = new Set<OverrideKey>();
  const overrides: MetricOverride[] = [];
  for (const o of next.overrides ?? []) {
    if (!OVERRIDE_KEYS.includes(o.key) || seen.has(o.key) || !Number.isFinite(o.value) || o.value < 0) continue;
    seen.add(o.key);
    const value = Math.round(o.value);
    const why = plainNote(o.why).slice(0, 300) || undefined;
    const before = was.get(o.key);
    const same = before && before.value === value && (before.why ?? undefined) === why;
    overrides.push(same ? before : { key: o.key, value, by: by.slice(0, 80), at: nowIso, ...(why ? { why } : {}) });
  }
  const out: Sections = { ...next };
  if (next.teamNotes !== undefined) out.teamNotes = (next.teamNotes ?? "").slice(0, TEAM_NOTE_MAX * 2);
  if (next.cardNotes !== undefined) out.cardNotes = next.cardNotes.slice(0, 6).map((c) => (c ?? "").slice(0, CARD_NOTE_MAX * 2));
  if (next.overrides !== undefined) out.overrides = overrides;
  return out;
}
