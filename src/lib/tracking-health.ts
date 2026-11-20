import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { healthOf, worstFirst, type Health } from "@/lib/tracking-health-core";

// The Tracking Specialist's Tracking tab (rules in ./tracking-health-core.ts): every active client that buys paid ads
// (Meta, Google, TikTok), with its tracking health, why, days since onboarding, open tracking requests and when it was
// last checked, worst first. Reads the tracking watchdogs (watch_flags), client_onboarding.tracking and the tracking
// requests (agent_asks made from Slack, email, Asana, calls and Gemini notes, or sent by teammates).

const PAID = ["facebook-ads", "google-ads", "tiktok-ads"];
const FLAG_KINDS = ["tracking_audit", "tracking_mismatch", "cvr_drop", "zero_results", "lead_no_crm", "access_lost", "integration_auth"];

export type HealthRow = {
  clientId: string;
  client: string;
  slug: string;
  health: Health;
  flags: { id: string; kind: string; title: string; body: string | null; openedAt: string }[];
  requests: { id: string; title: string; openedAt: string }[];
  lastChecked: string | null;
};

export async function trackingHealth(admin: SupabaseClient, now = Date.now()): Promise<HealthRow[]> {
  const { data: clients } = await admin.from("clients").select("id, name, slug, created_at, reonboarded_at, services, services_extra, services_removed, strategy_only, client_onboarding(tracking)").is("archived_at", null).in("status", ["active", "onboarding"]).limit(2000);
  const { servicesOf } = await import("@/lib/services");
  const paid = ((clients ?? []) as unknown as { id: string; name: string; slug: string; created_at: string; reonboarded_at: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; strategy_only: boolean | null; client_onboarding: { tracking: { status?: string } | null } | { tracking: { status?: string } | null }[] | null }[]).filter((c) => servicesOf(c).some((s) => PAID.includes(s)));
  if (!paid.length) return [];
  const ids = paid.map((c) => c.id);
  const { data: tracker } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", "tracking_specialist");
  const trackers = (tracker ?? []).map((t) => t.id as string);
  const [{ data: flags }, { data: asks }, { data: lastRun }, { data: audits }] = await Promise.all([
    admin.from("watch_flags").select("id, kind, client_id, title, body, opened_at").is("resolved_at", null).in("kind", FLAG_KINDS).in("client_id", ids).limit(2000),
    trackers.length ? admin.from("agent_asks").select("id, client_id, title, created_at").eq("status", "open").in("owner_id", trackers).in("client_id", ids).limit(1000) : Promise.resolve({ data: [] }),
    // The watchdogs read every client each run: their latest pass is when everyone was last checked
    admin.from("watch_flags").select("seen_at").not("seen_at", "is", null).order("seen_at", { ascending: false }).limit(1),
    admin.from("account_audits").select("client_id, created_at").in("client_id", ids).order("created_at", { ascending: false }).limit(2000),
  ]);
  const ran = (lastRun?.[0]?.seen_at as string | undefined) ?? null;
  const rows: HealthRow[] = paid.map((c) => {
    const ob = Array.isArray(c.client_onboarding) ? c.client_onboarding[0] : c.client_onboarding;
    const st = ob?.tracking?.status;
    const f = (flags ?? []).filter((x) => x.client_id === c.id).map((x) => ({ id: x.id as string, kind: x.kind as string, title: x.title as string, body: (x.body as string | null) ?? null, openedAt: x.opened_at as string }));
    const r = ((asks ?? []) as { id: string; client_id: string; title: string; created_at: string }[]).filter((x) => x.client_id === c.id).map((x) => ({ id: x.id, title: x.title, openedAt: x.created_at }));
    const audit = (audits ?? []).find((a) => a.client_id === c.id)?.created_at as string | undefined;
    const lastChecked = [ran, audit ?? null].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    return {
      clientId: c.id,
      client: c.name,
      slug: c.slug,
      health: healthOf({ onboardedAt: c.reonboarded_at ?? c.created_at, setUp: st === "done" || st === "na", flags: f, requests: r }, now),
      flags: f,
      requests: r,
      lastChecked,
    };
  });
  return worstFirst(rows);
}
