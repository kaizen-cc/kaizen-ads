import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleElapsed } from "@/lib/allotment";
import { packageGaps } from "@/lib/package-gaps";
import { loadProduction, type Production, type Scorecard } from "@/lib/production";
import { roleLabel, type TeamRole } from "@/lib/roles";

// The creative team's KPIs for execs and leads, on the Board's KPIs tab: speed, quality and volume against the period
// before, each maker's card, every creative-package client's allotment this billing cycle, how the new creative is
// doing in the ad accounts, and the handful of things to act on first. Production numbers come from the Creative
// board's history (Asana while the team moves over) and the Board's own tickets; allotments from each client's billing
// cycle; creative results from the ledger (profitable winners only, rule one).

export type Period = "cycle" | "30" | "90";
export const PERIODS: { key: Period; label: string }[] = [
  { key: "cycle", label: "This billing month" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
];

export type Tone = "ok" | "warn" | "bad" | null;
export type Headline = { key: string; label: string; value: number | null; unit: "d" | "%" | ""; previous: number | null; better: "down" | "up"; tone: Tone; verdict: string; hint: string };
export type Maker = Scorecard & { role: string; open: number; late: number; act: string | null };
export type ClientAllotment = {
  id: string;
  name: string;
  slug: string;
  used: number;
  cap: number | null;
  elapsed: number; // 0–1 through the billing cycle
  resets: string | null;
  status: "ahead" | "on_track" | "behind" | "at_risk" | "missed";
};
export type Action = { key: string; tone: "bad" | "warn"; title: string; detail: string; href: string };
export type CreativeKpis = {
  period: Period;
  days: number;
  headlines: Headline[];
  makers: Maker[];
  allotments: ClientAllotment[];
  revisionClients: Production["revisions"];
  slowClients: Production["slow"];
  late: { number: number; title: string; client: string; stage: string; hoursOver: number; assignee: string | null }[];
  results: { launched: number; winners: number; losers: number; testing: number; hitRate: number | null; previousHitRate: number | null; topClients: { name: string; slug: string; winners: number; judged: number }[] };
  tiring: { client: string; slug: string; ad: string; severity: string; thumbnail: string | null; since: string; refreshing: boolean }[];
  actions: Action[];
  split: { copy: number; creative: number };
  source: { asana: boolean };
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

/** How many days "this billing month" covers: the median creative client's days into their cycle (at least a week). */
export function cycleDays(rows: { period_start: string | null }[]) {
  const into = rows
    .map((r) => (r.period_start ? (Date.now() - Date.parse(`${r.period_start}T00:00:00`)) / 86_400_000 : null))
    .filter((x): x is number => x != null && x >= 0)
    .sort((a, b) => a - b);
  const mid = into.length ? into[Math.floor(into.length / 2)] : new Date().getDate();
  return Math.max(7, Math.round(mid));
}

/** "Turnaround is 1.2 days faster than the period before" */
export function verdictOf(label: string, value: number | null, previous: number | null, unit: string, better: "up" | "down", noun: string) {
  if (value == null) return `No ${noun} in this period yet.`;
  if (previous == null) return `${label} is ${value}${unit}. Nothing to compare with yet.`;
  const diff = r1(value - previous) ?? 0;
  if (Math.abs(diff) < (unit === "%" ? 2 : 0.2)) return `${label} is holding steady at ${value}${unit}.`;
  const good = better === "down" ? diff < 0 : diff > 0;
  const amount = unit === "%" ? `${Math.abs(diff)} points` : `${Math.abs(diff)} ${Math.abs(diff) === 1 ? "day" : "days"}`;
  const word = unit === "%" ? (diff > 0 ? "higher" : "lower") : diff > 0 ? "slower" : "faster";
  return `${good ? "Better: " : "Worse: "}${amount} ${word} than the period before.`;
}

export async function loadCreativeKpis(db: SupabaseClient, period: Period): Promise<CreativeKpis> {
  const { data: usage } = await db.from("client_allotment_usage").select("*");
  const usageRows = (usage ?? []) as { client_id: string; images_per_month: number | null; videos_per_month: number | null; images_used: number; videos_used: number; period_start: string | null; period_end: string | null }[];
  const days = period === "cycle" ? cycleDays(usageRows) : Number(period);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const before = new Date(Date.now() - 2 * days * 86_400_000).toISOString();

  const [now, prev, { data: clients }, { data: tickets }, { data: people }, gaps, { data: ledger }, { data: fatigue }] = await Promise.all([
    loadProduction(db, days).catch(() => null),
    loadProduction(db, days, days).catch(() => null),
    db.from("clients").select("id, name, slug, creative_package, status").is("archived_at", null).in("status", ["active", "onboarding"]),
    db.from("board_requests").select("number, title, client_name, client_slug, stage, assignee_id, assignee_name, minutes_over, created_at, launched_at").is("deleted_at", null).neq("stage", "launched").limit(1500),
    db.from("profiles").select("id, full_name, role").eq("is_active", true),
    packageGaps(db).catch(() => new Map()),
    db.from("client_ledger").select("client_id, verdict, first_seen").eq("kind", "creative").gte("first_seen", before.slice(0, 10)).limit(5000),
    db.from("ad_fatigue").select("client_id, ad_name, headline, severity, thumbnail, first_flagged_at, state").in("state", ["open", "refreshing"]).order("first_flagged_at", { ascending: true }).limit(200),
  ]);
  const clientById = new Map((clients ?? []).map((c) => [c.id as string, c]));

  // ─── Headlines ───
  const team = now?.team ?? [];
  const prevTeam = prev?.team ?? [];
  const pooled = (t: Scorecard[], f: (s: Scorecard) => number | null) => {
    const xs = t.filter((s) => s.pieces > 0 && f(s) != null);
    const n = xs.reduce((a, s) => a + s.pieces, 0);
    return n ? Math.round(xs.reduce((a, s) => a + (f(s) ?? 0) * s.pieces, 0) / n) : null;
  };
  const firstPass = pooled(team, (s) => s.firstPass);
  const firstPassPrev = pooled(prevTeam, (s) => s.firstPass);
  const onTime = pooled(team, (s) => s.onTime);
  const onTimePrev = pooled(prevTeam, (s) => s.onTime);

  const judged = (from: string, to: string) => {
    const rows = (ledger ?? []).filter((r) => (r.first_seen as string) >= from.slice(0, 10) && (r.first_seen as string) < to.slice(0, 10));
    const w = rows.filter((r) => r.verdict === "winner").length;
    const l = rows.filter((r) => r.verdict === "loser").length;
    return { rows, w, l, t: rows.filter((r) => r.verdict === "testing").length, rate: w + l ? Math.round((w / (w + l)) * 100) : null };
  };
  const cur = judged(since, new Date(Date.now() + 86_400_000).toISOString());
  const old = judged(before, since);

  const tone = (v: number | null, ok: (x: number) => boolean, warn: (x: number) => boolean): Tone => (v == null ? null : ok(v) ? "ok" : warn(v) ? "warn" : "bad");
  const headlines: Headline[] = [
    { key: "draft", label: "To a first draft", value: now?.firstDraft ?? null, unit: "d", previous: prev?.firstDraft ?? null, better: "down", tone: tone(now?.firstDraft ?? null, (x) => x <= 3, (x) => x <= 5), verdict: verdictOf("Brief to first draft", now?.firstDraft ?? null, prev?.firstDraft ?? null, "d", "down", "pieces reached a client"), hint: `brief → in front of the client · ${now?.pieces ?? 0} pieces` },
    { key: "pass", label: "First-pass approval", value: firstPass, unit: "%", previous: firstPassPrev, better: "up", tone: tone(firstPass, (x) => x >= 70, (x) => x >= 50), verdict: verdictOf("First-pass approval", firstPass, firstPassPrev, "%", "up", "pieces passed on"), hint: "went through with no changes asked" },
    { key: "back", label: "Sent back by clients", value: now?.revisionRate ?? null, unit: "%", previous: prev?.revisionRate ?? null, better: "down", tone: tone(now?.revisionRate ?? null, (x) => x <= 25, (x) => x <= 45), verdict: verdictOf("Client revision rate", now?.revisionRate ?? null, prev?.revisionRate ?? null, "%", "down", "pieces reached a client"), hint: "of pieces, at least once" },
    { key: "rev", label: "Revision turnaround", value: now?.revisionTurnaround ?? null, unit: "d", previous: prev?.revisionTurnaround ?? null, better: "down", tone: tone(now?.revisionTurnaround ?? null, (x) => x <= 1, (x) => x <= 2), verdict: verdictOf("Revision turnaround", now?.revisionTurnaround ?? null, prev?.revisionTurnaround ?? null, "d", "down", "client revisions"), hint: "client revision → back to them" },
    { key: "ontime", label: "On time", value: onTime, unit: "%", previous: onTimePrev, better: "up", tone: tone(onTime, (x) => x >= 80, (x) => x >= 60), verdict: verdictOf("On-time delivery", onTime, onTimePrev, "%", "up", "pieces passed on"), hint: "pieces made within their turnaround target" },
    { key: "hit", label: "New creative that wins", value: cur.rate, unit: "%", previous: old.rate, better: "up", tone: tone(cur.rate, (x) => x >= 30, (x) => x >= 15), verdict: verdictOf("Hit rate", cur.rate, old.rate, "%", "up", "new creative judged"), hint: `profitable winners of ${cur.w + cur.l} judged in the ad accounts` },
  ];

  // ─── Makers ───
  const openBy = new Map<string, { open: number; late: number }>();
  for (const t of tickets ?? []) {
    if (!t.assignee_id) continue;
    const o = openBy.get(t.assignee_id as string) ?? { open: 0, late: 0 };
    o.open++;
    if ((t.minutes_over as number) > 0) o.late++;
    openBy.set(t.assignee_id as string, o);
  }
  const roleOf = new Map((people ?? []).map((p) => [p.id as string, roleLabel(p.role as TeamRole)]));
  const loads = team.map((s) => (openBy.get(s.profileId ?? "")?.open ?? 0) + s.sitting.length);
  const typical = avg(loads) ?? 0;
  const makers: Maker[] = team.map((s) => {
    const o = openBy.get(s.profileId ?? "") ?? { open: 0, late: 0 };
    const load = o.open + s.sitting.length;
    const act =
      s.sitting.length >= 3 || o.late >= 2
        ? `${s.sitting.length + o.late} pieces waiting on them: clear the oldest first`
        : typical && load >= Math.max(6, typical * 1.6)
          ? `Carrying ${load} open pieces, well above the team's ${Math.round(typical)}: move some work`
          : s.firstPass != null && s.firstPass < 50
            ? "Half their work comes back for changes: review the briefs and feedback together"
            : s.turnaround != null && s.turnaround > s.turnaroundTarget * 1.5
              ? `Turnaround ${s.turnaround}d against a ${s.turnaroundTarget}d target`
              : null;
    return { ...s, role: roleOf.get(s.profileId ?? "") ?? (s.kind === "copy" ? "Copywriter" : "Creative"), open: o.open, late: o.late, act };
  });

  // ─── Allotments, per creative-package client, this billing cycle ───
  const allotments: ClientAllotment[] = usageRows
    .map((u) => {
      const c = clientById.get(u.client_id);
      if (!c?.creative_package) return null;
      const cap = u.images_per_month == null && u.videos_per_month == null ? null : (u.images_per_month ?? 0) + (u.videos_per_month ?? 0);
      const used = (u.images_used ?? 0) + (u.videos_used ?? 0);
      const cycle = u.period_start && u.period_end ? { start: u.period_start, end: u.period_end } : null;
      const elapsed = cycleElapsed(cycle);
      const gap = gaps.get(u.client_id);
      const share = cap ? used / cap : null;
      const status: ClientAllotment["status"] = gap?.missed ? "missed" : gap?.atRisk ? "at_risk" : share == null ? "on_track" : share >= elapsed + 0.15 ? "ahead" : share >= elapsed - 0.2 ? "on_track" : "behind";
      return { id: u.client_id, name: c.name as string, slug: c.slug as string, used, cap, elapsed, resets: u.period_end, status };
    })
    .filter((x): x is ClientAllotment => x != null);
  const ORDER = { missed: 0, at_risk: 1, behind: 2, on_track: 3, ahead: 4 };
  allotments.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

  // ─── Late tickets on the Board ───
  const late = (tickets ?? [])
    .filter((t) => (t.minutes_over as number) > 0)
    .sort((a, b) => (b.minutes_over as number) - (a.minutes_over as number))
    .slice(0, 8)
    .map((t) => ({ number: t.number as number, title: t.title as string, client: (t.client_name as string) ?? "", stage: t.stage as string, hoursOver: Math.round((t.minutes_over as number) / 60), assignee: (t.assignee_name as string | null) ?? null }));

  // ─── Creative in the ad accounts ───
  const byClient = new Map<string, { w: number; j: number }>();
  for (const r of cur.rows) {
    const b = byClient.get(r.client_id as string) ?? { w: 0, j: 0 };
    if (r.verdict === "winner") b.w++;
    if (r.verdict === "winner" || r.verdict === "loser") b.j++;
    byClient.set(r.client_id as string, b);
  }
  const topClients = [...byClient.entries()]
    .filter(([id, b]) => b.w > 0 && clientById.has(id))
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, 5)
    .map(([id, b]) => ({ name: clientById.get(id)!.name as string, slug: clientById.get(id)!.slug as string, winners: b.w, judged: b.j }));
  const tiring = (fatigue ?? [])
    .filter((f) => clientById.has(f.client_id as string))
    .map((f) => ({ client: clientById.get(f.client_id as string)!.name as string, slug: clientById.get(f.client_id as string)!.slug as string, ad: (f.headline as string) || (f.ad_name as string), severity: f.severity as string, thumbnail: (f.thumbnail as string | null) ?? null, since: f.first_flagged_at as string, refreshing: f.state === "refreshing" }));

  // ─── Act on this: the few things that matter most, each linking to where it's handled ───
  const actions: Action[] = [];
  const missed = allotments.filter((a) => a.status === "missed");
  const risk = allotments.filter((a) => a.status === "at_risk" || a.status === "behind");
  if (missed.length) actions.push({ key: "missed", tone: "bad", title: `${missed.length} ${missed.length === 1 ? "client" : "clients"} paid for creative last cycle and got none`, detail: missed.slice(0, 3).map((a) => a.name).join(", "), href: `/clients/${missed[0].slug}` });
  if (late.length) actions.push({ key: "late", tone: late.length >= 5 ? "bad" : "warn", title: `${late.length} ${late.length === 1 ? "ticket is" : "tickets are"} late on the Board`, detail: `Oldest: #${late[0].number} ${late[0].title} (${late[0].hoursOver}h over)`, href: "/board?only=bad" });
  if (risk.length) actions.push({ key: "risk", tone: "warn", title: `${risk.length} ${risk.length === 1 ? "client is" : "clients are"} behind on this cycle's allotment`, detail: risk.slice(0, 3).map((a) => `${a.name} ${a.used}/${a.cap ?? "?"}`).join(" · "), href: `/clients/${risk[0].slug}` });
  const overloaded = makers.filter((m) => m.act && /open pieces|waiting on them/.test(m.act));
  for (const m of overloaded.slice(0, 2)) actions.push({ key: `load-${m.profileId}`, tone: "warn", title: `${m.name}: ${m.act}`, detail: `${m.open} open on the Board, ${m.sitting.length} sitting 2+ days in Asana`, href: m.profileId ? `/board?person=${m.profileId}` : "/board" });
  if (now?.revisionRate != null && prev?.revisionRate != null && now.revisionRate - prev.revisionRate >= 10)
    actions.push({ key: "revspike", tone: "warn", title: `Client revisions jumped to ${now.revisionRate}% (from ${prev.revisionRate}%)`, detail: now.revisions[0] ? `Most from ${now.revisions[0].client} (${now.revisions[0].perPiece} per piece)` : "Look at what clients are asking to change", href: now.revisions[0]?.slug ? `/clients/${now.revisions[0].slug}` : "/board" });
  else if (now?.revisions[0] && now.revisions[0].perPiece >= 1.5) actions.push({ key: "revclient", tone: "warn", title: `${now.revisions[0].client} sends back ${now.revisions[0].perPiece} revisions per piece`, detail: "Check the brief and their Brand Bible's dos and don'ts before the next round", href: now.revisions[0].slug ? `/clients/${now.revisions[0].slug}` : "/board" });
  const waitingRefresh = tiring.filter((t) => !t.refreshing);
  if (waitingRefresh.length >= 3) actions.push({ key: "tiring", tone: "warn", title: `${waitingRefresh.length} tiring ads have no refresh in the works`, detail: waitingRefresh.slice(0, 3).map((t) => t.client).join(", "), href: "/fatigue" });

  return {
    period,
    days,
    headlines,
    makers,
    allotments,
    revisionClients: now?.revisions ?? [],
    slowClients: now?.slow ?? [],
    late,
    results: { launched: cur.rows.length, winners: cur.w, losers: cur.l, testing: cur.t, hitRate: cur.rate, previousHitRate: old.rate, topClients },
    tiring: tiring.slice(0, 8),
    actions: actions.slice(0, 6),
    split: now?.split ?? { copy: 0, creative: 0 },
    source: { asana: Boolean(now) },
  };
}
