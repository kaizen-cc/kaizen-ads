import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { criticalityOf, portfolioOf, scorecard, summarize, topReasons, CRITICAL_FROM, type LineKpi, type Scorecard } from "@/lib/clients-kpi/core";
import { cachedClientKpis, loadAllClientKpis, type AllClientKpis } from "@/lib/clients-kpi/load";
import { LIVE } from "@/lib/live";
import { SERVICES, servicesOf, type ServiceSlug } from "@/lib/services";
import { billedTotal, billingGaps, itemKey, upsellBook, type BilledLine, type Marks, type StepKey, type Upsell, type UpsellInput } from "./core";

// Everything the weekly account review shows, read once: the scorecard, the critical accounts with their reasons, the
// issues (the account watch's open flags when it's running, plus off-target and at-risk clients), the upsells, the
// financial overview (what Stripe bills through Kaizen Track, read only, else the services and package we know), and
// the meeting's to-dos. The person's own session reads the clients; the KPI numbers are the Clients list's own.

export type ReviewClient = { id: string; name: string; slug: string; services: ServiceSlug[]; industry: string | null; kpis: LineKpi[]; atRisk: boolean; packageLabel: string | null };
export type CriticalRow = { key: string; id: string; name: string; slug: string; criticality: number; reasons: string[]; lines: { line: string; shown: string; tone: string }[]; atRisk: boolean };
export type IssueRow = { key: string; clientId: string; client: string; slug: string; kind: string; title: string; detail: string | null; severity: "critical" | "warn" | "info"; source: "watch" | "kpi" | "risk" };
export type UpsellRow = Upsell & { key: string; slug: string };
export type FinancialRow = { key: string; id: string; name: string; slug: string; services: ServiceSlug[]; packageLabel: string | null; billed: BilledLine[] | null; monthly: number | null; unlisted: ServiceSlug[]; unbilled: ServiceSlug[] };
export type TodoRow = { id: string; title: string; detail: string | null; assignee: { id: string; name: string } | null; due_on: string | null; status: string; client: { id: string; name: string } | null; item_key: string | null };
export type Meeting = { id: string; title: string; status: string; step: number; items: Marks; notes: string | null; started_at: string; ended_at: string | null };

export type Review = {
  scorecard: Scorecard;
  critical: number;
  criticalRows: CriticalRow[];
  issues: IssueRow[];
  upsells: UpsellRow[];
  financial: FinancialRow[];
  billingKnown: boolean;
  watchOn: boolean;
  items: Record<StepKey, string[]>;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

/** A call summary's words (its string fields, one sentence each), for reading what the client asked about */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(". ");
  if (v && typeof v === "object") return Object.values(v).map(textOf).filter(Boolean).join(". ");
  return "";
}

