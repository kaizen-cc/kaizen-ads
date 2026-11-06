// Kaizen only touches what Kaizen set up. A launch (Google or Meta) goes into a campaign whose name says Kaizen, a paused
// Kaizen campaign brought back, or a new campaign that has Kaizen in its name, following the way the account already
// names its Kaizen campaigns ("Search | Non Brand | Kaizen", "[Kaizen] Prospecting"). Everything else in the account is
// read for context (what converts, what's running) and never written to. Pure: the server, the cards and the tests
// (tests/kaizen-scope.test.ts) agree.

/** "Kaizen" as a whole word in a name, whatever wraps it: "| Kaizen", "Kaizen -", "[Kaizen]", "Kaizen_Search" */
export function isKaizenName(name: string | null | undefined): boolean {
  return /(^|[^a-z0-9])kaizen([^a-z0-9]|$)/i.test(String(name ?? ""));
}

/** How an account writes Kaizen into its names: before or after the rest, with which separator, in brackets or not */
export type KaizenStyle = { position: "prefix" | "suffix"; sep: string; bracket: boolean };

const DEFAULT_STYLE: KaizenStyle = { position: "suffix", sep: " | ", bracket: false };

/** The style most of the account's Kaizen names use (" | Kaizen" at the end when there's nothing to learn from) */
export function kaizenStyle(names: (string | null | undefined)[]): KaizenStyle {
  const seen = new Map<string, { style: KaizenStyle; n: number }>();
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!isKaizenName(name)) continue;
    const bracket = /[[(]\s*kaizen\s*[\])]/i.test(name);
    const m = name.match(/kaizen/i);
    if (!m || m.index == null) continue;
    const before = name.slice(0, m.index).replace(/[[(]\s*$/, "");
    const after = name.slice(m.index + m[0].length).replace(/^\s*[\])]/, "");
    // At the very start (or only brackets before it): a prefix; otherwise a suffix (the usual "… | Kaizen")
    const prefix = !before.trim() && Boolean(after.trim());
    const gap = prefix ? (after.match(/^\s*[|\-–_:/•·]+\s*|^\s+/)?.[0] ?? " ") : (before.match(/\s*[|\-–_:/•·]+\s*$|\s+$/)?.[0] ?? " ");
    const sep = gap.trim() ? gap.replace(/\s+/g, " ") : " ";
    const style: KaizenStyle = { position: prefix ? "prefix" : "suffix", sep: sep === " " && !bracket ? " | " : sep, bracket };
    const key = JSON.stringify(style);
    seen.set(key, { style, n: (seen.get(key)?.n ?? 0) + 1 });
  }
  return [...seen.values()].sort((a, b) => b.n - a.n)[0]?.style ?? DEFAULT_STYLE;
}

/** A name with Kaizen in it: as it is when it already has it, else Kaizen added the way the account's names have it */
export function withKaizen(name: string | null | undefined, examples: (string | null | undefined)[] = []): string {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (isKaizenName(n)) return n;
  if (!n) return "Kaizen";
  const s = kaizenStyle(examples);
  const tag = s.bracket ? "[Kaizen]" : "Kaizen";
  const sep = s.bracket ? " " : s.sep;
  return s.position === "prefix" ? `${tag}${sep}${n}` : `${n}${sep}${tag}`;
}

/** Whether new ad groups / ad sets should carry Kaizen too: most of the ones inside Kaizen campaigns already do */
export function childrenNamedKaizen(names: (string | null | undefined)[]): boolean {
  const list = names.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (list.length < 2) return false;
  return list.filter(isKaizenName).length / list.length >= 0.5;
}

/** A Meta ad set Kaizen set up: its own name or its campaign's says Kaizen */
export const isKaizenAdset = (s: { name: string; campaign?: string | null; campaignName?: string | null }) => isKaizenName(s.name) || isKaizenName(s.campaign ?? s.campaignName ?? "");

/** What's said when a buyer names something Kaizen didn't set up */
export function notKaizenLine(name: string, kaizenAlt: string | null, level: "campaign" | "ad set" = "campaign") {
  return `"${name}" wasn't set up by Kaizen, so I won't touch it. I'd use ${kaizenAlt ? `"${kaizenAlt}"` : `a new Kaizen ${level === "campaign" ? "campaign" : "ad set"}`}${kaizenAlt ? ` or a new Kaizen ${level}` : ""}.`;
}

