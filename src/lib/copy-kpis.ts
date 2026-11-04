import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cycleDays, verdictOf, type Headline, type Period, type Tone } from "@/lib/creative-kpis";

// The copy team's KPIs for execs and leads, on the Board's Copy KPIs tab: how fast copy moves from approved creative to
// an AI draft to approved, how often it's approved first time (by us and by the client), what the client-rule check
// flags and what's rebutted or forced through, each copywriter's card, each client's copy, and which angles and
// frameworks the copy rode into profitable winners (rule one: if it isn't profitable, it isn't working).

export type CopyAction = { key: string; tone: "bad" | "warn"; title: string; detail: string; href: string };
export type Copywriter = {
  id: string;
  name: string;
  reviewed: number;
  turnaround: number | null; // business days from the draft to approved
  firstPass: number | null; // % approved without a rewrite
  sendbacks: number; // sets the client sent back
  caught: number; // conflicts the check flagged on their sets
  rebutted: number; // conflicts they disagreed with
  weekly: number[];
  open: number;
  act: string | null;
};
export type CopyClient = { id: string; name: string; slug: string; sets: number; sendbacks: number; open: number; topRules: { rule: string; n: number }[] };
export type Framework = { name: string; winners: number; judged: number; rate: number | null };
export type CopyKpis = {
  period: Period;
  days: number;
  headlines: Headline[];
  writers: Copywriter[];
  clients: CopyClient[];
  frameworks: Framework[];
  angles: { title: string; client: string; slug: string; verdict: string; ads: number }[];
  late: { number: number; title: string; client: string; stage: string; hoursOver: number }[];
  overrides: { kind: "force" | "rebut"; rule: string; reason: string | null; client: string; slug: string; number: number | null; by: string | null; at: string }[];
  actions: CopyAction[];
  split: { copy: number; creative: number };
};

type SetRow = {
  id: string;
  request_id: string;
  client_id: string;
  angle_id: string | null;
  status: string;
  version: number | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  ads: { formula?: string; angle?: string }[] | null;
  client_status: { status?: string }[] | null;
  violations: { rule?: string }[] | null;
  dismissed: unknown;
  changes: unknown;
};

const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Whole business days (Mon–Fri) between two moments, to a tenth */
function bizDays(from: string, to: string) {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return 0;
  let ms = 0;
  for (let t = a; t < b; t += 3_600_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) ms += Math.min(3_600_000, b - t);
  }
  return ms / 86_400_000;
}

/** "PAS + StoryBrand" or "Hook + pain + relief + close (BAB)" → the named frameworks in it */
function frameworksOf(formula: string | undefined) {
  if (!formula) return [];
  const named = [...formula.matchAll(/\b(PAS|BAB|AIDA|PASTOR|FAB|4Ps|StoryBrand|Epiphany Bridge|Hook Story Offer|Before[- ]After[- ]Bridge|Problem[- ]Agitate[- ]Solve)\b/gi)].map((m) => m[1]);
  const norm = (x: string) => (/before/i.test(x) ? "BAB" : /problem/i.test(x) ? "PAS" : /storybrand/i.test(x) ? "StoryBrand" : /epiphany/i.test(x) ? "Epiphany Bridge" : x.toUpperCase() === x ? x : x.replace(/\b\w/g, (c) => c.toUpperCase()));
  return [...new Set(named.map(norm))];
}

const sentBack = (s: SetRow) => (Array.isArray(s.client_status) ? s.client_status.some((c) => c?.status && c.status !== "approved") : false);
const clientReviewed = (s: SetRow) => Array.isArray(s.client_status) && s.client_status.some((c) => c?.status);
const openConflicts = (s: SetRow) => {
  const v = Array.isArray(s.violations) ? s.violations : [];
  const gone = new Set((Array.isArray(s.dismissed) ? (s.dismissed as unknown[]) : []).map((d) => (typeof d === "string" ? d : JSON.stringify(d))));
  return v.filter((x) => !gone.has(JSON.stringify(x)) && !gone.has(x.rule ?? "")).length;
};

