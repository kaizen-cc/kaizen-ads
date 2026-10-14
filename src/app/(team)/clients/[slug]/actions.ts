"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

function done(slug: string, error?: { message: string } | null): ActionResult {
  revalidatePath(`/clients/${slug}`);
  revalidatePath("/clients");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: status, IDs and channels. RLS enforces exec-only. */
export async function saveClientDetails(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  await requireStaff();
  const kaizenId = str(form, "kaizen_id");
  const supabase = await createClient();
  const { error } = await supabase
    .from("clients")
    .update({
      status: str(form, "status") ?? "active",
      client_type: str(form, "client_type") ?? "traditional",
      website: str(form, "website"),
      meta_ad_account_id: str(form, "meta_ad_account_id")?.replace(/^act_/, "") ?? null,
      slack_channel_id: str(form, "slack_channel_id"),
      kaizen_id: kaizenId && /^\d+$/.test(kaizenId) ? Number(kaizenId) : null,
    })
    .eq("id", clientId);
  return done(slug, error);
}

export async function addContact(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_client_contact", {
    p_client: clientId,
    p_email: str(form, "email") ?? "",
    p_name: str(form, "name"),
  });
  return done(slug, error);
}

export async function removeContact(clientId: string, slug: string, contactId: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_client_contact", { p_client: clientId, p_contact: contactId });
  return done(slug, error);
}

export async function addAngle(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const name = str(form, "name");
  if (!name) return { ok: false, error: "Give the angle a name." };
  const supabase = await createClient();
  const { error } = await supabase.from("angles").insert({
    client_id: clientId,
    name,
    kind: str(form, "kind") === "avatar" ? "avatar" : "angle",
    description: str(form, "description"),
    created_by: me.id,
  });
  if (error?.code === "23505") return { ok: false, error: `"${name}" already exists for this client.` };
  return done(slug, error);
}

export async function setAngleStatus(slug: string, angleId: string, status: "active" | "archived"): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("angles").update({ status }).eq("id", angleId);
  return done(slug, error);
}

/** Execs and leads: monthly images / videos. */
export async function saveAllotment(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const n = (k: string) => Math.max(0, Math.min(999, Number(form.get(k)) || 0));
  const supabase = await createClient();
  const { error } = await supabase
    .from("client_allotments")
    .upsert({ client_id: clientId, images_per_month: n("images"), videos_per_month: n("videos"), updated_by: me.id, updated_at: new Date().toISOString() });
  return done(slug, error);
}

/** Something the team learned about this client. The AI uses it for suggestions and the request review. */
export async function addMemory(clientId: string, slug: string, form: FormData): Promise<ActionResult> {
  const me = await requireStaff();
  const body = str(form, "body");
  if (!body) return { ok: false, error: "Write what the AI should know." };
  const kind = str(form, "kind");
  const supabase = await createClient();
  const { error } = await supabase.from("client_memory").insert({
    client_id: clientId,
    kind: kind === "avoid" || kind === "prefer" ? kind : "note",
    body: body.slice(0, 1000),
    source: str(form, "source") === "client" ? "client" : "team",
    created_by: me.id,
  });
  return done(slug, error);
}

export async function archiveMemory(slug: string, memoryId: string): Promise<ActionResult> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.from("client_memory").update({ status: "archived" }).eq("id", memoryId);
  return done(slug, error);
}
