import "server-only";
import { onService } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeskAudit, DeskSprint } from "@/lib/overview-desk";

// What the email and social Overview reads beyond the board: each client's look (brand colour and logo, the ones their
// reports carry) and their latest audit and live sprint with when a move was last ticked (for the stale reminders).
// Everything reads through the person's own session, so RLS keeps it to the clients they can see.

export type Brand = { color: string | null; light: boolean; logo: string | null };

/** Each client's brand colour and logo address (the logo is served from its own address, cached) */
export async function loadBrands(db: SupabaseClient, ids: string[]): Promise<Map<string, Brand>> {
  const out = new Map<string, Brand>();
  if (!ids.length) return out;
  const { data } = await db.from("clients").select("id, brand_color:report_brand->>color, brand_light:report_brand->>light, brand_checked:report_brand->>checkedAt, brand_logo:report_brand->>source").in("id", ids);
  for (const r of (data ?? []) as { id: string; brand_color: string | null; brand_light: string | null; brand_checked: string | null; brand_logo: string | null }[]) {
    out.set(r.id, {
      color: /^#[0-9a-f]{6}$/i.test(r.brand_color ?? "") ? r.brand_color : null,
      light: r.brand_light === "true",
      // Looked for and none found: no request at all; not looked for yet: the address looks for it
      logo: r.brand_checked && !r.brand_logo ? null : `/api/clients/${r.id}/logo?v=${encodeURIComponent(r.brand_checked ?? "new")}`,
    });
  }
  return out;
}

type Row = Record<string, unknown>;
const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;

/** Each client's latest audit and live sprint, with when a move was last ticked. Degrades to empty, never throws */
export async function loadDeskOps(db: SupabaseClient, ids: string[], line: "email" | "social"): Promise<{ audits: Map<string, DeskAudit>; sprints: Map<string, DeskSprint> }> {
  const audits = new Map<string, DeskAudit>();
  const sprints = new Map<string, DeskSprint>();
  if (!ids.length) return { audits, sprints };
  const [a, s] = await Promise.all([
    db.from(`${line}_audits`).select("id, client_id, status, score, band, result, done, created_at, finished_at").in("client_id", ids).order("created_at", { ascending: false }).limit(Math.max(50, ids.length * 3)),
    db.from(`${line}_sprints`).select(`id, client_id, baseline, latest, started_at, next_check_at, ${line}_sprint_actions(status, done_at)`).in("client_id", ids).eq("status", "active"),
  ]);
  for (const r of (a.data ?? []) as Row[]) {
    const id = r.client_id as string;
    if (audits.has(id)) continue;
    const result = r.result as { verdict?: { headline?: string }; actions?: unknown[] } | null;
    const done = (r.done ?? {}) as Record<string, { at?: string } | null>;
    audits.set(id, {
      id: r.id as string,
      status: r.status as DeskAudit["status"],
      score: (r.score as number | null) ?? null,
      band: (r.band as DeskAudit["band"]) ?? null,
      headline: result?.verdict?.headline ?? null,
      createdAt: (r.finished_at as string | null) ?? (r.created_at as string),
      actions: result?.actions?.length ?? 0,
      done: Object.keys(done).length,
      lastTickAt: latest(Object.values(done).map((d) => d?.at)),
    });
  }
  for (const r of (s.data ?? []) as Row[]) {
    const acts = (r[`${line}_sprint_actions`] ?? []) as { status: string; done_at: string | null }[];
    sprints.set(r.client_id as string, {
      id: r.id as string,
      score: (r.latest as { score?: number } | null)?.score ?? null,
      baseline: (r.baseline as { score?: number } | null)?.score ?? null,
      moves: acts.filter((x) => x.status !== "skipped").length,
      done: acts.filter((x) => x.status === "done").length,
      startedAt: r.started_at as string,
      lastDoneAt: latest(acts.map((x) => x.done_at)),
      nextCheckAt: (r.next_check_at as string | null) ?? null,
    });
  }
  return { audits, sprints };
}

/** Messages owed on each client (the person's own, and ones escalated past a second notice), by client */
export async function owedByClient(db: SupabaseClient, me: { id: string; role: string; isExec: boolean; isLead: boolean }): Promise<Map<string, { n: number; escalated: number }>> {
  const out = new Map<string, { n: number; escalated: number }>();
  try {
    const { loadOwedReplies } = await import("@/lib/owed-replies");
    for (const o of await loadOwedReplies(db, me, false)) {
      if (!o.clientId) continue;
      const x = out.get(o.clientId) ?? { n: 0, escalated: 0 };
      x.n++;
      if (o.status === "escalated") x.escalated++;
      out.set(o.clientId, x);
    }
  } catch {
    // Owed replies are a signal, not the page: without them clients are ordered on the rest
  }
  return out;
}

// ─── The ads lines (Meta, Google): each ad account against its KPI ────────

export type AdsDeskRow = {
  targetId: string;
  clientId: string;
  name: string;
  slug: string;
  platform: "meta" | "google";
  label: string;
  status: "excellent" | "good" | "close" | "off" | "idle" | "setup" | "unset";
  deviation: number | null;
  /** The KPI over the last 14 days and its target (cost per result, or ROAS as a multiple) */
  value: number | null;
  target: number | null;
  roas: boolean;
  spend30: number;
  pacing: "over" | "under" | "check" | null;
  pace: number | null;
  hasAccount: boolean;
  owner: string | null;
  /** The signed-in person owns it, or holds a buyer seat on the client for this platform */
  mine: boolean;
};

const VERDICT_WORSE: Record<string, string> = { worse: "The last check says it's getting worse", wrong_move: "The last check flagged a wrong move" };

