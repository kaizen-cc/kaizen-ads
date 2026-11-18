import { bizDays } from "@/lib/production";
import { emailStageForColumn, isDoneColumn, routeFallback, turnaroundDays, type EmailStage, type Route } from "@/lib/email-board-core";

// The email team's KPIs as plain functions (no database), so the math is tested on its own: each ticket's life as
// stints (which stage, from when to when, who held it, where it went next), read the same way from a Kaizen ticket's
// events and from an Asana email task's history while the team moves over; then design passes, sendbacks (internal
// and the client's, routed to copy or design), first-pass approval, time to the client, copy approval, the score,
// judging each sent email against its own account's usual numbers, flows whose clicks are tiring, and each client's
// sending pace this cycle. Business days throughout (weekdays, New York).

export type Phase = EmailStage | "done";
export type Stint = { stage: Phase; from: string; to: string | null; holder: string | null; next: Phase | null };

/** A client note on a round (Kaizen: the client's own comments; Asana: the task's comments, routed by their words) */
export type Note = { at: string; route: Route | null; text: string };

/** One piece of email work: a Kaizen ticket or an Asana email task, with its life as stints */
export type Piece = {
  key: string;
  source: "kaizen" | "asana";
  number: number | null;
  title: string;
  clientId: string | null;
  client: string | null;
  slug: string | null;
  kind: "batch" | "flow";
  createdAt: string;
  open: boolean;
  stage: Phase;
  href: string;
  external: boolean;
  /** The due date first set, and every change to it */
  dueFirst: string | null;
  dueNow: string | null;
  dues: { at: string; from: string | null; to: string | null; by: string | null }[];
  stints: Stint[];
  /** Design uploads (Kaizen): who uploaded, when, for which message and version */
  uploads: { at: string; by: string | null; messageId: string | null; version: number | null }[];
  notes: Note[];
  /** Copy rewrites the AI was asked for (Kaizen), with the strategist's note */
  rewrites: { at: string; note: string | null }[];
  /** When the AI first wrote the copy (Kaizen) */
  drafted: string | null;
  /** When the copy was approved, and by whom (Kaizen) */
  copyApproved: { at: string; by: string | null } | null;
  minutesOver: number;
  holderNow: string | null;
  messages: number;
};

const SEC = 60_000;
const DESIGN: Phase[] = ["ready_for_design"];
const AFTER_DESIGN: Phase[] = ["for_review", "with_client", "ready_for_build", "ready_to_send", "live", "done"];
const BACK_TO_DESIGN: Phase[] = ["ready_for_design", "revisions", "copy_review"];
const READY: Phase[] = ["ready_to_send", "live", "done"];

export const DESIGN_TARGET = turnaroundDays("ready_for_design");
export const COPY_TARGET = turnaroundDays("copy_review");
export const REVISION_TARGET = turnaroundDays("revisions");

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const inWin = (at: string | null | undefined, from: string, to: string) => Boolean(at && at >= from && at < to);

/** An Asana column's stage on the Email Board: a done column is done, an unknown one keeps the last stage */
export const phaseOfColumn = (name: string | null): Phase | null => {
  if (isDoneColumn(name)) return "done";
  const known = emailStageForColumn(name);
  if (known || !name) return known;
  // The Asana email board's own wording the board's patterns don't start with ("Needs Revision", "Email Requests")
  if (/revision|changes requested/i.test(name)) return "revisions";
  if (/request|backlog/i.test(name)) return "copy_review";
  return null;
};

/**
 * A piece's life as stints. Moves and reassignments in time order; who held each stint (a reassignment within a
 * minute of a move belongs to the new stage, the way the board hands a ticket on), split where it changed hands.
 */
