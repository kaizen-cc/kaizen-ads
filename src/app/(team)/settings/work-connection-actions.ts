"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connections › Yours: the person's own Asana, as them only (never under View as).

type Result = { ok: true } | { ok: false; error: string };

/** They saw which Asana account signed in (not their Kaizen email) and want to use it anyway */
export async function confirmMyAsana(): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs || !adminConfigured()) return { ok: false, error: "Only you can do this, signed in as yourself." };
  const { confirmAsana } = await import("@/lib/asana-user");
  await confirmAsana(createAdminClient(), me.id);
  revalidatePath("/settings");
  revalidatePath("/pipeline");
  return { ok: true };
}

/** The workspaces besides Kaizen's that count for them (Kaizen's is always on) */
export async function saveMyAsanaWorkspaces(gids: string[]): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs || !adminConfigured()) return { ok: false, error: "Only you can do this, signed in as yourself." };
  const { setAsanaWorkspaces } = await import("@/lib/asana-user");
  await setAsanaWorkspaces(createAdminClient(), me.id, gids.map(String).slice(0, 50));
  revalidatePath("/settings");
  revalidatePath("/pipeline");
  return { ok: true };
}
