"use server";

import { revalidatePath } from "next/cache";
import { forgetAgent, SOURCE_KEYS, type AgentKey } from "@/lib/ai";
import { requireExec } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

function done(error?: { message: string } | null, key?: AgentKey): ActionResult {
  forgetAgent(key);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Model, effort, instructions and data sources. The next call of this agent uses them (within a minute on every server). */
export async function saveAgent(key: AgentKey, form: FormData): Promise<ActionResult> {
  const me = await requireExec();
  const model = str(form, "model");
  const effort = str(form, "effort");
  if (!["opus", "sonnet", "haiku"].includes(model)) return { ok: false, error: "Pick a model." };
  if (!["low", "medium", "high"].includes(effort)) return { ok: false, error: "Pick an effort." };
  const sources = Object.fromEntries(SOURCE_KEYS.map((k) => [k, form.get(`source_${k}`) === "on"]));
  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_agents")
    .update({ model, effort, instructions: str(form, "instructions").slice(0, 20000), sources, updated_by: me.id, updated_at: new Date().toISOString() })
    .eq("key", key);
  return done(error, key);
}

export async function addKnowledge(form: FormData): Promise<ActionResult> {
  const me = await requireExec();
  const title = str(form, "title");
  const body = str(form, "body");
  if (!title || !body) return { ok: false, error: "Give it a title and some content." };
  const agent = str(form, "agent_key");
  const kind = str(form, "kind");
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").insert({
    agent_key: agent && agent !== "all" ? agent : null,
    kind: ["knowledge", "skill", "example"].includes(kind) ? kind : "knowledge",
    title: title.slice(0, 200),
    body: body.slice(0, 60000),
    file_name: str(form, "file_name") || null,
    created_by: me.id,
  });
  return done(error);
}

export async function updateKnowledge(id: string, form: FormData): Promise<ActionResult> {
  await requireExec();
  const title = str(form, "title");
  const body = str(form, "body");
  if (!title || !body) return { ok: false, error: "Give it a title and some content." };
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").update({ title: title.slice(0, 200), body: body.slice(0, 60000), updated_at: new Date().toISOString() }).eq("id", id);
  return done(error);
}

export async function setKnowledgeActive(id: string, active: boolean): Promise<ActionResult> {
  await requireExec();
  const supabase = await createClient();
  const { error } = await supabase.from("ai_knowledge").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
  return done(error);
}