/** Every live ad account on this platform the person can see, with its KPI, and its latest audit and live sprint */
export async function loadAdsDesk(db: SupabaseClient, me: { id: string }, platform: "meta" | "google"): Promise<{ rows: AdsDeskRow[]; audits: Map<string, DeskAudit>; sprints: Map<string, DeskSprint> }> {
  const [{ LIVE }, { shownStatus }, { conversionFor }, { secondarySeatKeys }] = await Promise.all([import("@/lib/live"), import("@/lib/kpi/calc"), import("@/lib/kpi/conversions"), import("@/lib/buyer-seats")]);
  const [{ data: found }, seats] = await Promise.all([
    db.from("kpi_targets").select("id, client_id, label, platform, ad_account_id, owner_id, owner_name, conversion, target, clients!inner(name, slug, archived_at, status, services, services_extra, services_removed)").eq("active", true).eq("platform", platform).is("clients.archived_at", null).in("clients.status", [...LIVE]),
    secondarySeatKeys(db, me.id).catch(() => new Set<string>()),
  ]);
  // Only the lines the client buys (src/lib/service-gate.ts)
  const targets = ((found ?? []) as Row[]).filter((t) => onService(t as { platform?: string; clients?: unknown }));
  const ids = targets.map((t) => t.id as string);
  const audits = new Map<string, DeskAudit>();
  const sprints = new Map<string, DeskSprint>();
  if (!ids.length) return { rows: [], audits, sprints };
  const [{ data: snaps }, { data: auditRows }, { data: sprintRows }] = await Promise.all([
    db.from("kpi_snapshots").select("target_id, status, deviation, windows, budget").in("target_id", ids),
    db.from("account_audits").select("id, target_id, status, result, done, created_at, finished_at").in("target_id", ids).order("created_at", { ascending: false }).limit(Math.max(60, ids.length * 3)),
    db.from("optimization_sprints").select("id, target_id, started_at, next_check_at, sprint_actions(status, done_at), sprint_checks(verdict, created_at)").in("target_id", ids).eq("status", "active"),
  ]);
  const snapBy = new Map(((snaps ?? []) as Row[]).map((x) => [x.target_id as string, x]));
  const rows: AdsDeskRow[] = targets.map((t) => {
    const c = t.clients as { name: string; slug: string };
    const snap = snapBy.get(t.id as string);
    const status = shownStatus(snap?.status as string | null, t.target as number | null) as AdsDeskRow["status"];
    const w = snap?.windows as { d14?: { value?: number | null }; d30?: { spend?: number } } | null;
    const b = snap?.budget as { status?: string; pace?: number; budget?: number } | null;
    const offPace = (b?.status === "over" || b?.status === "under") && Number(b.budget ?? 0) >= 20;
    return {
      targetId: t.id as string,
      clientId: t.client_id as string,
      name: c.name,
      slug: c.slug,
      platform,
      label: (t.label as string | null) ?? "",
      status,
      deviation: snap?.deviation == null ? null : Number(snap.deviation),
      value: w?.d14?.value ?? null,
      target: t.target == null ? null : Number(t.target),
      roas: Boolean(conversionFor(String(t.conversion ?? "")).roas),
      spend30: Number(w?.d30?.spend ?? 0),
      pacing: offPace ? ((b!.pace ?? 1) > 3 ? "check" : (b!.status as "over" | "under")) : null,
      pace: offPace ? (b!.pace ?? null) : null,
      hasAccount: Boolean(t.ad_account_id),
      owner: (t.owner_name as string | null) ?? null,
      mine: t.owner_id === me.id || seats.has(`${t.client_id}:${platform}`),
    };
  });
  // The KPI's band stands in for an audit's score band: off is red, close is yellow
  const bandOf = new Map(rows.map((r) => [r.targetId, r.status === "off" ? ("bad" as const) : r.status === "close" ? ("watch" as const) : ("good" as const)]));
  for (const r of (auditRows ?? []) as Row[]) {
    const id = r.target_id as string;
    if (audits.has(id) || r.status === "queued") continue;
    const result = r.result as { verdict?: { headline?: string }; actions?: unknown[] } | null;
    const done = (r.done ?? {}) as Record<string, { at?: string } | null>;
    audits.set(id, {
      id: r.id as string,
      status: r.status as DeskAudit["status"],
      score: null,
      band: bandOf.get(id) ?? null,
      headline: result?.verdict?.headline ?? null,
      createdAt: (r.finished_at as string | null) ?? (r.created_at as string),
      actions: result?.actions?.length ?? 0,
      done: Object.keys(done).length,
      lastTickAt: latest(Object.values(done).map((d) => d?.at)),
    });
  }
  for (const r of (sprintRows ?? []) as Row[]) {
    const acts = (r.sprint_actions ?? []) as { status: string; done_at: string | null }[];
    const checks = ((r.sprint_checks ?? []) as { verdict: string; created_at: string }[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
    sprints.set(r.target_id as string, {
      id: r.id as string,
      score: null,
      baseline: null,
      moves: acts.filter((x) => x.status !== "skipped").length,
      done: acts.filter((x) => x.status === "done").length,
      startedAt: r.started_at as string,
      lastDoneAt: latest(acts.map((x) => x.done_at)),
      nextCheckAt: (r.next_check_at as string | null) ?? null,
      worse: checks[0] ? (VERDICT_WORSE[checks[0].verdict] ?? null) : null,
    });
  }
  return { rows, audits, sprints };
}

/** The creative clients the person holds a seat on (any seat) */
export async function mySeatClients(db: SupabaseClient, me: { id: string }): Promise<Set<string>> {
  const { data } = await db.from("client_assignments").select("client_id").eq("profile_id", me.id);
  return new Set((data ?? []).map((r) => r.client_id as string));
}