// ─── Bringing a paused Kaizen campaign back ─────────────────────────────────────────────────────────────────────

/** One campaign's track record from the daily tables (Google or Meta), its results judged on the client's KPI */
export type CampaignHistory = {
  id: string;
  name: string;
  status: string;
  type: string | null;
  spend30: number;
  results30: number;
  spend90: number;
  results90: number;
  spend180: number;
  results180: number;
  revenue180: number;
  /** Cost per result (or ROAS on a ROAS KPI) over the last 180 days it ran */
  value180: number | null;
  firstSpent: string | null;
  lastSpent: string | null;
  /** When it was paused, from the account's change history */
  pausedAt: string | null;
};

/** One day of one campaign, already reduced to the KPI's result (Google: conversions; Meta: the KPI's action type) */
export type CampaignDay = { id: string; name: string; date: string; spend: number; results: number; revenue: number };

const r2 = (x: number) => Math.round(x * 100) / 100;
const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Each campaign's 30, 90 and 180 days (to `today`), cost per result or ROAS, and when it last spent */
export function historyOf(days: CampaignDay[], status: Map<string, { status: string; type?: string | null }>, o: { today: string; roas: boolean }): CampaignHistory[] {
  const from30 = shiftDay(o.today, -29);
  const from90 = shiftDay(o.today, -89);
  const from180 = shiftDay(o.today, -179);
  const by = new Map<string, CampaignHistory>();
  for (const d of days) {
    if (d.date < from180 || d.date > o.today) continue;
    const s = status.get(d.id);
    const h = by.get(d.id) ?? { id: d.id, name: d.name, status: s?.status ?? "UNKNOWN", type: s?.type ?? null, spend30: 0, results30: 0, spend90: 0, results90: 0, spend180: 0, results180: 0, revenue180: 0, value180: null, firstSpent: null, lastSpent: null, pausedAt: null };
    if (d.name && (!h.lastSpent || d.date >= h.lastSpent)) h.name = d.name;
    h.spend180 += d.spend;
    h.results180 += d.results;
    h.revenue180 += d.revenue;
    if (d.date >= from90) {
      h.spend90 += d.spend;
      h.results90 += d.results;
    }
    if (d.date >= from30) {
      h.spend30 += d.spend;
      h.results30 += d.results;
    }
    if (d.spend > 0) {
      if (!h.lastSpent || d.date > h.lastSpent) h.lastSpent = d.date;
      if (!h.firstSpent || d.date < h.firstSpent) h.firstSpent = d.date;
    }
    by.set(d.id, h);
  }
  return [...by.values()].map((h) => ({
    ...h,
    spend30: r2(h.spend30),
    spend90: r2(h.spend90),
    spend180: r2(h.spend180),
    results30: Math.round(h.results30 * 10) / 10,
    results90: Math.round(h.results90 * 10) / 10,
    results180: Math.round(h.results180 * 10) / 10,
    revenue180: r2(h.revenue180),
    value180: o.roas ? (h.spend180 ? r2(h.revenue180 / h.spend180) : null) : h.results180 ? r2(h.spend180 / h.results180) : null,
  }));
}

/** The whole account's cost per result (or ROAS) over 90 days: what a campaign is held to when there's no KPI target */
export function accountValue(hist: CampaignHistory[], roas: boolean): number | null {
  const spend = hist.reduce((s, h) => s + h.spend90, 0);
  if (roas) {
    // Revenue is only kept for 180 days: the 90-day share of it, by spend
    const rev = hist.reduce((s, h) => s + (h.spend180 ? (h.revenue180 * h.spend90) / h.spend180 : 0), 0);
    return spend ? r2(rev / spend) : null;
  }
  const results = hist.reduce((s, h) => s + h.results90, 0);
  return results ? r2(spend / results) : null;
}

/** The thresholds a paused Kaizen campaign must clear to be offered back (exported so the report and tests agree) */
export const COMEBACK = {
  /** It must have spent at least this much in the last 180 days (or twice the CPA target, whichever is more) */
  minSpend: 100,
  /** …and brought at least this many results */
  minResults: 3,
  /** …and spent within this many days (older history says little about today's auction) */
  maxDaysSince: 180,
  /** CPA at most this much over the target (ROAS at least target ÷ this) */
  vsTarget: 1.2,
  /** Without a target: CPA at most this much over the account's own 90-day CPA (ROAS at least account ÷ this) */
  vsAccount: 1.1,
  /** Without a target or an account number: this many results at least */
  minResultsBlind: 5,
} as const;

