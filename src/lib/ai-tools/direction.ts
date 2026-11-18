import "server-only";
import { clientNamed as sharedClientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, type AiTool } from "./types";

// A client changing direction, for every agent and the assistant (registered in src/lib/kaizen-ai/extensions.ts):
//   direction_changes        open changes for a client, or the ones on the person (read)
//   log_direction_change     a change the person heard about, matched to the client's open tasks (asks first)
//   act_on_direction_change  send flagged tasks back, keep them or stop them (asks first)
// All with the person's own session: only clients they can see (src/lib/direction-changes.ts).

async function clientNamed(asked: string | null): Promise<{ id: string; name: string } | { error: string }> {
  if (!asked) return { error: "Which client?" };
  try {
    const hit = await sharedClientNamed(await createClient(), asked);
    return { id: hit.id, name: hit.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : `No client called "${asked}" that you can see.` };
  }
}

const listChanges: AiTool = {
  name: "direction_changes",
  description:
    "Open direction changes: when a client changed direction mid-production (a new offer or price, a campaign dropped, evergreen only, a new audience) and which open tasks it touches, on both boards (Kaizen and Asana). With a client: that client's; without: the ones the person was told about. Each has its id (for act_on_direction_change and open_screen what: direction_change), the summary, the client's words, and each flagged task with its id, stage, why and the suggested action.",
  input_schema: { type: "object", properties: { client: { type: "string" } }, additionalProperties: false },
  run: async (user: Staff, input) => {
    const db = await createClient();
    const { openChanges, loadChange } = await import("@/lib/direction-changes");
    const { actionLabel } = await import("@/lib/direction-core");
    let lines;
    if (str(input.client)) {
      const c = await clientNamed(str(input.client));
      if ("error" in c) return { ok: false, error: c.error };
      lines = await openChanges(db, { clientId: c.id, limit: 5 });
    } else lines = await openChanges(db, { notified: user.id, limit: 8 });
    const full = await Promise.all(lines.map((l) => loadChange(db, l.id)));
    return {
      ok: true,
      changes: full.filter(Boolean).map((c) => ({
        id: c!.id,
        client: c!.client.name,
        summary: c!.summary,
        was: c!.was,
        now: c!.now,
        quote: c!.quote,
        source: c!.source,
        saidAt: c!.saidAt,
        tasks: c!.tasks.map((t) => ({ id: t.id, title: t.title, board: t.kind, stage: t.stageLabel, verdict: t.verdict, why: t.why, suggested: actionLabel(t.kind, t.fix, t.suggested), done: t.action === "pending" ? null : t.action, withClientNow: t.withClient })),
      })),
      note: lines.length ? undefined : "No open direction changes.",
    };
  },
};

const logTool: AiTool = {
  name: "log_direction_change",
  description:
    "Logs that a client changed direction (heard on a call, a WhatsApp, anywhere: 'they want evergreen only now', 'the offer is 20% off, not 15'): it's matched against the client's open tasks on both boards and each touched task is flagged with where it should go back to; the media buyer, the strategist, the Head of Creative and whoever holds the tasks are told. Returns the change id and the flagged tasks with suggestions: read them out briefly and offer to apply (act_on_direction_change) or open it (open_screen what: direction_change). Say what you'll log and ask first.",
  input_schema: { type: "object", properties: { client: { type: "string" }, what_changed: { type: "string", description: "What the client changed, in plain words, with their own words when known" } }, required: ["client", "what_changed"], additionalProperties: false },
  spends: true,
  run: async (user: Staff, input) => {
    const c = await clientNamed(str(input.client));
    if ("error" in c) return { ok: false, error: c.error };
    const { logChange } = await import("@/lib/direction-changes");
    const r = await logChange(await createClient(), createAdminClient(), user, c.id, String(input.what_changed ?? ""), "assistant");
    return r.ok ? { ok: true, changeId: r.id, client: c.name, summary: r.summary, tasks: r.tasks, note: r.tasks.length ? undefined : `No open task for ${c.name} is touched by it.` } : r;
  },
};

const actTool: AiTool = {
  name: "act_on_direction_change",
  description:
    "Acts on tasks flagged after a client changed direction (ids from direction_changes or log_direction_change): send_back moves each to its suggested stage (or to: a stage) with the client's new direction as the note (an Asana task also gets a comment in Asana); keep leaves it as it is; stop removes a Kaizen ticket the board's way (never for good) or leaves a 'client stopped this' comment on an Asana task. Moving work is a change on the boards: say what will move where and ask first.",
  input_schema: {
    type: "object",
    properties: {
      task_ids: { type: "array", items: { type: "string" } },
      how: { type: "string", enum: ["send_back", "keep", "stop"] },
      to: { type: "string", description: "send_back only: a stage instead of the suggestion (creative: requested, in_production, copy, client_revision; email: copy_review, ready_for_design, revisions)" },
      note: { type: "string", description: "Anything to add for the makers" },
    },
    required: ["task_ids", "how"],
    additionalProperties: false,
  },
  spends: true,
  run: async (user: Staff, input) => {
    const ids = (Array.isArray(input.task_ids) ? input.task_ids : []).map(String).slice(0, 40);
    const how = input.how === "keep" ? "keep" : input.how === "stop" ? "stop" : "send_back";
    const to = str(input.to);
    const { actOnTasks } = await import("@/lib/direction-changes");
    const r = await actOnTasks(await createClient(), createAdminClient(), user, ids, how, { to: to ? Object.fromEntries(ids.map((id) => [id, to])) : undefined, note: str(input.note) });
    return r.ok ? { ok: true, done: r.done, failed: r.failed, allHandled: r.handled } : r;
  },
};

export const tools: AiTool[] = [listChanges, logTool, actTool];
