import { requireStaff } from "@/lib/auth";
import { startSections } from "@/lib/request-start";
import { createClient } from "@/lib/supabase/server";

// GET /api/requests/start?client=: the new request's "How do you want to start?" sections for one client, from what's
// already stored (no AI). A plain fetch rather than a server action, so it never waits behind another action, and the
// client picker can ask for it the moment a name is hovered.
export async function GET(req: Request) {
  try {
    await requireStaff();
  } catch {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  const clientId = new URL(req.url).searchParams.get("client") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return Response.json({ error: "Which client?" }, { status: 400 });
  const data = await startSections(await createClient(), clientId);
  return Response.json(data, { headers: { "cache-control": "private, max-age=60" } });
}
