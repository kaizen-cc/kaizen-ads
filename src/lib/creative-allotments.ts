// Creative allotment gaps, per client and per pool, for the creative team's Overview and Next for me. Plain functions
// (safe anywhere, tested in tests/creative-allotments.test.ts); the loader is creative-allotments-load.ts.
//
// How it counts (the same numbers as public.client_allotment_usage, src/lib/allotment.ts):
// * The cycle is the client's creative billing cycle: it starts on their billing day (from Stripe via Kaizen Track,
//   src/lib/client-sync.ts) and resets on the same day next month. The view gives it; cycleFor() is the same rule.
// * Requested this cycle = what the view counts as used: everything asked this cycle (delivered or not) plus anything
//   still in the production line whatever cycle it was asked in (Asana briefs not started yet included), every
//   version, a carousel per slide, each piece once. Briefs sent clear a gap the moment they're sent.
// * In motion = on the board or in Asana and not delivered yet, whatever cycle it was asked in (already inside used).
// * Missing = the cap less what's requested. Nothing in motion = nothing requested and nothing on its way.
// * Pacing: work spread evenly through the cycle. "Due this week" is what has to be briefed by a week from today to
//   stay on that even line (all of what's missing in the last week), so the team doesn't make it all in one batch.
// * Urgency orders the list: what's missing over the days left to the reset (the closer the reset and the bigger the
//   gap, the higher), nothing in motion first among equals.
// Paused clients (status) and a paused creative service (watch_pauses 'creative') never reach here: the loader drops them.

export type GapPool = "images" | "videos";

/** What Suggest briefs and Create brief need for a gap (serializable, to hand to the browser) */
export type BriefIdea = { clientId: string; slug: string; key: string; label: string; text: string; format: "image" | "video" | "carousel" | null; kicker: string };

export type UsageLike = {
  client_id: string;
  images_per_month: number | null;
  videos_per_month: number | null;
  images_used: number | null;
  videos_used: number | null;
  asana_waiting_images?: number | null;
  asana_waiting_videos?: number | null;
  progress_images?: number | null;
  progress_videos?: number | null;
  period_start?: string | null;
  period_end?: string | null;
  billing_day?: number | null;
};

export type AllotmentGap = {
  clientId: string;
  client: string;
  slug: string;
  pool: GapPool;
  cap: number;
  /** Asked this cycle (tickets, Asana tasks counted, Asana briefs not started) */
  requested: number;
  /** On its way: not delivered yet, any cycle */
  inMotion: number;
  /** Asked this cycle and already past production (requested less what's still in motion, never below 0) */
  delivered: number;
  missing: number;
  over: number;
  /** The day the allotment starts again (YYYY-MM-DD) */
  resetsOn: string;
  daysLeft: number;
  /** How far through the cycle (0 to 1) */
  elapsed: number;
  state: "nothing" | "missing" | "covered" | "over";
  /** To brief within the next 7 days to stay on an even pace */
  dueThisWeek: number;
  urgency: number;
  /** "3 videos missing · resets in 2 days" */
  line: string;
  /** "2 this week to stay on pace" */
  pace: string;
  /** "Nothing delivered" style detail: requested, in motion, the cap */
  detail: string;
};

const DAY = 86_400_000;
const whole = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));
const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Whole days from a to b (YYYY-MM-DD), negative when b is before a */
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);

/** The creative billing cycle a day falls in: from the billing day (1 to 28; 1 when unknown) to the same day next month */
export function cycleFor(billingDay: number | null | undefined, today: string): { start: string; end: string } {
  const b = Math.max(1, Math.min(28, Math.floor(Number(billingDay) || 1)));
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const d = Number(today.slice(8, 10));
  const start = d >= b ? Date.UTC(y, m, b) : Date.UTC(y, m - 1, b);
  const s = new Date(start);
  return { start: iso(start), end: iso(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, b)) };
}

export const POOL_WORD: Record<GapPool, [string, string]> = { images: ["image", "images"], videos: ["video", "videos"] };
const word = (pool: GapPool, n: number) => POOL_WORD[pool][n === 1 ? 0 : 1];

/** Create brief: the request form for that client, with the format picked */
export const createBriefHref = (slug: string, format: BriefIdea["format"]) => `/requests/new?client=${encodeURIComponent(slug)}${format ? `&format=${format}` : ""}`;