/** The review's numbers for an exec (every client, every line) */
export async function loadReview(db: SupabaseClient, admin: SupabaseClient): Promise<Review> {
  const [{ data: rows }, all, said, flags, billedRes, snaps] = await Promise.all([
    db.from("clients").select("id, name, slug, industry, services, services_extra, services_removed, creative_package, creative_packages(label)").is("archived_at", null).in("status", [...LIVE]).order("name"),
    cachedClientKpis().catch((): Promise<AllClientKpis> => loadAllClientKpis(admin)),
    // What clients said lately (call summaries and notes from Slack and email), for "they asked about it"
    db.from("client_calls").select("client_id, title, occurred_at, summary").not("client_id", "is", null).gte("occurred_at", new Date(Date.now() - 60 * 86_400_000).toISOString()).order("occurred_at", { ascending: false }).limit(400),
    // The account watch's open flags, when it's running (read through the session; nothing when the table isn't there)
    db.from("watch_flags").select("id, kind, client_id, line, title, body, severity, opened_at").is("resolved_at", null).order("opened_at", { ascending: false }).limit(200),
    db.from("clients").select("id, billed_services, billed_synced_at").is("archived_at", null),
    admin.from("kpi_snapshots").select("windows, kpi_targets!inner(client_id, active)").eq("kpi_targets.active", true),
  ]);
  const clients: ReviewClient[] = ((rows ?? []) as unknown as { id: string; name: string; slug: string; industry: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; creative_package: boolean; creative_packages: { label: string } | null }[]).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    services: servicesOf(c),
    industry: c.industry,
    kpis: all[c.id]?.kpis ?? [],
    atRisk: all[c.id]?.atRisk ?? false,
    packageLabel: c.creative_package ? (c.creative_packages?.label ?? "Creative package") : null,
  }));
  const byId = new Map(clients.map((c) => [c.id, c]));
  const book = portfolioOf(clients);
  const card = scorecard(clients, null, book, 10);
  const sum = summarize(clients, null, book);

  // Critical accounts: every client at or over the line, most critical first
  const criticalRows: CriticalRow[] = clients
    .map((c) => ({ c, v: criticalityOf(c, null, book) }))
    .filter((x): x is { c: ReviewClient; v: number } => x.v != null && x.v >= CRITICAL_FROM)
    .sort((a, b) => b.v - a.v)
    .slice(0, 15)
    .map(({ c, v }) => ({ key: itemKey("critical", c.id), id: c.id, name: c.name, slug: c.slug, criticality: v, reasons: topReasons(c.kpis, 3), lines: c.kpis.filter((k) => k.health != null).map((k) => ({ line: k.line, shown: k.shown, tone: k.tone })), atRisk: c.atRisk }));

  // Issues: the watch's flags first, then off-target lines and clients someone said may leave
  const watchOn = !flags.error;
  const issues: IssueRow[] = [];
  for (const f of (flags.data ?? []) as { id: string; kind: string; client_id: string; line: string | null; title: string; body: string | null; severity: string }[]) {
    const c = byId.get(f.client_id);
    if (!c) continue;
    issues.push({ key: itemKey("issues", "watch", f.id), clientId: c.id, client: c.name, slug: c.slug, kind: f.kind, title: f.title, detail: f.body, severity: f.severity === "critical" ? "critical" : f.severity === "info" ? "info" : "warn", source: "watch" });
  }
  for (const c of clients) {
    if (c.atRisk) issues.push({ key: itemKey("issues", "risk", c.id), clientId: c.id, client: c.name, slug: c.slug, kind: "at_risk", title: "Said to be at risk of leaving", detail: "A recent note says they may cancel.", severity: "critical", source: "risk" });
    for (const k of c.kpis.filter((x) => x.tone === "bad")) issues.push({ key: itemKey("issues", "off", c.id, k.line), clientId: c.id, client: c.name, slug: c.slug, kind: "off_target", title: `${k.label === k.line ? k.line : k.label} off target: ${k.shown}`, detail: k.reasons[0]?.text ?? null, severity: "warn", source: "kpi" });
  }
  const sevRank = { critical: 0, warn: 1, info: 2 } as const;
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.source === "watch" ? -1 : 0) - (b.source === "watch" ? -1 : 0) || a.client.localeCompare(b.client));

  // Upsells: spend growth from the snapshots (14 days against the 16 before them, scaled), and what clients said
  const spend = new Map<string, { d14: number; d30: number }>();
  for (const s of (snaps.data ?? []) as unknown as { windows: Record<string, { spend?: number }> | null; kpi_targets: { client_id: string } }[]) {
    const id = s.kpi_targets?.client_id;
    if (!id) continue;
    const cur = spend.get(id) ?? { d14: 0, d30: 0 };
    spend.set(id, { d14: cur.d14 + (num(s.windows?.d14?.spend) ?? 0), d30: cur.d30 + (num(s.windows?.d30?.spend) ?? 0) });
  }
  const saidBy = new Map<string, UpsellInput["said"]>();
  for (const r of (said.data ?? []) as { client_id: string; title: string; occurred_at: string; summary: unknown }[]) {
    const list = (saidBy.get(r.client_id) ?? []) as { text: string; source: string; at?: string | null }[];
    if (list.length < 6) list.push({ text: textOf(r.summary), source: `the ${r.occurred_at.slice(0, 10)} call`, at: r.occurred_at });
    saidBy.set(r.client_id, list);
  }
  const inputs: UpsellInput[] = clients.map((c) => {
    const s = spend.get(c.id);
    const before = s ? ((s.d30 - s.d14) * 14) / 16 : 0;
    return { clientId: c.id, name: c.name, services: c.services, industry: c.industry, kpis: c.kpis, spendGrowth: s && before > 50 ? s.d14 / before - 1 : null, said: saidBy.get(c.id) ?? [] };
  });
  const upsells: UpsellRow[] = upsellBook(inputs, 1, 25).map((u) => ({ ...u, key: itemKey("upsell", u.clientId, u.service), slug: byId.get(u.clientId)?.slug ?? "" }));

  // Financial: Stripe's billed lines through Track when the mirror keeps them, else what we know they buy
  const billedBy = new Map<string, BilledLine[]>();
  const billingKnown = !billedRes.error && (billedRes.data ?? []).some((r) => (r as { billed_synced_at?: string | null }).billed_synced_at);
  if (billingKnown) {
    for (const r of (billedRes.data ?? []) as { id: string; billed_services: Record<string, { last?: string; amount?: number }> | null; billed_synced_at: string | null }[]) {
      if (!r.billed_synced_at) continue;
      billedBy.set(
        r.id,
        Object.entries(r.billed_services ?? {})
          .filter(([k]) => SERVICES.some((s) => s.slug === k))
          .map(([k, v]) => ({ service: k as ServiceSlug, amount: num(v?.amount), last: v?.last ?? null })),
      );
    }
  }
  const financial: FinancialRow[] = clients.map((c) => {
    const billed = billedBy.get(c.id) ?? null;
    const gaps = billingGaps(c.services, billed);
    return { key: itemKey("financial", c.id), id: c.id, name: c.name, slug: c.slug, services: c.services, packageLabel: c.packageLabel, billed, monthly: billed ? billedTotal(billed) : null, ...gaps };
  });
  financial.sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1) || b.unlisted.length + b.unbilled.length - (a.unlisted.length + a.unbilled.length) || a.name.localeCompare(b.name));

  const items: Record<StepKey, string[]> = {
    scorecard: card.lines.map((l) => itemKey("scorecard", l.line)),
    critical: criticalRows.map((r) => r.key),
    issues: issues.slice(0, 40).map((r) => r.key),
    upsell: upsells.map((r) => r.key),
    financial: financial.filter((f) => f.unlisted.length || f.unbilled.length).map((f) => f.key),
    todos: [],
  };
  return { scorecard: card, critical: sum.critical, criticalRows, issues: issues.slice(0, 40), upsells, financial, billingKnown, watchOn, items };
}