export type Comeback = { id: string; name: string; why: string; value: number | null; target: number | null; roas: boolean; pausedAt: string | null; score: number };

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "kaizen"));
const money = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const day = (s: string | null) => (s ? new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null);

/**
 * The paused Kaizen campaign worth bringing back for this launch, or null. Only a Kaizen-named campaign that's paused
 * (never removed), that spent and converted enough in the last 180 days, at a CPA within 20% of the KPI target (ROAS
 * within 20% under it; without a target, against the account's own 90 days), of the right type, and that the latest
 * audit or sprint didn't say to cut. The best fit by result, then by how well its name fits what's launched.
 */
export function comebackPick(
  hist: CampaignHistory[],
  o: { today: string; roas: boolean; target: number | null; theme: string; types?: string[] | null; flagged?: Set<string>; pausedStatuses?: string[] },
): Comeback | null {
  const paused = new Set(o.pausedStatuses ?? ["PAUSED"]);
  const bench = o.target ?? accountValue(hist, o.roas);
  const fromTarget = o.target != null;
  const want = words(o.theme);
  const since = (d: string | null) => (d ? Math.round((Date.parse(`${o.today}T12:00:00Z`) - Date.parse(`${d.slice(0, 10)}T12:00:00Z`)) / 86_400_000) : Infinity);
  const out: Comeback[] = [];
  for (const h of hist) {
    if (!isKaizenName(h.name) || !paused.has(h.status)) continue;
    if (o.types?.length && h.type && !o.types.includes(h.type)) continue;
    if (o.flagged?.has(h.id)) continue;
    const minSpend = Math.max(COMEBACK.minSpend, !o.roas && o.target ? o.target * 2 : 0);
    if (h.spend180 < minSpend || h.results180 < COMEBACK.minResults) continue;
    if (since(h.lastSpent) > COMEBACK.maxDaysSince) continue;
    const v = h.value180;
    if (v == null) continue;
    let ratio: number;
    if (bench != null && bench > 0) {
      const limit = fromTarget ? COMEBACK.vsTarget : COMEBACK.vsAccount;
      ratio = o.roas ? v / bench : bench / v;
      if (ratio < 1 / limit) continue;
    } else {
      if (h.results180 < COMEBACK.minResultsBlind) continue;
      ratio = 1;
    }
    const fit = [...words(h.name)].filter((w) => want.has(w)).length;
    const vs = bench != null ? ` vs ${fromTarget ? "the" : "the account's"} ${o.roas ? `${bench}x` : money(bench)}${fromTarget ? " target" : ""}` : "";
    const when = day(h.pausedAt ?? h.lastSpent);
    const why = `${h.name} ran at ${o.roas ? `${v}x ROAS` : `${money(v)} CPA`}${vs} (${Math.round(h.results180)} ${o.roas ? "purchases" : "results"} on ${money(h.spend180)})${when ? ` until it was paused ${when}` : ""}.`;
    out.push({ id: h.id, name: h.name, why, value: v, target: bench, roas: o.roas, pausedAt: h.pausedAt, score: Math.round((ratio * 100 + fit * 40 + Math.min(30, Math.log10(1 + h.results180) * 15)) * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score)[0] ?? null;
}

/** What a master buyer knows walking into a launch, built once per run (src/lib/launch-context.ts) */
export type LaunchContext = { client: string; history: string; related: string; comeback: Comeback | null; kaizen: { live: number; paused: number; outside: number }; at: string };

/** The comeback offered as an option on the "where it goes" question */
export const comebackOption = (c: Pick<Comeback, "name">) => `Bring back ${c.name} (paused) with this in it`;

/** An answer that asks to bring a paused campaign back */
export const BRING_BACK = /\b(bring (it |that |this |them )?back|turn (it |that )?(back )?on|re-?activat|reviv|un-?pause|restart|switch (it )?back on)\b/i;

// ─── What's never asked, and "yes" answering only the question just asked ──────────────────────────────────────

/**
 * Questions that are Kaizen's rules, not the buyer's decisions: whether to create paused, and a match type for a
 * plainly written keyword (phrase, Kaizen's default). Tested on "key question".
 */
export const NOT_ASKED = /^(go_live|match_types?|paused|create_paused)\b|\bcreated? (everything |it |them |these |all )?paused\b|\bok to create paused\b|\bwhich match types?\b|\bwhat match types?\b/i;

/** A reply with any sentence about creating things paused taken out (it's Kaizen's rule, never news to the buyer) */
export function scrubPaused(text: string) {
  const out = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\b(taking (that|it|this) as paused|(everything|it all|all of it|it|they) (is|are|gets|get|will be|'ll be) created paused|created paused for you|ok(ay)? to create (it |them )?paused)\b/i.test(s))
    .join(" ")
    .trim();
  return out || text;
}

/** A short "yes" (or "sounds good", "go with that") with nothing else in it */
export const SHORT_YES = /^\s*(yes|yeah|yep|yup|ya|sure|ok(ay)?|k|sounds good|go (with|for) (it|that)|do (it|that)|that works|perfect|great|correct|right|agreed|fine|please( do)?|let'?s do (it|that)|go ahead|👍)\s*[.!]*\s*(please|thanks?|thank you)?\s*[.!]*\s*$/i;

const TOPIC: Record<string, RegExp> = {
  campaign: /\bcampaign\b|\bbring (it )?back\b|\bstart a (small )?(new )?one\b/i,
  ad_group: /\bad ?group\b/i,
  final_url: /\b(landing|page|link|url|send (people|them))\b/i,
  link: /\b(landing|page|link|url|send (people|them))\b/i,
  keywords: /\bkeywords?\b/i,
  match_types: /\bmatch( type)?\b|\bphrase\b|\bexact\b/i,
  ads: /\bheadlines?\b|\bad copy\b|\brsas?\b|\bwrite (the )?ads?\b|\bdescriptions?\b/i,
  budget: /\bbudget\b|\$\d|\/day\b|\bper day\b|\bdaily\b/i,
  structure: /\bad set\b|\bcampaign\b|\bwhere (it|they|these) go\b/i,
  targeting: /\btarget(ing)?\b|\bradius\b|\bages?\b|\bmiles?\b/i,
  rows: /\brows?\b/i,
  pages: /\bpage access\b|\bpartnership\b|\bbrand'?s page\b/i,
  posts: /\bexisting posts?\b/i,
};

/**
 * The question the last reply asked: the key it said it asked, else the open question its words are about (the last
 * one mentioned), else the first open required one. Null when nothing is open.
 */
export function askedKey(questions: { key: string; required: boolean; answer: string | null }[], last: { asks?: string | null; text: string } | null): string | null {
  const open = questions.filter((q) => !q.answer?.trim());
  if (!open.length) return null;
  if (last?.asks && open.some((q) => q.key === last.asks)) return last.asks;
  const text = last?.text ?? "";
  // The question sits at the end of the reply: the open question mentioned last wins
  const tail = text.split(/(?<=[.!?])\s+/).filter((s) => s.includes("?")).pop() ?? text;
  for (const part of [tail, text]) {
    const hits = open.filter((q) => TOPIC[q.key]?.test(part));
    if (hits.length) return hits.sort((a, b) => part.search(TOPIC[b.key]) - part.search(TOPIC[a.key]))[0].key;
  }
  return (open.find((q) => q.required) ?? open[0]).key;
}

/**
 * A short "yes" answers only the question just asked: the model's answers to any other question are dropped, and when
 * it gave none for the asked one, that question's proposal is taken. Anything longer than a short yes passes as it is.
 */
export function yesOnlyAnswersAsked(
  message: string,
  answers: { key: string; answer: string }[],
  questions: { key: string; required: boolean; answer: string | null; proposal: string }[],
  last: { asks?: string | null; text: string } | null,
): { key: string; answer: string }[] {
  if (!SHORT_YES.test(message)) return answers;
  const key = askedKey(questions, last);
  if (!key) return [];
  const own = answers.filter((a) => a.key === key && a.answer.trim());
  if (own.length) return own.slice(0, 1);
  const q = questions.find((x) => x.key === key);
  return q?.proposal.trim() ? [{ key, answer: q.proposal }] : [];
}
