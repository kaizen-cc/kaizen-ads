import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// GET /api/ad-media/<Meta ad id>/play: sends the player to the ad's video file (Meta's link is asked for fresh, since it
// expires). Staff only.
export async function GET(_request: Request, ctx: RouteContext<"/api/ad-media/[adId]/play">) {
  try {
    await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  const { adId } = await ctx.params;
  if (!/^\d{5,25}$/.test(adId) || !adminConfigured()) return new Response("Not found", { status: 404 });
  const { adVideoSource } = await import("@/lib/ad-media-info");
  const src = await adVideoSource(createAdminClient(), adId).catch(() => null);
  if (!src) return new Response("Not a video", { status: 404 });
  return Response.redirect(src, 302);
}