export function stintsOf(createdAt: string, first: Phase, moves: readonly { at: string; to: Phase }[], assigns: readonly { at: string; from?: string | null; to: string | null }[], holderNow: string | null, open = true): Stint[] {
  const mv = [...moves].filter((m) => m.at >= createdAt).sort((a, b) => a.at.localeCompare(b.at));
  const as = [...assigns].sort((a, b) => a.at.localeCompare(b.at));
  const plus = (iso: string) => new Date(Date.parse(iso) + SEC).toISOString();
  const holderAt = (iso: string) => {
    const before = as.filter((x) => x.at <= plus(iso)).at(-1);
    if (before) return before.to;
    if (as.length) return as[0].from !== undefined ? as[0].from : as[0].to;
    return holderNow;
  };
  const out: Stint[] = [];
  let stage = first;
  let from = createdAt;
  for (const m of mv) {
    if (m.to === stage) continue;
    out.push({ stage, from, to: m.at, holder: holderAt(from), next: m.to });
    stage = m.to;
    from = m.at;
  }
  out.push({ stage, from, to: null, holder: open && holderNow != null ? holderNow : holderAt(from), next: null });
  return out.flatMap((s) => {
    const inside = as.filter((x) => x.at > plus(s.from) && (!s.to || x.at < s.to));
    if (!inside.length) return [s];
    const parts: Stint[] = [];
    let start = s.from;
    let who = s.holder;
    for (const x of inside) {
      if (x.to === who) continue;
      parts.push({ ...s, from: start, to: x.at, holder: who, next: s.stage });
      start = x.at;
      who = x.to;
    }
    parts.push({ ...s, from: start, holder: s.to == null && open && holderNow != null ? holderNow : who });
    return parts;
  });
}

/** Who made the design in a stint: the last person to upload in it (Kaizen), else whoever held it */
export function makerOf(p: Piece, s: Stint): string | null {
  const up = p.uploads.filter((u) => u.by && u.at >= s.from && (!s.to || u.at <= s.to)).at(-1);
  return up?.by ?? s.holder;
}

/** The designer of the piece as of a moment: the maker of the last design stint before it */
export function designerAt(p: Piece, at: string): string | null {
  const s = p.stints.filter((x) => DESIGN.includes(x.stage) && x.from <= at).at(-1);
  return s ? makerOf(p, s) : null;
}

/** The strategist on the copy as of a moment: who held the last copy stint before it */
export function writerAt(p: Piece, at: string): string | null {
  return p.stints.filter((x) => x.stage === "copy_review" && x.from <= at && x.holder).at(-1)?.holder ?? p.copyApproved?.by ?? null;
}

// ─── Design ───────────────────────────────────────────────────────────────────

export type Pass = { person: string | null; piece: Piece; at: string; days: number; onTime: boolean };

/** Each design passed on (a design stint ending forward) in the window, with its business days against the target */
export function designPasses(pieces: readonly Piece[], from: string, to: string): Pass[] {
  const out: Pass[] = [];
  for (const p of pieces)
    for (const s of p.stints) {
      if (!DESIGN.includes(s.stage) || !s.to || !s.next || !AFTER_DESIGN.includes(s.next) || !inWin(s.to, from, to)) continue;
      const days = bizDays(s.from, s.to);
      out.push({ person: makerOf(p, s), piece: p, at: s.to, days, onTime: days <= DESIGN_TARGET });
    }
  return out;
}

/** Which way a client round went: design when any note in it is about the design, copy when only words, null when nothing was said */
export function roundRoute(p: Piece, s: Stint): Route | null {
  const end = s.to ? new Date(Date.parse(s.to) + 3_600_000).toISOString() : new Date(Date.now() + 3_600_000).toISOString();
  const said = p.notes.filter((n) => n.at >= s.from && n.at <= end);
  if (!said.length) return null;
  const routes = said.map((n) => n.route ?? routeFallback(n.text));
  return routes.includes("design") ? "design" : "copy";
}

export type Sendback = { kind: "internal" | "client"; route: Route; person: string | null; at: string; piece: Piece; note: string | null };

/**
 * Every time a piece came back: the strategist's review sending a design back (to its designer), and the client's
 * changes (to the designer when any note is about the design or nothing was said, the strategist when only the words).
 */
export function sendbacksOf(pieces: readonly Piece[], since: string): Sendback[] {
  const out: Sendback[] = [];
  for (const p of pieces)
    for (const s of p.stints) {
      if (!s.to || !s.next || s.to < since) continue;
      if (s.stage === "for_review" && BACK_TO_DESIGN.includes(s.next)) {
        const copy = s.next === "copy_review";
        out.push({ kind: "internal", route: copy ? "copy" : "design", person: copy ? writerAt(p, s.from) : designerAt(p, s.from), at: s.to, piece: p, note: copy ? "Copy sent back in review" : "Design sent back in review" });
      }
      if (s.stage === "with_client" && s.next === "revisions") {
        const route = roundRoute(p, s) ?? "design";
        const end = new Date(Date.parse(s.to) + 3_600_000).toISOString();
        const said = p.notes.filter((n) => n.at >= s.from && n.at <= end && (n.route ?? routeFallback(n.text)) === route).at(-1)?.text ?? null;
        out.push({ kind: "client", route, person: route === "copy" ? writerAt(p, s.from) : designerAt(p, s.from), at: s.to, piece: p, note: said ? `Client: ${said.slice(0, 160)}` : route === "copy" ? "Client asked for copy changes" : "Client asked for design changes" });
      }
    }
  return out;
}