export async function loadCopyKpis(db: SupabaseClient, period: Period): Promise<CopyKpis> {
  const { data: usage } = await db.from("client_allotment_usage").select("period_start");
  const days = period === "cycle" ? cycleDays((usage ?? []) as { period_start: string | null }[]) : Number(period);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const before = new Date(Date.now() - 2 * days * 86_400_000).toISOString();

  const [{ data: sets }, { data: events }, { data: overrides }, { data: clients }, { data: people }, { data: tickets }, { data: ledger }, { data: angles }, { data: comments }] = await Promise.all([
    db.from("copy_sets").select("id, request_id, client_id, angle_id, status, version, approved_by, approved_at, created_at, ads, client_status, violations, dismissed, changes").gte("updated_at", before).limit(3000),
    db.from("request_events").select("request_id, kind, from_stage, to_stage, created_at").gte("created_at", before).or("to_stage.eq.copy,to_stage.eq.copy_review,from_stage.eq.copy_review").limit(10000),
    db.from("copy_rule_overrides").select("client_id, request_id, rule, reason, kind, created_by, created_at").gte("created_at", before).order("created_at", { ascending: false }).limit(500),
    db.from("clients").select("id, name, slug").is("archived_at", null),
    db.from("profiles").select("id, full_name, role").eq("is_active", true),
    db.from("board_requests").select("id, number, title, client_name, client_slug, stage, minutes_over").is("deleted_at", null).in("stage", ["copy", "copy_review"]).limit(500),
    db.from("client_ledger").select("client_id, key, title, verdict, ads, first_seen").eq("kind", "angle").in("verdict", ["winner", "loser"]).gte("first_seen", new Date(Date.now() - Math.max(90, 2 * days) * 86_400_000).toISOString().slice(0, 10)).limit(3000),
    db.from("angles").select("id, client_id, name"),
    db.from("review_comments").select("request_id, design_id, author_contact_id, created_at").not("author_contact_id", "is", null).gte("created_at", before).limit(5000),
  ]);
  const rows = (sets ?? []) as SetRow[];
  const clientById = new Map((clients ?? []).map((c) => [c.id as string, c]));
  const nameOf = new Map((people ?? []).map((p) => [p.id as string, p.full_name as string]));
  const numberOf = new Map((tickets ?? []).map((t) => [t.id as string, t.number as number]));

  // ─── Timings per set: creative approved → AI draft → copy approved ───
  const firstAt = (rid: string, test: (e: { kind: string; from_stage: string | null; to_stage: string | null }) => boolean) =>
    (events ?? []).filter((e) => e.request_id === rid && test(e as never)).map((e) => e.created_at as string).sort()[0] ?? null;
  const timing = rows.map((s) => {
    const toCopy = firstAt(s.request_id, (e) => e.to_stage === "copy") ?? s.created_at;
    const drafted = firstAt(s.request_id, (e) => e.to_stage === "copy_review");
    return { s, toCopy, drafted, approved: s.approved_at };
  });
  const inWindow = (at: string | null, from: string, to: string) => Boolean(at && at >= from && at < to);
  const nowIso = new Date(Date.now() + 60_000).toISOString();
  const metrics = (from: string, to: string) => {
    const approved = timing.filter((t) => inWindow(t.approved, from, to));
    const draftHours = avg(timing.filter((t) => t.drafted && inWindow(t.drafted, from, to)).map((t) => (Date.parse(t.drafted!) - Date.parse(t.toCopy)) / 3_600_000).filter((h) => h >= 0 && h < 24 * 14));
    const review = avg(approved.filter((t) => t.drafted).map((t) => bizDays(t.drafted!, t.approved!)));
    const total = avg(approved.map((t) => bizDays(t.toCopy, t.approved!)));
    const firstPass = approved.length ? Math.round((approved.filter((t) => (t.s.version ?? 1) <= 1).length / approved.length) * 100) : null;
    const reviewed = rows.filter((s) => clientReviewed(s) && inWindow(s.approved_at ?? s.created_at, from, to));
    const clientPass = reviewed.length ? Math.round((reviewed.filter((s) => !sentBack(s)).length / reviewed.length) * 100) : null;
    const checked = rows.filter((s) => inWindow(s.created_at, from, to) || inWindow(s.approved_at, from, to));
    const conflicts = checked.length ? r1(checked.reduce((a, s) => a + (Array.isArray(s.violations) ? s.violations.length : 0), 0) / checked.length) : null;
    const ovr = (overrides ?? []).filter((o) => inWindow(o.created_at as string, from, to));
    return { approved: approved.length, draftHours: r1(draftHours), review: r1(review), total: r1(total), firstPass, clientPass, sendback: clientPass == null ? null : 100 - clientPass, conflicts, force: ovr.filter((o) => o.kind === "force").length, rebut: ovr.filter((o) => o.kind === "rebut").length };
  };
  const cur = metrics(since, nowIso);
  const old = metrics(before, since);

  // Copy vs creative: what clients asked to change (copy sets sent back vs design comments by client contacts)
  const copyChanges = rows.filter((s) => inWindow(s.approved_at ?? s.created_at, since, nowIso)).reduce((a, s) => a + (Array.isArray(s.client_status) ? s.client_status.filter((c) => c?.status && c.status !== "approved").length : 0), 0);
  const designChanges = new Set((comments ?? []).filter((c) => (c.created_at as string) >= since).map((c) => `${c.request_id}:${c.design_id}`)).size;

  const tone = (v: number | null, ok: (x: number) => boolean, warn: (x: number) => boolean): Tone => (v == null ? null : ok(v) ? "ok" : warn(v) ? "warn" : "bad");
  const headlines: Headline[] = [
    { key: "total", label: "Creative approved → copy approved", value: cur.total, unit: "d", previous: old.total, better: "down", tone: tone(cur.total, (x) => x <= 1, (x) => x <= 2), verdict: verdictOf("Copy turnaround", cur.total, old.total, "d", "down", "copy approved"), hint: `AI draft in ${cur.draftHours == null ? "—" : `${cur.draftHours}h`} · review ${cur.review == null ? "—" : `${cur.review}d`} · ${cur.approved} sets` },
    { key: "pass", label: "Approved first time (us)", value: cur.firstPass, unit: "%", previous: old.firstPass, better: "up", tone: tone(cur.firstPass, (x) => x >= 70, (x) => x >= 50), verdict: verdictOf("Internal first pass", cur.firstPass, old.firstPass, "%", "up", "copy approved"), hint: "the AI draft approved without a rewrite" },
    { key: "client", label: "Approved first time (client)", value: cur.clientPass, unit: "%", previous: old.clientPass, better: "up", tone: tone(cur.clientPass, (x) => x >= 80, (x) => x >= 60), verdict: verdictOf("Client first pass", cur.clientPass, old.clientPass, "%", "up", "copy the client reviewed"), hint: "sets the client approved with no ad sent back" },
    { key: "conflicts", label: "Client-rule flags per set", value: cur.conflicts, unit: "", previous: old.conflicts, better: "down", tone: tone(cur.conflicts, (x) => x <= 0.5, (x) => x <= 1.5), verdict: cur.conflicts == null ? "No copy checked in this period yet." : old.conflicts == null ? `${cur.conflicts} flags per set. Nothing to compare with yet.` : `${cur.conflicts} per set (${old.conflicts} the period before).`, hint: "things that went against what the client told us" },
    { key: "overrides", label: "Rebutted · forced through", value: cur.rebut + cur.force, unit: "", previous: old.rebut + old.force, better: "down", tone: tone(cur.force, (x) => x === 0, (x) => x <= 2), verdict: `${cur.rebut} rebutted as too strict, ${cur.force} forced through by an exec or lead.`, hint: "rebuttals teach the check; forces skip it" },
    { key: "share", label: "Client changes that are copy", value: copyChanges + designChanges ? Math.round((copyChanges / (copyChanges + designChanges)) * 100) : null, unit: "%", previous: null, better: "down", tone: null, verdict: copyChanges + designChanges ? `${copyChanges} copy changes against ${designChanges} creative changes.` : "No client changes in this period.", hint: "of everything clients asked to change" },
  ];

  // ─── Copywriters ───
  const writerIds = new Set([...(people ?? []).filter((p) => p.role === "copywriter").map((p) => p.id as string), ...rows.map((s) => s.approved_by).filter((x): x is string => Boolean(x))]);
  const openSets = rows.filter((s) => s.status === "review" || s.status === "drafting");
  const { data: assigned } = await db.from("client_assignments").select("client_id, profile_id").eq("role", "copywriter");
  const writerOf = new Map((assigned ?? []).map((a) => [a.client_id as string, a.profile_id as string]));
  const rebutBy = (overrides ?? []).filter((o) => o.kind === "rebut" && (o.created_at as string) >= since);
  const writers: Copywriter[] = [...writerIds]
    .map((id) => {
      const mine = timing.filter((t) => t.s.approved_by === id && inWindow(t.approved, since, nowIso));
      const theirClients = rows.filter((s) => writerOf.get(s.client_id) === id || s.approved_by === id);
      const weeks = Math.max(2, Math.min(13, Math.ceil(days / 7)));
      const weekly = Array.from({ length: weeks }, (_, i) => {
        const end = Date.now() - (weeks - 1 - i) * 7 * 86_400_000;
        return timing.filter((t) => t.s.approved_by === id && t.approved && Date.parse(t.approved) <= end && Date.parse(t.approved) > end - 7 * 86_400_000).length;
      });
      const turnaround = r1(avg(mine.filter((t) => t.drafted).map((t) => bizDays(t.drafted!, t.approved!))));
      const firstPass = mine.length ? Math.round((mine.filter((t) => (t.s.version ?? 1) <= 1).length / mine.length) * 100) : null;
      const sendbacks = theirClients.filter((s) => sentBack(s) && inWindow(s.approved_at ?? s.created_at, since, nowIso)).length;
      const caught = theirClients.filter((s) => inWindow(s.approved_at ?? s.created_at, since, nowIso)).reduce((a, s) => a + (Array.isArray(s.violations) ? s.violations.length : 0), 0);
      const rebutted = rebutBy.filter((o) => o.created_by === id).length;
      const open = openSets.filter((s) => writerOf.get(s.client_id) === id).length;
      const late = (tickets ?? []).filter((t) => (t.minutes_over as number) > 0 && openSets.some((s) => s.request_id === t.id && writerOf.get(s.client_id) === id)).length;
      const act = late
        ? `${late} copy ${late === 1 ? "set is" : "sets are"} late: clear the oldest first`
        : open >= 6
          ? `${open} sets waiting on them: share the load`
          : firstPass != null && firstPass < 50
            ? "Most AI drafts get rewritten: look at what changes and teach the Copywriter agent"
            : sendbacks >= 3
              ? `${sendbacks} sets came back from clients: check their dos and don'ts`
              : null;
      return { id, name: nameOf.get(id) ?? "Someone", reviewed: mine.length, turnaround, firstPass, sendbacks, caught, rebutted, weekly, open, act };
    })
    .filter((w) => w.reviewed || w.open || w.sendbacks)
    .sort((a, b) => b.reviewed - a.reviewed);

  // ─── Clients ───
  const ruleCount = new Map<string, Map<string, number>>();
  for (const s of rows.filter((x) => inWindow(x.approved_at ?? x.created_at, since, nowIso))) for (const v of Array.isArray(s.violations) ? s.violations : []) if (v.rule) ruleCount.set(s.client_id, new Map(ruleCount.get(s.client_id) ?? []).set(v.rule, (ruleCount.get(s.client_id)?.get(v.rule) ?? 0) + 1));
  const perClient = new Map<string, CopyClient>();
  for (const s of rows) {
    const c = clientById.get(s.client_id);
    if (!c) continue;
    const cur2 = perClient.get(s.client_id) ?? { id: s.client_id, name: c.name as string, slug: c.slug as string, sets: 0, sendbacks: 0, open: 0, topRules: [] };
    if (inWindow(s.approved_at ?? s.created_at, since, nowIso)) {
      cur2.sets++;
      if (sentBack(s)) cur2.sendbacks++;
    }
    if (s.status === "review" || s.status === "drafting") cur2.open++;
    perClient.set(s.client_id, cur2);
  }
  for (const [id, m] of ruleCount) {
    const c = perClient.get(id);
    if (c) c.topRules = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([rule, n]) => ({ rule, n }));
  }
  const clientRows = [...perClient.values()].filter((c) => c.sets || c.open).sort((a, b) => b.sendbacks - a.sendbacks || b.open - a.open || b.sets - a.sets).slice(0, 12);

  // ─── Copy in the ad accounts: each set's angle judged in the ledger (profitable winners only) ───
  const angleName = new Map((angles ?? []).map((a) => [a.id as string, { client: a.client_id as string, key: String(a.name ?? "").toLowerCase().trim() }]));
  const verdictOf2 = (clientId: string, key: string) => (ledger ?? []).find((l) => l.client_id === clientId && String(l.key).toLowerCase().trim() === key);
  const fw = new Map<string, { w: number; j: number }>();
  const angleRows: CopyKpis["angles"] = [];
  const seen = new Set<string>();
  for (const s of rows.filter((x) => x.status === "approved")) {
    const keys = new Set<string>();
    const a = s.angle_id ? angleName.get(s.angle_id) : null;
    if (a?.key) keys.add(a.key);
    for (const ad of s.ads ?? []) if (ad.angle) keys.add(ad.angle.split(":")[0].toLowerCase().trim());
    for (const key of keys) {
      const l = verdictOf2(s.client_id, key);
      if (!l) continue;
      for (const f of new Set((s.ads ?? []).flatMap((ad) => frameworksOf(ad.formula)))) {
        const b = fw.get(f) ?? { w: 0, j: 0 };
        b.j++;
        if (l.verdict === "winner") b.w++;
        fw.set(f, b);
      }
      const k = `${s.client_id}:${key}`;
      const c = clientById.get(s.client_id);
      if (!seen.has(k) && c) {
        seen.add(k);
        angleRows.push({ title: l.title as string, client: c.name as string, slug: c.slug as string, verdict: l.verdict as string, ads: (l.ads as number) ?? 0 });
      }
    }
  }
  const frameworks = [...fw.entries()].map(([name, b]) => ({ name, winners: b.w, judged: b.j, rate: b.j ? Math.round((b.w / b.j) * 100) : null })).sort((a, b) => b.winners - a.winners || (b.rate ?? 0) - (a.rate ?? 0));
  angleRows.sort((a, b) => Number(b.verdict === "winner") - Number(a.verdict === "winner") || b.ads - a.ads);

  // ─── Late copy, overrides, and what to act on ───
  const late = (tickets ?? [])
    .filter((t) => (t.minutes_over as number) > 0)
    .sort((a, b) => (b.minutes_over as number) - (a.minutes_over as number))
    .slice(0, 8)
    .map((t) => ({ number: t.number as number, title: t.title as string, client: (t.client_name as string) ?? "", stage: t.stage as string, hoursOver: Math.round((t.minutes_over as number) / 60) }));
  const recentOverrides = (overrides ?? [])
    .filter((o) => (o.created_at as string) >= since)
    .slice(0, 10)
    .map((o) => {
      const c = clientById.get(o.client_id as string);
      return { kind: o.kind as "force" | "rebut", rule: o.rule as string, reason: (o.reason as string | null) ?? null, client: (c?.name as string) ?? "", slug: (c?.slug as string) ?? "", number: o.request_id ? (numberOf.get(o.request_id as string) ?? null) : null, by: o.created_by ? (nameOf.get(o.created_by as string) ?? null) : null, at: o.created_at as string };
    });
  const blocked = rows.filter((s) => s.status === "review" && openConflicts(s) > 0);
  const actions: CopyAction[] = [];
  if (late.length) actions.push({ key: "late", tone: late.length >= 4 ? "bad" : "warn", title: `${late.length} copy ${late.length === 1 ? "set is" : "sets are"} late`, detail: `Oldest: #${late[0].number} ${late[0].title} (${late[0].hoursOver}h over)`, href: `/board?t=${late[0].number}` });
  if (blocked.length) {
    const n = numberOf.get(blocked[0].request_id);
    actions.push({ key: "blocked", tone: "warn", title: `${blocked.length} ${blocked.length === 1 ? "set is" : "sets are"} blocked by the client's rules`, detail: blocked.slice(0, 3).map((s) => (clientById.get(s.client_id)?.name as string) ?? "").filter(Boolean).join(", "), href: n ? `/board?t=${n}` : "/board" });
  }
  const forced = recentOverrides.filter((o) => o.kind === "force");
  if (forced.length) actions.push({ key: "forced", tone: "warn", title: `${forced.length} ${forced.length === 1 ? "set was" : "sets were"} forced through over a client rule`, detail: `${forced[0].client}: "${forced[0].rule}"${forced[0].by ? ` · ${forced[0].by}` : ""}`, href: forced[0].number ? `/board?t=${forced[0].number}` : `/clients/${forced[0].slug}` });
  const rebuts = recentOverrides.filter((o) => o.kind === "rebut");
  if (rebuts.length) actions.push({ key: "rebuts", tone: "warn", title: `${rebuts.length} client ${rebuts.length === 1 ? "rule was" : "rules were"} rebutted as too strict`, detail: `Check the Brand Bible rule: ${rebuts[0].client}, "${rebuts[0].rule}"`, href: `/clients/${rebuts[0].slug}/brand-bible` });
  const backClient = clientRows.find((c) => c.sendbacks >= 2);
  if (backClient) actions.push({ key: "sendbacks", tone: "warn", title: `${backClient.name} sent copy back ${backClient.sendbacks} times`, detail: backClient.topRules[0] ? `Most flagged: "${backClient.topRules[0].rule}"` : "Look at what they changed before the next set", href: `/clients/${backClient.slug}` });
  for (const w of writers.filter((x) => x.act && /late|waiting/.test(x.act)).slice(0, 1)) actions.push({ key: `w-${w.id}`, tone: "warn", title: `${w.name}: ${w.act}`, detail: `${w.open} open sets`, href: `/board?person=${w.id}` });

  return { period, days, headlines, writers, clients: clientRows, frameworks: frameworks.slice(0, 8), angles: angleRows.slice(0, 8), late, overrides: recentOverrides, actions: actions.slice(0, 6), split: { copy: copyChanges, creative: designChanges } };
}
