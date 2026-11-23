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

async function findFlagged(user: Parameters<AiTool["run"]>[0], input: Record<string, unknown>) {
  const { loadFlagged } = await import("@/lib/stepins/flagged");
  const rows = await loadFlagged(createAdminClient(), user);
  const id = str(input.id);
  const c = str(input.client)?.toLowerCase();
  const line = str(input.line)?.toLowerCase();
  const hits = rows.filter((r) => (id ? r.id === id : Boolean(c) && r.client.toLowerCase().includes(c!) && (!line || r.line === line || r.lineLabel.toLowerCase().includes(line))));
  if (hits.length === 1) return { row: hits[0] } as const;
  if (!hits.length) return { error: "No flagged account matches. Use flagged_accounts to see them." } as const;
  return { error: `More than one matches: ${hits.map((h) => `${h.client} ${h.lineLabel} (id ${h.id})`).join("; ")}. Say which line.` } as const;
}

const flagged: AiTool = {
  name: "flagged_accounts",
  description:
    "Every account the line heads' Monday review flagged this week in this exec's lines (plus clients on fire): client, line, the hole in a few words, who it's on (name and role), moving or stuck N days, and where it sits (with the owner, with the lead, a step-in), with the numbers, what the team did and hasn't, the items stuck with the lead, and the execs' comments. Executives only. client narrows it. open_screen place 'flagged accounts' shows the list.",
  input_schema: { type: "object", properties: { client: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const { loadFlagged } = await import("@/lib/stepins/flagged");
    const c = str(input.client)?.toLowerCase();
    const rows = (await loadFlagged(createAdminClient(), user)).filter((r) => !c || r.client.toLowerCase().includes(c));
    return {
      ok: true,
      page: "/stepins?flagged=1",
      count: rows.length,
      accounts: rows.slice(0, 40).map((r) => ({ id: r.id, client: r.client, line: r.lineLabel, holes: r.holes, on: r.owner?.label ?? null, status: r.status.kind === "stuck" ? `stuck ${r.status.days} days` : r.status.kind, rung: r.rung === "owner" ? "with the owner" : r.rung === "lead" ? "with the lead" : "step-in", due: r.dueOn, numbers: r.results.map((x) => x.text), teamDid: r.done, teamHasnt: r.notDone, stuckWithLead: r.items.map((x) => `${x.owner ? `${x.owner}: ` : ""}${x.text}`), comments: r.comments.slice(-4).map((m) => ({ by: m.author, said: m.body })) })),
    };
  },
};

const commentFlag: AiTool = {
  name: "comment_flagged_account",
  description: "Comment on a flagged account to the person it's on: it reaches them in the app on a thread every exec sees. It doesn't take it off them or escalate it. Optional who (a name) and due (YYYY-MM-DD) put it on someone else or set a due date. id from flagged_accounts, or client (+ line). Say what you'll send and ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, client: { type: "string" }, line: { type: "string" }, comment: { type: "string" }, who: { type: "string" }, due: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!user.isExec) return NOT_EXEC;
    const f = await findFlagged(user, input);
    if ("error" in f) return { ok: false, error: f.error };
    const fl = await import("@/lib/stepins/flagged");
    const out: unknown[] = [];
    if (str(input.comment)) out.push(await fl.commentFlagged(createAdminClient(), user, f.row.id, str(input.comment)!));
    if (str(input.who) || str(input.due)) out.push(await fl.assignFlagged(createAdminClient(), user, f.row.id, { personName: str(input.who), dueOn: str(input.due) ?? undefined }));
    return out.length ? (out.length === 1 ? out[0] : { ok: true, done: out }) : { ok: false, error: "Say the comment (or who / due)." };
  },
};

export const tools: AiTool[] = [list, comment, assign, close, flagged, commentFlag];
