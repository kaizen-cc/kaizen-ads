// Feedback about the app, the parts that are plain logic (client-safe, and tested): the types and statuses, the area
// a page belongs to, how alike two reports are, a group's counts, and its priority.

export type FeedbackType = "bug" | "idea" | "confusing";
export type FeedbackStatus = "new" | "planned" | "in_progress" | "fixed" | "wont_fix";
export type Severity = "low" | "medium" | "high";

export const TYPES: { value: FeedbackType; label: string; hint: string }[] = [
  { value: "bug", label: "Bug", hint: "Something is broken or wrong" },
  { value: "idea", label: "Idea", hint: "Something that would make it better" },
  { value: "confusing", label: "Something confusing", hint: "Hard to find or understand" },
];
export const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;

export const STATUSES: { value: FeedbackStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "fixed", label: "Fixed" },
  { value: "wont_fix", label: "Won't fix" },
];
export const statusLabel = (s: string) => STATUSES.find((x) => x.value === s)?.label ?? s;
export const isOpen = (s: string) => s !== "fixed" && s !== "wont_fix";

// The parts of the app, by where you are in it. The first prefix that matches wins.
export const AREAS: { area: string; prefixes: string[] }[] = [
  { area: "Overview", prefixes: ["/pipeline", "/today"] },
  { area: "Next for me", prefixes: ["/next"] },
  { area: "Board", prefixes: ["/board", "/requests"] },
  { area: "Clients", prefixes: ["/clients"] },
  { area: "KPIs", prefixes: ["/kpis", "/fatigue"] },
  { area: "Reports", prefixes: ["/reports", "/report"] },
  { area: "Kaizen AI", prefixes: ["/ai"] },
  { area: "Ideas", prefixes: ["/ideas", "/winners", "/market"] },
  { area: "Ads Lab", prefixes: ["/lab"] },
  { area: "Settings", prefixes: ["/settings", "/team"] },
  { area: "Notifications", prefixes: ["/notifications"] },
  { area: "Feedback", prefixes: ["/feedback"] },
  { area: "Client portal", prefixes: ["/c/", "/p/", "/r/"] },
];
export const AREA_NAMES = [...AREAS.map((a) => a.area), "Brand Bible", "Launcher", "Other"];

/** The area a page is in, from its path (a Brand Bible or launch tab inside a client's page counts as its own area). */
export function areaFromRoute(route: string | null | undefined): string {
  const r = (route ?? "").split("?")[0];
  if (!r) return "Other";
  if (/^\/clients\/[^/]+/.test(r) && /bible/i.test(route ?? "")) return "Brand Bible";
  if (/launch/i.test(route ?? "")) return "Launcher";
  for (const a of AREAS) for (const p of a.prefixes) if (r === p || r.startsWith(p.endsWith("/") ? p : `${p}/`) || r === p.replace(/\/$/, "")) return a.area;
  return "Other";
}

/** The path a report came from, with ids and slugs replaced, so the same screen reads the same for every client. */
export function routePattern(path: string | null | undefined): string {
  return (path ?? "")
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[id]")
    .replace(/^\/clients\/[^/]+/, "/clients/[slug]")
    .replace(/\/\d+(?=\/|$)/g, "/[n]");
}

const STOP = new Set(
  "a an the and or but if then so to of in on at for with by from it its is are was were be been this that these those i me my we our you your can cant can't could would should when where what why how not no do does did dont don't just very really there here when page button click please it's im i'm get got have has into out up down also still again".split(" "),
);

/** The words that carry meaning in a report (lowercase, no stop words, simple plurals folded). */
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/** How alike two texts are: shared meaningful words over all of them (0 to 1). */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export type GroupCandidate = { id: string; type: string; area: string; title: string; summary: string | null; status: string };

/**
 * Without the AI: the existing group a report most likely repeats, when it's the same type and area and says much
 * the same thing (or the closest one is very close whatever the area). Null for something new.
 */
export function closestGroup(report: { type: string; area: string; text: string }, groups: GroupCandidate[], threshold = 0.45): string | null {
  let best: { id: string; score: number } | null = null;
  for (const g of groups) {
    if (g.status === "wont_fix") continue;
    const score = similarity(report.text, `${g.title} ${g.summary ?? ""}`);
    const sameSpot = g.type === report.type && g.area === report.area;
    if ((sameSpot && score >= threshold) || score >= 0.7) if (!best || score > best.score) best = { id: g.id, score };
  }
  return best?.id ?? null;
}