/** Whether a piece's first design came through with no change asked for its design (in review or by the client) */
export function firstPasses(pieces: readonly Piece[], from: string, to: string): { person: string | null; piece: Piece; pass: boolean }[] {
  const out: { person: string | null; piece: Piece; pass: boolean }[] = [];
  for (const p of pieces) {
    const first = p.stints.find((s) => DESIGN.includes(s.stage) && s.to && s.next && AFTER_DESIGN.includes(s.next));
    if (!first?.to || !inWin(first.to, from, to)) continue;
    const back = p.stints.some((s) => s.from >= first.to! && s.to && ((s.stage === "for_review" && s.next && ["ready_for_design", "revisions"].includes(s.next)) || (s.stage === "with_client" && s.next === "revisions" && (roundRoute(p, s) ?? "design") === "design")));
    out.push({ person: makerOf(p, first), piece: p, pass: !back });
  }
  return out;
}

/** Each piece's first time in front of the client in the window: business days from the request, credited to its designer */
export function toClient(pieces: readonly Piece[], from: string, to: string): { person: string | null; piece: Piece; at: string; days: number }[] {
  const out: { person: string | null; piece: Piece; at: string; days: number }[] = [];
  for (const p of pieces) {
    const s = p.stints.find((x) => x.stage === "with_client");
    if (!s || !inWin(s.from, from, to)) continue;
    out.push({ person: designerAt(p, s.from), piece: p, at: s.from, days: bizDays(p.createdAt, s.from) });
  }
  return out;
}

/** Revisions sent back in the window: business days in Revisions, by whoever held it */
export function revisionTurns(pieces: readonly Piece[], from: string, to: string, route?: Route): { person: string | null; days: number; piece: Piece }[] {
  const out: { person: string | null; days: number; piece: Piece }[] = [];
  for (const p of pieces)
    p.stints.forEach((s, i) => {
      if (s.stage !== "revisions" || !s.to || !inWin(s.to, from, to) || s.next === "revisions") return;
      if (route) {
        const round = p.stints.slice(0, i).reverse().find((x) => x.stage === "with_client");
        const r = round ? (roundRoute(p, round) ?? "design") : "design";
        if (r !== route) return;
      }
      out.push({ person: route === "design" ? (makerOf(p, s) ?? s.holder) : s.holder, days: bizDays(s.from, s.to), piece: p });
    });
  return out;
}

/** Whether the piece was ready to send by the due date first set (a later push doesn't make it on time) */
export function metDue(p: Piece): { met: boolean; readyAt: string; due: string } | null {
  const due = p.dueFirst;
  const ready = p.stints.find((s) => READY.includes(s.stage));
  if (!due || !ready) return null;
  const day = new Date(ready.from).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { met: day <= due.slice(0, 10), readyAt: ready.from, due };
}

/** Due dates someone moved later while they held the piece */
export function pushes(p: Piece, since: string): { by: string; at: string; from: string; to: string }[] {
  const out: { by: string; at: string; from: string; to: string }[] = [];
  for (const e of p.dues) {
    if (e.at < since || !e.from || !e.to || e.to <= e.from || !e.by) continue;
    const holding = p.stints.find((s) => s.from <= e.at && (!s.to || s.to >= e.at));
    if (holding?.holder !== e.by) continue;
    out.push({ by: e.by, at: e.at, from: e.from, to: e.to });
  }
  return out;
}

/** Business days the current holder has had it (nothing counts while it waits on the client) */
export function sittingDays(p: Piece, now = new Date().toISOString()): number {
  const s = p.stints.at(-1);
  if (!p.open || !s || s.stage === "with_client" || s.stage === "done" || s.stage === "live") return 0;
  return bizDays(s.from, now);
}

// ─── The score ────────────────────────────────────────────────────────────────

export const LEVEL = (s: number | null) => (s == null ? "Warming up" : s >= 90 ? "On fire" : s >= 75 ? "Strong" : s >= 60 ? "Steady" : "Room to grow");

