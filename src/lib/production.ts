import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoryEvent } from "@/lib/asana";

// How creative production is going, from each Asana task's history (every column move and reassignment): how long a
// piece takes to reach the client, how many come back for revisions (copy or creative), how fast revisions go back,
// and, per designer, editor and copywriter, a scorecard of their own work. Business days throughout (weekdays, New
// York). While the team works in Asana this is the source; tickets in Kaizen Ads join it as they move over.

type Col = "brief" | "make" | "creative_review" | "copy" | "copy_review" | "client" | "client_revision" | "launch" | "done";
const COLS: [RegExp, Col][] = [
  [/^creative brief/i, "brief"],
  [/^in progress/i, "make"],
  [/^creative for review/i, "creative_review"],
  [/^ready for copy/i, "copy"],
  [/^copy for review/i, "copy_review"],
  [/^copy/i, "copy"],
  [/^(ready for|sent to) client/i, "client"],
  [/^client revision/i, "client_revision"],
  [/^ready for launch/i, "launch"],
  [/^launched/i, "done"],
];
const colOf = (s: string | null): Col | null => (s ? (COLS.find(([re]) => re.test(s.trim()))?.[1] ?? null) : null);

/** Weekday time between two moments, in days (New York weekends don't count). */
export function bizDays(fromIso: string, toIso: string) {
  let a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!(b > a)) return 0;
  let ms = 0;
  while (a < b) {
    const next = Math.min(b, (Math.floor((a - 5 * 3_600_000) / 86_400_000) + 1) * 86_400_000 + 5 * 3_600_000);
    const dow = new Date(a - 5 * 3_600_000).getUTCDay();
    if (dow !== 0 && dow !== 6) ms += next - a;
    a = next;
  }
  return ms / 86_400_000;
}

type Span = { col: Col; from: string; to: string | null; holder: string | null; next: Col | null };
type Task = { gid: string; name: string; clientId: string | null; client: string | null; slug: string | null; createdAt: string; open: boolean; section: string | null; assignee: string | null; url: string | null; spans: Span[] };

/** The task's life as spans: which column, from when to when, who held it, and where it went next. */
function spansOf(createdAt: string, history: HistoryEvent[], section: string | null, assignee: string | null): Span[] {
  const moves = history.filter((e): e is Extract<HistoryEvent, { kind: "moved" }> => e.kind === "moved").sort((a, b) => a.at.localeCompare(b.at));
  const assigns = history.filter((e) => e.kind === "assigned").sort((a, b) => a.at.localeCompare(b.at));
  const holderAt = (iso: string) => {
    const before = assigns.filter((x) => x.at <= iso).at(-1);
    if (before) return before.to;
    return assigns[0]?.to ?? assignee; // assigned later (or never changed): who it went to
  };
  const out: Span[] = [];
  let col = colOf(moves[0]?.from ?? section) ?? "brief";
  let from = createdAt;
  for (const m of moves) {
    const to = colOf(m.to);
    out.push({ col, from, to: m.at, holder: holderAt(from), next: to });
    col = to ?? col;
    from = m.at;
  }
  out.push({ col: colOf(section) ?? col, from, to: null, holder: assignee ?? holderAt(from), next: null });
  // A person's time on a piece changes hands with a reassignment mid-column: split the span there
  return out.flatMap((s) => {
    const inside = assigns.filter((x) => x.at > s.from && (!s.to || x.at < s.to));
    if (!inside.length) return [s];
    const parts: Span[] = [];
    let start = s.from;
    let who = s.holder;
    for (const x of inside) {
      parts.push({ ...s, from: start, to: x.at, holder: who, next: s.col });
      start = x.at;
      who = x.to;
    }
    parts.push({ ...s, from: start, holder: who });
    return parts;
  });
}

const MAKE: Col[] = ["make", "client_revision"];
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

export type Scorecard = {
  name: string;
  profileId: string | null;
  kind: "creative" | "copy";
  score: number | null; // 0–100, null with too little to go on
  level: string;
  previous: number | null; // the 30 days before
  pieces: number; // pieces passed on in the window
  turnaround: number | null; // business days per piece (make, or copy)
  turnaroundTarget: number;
  firstPass: number | null; // % that went through with no changes asked for
  revisionTurnaround: number | null; // business days to send a revision back
  sitting: { name: string; client: string | null; days: number; url: string | null }[]; // on them 2+ business days
};

export type Production = {
  window: number; // days
  pieces: number; // reached the client in the window
  firstDraft: number | null; // business days, created → first time in front of the client
  revisionRate: number | null; // % of pieces the client sent back at least once
  revisionTurnaround: number | null; // business days, client revision → back to the client
  split: { copy: number; creative: number }; // revisions asked for, by kind (client and internal)
  slow: { client: string; slug: string | null; days: number; pieces: number }[]; // clients whose pieces take longest
  revisions: { client: string; slug: string | null; perPiece: number; pieces: number }[]; // clients sending the most back
  team: Scorecard[];
};