export type ReportFacts = { profileId: string; severity: Severity | null; blocksWork: boolean; createdAt: string };
export type GroupStats = { reports: number; people: number; severity: Severity; blocksWork: boolean; firstReportedAt: string | null; lastReportedAt: string | null };

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/** A group's counts from its reports: how many, how many different people, the worst severity, whether any blocks work. */
export function groupStats(reports: ReportFacts[]): GroupStats {
  let severity: Severity = "low";
  for (const r of reports) if (r.severity && RANK[r.severity] > RANK[severity]) severity = r.severity;
  const times = reports.map((r) => r.createdAt).sort();
  return {
    reports: reports.length,
    people: new Set(reports.map((r) => r.profileId)).size,
    severity,
    blocksWork: reports.some((r) => r.blocksWork),
    firstReportedAt: times[0] ?? null,
    lastReportedAt: times[times.length - 1] ?? null,
  };
}

/**
 * What to work on first. Repeats lead: each extra report adds, each extra person adds more (five people once beats one
 * person five times). Then how bad it is, whether it stops someone working, and a little for being recent. A bug
 * outranks an idea said as often. Closed groups (fixed, won't fix) score 0.
 */
export function priorityScore(
  g: { reports: number; people: number; severity: Severity; blocksWork: boolean; type: string; status: string; lastReportedAt: string | null },
  now = Date.now(),
): number {
  if (!isOpen(g.status)) return 0;
  const repeats = Math.max(0, g.reports - 1) * 10 + Math.max(0, g.people - 1) * 15;
  const sev = g.severity === "high" ? 30 : g.severity === "medium" ? 15 : 5;
  const blocks = g.blocksWork ? 25 : 0;
  const type = g.type === "bug" ? 6 : g.type === "confusing" ? 4 : 0;
  const days = g.lastReportedAt ? (now - new Date(g.lastReportedAt).getTime()) / 86_400_000 : 99;
  const recent = days <= 7 ? 8 : days <= 30 ? 3 : 0;
  return repeats + sev + blocks + type + recent;
}

/** Highest priority first; ties go to more people, then more reports, then the latest. */
export function byPriority<T extends { priority: number; people: number; reports: number; lastReportedAt: string | null }>(a: T, b: T) {
  return b.priority - a.priority || b.people - a.people || b.reports - a.reports || (b.lastReportedAt ?? "").localeCompare(a.lastReportedAt ?? "");
}

// ─── Which path a report takes ──────────────────────────────────────────────
// A small bug (contained, clear repro: a UI glitch, a wrong link, a crash with a stack, a copy error) is fixed by
// Claude and ships itself once every check passes. A big issue (data, security, money, ad-account writes, sign-in and
// permissions, the database, several areas) or a feature request waits for an exec's review.

export type Scope = "small_bug" | "big_issue" | "feature";
export type Lane = "auto_fix" | "review" | "build";

export const SCOPE_LABEL: Record<Scope, string> = { small_bug: "Small bug", big_issue: "Big issue", feature: "Feature request" };

// Words that put a report out of reach of an automatic fix, whatever the AI thought
const BIG =
  /\b(data (?:loss|lost|gone|wrong|deleted)|lost (?:my|our|the|all)|deleted|security|leak|exposed|password|log ?in|sign ?in|logged out|permissions?|access|rls|admin|billing|invoice|stripe|payments?|charged?|refund|money|budgets?|spend|ad accounts?|meta write|campaigns? (?:paused|turned off|turned on|created|launched)|migrations?|schema|database|supabase|secrets?|api key|tokens?)\b/i;

/** The path a report takes: the AI's read, with guardrails that only ever make it more careful. */
export function classifyScope(r: { aiScope: Scope | null; type: string; severity: Severity; text: string; area: string }): { scope: Scope; reason: string } {
  if (r.aiScope === "big_issue") return { scope: "big_issue", reason: "Too big or risky for an automatic fix" };
  if (r.type === "idea" || r.aiScope === "feature") return { scope: "feature", reason: "Asks for something new, not a fix" };
  const hit = r.text.match(BIG)?.[0];
  if (hit) return { scope: "big_issue", reason: `Mentions "${hit.toLowerCase()}", which an automatic fix never touches` };
  if (r.severity === "high") return { scope: "big_issue", reason: "High severity" };
  if (r.area === "Launcher") return { scope: "big_issue", reason: "The launcher writes to ad accounts" };
  return { scope: "small_bug", reason: "Small and contained" };
}

