"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff, type Staff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { addKnowledge, forgetIndex, knowledgeSlots, readKnowledge, type KnowledgeTarget } from "@/lib/knowledge";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Knowledge files: added to an agent or every agent (execs, in Settings), to the Ads Lab library (execs and leads), or
// to a client (anyone on the team who can see the client). Read in the background once uploaded.

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Who may add to or change knowledge in this place */
async function allowed(me: Staff, t: KnowledgeTarget) {
  if (t.scope === "agent" || t.scope === "shared") return me.isExec;
  if (t.scope === "lab") return isExecOrLead(me);
  // A client: the team member's own access rules decide
  const { data } = await (await createClient()).from("clients").select("id").eq("id", t.clientId).maybeSingle();
  return Boolean(data);
}

const pathFor = (t: KnowledgeTarget) => (t.scope === "client" ? "/clients" : t.scope === "lab" ? "/lab" : "/settings");

/** Where to send each file (signed, straight to storage from the browser) */
export async function knowledgeUploadSlots(t: KnowledgeTarget, files: { name: string; bytes: number }[]): Promise<R<{ slots: { path: string; token: string }[] }>> {
  try {
    const me = await requireStaff();
    if (!adminConfigured()) return { ok: false, error: "Not connected." };
    if (!(await allowed(me, t))) return { ok: false, error: "You can't add knowledge here." };
    return { ok: true, slots: await knowledgeSlots(createAdminClient(), t, files) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't start the upload." };
  }
}

/** The uploaded files: saved as reading, then read one after another in the background */
export async function saveKnowledge(t: KnowledgeTarget, files: { path: string; name: string; mime: string; bytes: number }[]): Promise<R> {
  try {
    const me = await requireStaff();
    if (!adminConfigured()) return { ok: false, error: "Not connected." };
    if (!(await allowed(me, t))) return { ok: false, error: "You can't add knowledge here." };
    if (!aiEnabled()) return { ok: false, error: "The AI isn't connected, so files can't be read yet." };
    const admin = createAdminClient();
    const ids = await addKnowledge(admin, t, me.id, files);
    if (!ids.length) return { ok: false, error: "Nothing was uploaded." };
    after(async () => {
      for (const id of ids) await readKnowledge(admin, id);
    });
    revalidatePath(pathFor(t), "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
}

async function loadDoc(id: string) {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: d } = await admin.from("knowledge_docs").select("id, scope, agent_key, client_id, lab_source_id").eq("id", id).maybeSingle();
  if (!d) throw new Error("Not found.");
  const t: KnowledgeTarget = d.scope === "agent" ? { scope: "agent", agentKey: d.agent_key as string } : d.scope === "client" ? { scope: "client", clientId: d.client_id as string } : { scope: d.scope as "shared" | "lab" };
  if (!(await allowed(me, t))) throw new Error("You can't change this one.");
  return { admin, d, t };
}

/** Read it again (after a failure, or to pick up a better reading) */
export async function rereadKnowledge(id: string): Promise<R> {
  try {
    const { admin, t } = await loadDoc(id);
    await admin.from("knowledge_docs").update({ status: "reading", progress: 0, note: null, updated_at: new Date().toISOString() }).eq("id", id);
    after(() => readKnowledge(admin, id));
    revalidatePath(pathFor(t), "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't read it again." };
  }
}

/** Agents, every agent and the Lab: no longer read (kept on record). A client's documents are never removed: see setBackground */
export async function removeKnowledge(id: string): Promise<R> {
  try {
    const { admin, d, t } = await loadDoc(id);
    if (t.scope === "client") return { ok: false, error: "A client's documents are kept: set it as background instead." };
    await admin.from("knowledge_docs").update({ removed_at: new Date().toISOString() }).eq("id", id);
    if (d.lab_source_id) await admin.from("lab_sources").delete().eq("id", d.lab_source_id);
    forgetIndex();
    revalidatePath(pathFor(t), "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't remove it." };
  }
}

/** A client's document set aside as background (out of date, superseded): read last, and only when it matches strongly */
export async function setKnowledgeBackground(id: string, background: boolean): Promise<R> {
  try {
    const { admin, t } = await loadDoc(id);
    await admin.from("knowledge_docs").update({ background, updated_at: new Date().toISOString() }).eq("id", id);
    forgetIndex();
    revalidatePath(pathFor(t), "layout");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't change it." };
  }
}
