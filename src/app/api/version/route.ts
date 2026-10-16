// Which version of Kaizen Ads is live: open tabs compare it with their own (UpdateBar)
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
