import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// GET /api/ad-media/<Meta ad id>: the ad's picture, kept. Meta's image links (fbcdn) expire after a few days, so the
// links saved with the ad stop loading; this asks Meta for the ad's current creative (its image, a video's poster, the
// post's picture), keeps a copy in storage, and serves that from then on (refreshed after 30 days). When nothing can be
// read it answers with a plain card that says so, never a broken image. Staff only. The reading is in lib/ad-media.

/** A neutral card for an ad whose picture can't be read: the page still lays out, and the link opens Ads Manager */
function placeholder() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000"><rect width="800" height="1000" fill="#e9e7e3"/><g fill="#8a8590" font-family="Helvetica, Arial, sans-serif" text-anchor="middle"><text x="400" y="480" font-size="34">Preview in Ads Manager</text><text x="400" y="530" font-size="24">The picture couldn't be read from Meta</text></g></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=600" } });
}

export async function GET(request: Request, ctx: RouteContext<"/api/ad-media/[adId]">) {
  try {
    await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  const { adId } = await ctx.params;
  // ?strict: a page that draws its own themed placeholder asks for a plain 404 instead of the card
  const strict = new URL(request.url).searchParams.has("strict");
  const none = () => (strict ? new Response(null, { status: 404, headers: { "cache-control": "private, max-age=600" } }) : placeholder());
  if (!/^\d{5,25}$/.test(adId) || !adminConfigured()) return none();
  const { readAdMedia } = await import("@/lib/ad-media");
  const media = await readAdMedia(createAdminClient(), adId);
  if (!media) return none();
  return new Response(media.bytes as BodyInit, { headers: { "content-type": media.mime, "cache-control": "private, max-age=86400, stale-while-revalidate=604800" } });
}