/** 0 to 100, the creative team's weights: first pass 40%, turnaround 30%, revision turnaround 15%, nothing left sitting 15% */
export function scoreOf(parts: { firstPass: number | null; turnaround: number | null; target: number; revision: number | null; revisionTarget?: number; sitting: number }): number | null {
  const comps: [number, number][] = [];
  if (parts.firstPass != null) comps.push([parts.firstPass, 0.4]);
  if (parts.turnaround != null) comps.push([Math.min(100, (parts.target / Math.max(0.1, parts.turnaround)) * 100), 0.3]);
  if (parts.revision != null) comps.push([Math.min(100, ((parts.revisionTarget ?? REVISION_TARGET) / Math.max(0.1, parts.revision)) * 100), 0.15]);
  comps.push([Math.max(0, 100 - parts.sitting * 20), 0.15]);
  if (comps.length < 3) return null;
  const w = comps.reduce((n, [, x]) => n + x, 0);
  return Math.round(comps.reduce((n, [v, x]) => n + v * x, 0) / w);
}

export const pctOf = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);
export const mean = (xs: readonly (number | null)[]) => r1(avg(xs.filter((x): x is number => x != null)));

/** "Designs passed on: 14, 3 more than the period before" (a count, not days or points) */
export function countVerdict(label: string, value: number | null, previous: number | null, better: "up" | "down") {
  if (value == null) return `No ${label.toLowerCase()} in this period yet.`;
  if (previous == null) return `${label}: ${value}. Nothing to compare with yet.`;
  const diff = Math.round((value - previous) * 10) / 10;
  if (Math.abs(diff) < 0.1) return `${label} is holding steady at ${value}.`;
  const good = better === "up" ? diff > 0 : diff < 0;
  return `${good ? "Better: " : "Worse: "}${Math.abs(diff)} ${diff > 0 ? "more" : "fewer"} than the period before.`;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

/** Copy approved in the window: business days in Copy for review, whether the AI's first draft went through, who approved */
export function copyApprovals(pieces: readonly Piece[], from: string, to: string): { person: string | null; piece: Piece; at: string; days: number | null; firstPass: boolean | null; rewrites: number; draftHours: number | null }[] {
  const out: { person: string | null; piece: Piece; at: string; days: number | null; firstPass: boolean | null; rewrites: number; draftHours: number | null }[] = [];
  for (const p of pieces) {
    const s = p.stints.find((x) => x.stage === "copy_review" && x.to && x.next && x.next !== "copy_review");
    const at = p.copyApproved?.at ?? s?.to ?? null;
    if (!at || !inWin(at, from, to)) continue;
    const rewrites = p.rewrites.filter((r) => r.at <= at).length;
    const known = p.source === "kaizen";
    out.push({
      person: p.copyApproved?.by ?? (s ? s.holder : null),
      piece: p,
      at,
      days: s?.to ? bizDays(s.from, s.to) : null,
      firstPass: known ? rewrites === 0 : null,
      rewrites,
      draftHours: p.drafted ? Math.max(0, (Date.parse(p.drafted) - Date.parse(p.createdAt)) / 3_600_000) : null,
    });
  }
  return out;
}

/** Client rounds in the window by where the changes went (copy, design), for "where client changes come from" */
export function clientRounds(pieces: readonly Piece[], from: string, to: string): { copy: number; design: number; reviewed: number; copyBack: Piece[] } {
  let copy = 0;
  let design = 0;
  const reviewed = new Set<string>();
  const copyBack: Piece[] = [];
  for (const p of pieces)
    for (const s of p.stints) {
      if (s.stage !== "with_client" || !s.to || !inWin(s.to, from, to)) continue;
      reviewed.add(p.key);
      if (s.next !== "revisions") continue;
      const end = new Date(Date.parse(s.to) + 3_600_000).toISOString();
      const said = p.notes.filter((n) => n.at >= s.from && n.at <= end).map((n) => n.route ?? routeFallback(n.text));
      const c = said.filter((r) => r === "copy").length;
      const d = said.filter((r) => r === "design").length;
      if (!said.length) design++;
      copy += c;
      design += d;
      if (c && !copyBack.includes(p)) copyBack.push(p);
    }
  return { copy, design, reviewed: reviewed.size, copyBack };
}

// ─── Build ────────────────────────────────────────────────────────────────────

export const BUILD_TARGET = turnaroundDays("ready_for_build");
const BUILT: Phase[] = ["ready_to_send", "live", "done"];

/** Each build finished (Ready for build moving on to send) in the window, credited to whoever held it */
export function buildPasses(pieces: readonly Piece[], from: string, to: string): Pass[] {
  const out: Pass[] = [];
  for (const p of pieces)
    for (const s of p.stints) {
      if (s.stage !== "ready_for_build" || !s.to || !s.next || !BUILT.includes(s.next) || !inWin(s.to, from, to)) continue;
      const days = bizDays(s.from, s.to);
      out.push({ person: s.holder, piece: p, at: s.to, days, onTime: days <= BUILD_TARGET });
    }
  return out;
}

/** Builds that came back to Ready for build after leaving it (a wrong link, a broken block), against the builder who had it */
export function buildReturns(pieces: readonly Piece[], since: string): { person: string | null; at: string; piece: Piece }[] {
  const out: { person: string | null; at: string; piece: Piece }[] = [];
  for (const p of pieces)
    p.stints.forEach((s, i) => {
      if (s.stage === "ready_for_build" || s.next !== "ready_for_build" || !s.to || s.to < since) return;
      const built = p.stints.slice(0, i).reverse().find((x) => x.stage === "ready_for_build");
      if (!built) return;
      out.push({ person: built.holder, at: s.to, piece: p });
    });
  return out;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

/** Where work waits on the strategist: copy to approve, the final look, the final check before send */
export const STRATEGIST_STAGES: Phase[] = ["copy_review", "for_review", "ready_to_send"];

/** Each finished stint in these stages in the window: business days it sat with whoever held it, against that stage's target */
export function holdTimes(pieces: readonly Piece[], stages: readonly Phase[], from: string, to: string): { person: string | null; stage: Phase; days: number; target: number; piece: Piece }[] {
  const out: { person: string | null; stage: Phase; days: number; target: number; piece: Piece }[] = [];
  for (const p of pieces)
    for (const s of p.stints) {
      if (!stages.includes(s.stage) || !s.to || !inWin(s.to, from, to) || s.next === s.stage) continue;
      out.push({ person: s.holder, stage: s.stage, days: bizDays(s.from, s.to), target: s.stage === "done" ? 0 : turnaroundDays(s.stage as EmailStage), piece: p });
    }
  return out;
}

/** A bottleneck: their stints run half again over target on average, or two or more are sitting past target right now */
export function isBottleneck(avgOver: number | null, sittingPastTarget: number) {
  return (avgOver != null && avgOver >= 1.5) || sittingPastTarget >= 2;
}

// ─── Results: each sent email against its own account's usual ─────────────────

export type Sent = { id: string; clientId: string; name: string; subject: string | null; preview: string | null; channel: string | null; sendTime: string | null; recipients: number; openRate: number | null; clickRate: number | null; revenue: number };
export type Baseline = { n: number; click: number | null; open: number | null; rpr: number | null };

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const isEmail = (c: Pick<Sent, "channel">) => !c.channel || c.channel.toLowerCase() === "email";
/** Big enough to judge: an email with a real audience */
export const judgeable = (c: Sent) => isEmail(c) && c.recipients >= 100 && Boolean(c.sendTime);

/** Each client's usual email: the median click rate, open rate and revenue per recipient of their sends */
export function baselines(sent: readonly Sent[]): Map<string, Baseline> {
  const by = new Map<string, Sent[]>();
  for (const c of sent.filter(judgeable)) by.set(c.clientId, [...(by.get(c.clientId) ?? []), c]);
  const out = new Map<string, Baseline>();
  for (const [id, rows] of by)
    out.set(id, {
      n: rows.length,
      click: median(rows.map((r) => r.clickRate).filter((x): x is number => x != null)),
      open: median(rows.map((r) => r.openRate).filter((x): x is number => x != null)),
      rpr: median(rows.map((r) => r.revenue / Math.max(1, r.recipients))),
    });
  return out;
}

export type Verdict = "winner" | "loser" | "par";

/**
 * An email against its account's usual (at least four sends to compare with). Design is judged on clicks: a winner
 * clicks 20% above their usual without making less per recipient; a loser 20% below. Subject lines on opens: 12% either way.
 */
export function judge(c: Sent, base: Baseline | undefined, on: "click" | "open"): Verdict | null {
  if (!base || base.n < 4 || !judgeable(c)) return null;
  if (on === "click") {
    if (c.clickRate == null || !base.click) return null;
    const lift = c.clickRate / base.click - 1;
    const rpr = c.revenue / Math.max(1, c.recipients);
    if (lift >= 0.2 && (base.rpr == null || base.rpr === 0 || rpr >= base.rpr * 0.8)) return "winner";
    if (lift <= -0.2) return "loser";
    return "par";
  }
  if (c.openRate == null || !base.open) return null;
  const lift = c.openRate / base.open - 1;
  return lift >= 0.12 ? "winner" : lift <= -0.12 ? "loser" : "par";
}

/** How far above or below its account's usual, as a whole percentage (+34, −18) */
export function liftOf(value: number | null, usual: number | null) {
  return value == null || !usual ? null : Math.round((value / usual - 1) * 100);
}

/** Hit rate: winners among the emails judged (a par email is neither), as the creative team counts profitable winners */
export function hitRate(verdicts: readonly (Verdict | null)[]) {
  const w = verdicts.filter((v) => v === "winner").length;
  const l = verdicts.filter((v) => v === "loser").length;
  return { w, l, par: verdicts.filter((v) => v === "par").length, rate: w + l ? Math.round((w / (w + l)) * 100) : null };
}

/** Subject line styles, read on the subject alone (a subject can have several) */
export const SUBJECT_STYLES: { name: string; test: (s: string) => boolean }[] = [
  { name: "A question", test: (s) => s.includes("?") },
  { name: "A number or percentage", test: (s) => /\d/.test(s) },
  { name: "Urgency", test: (s) => /\b(last chance|ends? (today|tonight|soon|tomorrow)|final|hurry|only \d+|today only|don'?t miss|limited|expires?|\d+ ?(hours?|hrs?) left)\b/i.test(s) },
  { name: "An emoji", test: (s) => /\p{Extended_Pictographic}/u.test(s) },
  { name: "Short (40 characters or fewer)", test: (s) => s.length <= 40 },
  { name: "Long (over 60 characters)", test: (s) => s.length > 60 },
  { name: "Personal (you, your)", test: (s) => /\byou(r|'re)?\b/i.test(s) },
  { name: "An offer", test: (s) => /\d+\s?%|\$\s?\d+|\bfree\b|\bsale\b|\boff\b|\bsave\b/i.test(s) },
];

/** Each subject style: how many of its emails beat their account's usual open rate, of those judged */
export function styleResults(rows: readonly { subject: string | null; verdict: Verdict | null }[]): { name: string; winners: number; judged: number; rate: number | null }[] {
  return SUBJECT_STYLES.map((st) => {
    const mine = rows.filter((r) => r.subject && r.verdict && r.verdict !== "par" && st.test(r.subject));
    const w = mine.filter((r) => r.verdict === "winner").length;
    return { name: st.name, winners: w, judged: mine.length, rate: mine.length ? Math.round((w / mine.length) * 100) : null };
  })
    .filter((s) => s.judged >= 2)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.judged - a.judged);
}

/**
 * A flow's last 30 days against the 60 before (its 90-day numbers less the last 30). A flow's design runs for months,
 * so this is where an email wears out: tiring 20% down, tired 35% down. Null with too few sends to tell.
 */
export function flowTrend(f: { recipients30: number; recipients90: number; rate30: number | null; rate90: number | null }, min = 300): { before: number; now: number; change: number } | null {
  if (f.rate30 == null || f.rate90 == null || f.recipients30 < min) return null;
  const rest = f.recipients90 - f.recipients30;
  if (rest < min) return null;
  const before = (f.rate90 * f.recipients90 - f.rate30 * f.recipients30) / rest;
  if (!(before > 0)) return null;
  return { before, now: f.rate30, change: f.rate30 / before - 1 };
}
export const severityOf = (change: number): "tiring" | "tired" | null => (change <= -0.35 ? "tired" : change <= -0.2 ? "tiring" : null);

// ─── Each client's sending pace this cycle ───────────────────────────────────

export type CadenceStatus = "none" | "behind" | "on_track" | "ahead";

/**
 * Where a client's sending stands this cycle, against what they sent last cycle (their usual): nothing sent and
 * nothing in the works is the one to fix; behind the pace their usual sets, on track, or ahead.
 */
export function cadenceStatus(c: { sent: number; usual: number; open: number; elapsed: number }): CadenceStatus {
  if (c.sent === 0 && c.open === 0) return "none";
  if (c.usual <= 0) return "on_track";
  const pace = c.usual * c.elapsed;
  if (c.sent + Math.min(c.open, 1) < pace - 1) return "behind";
  if (c.sent >= pace + 2) return "ahead";
  return "on_track";
}

export const CADENCE_ORDER: Record<CadenceStatus, number> = { none: 0, behind: 1, on_track: 2, ahead: 3 };
