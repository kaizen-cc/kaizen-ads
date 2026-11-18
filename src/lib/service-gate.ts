import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf, type ServiceSlug } from "@/lib/services";

// One gate for every line of work: a client's services (Team & setup on the client page; servicesOf) decide whether
// the team does anything for that line. Take a service off and its line goes quiet everywhere: no KPI card, no
// reports, no metric syncs, no audits, sprints, watch flags, recap items, alerts, allotment or board items, and it
// isn't counted in any total. Nothing is deleted: the gate hides and skips, so adding the service back brings every
// card, report and number back (the syncs catch up on their next run).
//
// A client's status (paused, offboarded) keeps its own handling where each caller already has it; this is only the
// services side. The account watch's billing check (Stripe vs services) reads the raw services on purpose, since
// that's how a mismatch gets caught. The database has the same gate as public.client_has_line (migration
// 20261121090000_service_gate.sql) for triggers and cron SQL.

export const SERVICE_LINES = ["meta", "google", "tiktok", "creative", "email", "social", "web", "crm"] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

/** Each line's service slug (src/lib/services.ts) */
export const LINE_SERVICE: Record<ServiceLine, ServiceSlug> = {
  meta: "facebook-ads",
  google: "google-ads",
  tiktok: "tiktok-ads",
  creative: "creative",
  email: "email-marketing",
  social: "social-media",
  web: "web-design",
  crm: "crm",
};

/** The client columns the gate reads; add them to any select (or a clients(...) embed) that's gated */
export const SERVICE_FIELDS = "services, services_extra, services_removed";

export type ServiceFields = { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null };

/** The lines a client buys */
export function linesOf(c: ServiceFields | null | undefined): Set<ServiceLine> {
  const s = new Set<string>(servicesOf(c ?? {}));
  return new Set(SERVICE_LINES.filter((l) => s.has(LINE_SERVICE[l])));
}

/** Whether the client buys this line (no client row: no) */
export function hasLine(c: ServiceFields | null | undefined, line: ServiceLine): boolean {
  if (!c) return false;
  return (servicesOf(c) as string[]).includes(LINE_SERVICE[line]);
}

/** A KPI or ad platform as its line ("facebook" is Meta); null for anything that isn't an ad line */
export function lineOfPlatform(platform: string | null | undefined): ServiceLine | null {
  const p = String(platform ?? "").toLowerCase();
  if (p === "meta" || p === "facebook" || p === "instagram") return "meta";
  if (p === "google") return "google";
  if (p === "tiktok") return "tiktok";
  if (p === "email" || p === "klaviyo" || p === "brevo" || p === "customerio") return "email";
  if (p === "social") return "social";
  if (p === "creative") return "creative";
  return null;
}

/**
 * A KPI card (or any row with a platform and its client embedded as `clients`) is on service when its client buys that
 * platform's line. A row whose platform isn't an ad line, or whose client wasn't embedded, is kept (nothing to judge).
 */
export function onService(row: { platform?: string | null; clients?: unknown }): boolean {
  const line = lineOfPlatform(row.platform);
  if (!line) return true;
  const c = (Array.isArray(row.clients) ? row.clients[0] : row.clients) as ServiceFields | null | undefined;
  if (c === undefined) return true;
  return hasLine(c, line);
}

/** Every client's lines, in one batched read (a page of 1000 at a time). Clients the reader can't see aren't in it. */
export async function clientLineMap(db: SupabaseClient, ids?: readonly string[]): Promise<Map<string, Set<ServiceLine>>> {
  const out = new Map<string, Set<ServiceLine>>();
  const want = ids ? [...new Set(ids.filter(Boolean))] : null;
  if (want && !want.length) return out;
  const put = (rows: (ServiceFields & { id: string })[] | null) => {
    for (const c of rows ?? []) out.set(c.id, linesOf(c));
  };
  if (want) {
    for (let i = 0; i < want.length; i += 300) {
      const { data } = await db.from("clients").select(`id, ${SERVICE_FIELDS}`).in("id", want.slice(i, i + 300));
      put(data as (ServiceFields & { id: string })[] | null);
    }
    return out;
  }
  for (let p = 0; p < 20; p++) {
    const { data, error } = await db.from("clients").select(`id, ${SERVICE_FIELDS}`).order("id").range(p * 1000, p * 1000 + 999);
    if (error || !data) break;
    put(data as (ServiceFields & { id: string })[]);
    if (data.length < 1000) break;
  }
  return out;
}

/** The clients that buy a line, as a set of ids (one batched read) */
export async function clientsWithLine(db: SupabaseClient, line: ServiceLine, ids?: readonly string[]): Promise<Set<string>> {
  const map = await clientLineMap(db, ids);
  return new Set([...map].filter(([, lines]) => lines.has(line)).map(([id]) => id));
}

/** Keep the rows (KPI cards, snapshots joined to them, anything with client_id + platform) whose client buys that platform's line */
export function keepOnService<T extends { client_id?: string | null; platform?: string | null }>(rows: readonly T[], lines: Map<string, Set<ServiceLine>>): T[] {
  return rows.filter((r) => {
    const line = lineOfPlatform(r.platform);
    if (!line) return true;
    return Boolean(r.client_id && lines.get(r.client_id)?.has(line));
  });
}

/** The same, reading the clients' services itself: one query for every row's client */
export async function gateRows<T extends { client_id?: string | null; platform?: string | null }>(db: SupabaseClient, rows: readonly T[]): Promise<T[]> {
  if (!rows.length) return [];
  const lines = await clientLineMap(db, rows.map((r) => r.client_id ?? "").filter(Boolean));
  return keepOnService(rows, lines);
}

/** Keep the rows of clients that buy one given line (rows keyed by client_id) */
export function keepWithLine<T extends { client_id?: string | null }>(rows: readonly T[], lines: Map<string, Set<ServiceLine>>, line: ServiceLine): T[] {
  return rows.filter((r) => Boolean(r.client_id && lines.get(r.client_id)?.has(line)));
}