/** Bigger always wins when reports are grouped: a group is as careful as its most careful report. */
export const widerScope = (a: Scope, b: Scope): Scope => (a === "big_issue" || b === "big_issue" ? "big_issue" : a === "feature" || b === "feature" ? "feature" : "small_bug");

export const AUTO_FIX_PER_DAY = 3;
export const AUTO_FIX_MAX_ATTEMPTS = 2;
export const AUTO_FIX_FAILURES_TO_PAUSE = 2; // in a day, across all fixes: something is off, so stop and let a person look

/**
 * Whether to hand a group to the fix pipeline now. Only small bugs, still open, with GitHub connected; at most a few a
 * day; a fix that failed its checks gets one more try, then goes to review; and if fixes keep failing, everything
 * waits for a person.
 */
export function autoFixDecision(g: {
  scope: Scope;
  status: string;
  fixState: string | null;
  attempts: number;
  startedToday: number;
  failedToday: number;
  github: boolean;
}): { action: "start" | "wait" | "review" | "none"; reason: string } {
  if (!isOpen(g.status)) return { action: "none", reason: "Closed" };
  if (g.scope !== "small_bug") return { action: "review", reason: g.scope === "feature" ? "A feature request: an exec decides" : "Too big for an automatic fix" };
  if (g.fixState === "working" || g.fixState === "pr_open" || g.fixState === "merged") return { action: "none", reason: "Already on its way" };
  if (!g.github) return { action: "review", reason: "Automatic fixes aren't connected (GITHUB_TOKEN)" };
  if (g.attempts >= AUTO_FIX_MAX_ATTEMPTS) return { action: "review", reason: `The fix failed its checks ${g.attempts} times` };
  if (g.failedToday >= AUTO_FIX_FAILURES_TO_PAUSE) return { action: "review", reason: `Automatic fixes are paused: ${g.failedToday} failed their checks today` };
  if (g.startedToday >= AUTO_FIX_PER_DAY) return { action: "wait", reason: `Today's ${AUTO_FIX_PER_DAY} automatic fixes are used; it goes next` };
  return { action: "start", reason: "Small bug" };
}

export type FixState = "working" | "pr_open" | "checks_failed" | "merged" | "no_change" | "protected";

/**
 * Where a fix stands, from GitHub: the issue, the pull request on claude/fix-<n> (if any), and the comments the
 * claude-fix workflow leaves. The workflow squash-merges a passing low-severity fix itself and closes the issue.
 */
export function fixOutcome(gh: {
  issueClosed: boolean;
  pr: { url: string; open: boolean; merged: boolean } | null;
  comments: string[];
  minutesSinceStart: number;
}): { state: FixState; commit: string | null; note: string | null } {
  const all = gh.comments.join("\n");
  const commit = all.match(/Merged into main as ([0-9a-f]{7,40})/)?.[1] ?? null;
  if (gh.pr?.merged || commit || (gh.issueClosed && /merged automatically/i.test(all))) return { state: "merged", commit, note: null };
  if (/A check failed/i.test(all)) return { state: "checks_failed", commit: null, note: "A check failed on the fix" };
  if (/changes the database|touches files an automatic fix never ships/i.test(all))
    return { state: "protected", commit: null, note: "The fix touches what an automatic fix never ships (the database, sign-in, ad accounts, billing, secrets, or many files)" };
  if (gh.pr?.open) return { state: "pr_open", commit: null, note: null };
  // Claude decided there was nothing of ours to change (it comments why), once the run is long over
  if (!gh.pr && gh.minutesSinceStart > 90) return { state: "no_change", commit: null, note: gh.comments.at(-1)?.slice(0, 600) ?? "Claude found nothing to change" };
  return { state: "working", commit: null, note: null };
}

/** The path, as the Feedback page shows it. */
export function pathLabel(g: { status: string; lane: string; fixState: string | null; pending?: boolean }): { label: string; tone: "ok" | "warn" | "brand" | "muted" } {
  if (g.pending) return { label: "Reading it", tone: "muted" };
  if (g.status === "fixed") return { label: "Fixed", tone: "ok" };
  if (g.status === "wont_fix") return { label: "Won't do", tone: "muted" };
  if (g.lane === "auto_fix") return { label: g.fixState === "queued" ? "Auto-fix queued" : "Auto-fixing", tone: "brand" };
  if (g.lane === "build") return { label: g.fixState === "pr_open" ? "Planned · PR to review" : "Planned", tone: "brand" };
  return { label: "Needs your review", tone: "warn" };
}
