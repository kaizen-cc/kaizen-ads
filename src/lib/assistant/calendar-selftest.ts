import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gcal } from "./calendar-server";
import { sameDomain } from "./scheduling-core";

// A one-time check that calendar scheduling works in production, run by the cron once (system_checks
// "calendar-booking"; delete that row to run it again): the owner's token for free/busy, a FreeBusy ask for the owner
// and one teammate, then the events token and a private test event on the owner's own calendar (no attendees,
// sendUpdates none, so no one is invited or emailed), deleted straight away. Each step's outcome is kept.

const KEY = "calendar-booking";
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function calendarSelfTestOnce(admin: SupabaseClient): Promise<{ ran: boolean; ok?: boolean }> {
  const { data: had } = await admin.from("system_checks").select("key").eq("key", KEY).maybeSingle();
  if (had) return { ran: false };
  const { googleConfigured, googleFreeBusyToken, googleCalendarEventsToken } = await import("@/lib/context/google");
  if (!googleConfigured()) return { ran: false };
  // Claim it first, so two cron runs at once don't both test
  const { error: claimed } = await admin.from("system_checks").insert({ key: KEY, ok: false, result: { running: true } });
  if (claimed) return { ran: false };

  const steps: Record<string, unknown> = {};
  let ok = false;
  try {
    const { data: owner } = await admin.from("profiles").select("id, email").eq("can_view_as", true).eq("is_active", true).limit(1).maybeSingle();
    const ownerEmail = String(owner?.email ?? "").toLowerCase();
    if (!ownerEmail) throw new Error("no owner profile (can_view_as) with an email");
    const { data: others } = await admin.from("profiles").select("email").eq("is_active", true).eq("is_exec", false).not("email", "is", null).limit(50);
    const mate = ((others ?? []) as { email: string }[]).map((p) => p.email.toLowerCase()).find((e) => e !== ownerEmail && sameDomain(e, ownerEmail));
    if (!mate) throw new Error("no teammate on the owner's domain");

    let fbToken: string;
    try {
      fbToken = await googleFreeBusyToken(ownerEmail);
      steps.freebusy_token = "ok";
    } catch (e) {
      steps.freebusy_token = short(e);
      throw e;
    }
    const now = Date.now();
    type FB = { calendars?: Record<string, { busy?: unknown[]; errors?: unknown[] }> };
    const fb = await gcal<FB>(fbToken, "POST", "/freeBusy", {}, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 3 * 86_400_000).toISOString(), items: [{ id: ownerEmail }, { id: mate }] });
    steps.freebusy = Object.fromEntries(Object.entries(fb.calendars ?? {}).map(([k, v]) => [k === ownerEmail ? "owner" : "teammate", v.errors?.length ? { errors: v.errors } : { busy_blocks: v.busy?.length ?? 0 }]));

    let evToken: string;
    try {
      evToken = await googleCalendarEventsToken(ownerEmail);
      steps.events_token = "ok";
    } catch (e) {
      steps.events_token = short(e);
      throw e;
    }
    // Tomorrow at 06:00 UTC for 15 minutes, private, nobody invited, nobody emailed
    const start = new Date(Math.ceil(now / 86_400_000) * 86_400_000 + 6 * 3_600_000);
    const ev = await gcal<{ id: string; status?: string }>(evToken, "POST", "/calendars/primary/events", { sendUpdates: "none" }, {
      summary: "Kaizen OS calendar test (deleted right away)",
      start: { dateTime: start.toISOString() },
      end: { dateTime: new Date(start.getTime() + 15 * 60_000).toISOString() },
      visibility: "private",
      transparency: "transparent",
      reminders: { useDefault: false, overrides: [] },
    });
    steps.create_event = { ok: true, status: ev.status ?? null };
    await gcal(evToken, "DELETE", `/calendars/primary/events/${encodeURIComponent(ev.id)}`, { sendUpdates: "none" });
    steps.delete_event = "ok";
    ok = true;
  } catch (e) {
    steps.error = short(e);
  }
  await admin.from("system_checks").update({ ok, result: steps, ran_at: new Date().toISOString() }).eq("key", KEY);
  return { ran: true, ok };
}
