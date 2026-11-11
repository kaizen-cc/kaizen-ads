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
// A bug or an error, of any size, goes to the Claude fix pipeline right away: no one has to look at it first. Most
// ship themselves once every check passes. A fix that would touch the safety rails (the database, sign-in and
// permissions, anything that writes to ad accounts, billing, secrets and env, the pipeline itself, or a very large
// change) is still built, on a pull request, but it waits for the owner's approval before it merges. A feature
// request never starts a fix: it goes to the owner as an Ask (build now, plan it, ask for more, or won't do). So does
// a report that reads like a note or an instruction rather than something going wrong.

// The stored scope keeps its old names: small_bug ships itself; big_issue is a bug whose fix needs approval;
// feature is an Ask.
export type Scope = "small_bug" | "big_issue" | "feature";
export type Lane = "auto_fix" | "review" | "build";
export type Rail = "database" | "auth" | "ad_accounts" | "billing" | "secrets" | "pipeline" | "very_large";

export const SCOPE_LABEL: Record<Scope, string> = { small_bug: "Bug", big_issue: "Bug · fix needs approval", feature: "Ask" };
export const RAIL_LABEL: Record<Rail, string> = {
  database: "the database (a migration)",
  auth: "sign-in, RLS or permissions",
  ad_accounts: "writes to ad accounts",
  billing: "billing",
  secrets: "secrets or env",
  pipeline: "the pipeline itself (.github)",
  very_large: "a very large change",
};

// Words that put a fix behind the owner's approval, whatever the AI thought (they only ever make it more careful)
const RAILS: [Rail, RegExp][] = [
  ["database", /\b(migrations?|schema|database|supabase|db tables?|columns? (?:missing|added|renamed))\b/i],
  ["auth", /\b(log ?in|log ?out|logged (?:out|in)|sign ?in|sign ?up|signed out|permissions?|rls|access denied|not allowed to|password|magic link|auth(?:entication)?)\b/i],
  ["ad_accounts", /\b(meta[- ]write|google[- ]write|launch(?:er|es|ed|ing)?|ad accounts?|budgets? (?:changed|set|moved|wrong)|campaigns? (?:paused|turned off|turned on|created|launched)|paused? (?:the |an? )?(?:ads?|campaigns?|ad sets?))\b/i],
  ["billing", /\b(billing|invoices?|stripe|payments?|charged|refunds?)\b/i],
  ["secrets", /\b(secrets?|api keys?|access tokens?|env(?:ironment)? var(?:iable)?s?|\.env)\b/i],
  ["pipeline", /(\.github|github actions?|claude-fix)/i],
];

/** The safety rail a fix for this would touch, or null when it may ship itself. */
export function railFor(r: { text: string; area: string; aiRail?: Rail | "none" | null }): { rail: Rail; why: string } | null {
  for (const [rail, re] of RAILS) {
    const hit = r.text.match(re)?.[0];
    if (hit) return { rail, why: `Mentions "${hit.toLowerCase()}"` };
  }
  if (r.area === "Launcher") return { rail: "ad_accounts", why: "The launcher writes to ad accounts" };
  if (r.aiRail && r.aiRail !== "none") return { rail: r.aiRail, why: "The triage read it that way" };
  return null;
}

