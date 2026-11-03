"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A shot sent from the client's shot list: its files are already uploaded (and on their way to Drive through the
// setup guide's asset path); this marks the shot delivered, so it's never asked for again.

export async function shotSent(slug: string, listId: string, shotId: string, files: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!adminConfigured()) return { ok: false, error: "The portal isn't set up yet." };
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)))) return { ok: false, error: "Not found." };
  const { data: list } = await admin.from("shot_lists").select("id").eq("id", listId).eq("client_id", client.id).maybeSingle();
  if (!list) return { ok: false, error: "That list isn't here any more." };
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team, testing)`;
  const { markDelivered } = await import("@/lib/shot-list");
  await markDelivered(admin, listId, [{ shotId, files: files.map((f) => f.slice(0, 200)).slice(0, 12) }], by);
  revalidatePath(`/c/${slug}/shots`);
  revalidatePath(`/c/${slug}`);
  return { ok: true };
}
