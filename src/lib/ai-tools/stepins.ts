import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { str, type AiTool } from "./types";

// The executives' step-ins as tools, for the assistant (voice and text) and every Kaizen AI agent
// (src/lib/kaizen-ai/extensions.ts). Executives only.
//   exec_stepins       this week's accounts where an exec needs to step in (their focus lines plus fires), each with
//                      the hole, numbers vs target and trend, what the team did and hasn't, owners, the suggested
//                      step-in, who's handling it and the execs' comments
//   comment_stepin     add a comment every exec sees ("I'll take this", "Kyle handles")
//   assign_stepin      set who's handling it and a due date
//   close_stepin       mark it handled (it reopens if the account slides again), or reopen it
// open_screen place 'step-ins' (or 'step-ins story' for the Monday story mode).

const NOT_EXEC = { ok: false as const, error: "Step-ins are for the executives." };

async function find(user: Parameters<AiTool["run"]>[0], input: Record<string, unknown>) {
  const { loadStepins } = await import("@/lib/stepins/act");
  const cards = await loadStepins(await createClient(), user, { status: "all" });
  const id = str(input.id);
  const c = str(input.client)?.toLowerCase();
  const hits = cards.filter((s) => (id ? s.id === id : c ? s.card.client.name.toLowerCase().includes(c) : false));
  if (hits.length === 1) return { card: hits[0] } as const;
  if (!hits.length) return { error: "No step-in matches. Use exec_stepins to see them." } as const;
  return { error: `More than one matches: ${hits.map((h) => `${h.card.client.name} (id ${h.id})`).join("; ")}.` } as const;
}

const list: AiTool = {
  name: "exec_stepins",
  description:
    "This week's executive step-ins: the accounts where an exec needs to step in, in this exec's focus lines plus company-wide fires (a client leaving, an ad account disabled or unpaid or not spending, an angry client unanswered), ad accounts 50%+ off target for over 7 days with nothing in motion, email red all week with nothing moving, and items stuck past the lead. Everything the leads are handling stays with them. Each card: the hole, numbers vs target and trend, what the team did and hasn't, who owns it, the suggested step-in, who's handling it and by when, and the execs' comments. status: open (default) or all. open_screen place 'step-ins' shows them ('step-ins story' walks them one by one).",
  input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "all"] }, client: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const { loadStepins } = await import("@/lib/stepins/act");
    const c = str(input.client)?.toLowerCase();
    const cards = (await loadStepins(await createClient(), user, { status: str(input.status) === "all" ? "all" : "open" })).filter((s) => !c || s.card.client.name.toLowerCase().includes(c));
    return {
      ok: true,
      page: "/stepins",
      count: cards.length,
      stepins: cards.slice(0, 20).map((s) => ({
        id: s.id,
        client: s.card.client.name,
        status: s.status,
        fire: s.fire,
        holes: s.reasons.map((r) => ({ kind: r.kind, line: r.line, what: r.title, detail: r.detail, number: r.stat ?? null })),
        numbers: s.card.kpis.map((k) => ({ platform: k.platform, value: k.value, target: k.target, trend: k.trend })),
        teamDid: s.card.team.done,
        teamHasnt: s.card.team.notDone,
        owners: s.card.owners,
        suggestedStepIn: s.card.step,
        handling: s.handler?.name ?? null,
        due: s.dueOn,
        comments: s.comments.slice(-5).map((m) => ({ by: m.author, said: m.body, on: m.at.slice(0, 10) })),
      })),
    };
  },
};

const comment: AiTool = {
  name: "comment_stepin",
  description: "Add a comment to an exec step-in card that every exec sees, and the other execs are told in the app (context, \"I'll take this\", \"the Head of Meta handles it\"). id from exec_stepins, or client. Say what you'll post and ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, comment: { type: "string" } }, required: ["comment"], additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const f = await find(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    return (await import("@/lib/stepins/act")).commentStepin(createAdminClient(), user, f.card.id, str(input.comment) ?? "");
  },
};

const assign: AiTool = {
  name: "assign_stepin",
  description: "Set who's handling an exec step-in (an exec, or a lead or owner by name; 'me' for the person asking) and/or its due date (YYYY-MM-DD). id from exec_stepins, or client. Ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, who: { type: "string" }, due: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const f = await find(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    const who = str(input.who);
    const me = who && /^(me|myself|i)$/i.test(who);
    return (await import("@/lib/stepins/act")).assignStepin(createAdminClient(), user, f.card.id, { handlerId: me ? user.id : null, handlerName: me ? null : who, dueOn: str(input.due) ?? undefined });
  },
};

const close: AiTool = {
  name: "close_stepin",
  description: "Mark an exec step-in handled (with what was done; it reopens on its own if the account slides again), or how 'reopen' to open it again. id from exec_stepins, or client. Ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, how: { type: "string", enum: ["handled", "reopen"] }, note: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const f = await find(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    const act = await import("@/lib/stepins/act");
    return str(input.how) === "reopen" ? act.reopenStepin(createAdminClient(), user, f.card.id) : act.closeStepin(createAdminClient(), user, f.card.id, str(input.note) ?? "");
  },
};

export const tools: AiTool[] = [list, comment, assign, close];
