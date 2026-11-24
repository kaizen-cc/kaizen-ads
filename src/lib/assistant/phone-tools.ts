import "server-only";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { MAX_CALLS_PER_HOUR, prettyPhone, twilioConfigured, UNSEEN_MINUTES } from "@/lib/phone-core";
import type { AssistantCtx } from "./tools";

// Phone alerts through the assistant: what's set up, turning it off, quiet hours, a test call. Turning it on stays in
// Settings › Phone alerts, where they tick the consent box themselves (a spoken "yes" isn't the record of consent).

export function phoneTools(ctx: AssistantCtx): LoopTool[] {
  return [
    {
      name: "phone_alerts",
      description: `The person's own phone alerts: Kaizen OS calls their phone when a critical item for them sits unseen ${UNSEEN_MINUTES} minutes (press 1 to hear it and get the link by text, 2 to snooze an hour; at most ${MAX_CALLS_PER_HOUR} calls an hour, never in their quiet hours). what: status (what's set), off (turn it off), quiet_hours (from and until, 0-23, in their time zone), test_call (rings them now). Turning it ON needs them to tick the consent box in Settings › Phone alerts: open it with open_screen place "phone alerts".`,
      input_schema: { type: "object", properties: { what: { type: "string", enum: ["status", "off", "quiet_hours", "test_call"] }, from: { type: "integer" }, until: { type: "integer" } }, required: ["what"], additionalProperties: false },
      run: async (input) => {
        const me = ctx.me as typeof ctx.me & { viewAs?: unknown };
        const { data: s } = await ctx.db.from("phone_settings").select("phone, opted_in, consent_at, quiet_start, quiet_end, timezone").eq("profile_id", ctx.me.id).maybeSingle();
        if (input.what === "status")
          return {
            switched_on_for_kaizen: twilioConfigured(),
            on: Boolean(s?.opted_in && s?.consent_at),
            number: s?.phone ? prettyPhone(String(s.phone)) : null,
            quiet_hours: s ? `${s.quiet_start}:00 to ${s.quiet_end}:00 (${s.timezone})` : "9pm to 7am (Eastern), the default",
            note: s?.opted_in ? "" : 'Off. To turn it on they add their number and tick the consent box in Settings › Phone alerts (open_screen place "phone alerts").',
          };
        if (me.viewAs) return { error: "While viewing as someone, nothing is changed." };
        if (input.what === "off") {
          if (!s?.opted_in) return { done: true, note: "It was already off." };
          const { error } = await ctx.db.from("phone_settings").update({ opted_in: false, updated_at: new Date().toISOString() }).eq("profile_id", ctx.me.id);
          return error ? { error: error.message } : { done: true, note: "Phone alerts are off. They can turn them back on in Settings." };
        }
        if (input.what === "quiet_hours") {
          const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23;
          if (!ok(input.from) || !ok(input.until)) return { error: "Say the hours (0 to 23), from and until." };
          const { error } = await ctx.db.from("phone_settings").upsert({ profile_id: ctx.me.id, quiet_start: input.from, quiet_end: input.until, updated_at: new Date().toISOString() }, { onConflict: "profile_id" });
          return error ? { error: error.message } : { done: true, quiet_hours: `${input.from}:00 to ${input.until}:00` };
        }
        // test_call
        if (!twilioConfigured()) return { error: "Phone calls aren't switched on for Kaizen yet (Twilio isn't connected)." };
        if (!s?.opted_in || !s.consent_at || !s.phone) return { error: 'Phone alerts are off for them: they turn them on in Settings › Phone alerts (open_screen place "phone alerts").' };
        const { count } = await ctx.admin.from("phone_calls").select("id", { count: "exact", head: true }).eq("profile_id", ctx.me.id).eq("kind", "test").gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
        if ((count ?? 0) >= 3) return { error: "That's three test calls this hour." };
        const { placeCall } = await import("@/lib/phone");
        const r = await placeCall(ctx.admin, { profileId: ctx.me.id, phone: String(s.phone), kind: "test", title: "Test call" });
        return "id" in r ? { done: true, note: "Their phone is ringing now." } : { error: r.error };
      },
    },
  ];
}