/** The format a "Create brief" opens with for a pool (images and carousels share the image pool) */
export const POOL_FORMAT: Record<GapPool, "image" | "video"> = { images: "image", videos: "video" };

/** "resets today", "resets tomorrow", "resets in 4 days", "resets Dec 5" */
export function resetsLabel(resetsOn: string, daysLeft: number) {
  if (daysLeft <= 0) return "resets today";
  if (daysLeft === 1) return "resets tomorrow";
  if (daysLeft <= 6) return `resets in ${daysLeft} days`;
  return `resets ${new Date(`${resetsOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/** One pool of one client this cycle: null when the pool has no cap */
export function poolGap(u: UsageLike, client: { name: string; slug: string }, pool: GapPool, today: string): AllotmentGap | null {
  const cap = whole(pool === "images" ? u.images_per_month : u.videos_per_month);
  if (!cap) return null;
  const used = whole(pool === "images" ? u.images_used : u.videos_used);
  const inMotion = whole(pool === "images" ? u.progress_images : u.progress_videos);
  const cycle = u.period_start && u.period_end ? { start: String(u.period_start).slice(0, 10), end: String(u.period_end).slice(0, 10) } : cycleFor(u.billing_day, today);
  const length = Math.max(1, daysBetween(cycle.start, cycle.end));
  const gone = Math.max(0, Math.min(length, daysBetween(cycle.start, today)));
  const daysLeft = Math.max(0, daysBetween(today, cycle.end));
  // Everything in the production line is already in used (the view counts it once), so nothing is added on top
  const requested = used;
  const missing = Math.max(0, cap - requested);
  const over = Math.max(0, requested - cap);
  const delivered = Math.max(0, used - inMotion);
  const state: AllotmentGap["state"] = requested === 0 && inMotion === 0 ? "nothing" : over > 0 ? "over" : missing > 0 ? "missing" : "covered";
  // Even pace: by a week from today, this much of the cap should be asked for (all of it in the last week)
  const dueThisWeek = daysLeft <= 7 ? missing : Math.min(missing, Math.max(0, Math.ceil((cap * Math.min(length, gone + 7)) / length) - requested));
  const urgency = missing ? missing / Math.max(1, daysLeft) + (state === "nothing" ? 0.01 : 0) : 0;
  const resets = resetsLabel(cycle.end, daysLeft);
  const line =
    state === "nothing"
      ? `Nothing in motion · ${cap} ${word(pool, cap)} to brief · ${resets}`
      : state === "missing"
        ? `${missing} ${word(pool, missing)} missing · ${resets}`
        : state === "over"
          ? `${over} ${word(pool, over)} over the allotment · ${resets}`
          : `Covered · ${resets}`;
  const pace = !missing ? "Nothing more to brief this cycle" : dueThisWeek ? `${dueThisWeek} this week to stay on pace` : "On pace this week";
  const detail = [`${requested} of ${cap} ${word(pool, cap)} requested`, inMotion ? `${inMotion} in motion` : null, requested > 0 && delivered === 0 ? "nothing delivered yet" : delivered ? `${delivered} delivered` : null].filter(Boolean).join(" · ");
  return { clientId: u.client_id, client: client.name, slug: client.slug, pool, cap, requested, inMotion, delivered, missing, over, resetsOn: cycle.end, daysLeft, elapsed: gone / length, state, dueThisWeek, urgency, line, pace, detail };
}

/** Every capped pool of every client, most urgent first */
export function allotmentGaps(rows: readonly UsageLike[], clients: ReadonlyMap<string, { name: string; slug: string }>, today: string): AllotmentGap[] {
  const out: AllotmentGap[] = [];
  for (const u of rows) {
    const c = clients.get(u.client_id);
    if (!c) continue;
    for (const pool of ["images", "videos"] as GapPool[]) {
      const g = poolGap(u, c, pool, today);
      if (g) out.push(g);
    }
  }
  return out.sort(byUrgency);
}

export const byUrgency = (a: AllotmentGap, b: AllotmentGap) => b.urgency - a.urgency || a.daysLeft - b.daysLeft || b.missing - a.missing || a.client.localeCompare(b.client);

/**
 * Whose slice of the allotments someone sees (by role, never by name): the head of creative and the executives every
 * client and pool, the lead graphic designer every client's images and carousels, the lead video editor every
 * client's video, a designer or editor their own seated clients in their pool. Anyone else: none.
 */
export function allotmentSlice(me: { role: string; isExec?: boolean }): { pools: GapPool[]; every: boolean } | null {
  if (me.isExec || me.role === "head_of_creative") return { pools: ["images", "videos"], every: true };
  if (me.role === "lead_graphic_designer") return { pools: ["images"], every: true };
  if (me.role === "lead_video_editor") return { pools: ["videos"], every: true };
  if (me.role === "graphic_designer") return { pools: ["images"], every: false };
  if (me.role === "video_editor") return { pools: ["videos"], every: false };
  return null;
}

/** The gaps in someone's slice (seated: the clients they hold a seat on) */
export function sliceGaps(gaps: readonly AllotmentGap[], me: { role: string; isExec?: boolean }, seated: ReadonlySet<string>): AllotmentGap[] {
  const s = allotmentSlice(me);
  if (!s) return [];
  return gaps.filter((g) => s.pools.includes(g.pool) && (s.every || seated.has(g.clientId)));
}

/** Where a gap goes in Next for me: Now when the reset is close and the gap is real, Keep an eye on when it's due this week */
export function nextBucket(g: AllotmentGap): "now" | "watch" | null {
  if (!g.missing) return null;
  if (g.daysLeft <= 7 || (g.state === "nothing" && g.elapsed >= 1 / 3)) return "now";
  return g.dueThisWeek > 0 ? "watch" : null;
}

export type WeekLoad = { pool: GapPool; due: number; clients: number; capacity: number | null; line: string };

/**
 * The team's week for the head of creative: how many creatives must be briefed this week across clients to stay on
 * pace, against what the team typically finishes in a week (capacity; null when there's no history yet).
 */
export function weekLoad(gaps: readonly AllotmentGap[], capacity: Partial<Record<GapPool, number | null>>): WeekLoad[] {
  return (["images", "videos"] as GapPool[]).map((pool) => {
    const mine = gaps.filter((g) => g.pool === pool && g.dueThisWeek > 0);
    const due = mine.reduce((n, g) => n + g.dueThisWeek, 0);
    const cap = capacity[pool] ?? null;
    const vs = cap == null ? "" : due > cap ? ` · ${due - cap} more than a usual week (${cap})` : ` · a usual week makes ${cap}`;
    return { pool, due, clients: mine.length, capacity: cap, line: `${due} ${word(pool, due)} due this week across ${mine.length} client${mine.length === 1 ? "" : "s"}${vs}` };
  });
}

/** What the team finished per week, per pool, from finished work over some weeks (the typical week) */
export function weeklyCapacity(done: readonly { pool: GapPool; units: number }[], weeks: number): Record<GapPool, number | null> {
  const sum = (p: GapPool) => done.filter((d) => d.pool === p).reduce((n, d) => n + whole(d.units), 0);
  const per = (p: GapPool) => (sum(p) ? Math.round(sum(p) / Math.max(1, weeks)) : null);
  return { images: per("images"), videos: per("videos") };
}

/** The idea a "Suggest briefs" preview starts from: the gap, and where the strategist should look for what to make */
export function suggestIdea(g: Pick<AllotmentGap, "client" | "pool" | "missing" | "cap" | "requested" | "resetsOn" | "daysLeft">) {
  const n = Math.max(1, g.missing);
  const fmt = g.pool === "videos" ? "video" : "image or carousel";
  return {
    label: `${g.client}: ${n} ${word(g.pool, n)} still to brief this cycle (${resetsLabel(g.resetsOn, g.daysLeft)})`,
    text: `${g.requested} of ${g.cap} ${word(g.pool, g.cap)} in their creative allotment are requested so far this billing cycle. Suggest the strongest next ${fmt} concepts to fill the gap: build on their winning ads, their active angles and what's working for them now, and on their Brand Bible. Distinct concepts, one per brief, only ${fmt} formats, and no more versions in total than the ${n} still to brief.`,
  };
}

/** The idea for an account that needs fresh creative (off its KPI target, or ads wearing out) */
export function freshIdea(client: string, why: string) {
  return {
    label: `${client}: needs fresh creative (${why})`,
    text: `${why}. Suggest the fresh creative most likely to bring the account back to target: new hooks and visuals on the angles that have worked for them, and angles they haven't tried that fit their Brand Bible. Distinct concepts, one per brief, within what's left of their allotment.`,
  };
}