/** The meeting open now (the newest open one), or null */
export async function openMeeting(db: SupabaseClient): Promise<Meeting | null> {
  const { data } = await db.from("csuite_meetings").select("id, title, status, step, items, notes, started_at, ended_at").eq("status", "open").order("started_at", { ascending: false }).limit(1).maybeSingle();
  return (data as Meeting | null) ?? null;
}

/** The last few meetings, newest first */
export async function pastMeetings(db: SupabaseClient, n = 6): Promise<Meeting[]> {
  const { data } = await db.from("csuite_meetings").select("id, title, status, step, items, notes, started_at, ended_at").order("started_at", { ascending: false }).limit(n);
  return (data ?? []) as Meeting[];
}

/** A meeting's to-dos (or every open one when no meeting), with who and which client */
export async function meetingTodos(db: SupabaseClient, meetingId: string | null): Promise<TodoRow[]> {
  let q = db.from("csuite_todos").select("id, title, detail, due_on, status, item_key, assignee:profiles!csuite_todos_assignee_id_fkey(id, full_name), client:clients(id, name)").order("created_at", { ascending: true }).limit(100);
  q = meetingId ? q.eq("meeting_id", meetingId) : q.eq("status", "open");
  const { data } = await q;
  return ((data ?? []) as unknown as { id: string; title: string; detail: string | null; due_on: string | null; status: string; item_key: string | null; assignee: { id: string; full_name: string } | null; client: { id: string; name: string } | null }[]).map((t) => ({ id: t.id, title: t.title, detail: t.detail, due_on: t.due_on, status: t.status, item_key: t.item_key, assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.full_name } : null, client: t.client }));
}

/** A person's open to-dos from account reviews, soonest due first (their Overview) */
export async function myReviewTodos(db: SupabaseClient, profileId: string): Promise<TodoRow[]> {
  const { data } = await db.from("csuite_todos").select("id, title, detail, due_on, status, item_key, client:clients(id, name, slug)").eq("assignee_id", profileId).eq("status", "open").order("due_on", { ascending: true, nullsFirst: false }).limit(20);
  return ((data ?? []) as unknown as { id: string; title: string; detail: string | null; due_on: string | null; status: string; item_key: string | null; client: { id: string; name: string } | null }[]).map((t) => ({ ...t, assignee: null }));
}
