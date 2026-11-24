import { byeTwiml, detailTwiml, noticeTwiml, SNOOZE_MINUTES, snoozedTwiml, testDetailTwiml, textedTwiml } from "@/lib/phone-core";
import { validTwilioSignature } from "@/lib/phone-signature";
import { phoneBase, textLink } from "@/lib/phone";
import { siteUrl } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";

// Twilio's callbacks for a phone notice (src/lib/phone.ts): voice (what's said when they pick up), gather (the key they
// pressed: 1 the details, 2 snooze an hour), text (1 again: the link by text), status (ringing, answered, completed).
// Public (no session), so every request must carry Twilio's signature for this exact URL, made with our auth token.

const STEPS = new Set(["voice", "gather", "text", "status"]);
const twiml = (body: string) => new Response(body, { headers: { "content-type": "text/xml; charset=utf-8" } });

export async function POST(request: Request, ctx: RouteContext<"/api/phone/[step]">) {
  const { step } = await ctx.params;
  if (!STEPS.has(step)) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;
  // Signed for the address Twilio was given: our public base, this path and query
  const signedUrl = `${phoneBase()}${url.pathname}${url.search}`;
  if (!validTwilioSignature(process.env.TWILIO_AUTH_TOKEN, request.headers.get("x-twilio-signature"), signedUrl, params)) return new Response("Forbidden", { status: 403 });

  const callId = url.searchParams.get("call") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return new Response("Bad request", { status: 400 });
  const admin = createAdminClient();
  const { data: call } = await admin.from("phone_calls").select("id, profile_id, notification_id, kind, title").eq("id", callId).maybeSingle();
  if (!call) return step === "status" ? new Response(null, { status: 204 }) : twiml(byeTwiml());
  const now = new Date().toISOString();

  if (step === "status") {
    const duration = Number(params.CallDuration);
    await admin
      .from("phone_calls")
      .update({ status: String(params.CallStatus ?? "unknown").slice(0, 40), ...(Number.isFinite(duration) ? { duration_seconds: duration } : {}), updated_at: now })
      .eq("id", callId);
    return new Response(null, { status: 204 });
  }

  const base = phoneBase();
  if (step === "voice") {
    const { data: who } = await admin.from("profiles").select("full_name").eq("id", call.profile_id).maybeSingle();
    const firstName = String(who?.full_name ?? "there").split(/\s+/)[0];
    return twiml(noticeTwiml({ firstName, title: String(call.title), gatherUrl: `${base}/api/phone/gather?call=${callId}`, test: call.kind === "test" }));
  }

  const digit = String(params.Digits ?? "").slice(0, 1);
  if (step === "gather") {
    await admin.from("phone_calls").update({ digits: digit, updated_at: now }).eq("id", callId);
    if (call.kind === "test") return twiml(digit === "1" ? testDetailTwiml() : byeTwiml());
    const { data: item } = call.notification_id ? await admin.from("notifications").select("id, title, body, href").eq("id", call.notification_id).maybeSingle() : { data: null };
    if (digit === "2") {
      await admin.from("phone_calls").update({ snoozed_until: new Date(Date.now() + SNOOZE_MINUTES * 60_000).toISOString() }).eq("id", callId);
      return twiml(snoozedTwiml());
    }
    if (digit === "1" && item) {
      // They heard it: the item is seen
      await admin.from("notifications").update({ read_at: now }).eq("id", item.id).is("read_at", null);
      return twiml(detailTwiml({ body: `${item.title}. ${item.body ?? ""}`, textUrl: item.href ? `${base}/api/phone/text?call=${callId}` : null }));
    }
    return twiml(byeTwiml());
  }

  // step === "text": 1 sends the item's link to the number on file
  if (digit !== "1" || !call.notification_id) return twiml(byeTwiml());
  const [{ data: item }, { data: s }] = await Promise.all([
    admin.from("notifications").select("title, href").eq("id", call.notification_id).maybeSingle(),
    admin.from("phone_settings").select("phone").eq("profile_id", call.profile_id).maybeSingle(),
  ]);
  if (!item?.href || !s?.phone) return twiml(textedTwiml(false));
  const link = /^https?:/.test(String(item.href)) ? String(item.href) : `${siteUrl()}${item.href}`;
  const ok = await textLink(String(s.phone), `Kaizen OS: ${String(item.title).slice(0, 200)} ${link}`);
  if (ok) await admin.from("phone_calls").update({ texted_at: now, updated_at: now }).eq("id", callId);
  return twiml(textedTwiml(ok));
}