const TARGET = { creative: 2, copy: 1, revision: 1 };
const LEVEL = (s: number | null) => (s == null ? "Warming up" : s >= 90 ? "On fire" : s >= 75 ? "Strong" : s >= 60 ? "Steady" : "Room to grow");

function score(parts: { firstPass: number | null; turnaround: number | null; target: number; revision: number | null; sitting: number }) {
  const comps: [number, number][] = [];
  if (parts.firstPass != null) comps.push([parts.firstPass, 0.4]);
  if (parts.turnaround != null) comps.push([Math.min(100, (parts.target / Math.max(0.1, parts.turnaround)) * 100), 0.3]);
  if (parts.revision != null) comps.push([Math.min(100, (TARGET.revision / Math.max(0.1, parts.revision)) * 100), 0.15]);
  comps.push([Math.max(0, 100 - parts.sitting * 20), 0.15]);
  if (comps.length < 3) return null; // nothing passed on yet: no score to give
  const w = comps.reduce((n, [, x]) => n + x, 0);
  return Math.round(comps.reduce((n, [v, x]) => n + v * x, 0) / w);
}

/** Everything above for the last `days` days (and the scorecards for the window before, for the trend). */
export async function loadProduction(db: SupabaseClient, days = 30): Promise<Production | null> {
  const since = new Date(Date.now() - 2 * days * 86_400_000).toISOString();
  const [{ data: rows }, { data: people }] = await Promise.all([
    db
      .from("asana_tasks")
      .select("gid, name, client_id, asana_created_at, open, section, assignee_name, url, history, history_read_at, clients(name, slug)")
      .not("history_read_at", "is", null)
      .gte("asana_modified_at", since)
      .limit(2000),
    db.from("profiles").select("id, full_name, role").eq("is_active", true),
  ]);
  if (!rows?.length) return null;
  const now = new Date().toISOString();
  const cut = new Date(Date.now() - days * 86_400_000).toISOString();
  const tasks: Task[] = rows.map((r) => {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    return { gid: r.gid, name: r.name, clientId: r.client_id, client: c?.name ?? null, slug: c?.slug ?? null, createdAt: r.asana_created_at ?? now, open: r.open, section: r.section, assignee: r.assignee_name, url: r.url, spans: spansOf(r.asana_created_at ?? now, (r.history ?? []) as HistoryEvent[], r.section, r.assignee_name) };
  });
  const len = (s: Span) => bizDays(s.from, s.to ?? now);

  // Per piece: first time in front of the client, revisions, how long each revision took to go back
  const first: { t: Task; days: number }[] = [];
  const revTurn: number[] = [];
  let reached = 0;
  let sentBack = 0;
  let copy = 0;
  let creative = 0;
  const perClient = new Map<string, { client: string; slug: string | null; drafts: number[]; pieces: number; revisions: number }>();
  for (const t of tasks) {
    const firstClient = t.spans.find((s) => s.col === "client");
    const key = t.clientId ?? "none";
    const pc = perClient.get(key) ?? { client: t.client ?? "No client", slug: t.slug, drafts: [], pieces: 0, revisions: 0 };
    if (firstClient && firstClient.from >= cut) {
      reached++;
      const d = bizDays(t.createdAt, firstClient.from);
      first.push({ t, days: d });
      pc.drafts.push(d);
      pc.pieces++;
    }
    const clientRevs = t.spans.filter((s) => s.col === "client_revision" && s.from >= cut);
    if (firstClient && firstClient.from >= cut && t.spans.some((s) => s.col === "client_revision")) sentBack++;
    pc.revisions += clientRevs.length;
    perClient.set(key, pc);
    for (const s of t.spans) {
      if (!s.to || s.to < cut) continue;
      // Changes asked for: internal review sending it back, or the client's revision going to copy or to design
      if ((s.col === "copy_review" && s.next === "copy") || (s.col === "client_revision" && (s.next === "copy" || s.next === "copy_review"))) copy++;
      if ((s.col === "creative_review" && s.next === "make") || (s.col === "client_revision" && (s.next === "make" || s.next === "creative_review"))) creative++;
    }
    // A client revision → the next time it's back in front of the client
    t.spans.forEach((s, i) => {
      if (s.col !== "client_revision" || s.from < cut) return;
      const back = t.spans.slice(i + 1).find((x) => x.col === "client");
      if (back) revTurn.push(bizDays(s.from, back.from));
    });
  }

  const overall = avg(first.map((f) => f.days));
  const clients = [...perClient.values()].filter((c) => c.client !== "No client" && c.pieces >= 2);
  const slow = clients
    .map((c) => ({ client: c.client, slug: c.slug, days: round1(avg(c.drafts)) ?? 0, pieces: c.pieces }))
    .filter((c) => c.days >= Math.max(4, (overall ?? 0) * 1.5))
    .sort((a, b) => b.days - a.days)
    .slice(0, 6);
  const revisions = clients
    .map((c) => ({ client: c.client, slug: c.slug, perPiece: Math.round((c.revisions / c.pieces) * 10) / 10, pieces: c.pieces }))
    .filter((c) => c.perPiece >= 0.75)
    .sort((a, b) => b.perPiece - a.perPiece)
    .slice(0, 6);

  // Scorecards: each designer, editor and copywriter, on the time a piece was in their hands
  const personFor = (name: string | null) => (name ? (people ?? []).find((p) => p.full_name.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(p.full_name.toLowerCase())) : undefined);
  const cards = new Map<string, Scorecard & { _prev: { make: number[]; rev: number[]; pass: boolean[] } }>();
  const KIND: Record<string, "creative" | "copy"> = { graphic_designer: "creative", video_editor: "creative", copywriter: "copy" };
  const cardFor = (holder: string) => {
    const p = personFor(holder);
    const kind = p ? KIND[p.role as string] : undefined;
    if (!kind) return null;
    const key = p!.id;
    if (!cards.has(key))
      cards.set(key, { name: p!.full_name, profileId: p!.id, kind, score: null, level: "", previous: null, pieces: 0, turnaround: null, turnaroundTarget: TARGET[kind], firstPass: null, revisionTurnaround: null, sitting: [], _prev: { make: [], rev: [], pass: [] } });
    return cards.get(key)!;
  };
  const acc = new Map<string, { make: number[]; rev: number[]; pass: boolean[] }>();
  for (const t of tasks) {
    t.spans.forEach((s, i) => {
      if (!s.holder) return;
      const card = cardFor(s.holder);
      if (!card) return;
      // A designer who works a piece straight out of the Creative Brief column (never moving it to In Progress) made it
      // there: that span counts once it's passed on, not while it's waiting in the brief column
      const madeFromBrief = card.kind === "creative" && s.col === "brief" && s.to != null && s.next != null && s.next !== "brief";
      const mine = card.kind === "creative" ? MAKE.includes(s.col) || madeFromBrief : s.col === "copy";
      if (!mine) return;
      // Still on them: counts as sitting once it's been 2+ business days
      if (!s.to) {
        if (t.open && len(s) >= 2) card.sitting.push({ name: t.name, client: t.client, days: round1(len(s)) ?? 0, url: t.url });
        return;
      }
      // Handed to someone else mid-column: not a piece they passed on
      if (s.next === s.col) return;
      const recent = s.to >= cut;
      const bucket = recent ? (acc.get(card.profileId!) ?? { make: [], rev: [], pass: [] }) : card._prev;
      if (recent) acc.set(card.profileId!, bucket);
      if (s.col === "client_revision") bucket.rev.push(len(s));
      else {
        bucket.make.push(len(s));
        // First pass: after they passed it on, nothing came back to them for changes
        const later = t.spans.slice(i + 1);
        const back = card.kind === "creative" ? later.some((x) => x.col === "make" || x.col === "client_revision") : later.some((x) => x.col === "copy");
        bucket.pass.push(!back);
      }
    });
  }
  const team: Scorecard[] = [...cards.values()].map(({ _prev, ...c }) => {
    const a = acc.get(c.profileId!) ?? { make: [], rev: [], pass: [] };
    const firstPass = a.pass.length ? Math.round((a.pass.filter(Boolean).length / a.pass.length) * 100) : null;
    const turnaround = round1(avg(a.make));
    const revisionTurnaround = round1(avg(a.rev));
    const s = score({ firstPass, turnaround, target: c.turnaroundTarget, revision: revisionTurnaround, sitting: c.sitting.length });
    const prev = score({
      firstPass: _prev.pass.length ? Math.round((_prev.pass.filter(Boolean).length / _prev.pass.length) * 100) : null,
      turnaround: avg(_prev.make),
      target: c.turnaroundTarget,
      revision: avg(_prev.rev),
      sitting: 0,
    });
    return { ...c, pieces: a.make.length, turnaround, firstPass, revisionTurnaround, score: s, level: LEVEL(s), previous: prev, sitting: c.sitting.sort((x, y) => y.days - x.days).slice(0, 5) };
  });
  team.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  return {
    window: days,
    pieces: reached,
    firstDraft: round1(overall),
    revisionRate: reached ? Math.round((sentBack / reached) * 100) : null,
    revisionTurnaround: round1(avg(revTurn)),
    split: { copy, creative },
    slow,
    revisions,
    team,
  };
}
