import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { SERVICE_FIELDS, gateRows, hasLine, type ServiceFields } from "@/lib/service-gate";
import { nyToday } from "@/lib/dates";
import { loadPauses } from "@/lib/account-watch/pauses";
import { shownStatus } from "@/lib/kpi/calc";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { allotmentGaps, allotmentSlice, sliceGaps, weekLoad, weeklyCapacity, type AllotmentGap, type GapPool, type UsageLike, type WeekLoad } from "@/lib/creative-allotments";

// Creative allotment gaps for one person, read with their own access (src/lib/creative-allotments.ts says how they
// count). Paused clients and clients with the creative service paused (watch_pauses, until its date) are left out.

export type FreshNeed = { clientId: string; client: string; slug: string; why: string; targetId: string };
export type AllotmentDesk = {
  gaps: AllotmentGap[];
  /** The head of creative and the executives: this week's load across clients against a typical week */
  load: WeekLoad[] | null;
  /** Accounts off their KPI target on clients in this person's slice: they need fresh creative */
  fresh: FreshNeed[];
};

const WEEKS = 8;

export async function loadAllotmentDesk(db: SupabaseClient, me: { id: string; role: string; isExec?: boolean }): Promise<AllotmentDesk> {
  const slice = allotmentSlice(me);
  if (!slice) return { gaps: [], load: null, fresh: [] };
  const today = nyToday();
  const [{ data: usage }, { data: clients }, paused, { data: seats }] = await Promise.all([
    db.from("client_allotment_usage").select("*"),
    db.from("clients").select(`id, name, slug, ${SERVICE_FIELDS}`).is("archived_at", null).in("status", LIVE),
    loadPauses(db, "creative", today),
    db.from("client_assignments").select("client_id").eq("profile_id", me.id),
  ]);
  // Only clients that buy creative (src/lib/service-gate.ts): a removed service has no allotment gap until it's back
  const live = new Map(((clients ?? []) as ({ id: string; name: string; slug: string } & ServiceFields)[]).filter((c) => !paused.has(c.id) && hasLine(c, "creative")).map((c) => [c.id, { name: c.name, slug: c.slug }]));
  const seated = new Set((seats ?? []).map((s) => s.client_id as string));
  const gaps = sliceGaps(allotmentGaps((usage ?? []) as UsageLike[], live, today), me, seated);

  const head = slice.every && slice.pools.length === 2;
  const [load, fresh] = await Promise.all([head ? teamWeek(db, gaps) : Promise.resolve(null), offTarget(db, [...new Set(gaps.map((g) => g.clientId))], live).catch(() => [])]);
  return { gaps, load, fresh };
}

/** This week's load against what the team finished in a typical week (the last eight weeks, tickets and Asana tasks) */
async function teamWeek(db: SupabaseClient, gaps: AllotmentGap[]): Promise<WeekLoad[]> {
  const since = new Date(Date.now() - WEEKS * 7 * 86_400_000).toISOString();
  const [{ data: done }, { data: asana }] = await Promise.all([
    db.from("requests").select("format, allotment_units").is("deleted_at", null).gte("completed_at", since).limit(5000),
    db.from("asana_tasks").select("format, new_images, new_videos").is("request_id", null).gte("completed_at", since).limit(5000),
  ]);
  const rows: { pool: GapPool; units: number }[] = [];
  for (const r of done ?? []) rows.push({ pool: r.format === "video" ? "videos" : "images", units: Number(r.allotment_units) || 0 });
  for (const t of asana ?? []) {
    const f = String(t.format ?? "");
    rows.push({ pool: "images", units: t.new_images != null ? Number(t.new_images) : f === "image" || f === "carousel" ? 1 : 0 });
    rows.push({ pool: "videos", units: t.new_videos != null ? Number(t.new_videos) : f === "video" ? 1 : 0 });
  }
  return weekLoad(gaps, weeklyCapacity(rows, WEEKS));
}

/**
 * Meta and TikTok accounts off their KPI target (red) on these clients: the creative team hears they need fresh
 * creative. The KPI status is read with the service role (the creative team's screens leave out the KPI board),
 * only for clients already in their slice.
 */
async function offTarget(db: SupabaseClient, clientIds: string[], clients: ReadonlyMap<string, { name: string; slug: string }>): Promise<FreshNeed[]> {
  if (!clientIds.length) return [];
  const reader = adminConfigured() ? createAdminClient() : db;
  // Only accounts on a line the client buys (src/lib/service-gate.ts)
  const targets = await gateRows(reader, ((await reader.from("kpi_targets").select("id, client_id, label, platform, target").eq("active", true).in("platform", ["meta", "tiktok"]).in("client_id", clientIds)).data ?? []) as { id: string; client_id: string; label: string | null; platform: string; target: number | null }[]);
  const ids = (targets ?? []).map((t) => t.id as string);
  if (!ids.length) return [];
  const { data: snaps } = await reader.from("kpi_snapshots").select("target_id, status, deviation").in("target_id", ids);
  const snapBy = new Map((snaps ?? []).map((s) => [s.target_id as string, s]));
  const out: FreshNeed[] = [];
  for (const t of targets ?? []) {
    const s = snapBy.get(t.id as string);
    if (shownStatus(s?.status as string | null, t.target as number | null) !== "off") continue;
    const c = clients.get(t.client_id as string);
    if (!c) continue;
    const dev = s?.deviation == null ? null : Math.round(Math.abs(Number(s.deviation)) * 100);
    const platform = t.platform === "tiktok" ? "TikTok" : "Meta";
    out.push({ clientId: t.client_id as string, client: c.name, slug: c.slug, targetId: t.id as string, why: `${platform}${t.label ? ` ${t.label}` : ""} off target${dev != null ? ` by ${dev}%` : ""}` });
  }
  // One per client: the first account found
  return out.filter((x, i) => out.findIndex((y) => y.clientId === x.clientId) === i);
}
