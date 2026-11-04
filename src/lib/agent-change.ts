import type { Proposal } from "@/lib/agent-evals";

// What a change to an agent is about (so its test and its save line up in the agent's history), and the proposal a
// coach or agent-chat edit stands for. Shared by the Settings page and its actions.

type ChangeLike = { op: "set_instructions" | "update_item" | "add_item" | "turn_off_item" | "set_model" | "set_core"; item_id: string; kind: "" | "knowledge" | "skill" | "example"; title: string; body: string; model: "" | "opus" | "sonnet" | "haiku"; effort: "" | "low" | "medium" | "high" };

/** The part of the agent a change touches: its setup (brain and instructions), one item, a new item, or the core */
export function changeTarget(op: ChangeLike["op"], itemId?: string | null) {
  if (op === "set_instructions" || op === "set_model") return "setup";
  if (op === "set_core") return "core";
  if (op === "add_item") return "item:new";
  return `item:${itemId ?? ""}`;
}

/** A proposed coach or agent-chat edit as a test proposal */
export function proposalOf(c: ChangeLike, current?: { title: string; kind: "knowledge" | "skill" | "example" } | null): Proposal {
  if (c.op === "set_instructions") return { instructions: c.body };
  if (c.op === "set_core") return { core: c.body };
  if (c.op === "set_model") return { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}) };
  if (c.op === "add_item") return { items: [{ id: null, kind: c.kind || "skill", title: c.title || "From the coach", body: c.body, active: true }] };
  if (c.op === "turn_off_item") return { items: [{ id: c.item_id, kind: current?.kind ?? "skill", title: current?.title ?? "", body: "", active: false }] };
  return { items: [{ id: c.item_id, kind: (c.kind || current?.kind || "skill") as "knowledge" | "skill" | "example", title: c.title || current?.title || "", body: c.body, active: true }] };
}
