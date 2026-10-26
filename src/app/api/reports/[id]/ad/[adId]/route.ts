import { requireStaff } from "@/lib/auth";
import { adImageResponse, topAdOf } from "@/lib/reports/ad-image";
import { canReportOn } from "@/lib/reports/access";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { adminConfigured } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET /api/reports/<id>/ad/<adId>: a top ad's image in the report editor, fresh from Meta. The same rule as the
// report itself: its account's buyer, the leads of its line, execs.
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/[id]/ad/[adId]">) {
  const me = await requireStaff();
  const { id, adId } = await ctx.params;
  if (!adminConfigured() || !/^[0-9a-f-]{36}$/i.test(id) || !/^\d{6,25}$/.test(adId)) return new Response("Not found", { status: 404 });
  const db = await createClient();
  const { data: r } = await db.from("reports").select("owner_id, metrics, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  const t = r?.kpi_targets as unknown as { id: string; client_id: string; platform: string; owner_id: string | null } | null;
  if (!r || (r.owner_id !== me.id && !(t && (await canReportOn(db, me, t))))) return new Response("Not found", { status: 404 });
  const ad = topAdOf(r.metrics as ReportMetrics | null, adId);
  if (!ad) return new Response("Not found", { status: 404 });
  return adImageResponse(adId, ad.image, "private");
}
