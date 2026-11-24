"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { CONSENT_TEXT, toE164, twilioConfigured } from "@/lib/phone-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Settings › Phone alerts: each person's own choice, saved through their own session (the table only lets them write
// their own row). Turning it on needs the consent box ticked; the words they agreed to and when are kept.

export type PhoneForm = { phone: string; optedIn: boolean; consent: boolean; quietStart: number; quietEnd: number; timezone: string };
type Result = { ok: true; phone: string | null } | { ok: false; error: string };

const ZONES = new Set(["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Madrid", "Europe/Athens", "Asia/Manila", "Asia/Kolkata", "Asia/Karachi", "America/Bogota", "America/Mexico_City", "America/Sao_Paulo"]);
const hour = (n: unknown, d: number) => (Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) <= 23 ? Number(n) : d);

export async function savePhoneSettings(f: PhoneForm): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "While viewing as someone, nothing is changed." };
  const phone = f.phone.trim() ? toE164(f.phone) : null;
  if (f.phone.trim() && !phone) return { ok: false, error: "That doesn't look like a phone number. Use the full number, with the country code outside the US." };
  if (f.optedIn && !phone) return { ok: false, error: "Add your mobile number first." };
  if (f.optedIn && !f.consent) return { ok: false, error: "Tick the consent box to turn phone alerts on." };
  const db = await createClient();
  const { data: had } = await db.from("phone_settings").select("consent_at, opted_in").eq("profile_id", me.id).maybeSingle();
  const now = new Date().toISOString();
  const row = {
    profile_id: me.id,
    phone,
    opted_in: Boolean(f.optedIn && phone),
    // Consent is recorded when it's given (turning on again records it again)
    ...(f.optedIn && f.consent && (!had?.opted_in || !had?.consent_at) ? { consent_at: now, consent_text: CONSENT_TEXT } : {}),
    quiet_start: hour(f.quietStart, 21),
    quiet_end: hour(f.quietEnd, 7),
    timezone: ZONES.has(f.timezone) ? f.timezone : "America/New_York",
    updated_at: now,
  };
  const { error } = await db.from("phone_settings").upsert(row, { onConflict: "profile_id" });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true, phone };
}

/** A test call to their own number (at most 3 an hour) */
export async function testPhoneCall(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "While viewing as someone, nothing is changed." };
  if (!twilioConfigured()) return { ok: false, error: "Phone calls aren't switched on yet: Twilio isn't connected." };
  const db = await createClient();
  const { data: s } = await db.from("phone_settings").select("phone, opted_in, consent_at").eq("profile_id", me.id).maybeSingle();
  if (!s?.opted_in || !s.consent_at || !s.phone) return { ok: false, error: "Turn phone alerts on first." };
  const admin = createAdminClient();
  const { count } = await admin.from("phone_calls").select("id", { count: "exact", head: true }).eq("profile_id", me.id).eq("kind", "test").gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
  if ((count ?? 0) >= 3) return { ok: false, error: "That's three test calls this hour. Try again later." };
  const { placeCall } = await import("@/lib/phone");
  const r = await placeCall(admin, { profileId: me.id, phone: String(s.phone), kind: "test", title: "Test call" });
  return "id" in r ? { ok: true } : { ok: false, error: r.error };
}
