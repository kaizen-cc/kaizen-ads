"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// The request form's database copy (src/lib/brief-drafts.ts): saved as it's typed, picked up anywhere, gone once sent

export async function saveBriefDraftAction(d: { id: string | null; context: string | null; clientId: string | null; title: string | null; step: number; payload: Record<string, unknown> }): Promise<string | null> {
  const me = await requireStaff();
  if (me.viewAs) return null; // Viewing as someone: nothing is written
  const { saveBriefDraft } = await import("@/lib/brief-drafts");
  return saveBriefDraft(await createClient(), me.id, d).catch(() => null);
}

export async function deleteBriefDraftAction(id: string) {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false as const };
  const { deleteBriefDraft } = await import("@/lib/brief-drafts");
  await deleteBriefDraft(await createClient(), id);
  revalidatePath("/requests/new");
  revalidatePath("/pipeline");
  return { ok: true as const };
}
