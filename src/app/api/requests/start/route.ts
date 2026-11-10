import { requireStaff } from "@/lib/auth";
import { formatsFor } from "@/lib/creative-formats";
import { startCore, startRest, startSections } from "@/lib/request-start";
import { createClient } from "@/lib/supabase/server";

// GET /api/requests/start?client=: the new request's "How do you want to start?" sections for one client, from what's
// already stored (no AI). A plain fetch rather than a server action, so it never waits behind another action, and the
// client picker can ask for it the moment a name is hovered.
export async function GET(req: Request) {
  let me: Awaited<ReturnType<typeof requireStaff>>;
  try {
    me = await requireStaff();
  } catch {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return Response.json({ error: "Which client?" }, { status: 400 });
  // ?part=core: the briefs already written, promises and saves (quick); ?part=rest: patterns, winners and the market.
  // The page asks for both at once, so the briefs show the moment they're read and never wait on the heavier part.
  const part = url.searchParams.get("part");
  const db = await createClient();
  const data = part === "core" ? await startCore(db, clientId, formatsFor(me), me.id) : part === "rest" ? await startRest(db, clientId, formatsFor(me)) : await startSections(db, clientId, formatsFor(me), me.id);
  return Response.json(data, { headers: { "cache-control": "private, max-age=60" } });
}
