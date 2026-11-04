import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Slack's Events API: new, edited and deleted messages in client channels, pushed the moment they happen, so a
// client's portal chat shows our team's reply within a second instead of on the next read. Every request is checked
// against Slack's signature (SLACK_SIGNING_SECRET) and anything older than five minutes is refused (replays).
// Answered at once; the saving happens after (Slack wants an answer within three seconds).
export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return new Response("Not configured", { status: 503 });
  const raw = await request.text();
  const stamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const sig = request.headers.get("x-slack-signature") ?? "";
  if (!stamp || Math.abs(Date.now() / 1000 - Number(stamp)) > 300) return new Response("Stale", { status: 401 });
  const mine = `v0=${createHmac("sha256", secret).update(`v0:${stamp}:${raw}`).digest("hex")}`;
  const a = Buffer.from(mine);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Bad signature", { status: 401 });

  const body = JSON.parse(raw) as { type: string; challenge?: string; event?: Record<string, unknown> & { type: string } };
  // Slack checking the address when it's first saved
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (body.type === "event_callback" && body.event?.type === "message") {
    const event = body.event;
    after(async () => {
      const { onSlackEvent } = await import("@/lib/portal-chat");
      await onSlackEvent(createAdminClient(), event as never).catch((e) => console.error("[slack events]", e instanceof Error ? e.message : e));
    });
  }
  return new Response("ok");
}