// What says something went wrong (a bug), as opposed to a note or an instruction
const PROBLEM =
  /\?|\b(not|no|never|nothing|broken|breaks?|error|errors|wrong|fails?|failed|failing|bug|bugs|crash(?:es|ed)?|missing|stuck|blank|empty|slow|freez(?:e|es|ing)|disappear(?:s|ed)?|weird|incorrect|inaccurate|instead|should|why|how|cannot|can't|cant|won't|wont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|wasn't|shows?|showing|says|cut off|overlaps?|misaligned|typo|off[- ]screen|unreadable|hidden)\b/i;
const REQUEST_START = /^\s*(let'?s|lets|please|pls|can you|could you|make|create|launch|add|build|set up|write|send|schedule|start|go)\b/i;

/**
 * A report that reads like a note or an instruction meant for somewhere else (a chat message typed into the bubble,
 * "lets launch a campaign") rather than something going wrong. Those go to the owner as an Ask, never to a fix.
 */
export function looksLikeNote(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (PROBLEM.test(t)) return false;
  const words = t.split(/\s+/).length;
  return words <= 3 || (REQUEST_START.test(t) && words <= 30);
}

export type AiKind = "bug" | "feature" | "unclear";

/** The path a report takes: the AI's read, with guardrails that only ever make it more careful. */
export function classifyScope(r: { aiKind: AiKind | null; aiRail?: Rail | "none" | null; type: string; text: string; area: string; note?: string }): {
  scope: Scope;
  reason: string;
  rail: Rail | null;
  unclear: boolean;
} {
  if (r.type === "idea" || r.aiKind === "feature") return { scope: "feature", reason: "Asks for something new, not a fix", rail: null, unclear: false };
  if (r.aiKind === "unclear" || looksLikeNote(r.note ?? r.text))
    return { scope: "feature", reason: "Reads like a note or an instruction, not something going wrong", rail: null, unclear: true };
  const rail = railFor({ text: r.text, area: r.area, aiRail: r.aiRail });
  if (rail) return { scope: "big_issue", reason: `The fix may touch ${RAIL_LABEL[rail.rail]} (${rail.why}), so it waits for approval before it merges`, rail: rail.rail, unclear: false };
  return { scope: "small_bug", reason: "A bug: fixed and shipped once every check passes", rail: null, unclear: false };
}

/** A group is as careful as its most careful report: approval beats ships-itself; a bug report turns an Ask into a fix. */
export const widerScope = (a: Scope, b: Scope): Scope => (a === "big_issue" || b === "big_issue" ? "big_issue" : a === "small_bug" || b === "small_bug" ? "small_bug" : "feature");

export const DEFAULT_FIXES_PER_DAY = 15;
export const AUTO_FIX_MAX_ATTEMPTS = 2;
export const AUTO_FIX_FAILURES_TO_PAUSE = 4; // in a day, across all fixes: something is off, so stop and let a person look

/** How many fixes may start in a day: FEEDBACK_FIXES_PER_DAY when it's a sensible number, 15 otherwise. */
export function dailyFixCap(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_FIXES_PER_DAY;
}

/**
 * Whether to hand a group to the fix pipeline now. A bug starts at once (ships itself unless it needs approval); an
 * Ask goes to the owner unless the owner said build it. A fix already on its way is left alone; one that failed its
 * checks gets one more try; past today's cap it waits its turn; and without GitHub, after repeated failures, or when
 * fixes keep failing across the board, it's stuck and the owner looks.
 */
export function autoFixDecision(g: {
  scope: Scope;
  status: string;
  lane: string;
  fixState: string | null;
  attempts: number;
  startedToday: number;
  failedToday: number;
  github: boolean;
  cap?: number;
}): { action: "start" | "wait" | "ask" | "stuck" | "none"; autoMerge: boolean; reason: string } {
  const cap = g.cap ?? DEFAULT_FIXES_PER_DAY;
  const autoMerge = g.scope === "small_bug" && g.lane !== "build";
  if (!isOpen(g.status)) return { action: "none", autoMerge, reason: "Closed" };
  if (g.scope === "feature" && g.lane !== "build") return { action: "ask", autoMerge: false, reason: "An Ask: the owner decides" };
  if (g.fixState === "working" || g.fixState === "pr_open" || g.fixState === "merged") return { action: "none", autoMerge, reason: "Already on its way" };
  if (!g.github) return { action: "stuck", autoMerge, reason: "Automatic fixes aren't connected (GITHUB_TOKEN)" };
  if (g.attempts >= AUTO_FIX_MAX_ATTEMPTS) return { action: "stuck", autoMerge, reason: `The fix failed its checks ${g.attempts} times` };
  if (g.failedToday >= AUTO_FIX_FAILURES_TO_PAUSE) return { action: "stuck", autoMerge, reason: `Automatic fixes are paused: ${g.failedToday} failed their checks today` };
  if (g.startedToday >= cap) return { action: "wait", autoMerge, reason: `Today's ${cap} fixes are used; it goes next` };
  return { action: "start", autoMerge, reason: autoMerge ? "A bug: it ships itself once every check passes" : "Built now; the fix waits for approval before it merges" };
}

export type FixState = "working" | "pr_open" | "checks_failed" | "ready" | "merged" | "no_change";

/**
 * Where a fix stands, from GitHub: the issue, the pull request on claude/fix-<n> (if any), and the comments the
 * claude-fix workflow leaves. It squash-merges a passing fix that may ship itself; one that needs approval gets
 * "Every check passed. It needs approval" and waits; Approve and merge has it merged the same way.
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
  const ready = gh.comments.findLast((c) => /Every check passed\. It needs approval|changes the database|touches files an automatic fix never ships/i.test(c));
  if (ready && gh.pr?.open) return { state: "ready", commit: null, note: ready.slice(0, 600) };
  if (gh.pr?.open) return { state: "pr_open", commit: null, note: null };
  // Claude decided there was nothing of ours to change (it comments why; the workflow closes the issue)
  if (!gh.pr && (gh.issueClosed || gh.minutesSinceStart > 90)) return { state: "no_change", commit: null, note: gh.comments.findLast((c) => !/^Claude changed nothing/i.test(c))?.slice(0, 600) ?? "Claude found nothing to change" };
  return { state: "working", commit: null, note: null };
}

// ─── Where a group sits on the Feedback page, and what its reporters see ────

export type Section = "fixing" | "approval" | "asks" | "done";
export const SECTIONS: { key: Section; label: string; about: string }[] = [
  { key: "fixing", label: "Fixing", about: "Bugs on their way through the pipeline. Most ship themselves once every check passes." },
  { key: "approval", label: "Needs your approval", about: "Fixes built on a pull request that touch the safety rails, and anything the pipeline couldn't finish." },
  { key: "asks", label: "Asks", about: "Feature requests and notes from the team. Nothing is built until you say so." },
  { key: "done", label: "Done", about: "Live, or decided against." },
];

type GroupLike = { status: string; lane: string; scope: string; fixState: string | null; pending?: boolean };

/** The Feedback page section a group belongs in. */
export function sectionOf(g: GroupLike): Section {
  if (g.pending) return "fixing";
  if (!isOpen(g.status)) return "done";
  if (g.scope === "feature" && g.lane !== "build") return "asks";
  if (g.lane === "build" && g.fixState === "pr_open") return "approval";
  if (g.lane === "review") return "approval";
  return "fixing";
}

/** The short state shown on a group for the owner. */
export function pathLabel(g: GroupLike & { ready?: boolean }): { label: string; tone: "ok" | "warn" | "brand" | "muted" } {
  if (g.pending) return { label: "Reading it", tone: "muted" };
  if (g.status === "fixed") return { label: "Live", tone: "ok" };
  if (g.status === "wont_fix") return { label: "Won't do", tone: "muted" };
  const s = sectionOf(g);
  if (s === "asks") return { label: g.status === "planned" ? "Planned" : "Ask", tone: "brand" };
  if (s === "approval") return g.lane === "build" ? { label: g.ready ? "Fix ready to approve" : "Checking the fix", tone: "warn" } : { label: "Needs a look", tone: "warn" };
  if (g.fixState === "queued") return { label: "Next up", tone: "brand" };
  if (g.fixState === "checks_failed") return { label: "Trying again", tone: "brand" };
  if (g.fixState === "pr_open") return { label: "Checking", tone: "brand" };
  return { label: g.lane === "build" ? "Building" : "Fixing", tone: "brand" };
}

export type ReporterStatus = "received" | "building" | "fix_ready" | "live" | "with_owner" | "wont_do";
export const REPORTER_STATUS: Record<ReporterStatus, { label: string; note: string; tone: "ok" | "warn" | "brand" | "muted" }> = {
  received: { label: "Received", note: "We have it and we're reading it.", tone: "muted" },
  building: { label: "Building", note: "A fix is being built now. You'll hear when it's live.", tone: "brand" },
  fix_ready: { label: "Fix ready", note: "The fix is built and waiting for the owner's approval.", tone: "brand" },
  live: { label: "Live", note: "It's fixed in the latest version. Refresh if you still see the old behaviour.", tone: "ok" },
  with_owner: { label: "With the owner", note: "It's with the owner to decide what happens next.", tone: "warn" },
  wont_do: { label: "Won't do", note: "Decided against, with the reason on the report.", tone: "muted" },
};

/** Where a report stands, in the reporter's words. */
export function reporterStatus(g: (GroupLike & { groupId?: string | null }) | null): ReporterStatus {
  if (!g || g.pending || g.groupId === null) return "received";
  if (g.status === "fixed") return "live";
  if (g.status === "wont_fix") return "wont_do";
  const s = sectionOf(g);
  if (s === "asks") return "with_owner";
  if (s === "approval") return g.lane === "build" ? "fix_ready" : "with_owner";
  if (g.fixState) return "building";
  return "received";
}

// ─── Plan it: a line on the roadmap ─────────────────────────────────────────

export const ROADMAP_SECTION = "## Requested by the team";

/**
 * The roadmap with one more line under "Requested by the team" (the section is made at the end if it isn't there).
 * Keeps the file's line endings; a line already there isn't added twice.
 */
export function addToRoadmap(md: string, line: string): string {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const bullet = `- ${line.replace(/\s+/g, " ").trim()}`;
  const lines = md.split(/\r?\n/);
  if (lines.some((l) => l.trim() === bullet.trim())) return md;
  const at = lines.findIndex((l) => l.trim() === ROADMAP_SECTION);
  if (at === -1) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return [...lines, "", ROADMAP_SECTION, "", bullet, ""].join(eol);
  }
  let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  if (end === -1) end = lines.length;
  // After the section's last non-blank line
  let insert = end;
  while (insert - 1 > at && lines[insert - 1].trim() === "") insert--;
  const out = [...lines.slice(0, insert), ...(insert === at + 1 ? [""] : []), bullet, ...lines.slice(insert)];
  if (out[out.length - 1] !== "") out.push("");
  return out.join(eol);
}
