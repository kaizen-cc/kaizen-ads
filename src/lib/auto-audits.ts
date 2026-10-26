import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAudit } from "@/lib/audit";
import { inPlatform } from "@/lib/in-platform";

// Accounts in the red get audited without anyone asking: when a KPI is off target and has no audit yet, or its last
// audit is three days old and nobody has started on it (no action ticked, no change made from it, no sprint move
// begun), Kaizen Ads runs a fresh one and tells the account's buyer, with the moves it can make for them. A few per
// run, so the AI and ad platform calls stay spread out; the worst accounts go first.

const PER_RUN = 3;
const REFRESH_DAYS = 3;
const LIVE = ["active", "onboarding"];

type Off = { id: string; client_id: string; platform: string; owner_id: string | null; label: string | null; clients: { name: string }; deviation: number | null };

/** Whether anyone has acted on an audit: an action ticked, a change made from it, or a sprint move under way. */
async function touched(admin: SupabaseClient, audit: { id: string; done: unknown }) {
  if (Object.keys((audit.done ?? {}) as object).length) return true;
  const [{ count: changes }, { data: sprints }] = await Promise.all([
    admin.from("ad_changes").select("id", { count: "exact", head: true }).eq("audit_id", audit.id),
    admin.from("sprints").select("id").eq("audit_id", audit.id),
  ]);
  if (changes) return true;
  const ids = (sprints ?? []).map((s) => s.id as string);
  if (!ids.length) return false;
  const { count } = await admin.from("sprint_actions").select("id", { count: "exact", head: true }).in("sprint_id", ids).neq("status", "todo");
  return Boolean(count);
}

/** The KPIs that need an audit now, worst first. */
async function due(admin: SupabaseClient) {
  const { data: snaps } = await admin.from("kpi_snapshots").select("target_id, deviation").eq("status", "off");
  const dev = new Map((snaps ?? []).map((s) => [s.target_id as string, s.deviation as number | null]));
  if (!dev.size) return [];
  const { data: targets } = await admin
    .from("kpi_targets")
    .select("id, client_id, platform, owner_id, label, clients!inner(name, status, archived_at)")
    .eq("active", true)
    .in("platform", ["meta", "google"])
    .not("ad_account_id", "is", null)
    .is("clients.archived_at", null)
    .in("clients.status", LIVE)
    .in("id", [...dev.keys()]);
  const out: Off[] = [];
  const stale = Date.now() - REFRESH_DAYS * 86_400_000;
  for (const t of (targets ?? []) as unknown as Off[]) {
    const { data: last } = await admin.from("account_audits").select("id, status, created_at, done").eq("target_id", t.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (last) {
      const at = Date.parse(last.created_at as string);
      // One running or waiting already, or a failed one in the last six hours
      if (last.status === "running" && Date.now() - at < 15 * 60_000) continue;
      if (last.status === "queued") continue;
      if (last.status === "failed" && Date.now() - at < 6 * 3_600_000) continue;
      if (last.status === "ready" && (at > stale || (await touched(admin, last)))) continue;
    }
    out.push({ ...t, deviation: dev.get(t.id) ?? null });
  }
  // Spending with no results (no deviation) first, then the furthest off
  return out.sort((a, b) => (b.deviation ?? 1e9) - (a.deviation ?? 1e9));
}

/** The scheduled step: audit the accounts in the red that need it, then tell each buyer. */
export async function autoAudits(admin: SupabaseClient, budgetMs = 700_000) {
  const until = Date.now() + budgetMs;
  const list = await due(admin);
  let ran = 0;
  for (const t of list.slice(0, PER_RUN)) {
    if (Date.now() > until - 240_000) break;
    const { data: a } = await admin
      .from("account_audits")
      .insert({ target_id: t.id, client_id: t.client_id, created_by: t.owner_id, auto: true, step: "Starting", progress: 2 })
      .select("id")
      .single();
    if (!a) continue;
    await runAudit(admin, a.id);
    ran++;
    await tellBuyer(admin, a.id, t).catch((e) => console.error("auto audit notify", e));
  }
  return { due: list.length, ran };
}

type Action = { title: string; short?: string; area: string; owner: string; steps?: string[]; inPlatform?: boolean };

/** The buyer hears it ran, what it found, and the moves Kaizen Ads can make for them. */
async function tellBuyer(admin: SupabaseClient, auditId: string, t: Off) {
  const { data: a } = await admin.from("account_audits").select("status, result").eq("id", auditId).single();
  if (a?.status !== "ready" || !t.owner_id) return;
  const res = a.result as { verdict?: { headline?: string }; actions?: Action[] } | null;
  const platform = t.platform === "google" ? "google" : "meta";
  const actions = res?.actions ?? [];
  const quick = actions.filter((x) => x.owner === "media_buyer" && inPlatform(x, platform));
  const label = (x: Action) => x.short?.trim() || x.title;
  const list = (quick.length ? quick : actions).slice(0, 3).map((x) => `· ${label(x)}`);
  await admin.from("notifications").upsert(
    {
      profile_id: t.owner_id,
      kind: "kpi",
      title: `${t.clients.name} is off target: the audit is ready`,
      body: [res?.verdict?.headline ?? "", list.length ? `${quick.length ? `${quick.length} you can do from Kaizen Ads` : `${actions.length} actions`}:\n${list.join("\n")}` : ""].filter(Boolean).join("\n\n").slice(0, 1000),
      href: `/kpis/audit/${auditId}`,
      client_id: t.client_id,
      key: `auto-audit:${auditId}`,
      priority: "critical",
    },
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}
