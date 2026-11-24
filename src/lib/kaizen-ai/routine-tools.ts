import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// Routines in Kaizen AI and the assistant (chat and calls): "what did my morning recap say", "run my end-of-day recap
// now", "turn on the Friday recap at 4:30". Execs and leads (src/lib/routines.ts).

export function routineTools(ctx: ToolCtx): ChatTool[] {
  const allowed = async () => (await import("@/lib/routines-core")).mayUseRoutines(ctx.me);
  return [
    {
      name: "my_recaps",
      description: "The person's latest routine reports (morning recap, afternoon and end-of-day recaps, Friday week recap, Sunday week-ahead, sweeps and the nightly agent): each one's headline (its first sentence is the one thing to do first), its sections and a link. Use for 'what did my recap say', 'what's in my morning recap', 'read me my end-of-day'. kind narrows it to one routine.",
      input_schema: { type: "object", properties: { kind: { type: "string", enum: ["morning", "afternoon", "eod", "week_recap", "week_ahead", "debrief", "delegation", "nightly", "clean_sweep", "call_prep"] } }, additionalProperties: false },
      status: () => "Reading your recaps…",
      run: async (input) => {
        if (!(await allowed())) return { error: "Routines are for the executives and leads." };
        let q = ctx.db.from("routine_runs").select("id, kind, status, headline, report, started_at").eq("profile_id", ctx.me.id).order("started_at", { ascending: false }).limit(input.kind ? 1 : 5);
        if (typeof input.kind === "string") q = q.eq("kind", input.kind);
        const { data } = await q;
        if (!data?.length) return { note: "Nothing has run yet. Offer to run it now (run_routine) or turn it on (set_routine)." };
        return { recaps: data.map((r) => ({ kind: r.kind, when: r.started_at, status: r.status, headline: r.headline, sections: (r.report as { sections?: unknown[] } | null)?.sections ?? [], open: `/routines?run=${r.id}` })) };
      },
    },
    {
      name: "run_routine",
      description: "Runs one of the person's routines right now (a recap, a sweep): it takes a minute or two and lands on their Routines page and in the bell. Use for 'run my morning recap now', 'give me my end-of-day now'.",
      input_schema: { type: "object", properties: { kind: { type: "string", enum: ["morning", "afternoon", "eod", "week_recap", "week_ahead", "debrief", "delegation", "nightly", "clean_sweep", "call_prep"] } }, required: ["kind"], additionalProperties: false },
      status: () => "Running it…",
      run: async (input) => {
        if (!(await allowed())) return { error: "Routines are for the executives and leads." };
        if (ctx.me.viewAs) return { error: "Not while viewing as someone." };
        const { runRoutine } = await import("@/lib/routines");
        const r = await runRoutine(ctx.admin, ctx.me.id, input.kind as never);
        return r.report ? { headline: r.report.headline, sections: r.report.sections, open: `/routines?run=${r.id}` } : { error: r.error ?? "It didn't finish." };
      },
    },
    {
      name: "set_routine",
      description: "Turns one of the person's routines on or off, and sets its times (New York, 24h like 08:45; the debrief sweep takes several). Use for 'turn on my morning recap', 'move my end-of-day recap to 5:30', 'stop the nightly agent'.",
      input_schema: { type: "object", properties: { kind: { type: "string", enum: ["morning", "afternoon", "eod", "week_recap", "week_ahead", "debrief", "delegation", "nightly", "clean_sweep", "call_prep"] }, enabled: { type: "boolean" }, times: { type: "array", items: { type: "string" } } }, required: ["kind"], additionalProperties: false },
      status: () => "Saving your routine…",
      run: async (input) => {
        if (!(await allowed())) return { error: "Routines are for the executives and leads." };
        if (ctx.me.viewAs) return { error: "Not while viewing as someone." };
        const { routineOf, validTime } = await import("@/lib/routines-core");
        const def = routineOf(String(input.kind));
        if (!def) return { error: "That isn't a routine." };
        const { data: cur } = await ctx.db.from("routines").select("enabled, times").eq("profile_id", ctx.me.id).eq("kind", def.kind).maybeSingle();
        const times = Array.isArray(input.times) ? (input.times as string[]).map((t) => t.trim()).filter(validTime) : ((cur?.times as string[] | undefined) ?? def.times);
        const { error } = await ctx.db.from("routines").upsert({ profile_id: ctx.me.id, kind: def.kind, enabled: typeof input.enabled === "boolean" ? input.enabled : Boolean(cur?.enabled ?? true), times, days: def.days, updated_at: new Date().toISOString() });
        return error ? { error: error.message } : { saved: true, routine: def.label, times, page: "/routines" };
      },
    },
  ];
}
