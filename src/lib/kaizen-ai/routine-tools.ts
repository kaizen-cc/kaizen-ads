import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// The routines on demand, for whoever asks (owner, Nov 24 2026: baked into the OS for everyone, no page): "run my
// morning sweep", "give me my end-of-day recap", "track what I delegated today", "prep me for my 2pm" runs it now for
// them, scoped to their account, and answers with it; "send my recap at 9 instead" changes their own times, quietly.

const KINDS = ["morning", "afternoon", "eod", "week_recap", "week_ahead", "debrief", "delegation", "nightly", "clean_sweep", "call_prep"];

export function routineTools(ctx: ToolCtx): ChatTool[] {
  return [
    {
      name: "run_routine",
      description:
        "Runs one of the person's routines right now and returns what it found, to tell them inline: morning (overnight, still open, today, top 3), afternoon (today's meetings so far), eod (since 3pm, still open tonight, tomorrow), week_recap (Friday), week_ahead (Sunday prep), debrief (their calls read: their own action items, sales calls into Sales, coverage gaps), delegation (their Slack asks of teammates become items those teammates own), nightly (works their open items into drafts), clean_sweep (closes what's provably done, merges duplicates, leaves what only they can do), call_prep (a brief for a client call; at: the time they named, as an ISO date-time today). Use for 'run my morning sweep', 'give me my end-of-day recap', 'track what I delegated today', 'prep me for my 2pm'. Takes a minute or two.",
      input_schema: { type: "object", properties: { kind: { type: "string", enum: KINDS }, at: { type: "string", description: "call_prep: the call's time today (ISO)" } }, required: ["kind"], additionalProperties: false },
      status: (input) => (input.kind === "call_prep" ? "Prepping your call…" : "Running it for you…"),
      run: async (input) => {
        if (ctx.me.viewAs) return { error: "Not while viewing as someone." };
        const kind = String(input.kind);
        if (!KINDS.includes(kind)) return { error: "That isn't one of the routines." };
        if (kind === "call_prep") {
          const { prepUpcomingCalls } = await import("@/lib/routine-callprep");
          const n = await prepUpcomingCalls(ctx.admin, { id: ctx.me.id, full_name: ctx.me.fullName, email: ctx.me.email, role: String(ctx.me.role ?? ""), is_exec: Boolean(ctx.me.isExec), is_lead: Boolean(ctx.me.isLead) }, typeof input.at === "string" ? input.at : null);
          if (!n) return { note: "No client call on their calendar around then (sales calls are briefed by the Sales agent)." };
          const { data } = await ctx.db.from("routine_runs").select("report").eq("profile_id", ctx.me.id).eq("kind", "call_prep").order("started_at", { ascending: false }).limit(1).maybeSingle();
          return { brief: data?.report ?? null };
        }
        const { runRoutine } = await import("@/lib/routines");
        const r = await runRoutine(ctx.admin, ctx.me.id, kind as never);
        if (!r.report) return { error: r.error ?? "It didn't finish." };
        return r.report.sections.length ? { headline: r.report.headline, sections: r.report.sections, couldnt_read: r.report.failedSources ?? [] } : { note: "Nothing to report right now." };
      },
    },
    {
      name: "set_routine",
      description: "Changes the person's own routine times (their time zone, 24h like 09:00; the debrief takes several) or turns one off or back on. Use for 'send my recap at 9 instead', 'stop the nightly agent', 'move my end-of-day to 5:30'. Saved quietly; say what changed.",
      input_schema: { type: "object", properties: { kind: { type: "string", enum: KINDS }, enabled: { type: "boolean" }, times: { type: "array", items: { type: "string" } } }, required: ["kind"], additionalProperties: false },
      status: () => "Saving that…",
      run: async (input) => {
        if (ctx.me.viewAs) return { error: "Not while viewing as someone." };
        const { routineOf, validTime } = await import("@/lib/routines-core");
        const def = routineOf(String(input.kind));
        if (!def) return { error: "That isn't one of the routines." };
        const { data: cur } = await ctx.admin.from("routines").select("enabled, times").eq("profile_id", ctx.me.id).eq("kind", def.kind).maybeSingle();
        const times = Array.isArray(input.times) ? (input.times as string[]).map((t) => t.trim()).filter(validTime) : ((cur?.times as string[] | undefined) ?? def.times);
        const enabled = typeof input.enabled === "boolean" ? input.enabled : (cur?.enabled ?? true);
        const { error } = await ctx.admin.from("routines").upsert({ profile_id: ctx.me.id, kind: def.kind, enabled, times, days: def.days, updated_at: new Date().toISOString() });
        return error ? { error: error.message } : { saved: true, routine: def.label, on: enabled, times };
      },
    },
  ];
}
