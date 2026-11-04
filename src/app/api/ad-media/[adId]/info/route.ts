import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// GET /api/ad-media/<Meta ad id>/info: whether the ad is a video and where it sends people. Staff only.
export async function GET(_request: Request, ctx: RouteContext<"/api/ad-media/[adId]/info">) {
  try {
    await requireStaff();
  } catch {
    return Response.json({ video: false, link: null }, { status: 401 });
  }
  const { adId } = await ctx.params;
  if (!/^\d{5,25}$/.test(adId) || !adminConfigured()) return Response.json({ video: false, link: null });
  const { adInfo } = await import("@/lib/ad-media-info");
  const info = await adInfo(createAdminClient(), adId).catch(() => ({ video: false, link: null }));
  return Response.json(info, { headers: { "cache-control": "private, max-age=3600" } });
}
