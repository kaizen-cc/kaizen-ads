import { adImageResponse, topAdOf } from "@/lib/reports/ad-image";
import { loadBundle } from "@/lib/reports/share";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

// GET /r/<token>/ad/<adId>: a top ad's image on the client's live recap, fresh from Meta. The token is the key, and
// only the ads in that recap are served.
export async function GET(_request: Request, ctx: RouteContext<"/r/[token]/ad/[adId]">) {
  const { token, adId } = await ctx.params;
  if (!adminConfigured() || !/^\d{6,25}$/.test(adId)) return new Response("Not found", { status: 404 });
  const bundle = await loadBundle(createAdminClient(), token);
  const ad = bundle?.ready ? bundle.input.parts.map((p) => topAdOf(p.metrics, adId)).find(Boolean) : null;
  if (!ad) return new Response("Not found", { status: 404 });
  return adImageResponse(adId, ad.image, "public");
}
