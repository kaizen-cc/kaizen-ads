import { requireStaff } from "@/lib/auth";
import { SlowError, withTimeout } from "@/lib/fail-fast";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// POST /api/assistant/heads-up: the open app's light poll for "the assistant calls you about urgent items".
//   { action: "beat", visible, inCall, path }  they're here (every 15 seconds while a tab is in view): back comes a
//                                               ring when something urgent should ring now, and what's unread in the chat
//   { action: "end", id, outcome }              the ring was answered, declined, or missed after ten seconds
//   { action: "read", ids }                     heads-ups seen in the chat
// Staff only, each person's own heads-ups. The logic is in lib/assistant/heads-up-server.

// A poll: it answers in seconds or not at all, so a struggling database never holds a function for minutes
export const maxDuration = 15;

export async function POST(request: Request) {
  let me: Awaited<ReturnType<typeof requireStaff>>;
  try {
    me = await requireStaff();
  } catch {
    return new Response("Not allowed", { status: 401 });
  }
  if (!adminConfigured()) return Response.json({ ring: null, unread: [] });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const admin = createAdminClient();
  const hu = await import("@/lib/assistant/heads-up-server");
  try {
    if (body.action === "end") {
      const outcome = body.outcome === "answered" ? "answered" : body.outcome === "declined" ? "declined" : "missed";
      const id = String(body.id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ ok: false }, { status: 400 });
      const h = await hu.endRing(admin, me.id, id, outcome);
      return Response.json({ ok: Boolean(h), headsUp: h, unread: await hu.unreadHeadsUps(admin, me.id) });
    }
    if (body.action === "read") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      await hu.markHeadsUpsRead(admin, me.id, ids);
      return Response.json({ ok: true, unread: await hu.unreadHeadsUps(admin, me.id) });
    }
    const path = typeof body.path === "string" ? body.path : null;
    return Response.json(await withTimeout(hu.beat(admin, me.id, { visible: body.visible !== false, inCall: body.inCall === true, path }), 8000));
  } catch (e) {
    // Before the migration (or a blip): the app carries on without heads-ups
    console.error("[heads-up]", e instanceof Error ? e.message : e);
    // Slow: a 503 tells the open app to back off; anything else carries on without heads-ups
    if (e instanceof SlowError) return Response.json({ ring: null, unread: [] }, { status: 503 });
    return Response.json({ ring: null, unread: [] });
  }
}
