import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { siteUrl } from "@/lib/site";
import { shouldCall, STALE_MINUTES, toE164, twilioConfigured, type Item, type PastCall, type PhoneSettings } from "@/lib/phone-core";

// Phone notices (phase 1 of docs/PHONE-NOTIFICATIONS.md): the server side. Dormant until TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are set. The sweep (every 5 minutes) rings the phone of a teammate who
// opted in when a critical item for them (the notifications the escalation ladder already sends) sits unseen 10
// minutes; each call is a row in phone_calls, updated from Twilio's callbacks (src/app/api/phone/[step]/route.ts,
// signature checked), and shown in Settings › Calls & usage.

/** The public address Twilio calls back (and signs): the app's own */
export const phoneBase = () => (process.env.PHONE_WEBHOOK_BASE || siteUrl()).replace(/\/$/, "");

async function twilio(path: string, form: [string, string][]): Promise<Record<string, unknown>> {
  const sid = process.env.TWILIO_ACCOUNT_SID as string;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    cache: "no-store",
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(out.message ?? `Twilio said no (${res.status}).`).slice(0, 300));
  return out;
}

/** Rings a teammate: a notice for an item, or a test call. Returns the call's row id (or why it couldn't). */
export async function placeCall(admin: SupabaseClient, o: { profileId: string; phone: string; kind: "notice" | "test"; title: string; notificationId?: string | null }): Promise<{ id: string } | { error: string }> {
  if (!twilioConfigured()) return { error: "Phone calls aren't switched on yet (Twilio isn't connected)." };
  const to = toE164(o.phone);
  if (!to) return { error: "That isn't a phone number Kaizen OS can call." };
  const { data: row, error } = await admin.from("phone_calls").insert({ profile_id: o.profileId, notification_id: o.notificationId ?? null, kind: o.kind, title: o.title.slice(0, 300) }).select("id").single();
  if (error || !row) return { error: error?.message ?? "Couldn't log the call." };
  const id = row.id as string;
  const base = phoneBase();
  try {
    const call = await twilio("Calls.json", [
      ["To", to],
      ["From", process.env.TWILIO_FROM_NUMBER as string],
      ["Url", `${base}/api/phone/voice?call=${id}`],
      ["Method", "POST"],
      ["StatusCallback", `${base}/api/phone/status?call=${id}`],
      ["StatusCallbackMethod", "POST"],
      ["StatusCallbackEvent", "ringing"],
      ["StatusCallbackEvent", "answered"],
      ["StatusCallbackEvent", "completed"],
      ["Timeout", "25"],
    ]);
    await admin.from("phone_calls").update({ twilio_sid: String(call.sid ?? ""), status: String(call.status ?? "queued"), updated_at: new Date().toISOString() }).eq("id", id);
    return { id };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await admin.from("phone_calls").update({ status: "failed", error: why.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", id);
    return { error: why };
  }
}

/** The item's link by text, when they press 1 for it on the call */
export async function textLink(to: string, body: string): Promise<boolean> {
  if (!twilioConfigured()) return false;
  const number = toE164(to);
  if (!number) return false;
  try {
    await twilio("Messages.json", [
      ["To", number],
      ["From", process.env.TWILIO_FROM_NUMBER as string],
      ["Body", body.slice(0, 600)],
    ]);
    return true;
  } catch (e) {
    console.error("[phone] text", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Every 5 minutes: critical items unseen 10 minutes for teammates who opted in, outside their quiet hours, rate limited */
export async function sweepPhoneNotices(admin: SupabaseClient, now = new Date()): Promise<{ dormant?: true; called: number; skipped: Record<string, number> }> {
  if (!twilioConfigured()) return { dormant: true, called: 0, skipped: {} };
  const { data: people } = await admin.from("phone_settings").select("profile_id, phone, opted_in, consent_at, quiet_start, quiet_end, timezone").eq("opted_in", true).not("consent_at", "is", null);
  const settings = new Map(((people ?? []) as PhoneSettings[]).map((p) => [p.profile_id, p]));
  if (!settings.size) return { called: 0, skipped: {} };
  const since = new Date(now.getTime() - STALE_MINUTES * 60_000).toISOString();
  const ids = [...settings.keys()];
  const [{ data: items }, { data: calls }, { data: active }] = await Promise.all([
    admin.from("notifications").select("id, profile_id, priority, read_at, cleared_at, created_at, title").in("profile_id", ids).eq("priority", "critical").is("read_at", null).is("cleared_at", null).gte("created_at", since).order("created_at").limit(200),
    admin.from("phone_calls").select("profile_id, notification_id, created_at, snoozed_until").in("profile_id", ids).gte("created_at", since).limit(1000),
    admin.from("profiles").select("id").in("id", ids).eq("is_active", true),
  ]);
  const live = new Set((active ?? []).map((p) => p.id as string));
  const byPerson = new Map<string, PastCall[]>();
  for (const c of (calls ?? []) as (PastCall & { profile_id: string })[]) byPerson.set(c.profile_id, [...(byPerson.get(c.profile_id) ?? []), c]);
  let called = 0;
  const skipped: Record<string, number> = {};
  for (const it of (items ?? []) as (Item & { title: string })[]) {
    const s = settings.get(it.profile_id);
    const past = byPerson.get(it.profile_id) ?? [];
    const d = live.has(it.profile_id) ? shouldCall(it, s, past, now) : { call: false, why: "not active" };
    if (!d.call || !s?.phone) {
      skipped[d.why] = (skipped[d.why] ?? 0) + 1;
      continue;
    }
    const r = await placeCall(admin, { profileId: it.profile_id, phone: s.phone, kind: "notice", title: it.title, notificationId: it.id });
    // Counted against their hour and the item whether or not Twilio took it, so a failing call isn't retried every 5 minutes
    byPerson.set(it.profile_id, [...past, { notification_id: it.id, created_at: now.toISOString(), snoozed_until: null }]);
    if ("id" in r) called++;
    else skipped.failed = (skipped.failed ?? 0) + 1;
  }
  return { called, skipped };
}
