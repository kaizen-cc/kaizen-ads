"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

// Settings › Rate card: the executives add, change and remove Kaizen's starting prices (src/lib/kaizen-docs/rate-card.ts).

export async function saveRate(input: { id?: string | null; service: string; tier: string; label: string; cadence: "one_time" | "month"; amount: string; note: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only the executives change the rate card." };
  const { setRate } = await import("@/lib/kaizen-docs/rate-card");
  const r = await setRate(await createClient(), me.id, input);
  if (!r.ok) return r;
  revalidatePath("/settings");
  return { ok: true };
}

export async function removeRate(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only the executives change the rate card." };
  const { setRate } = await import("@/lib/kaizen-docs/rate-card");
  const r = await setRate(await createClient(), me.id, { id, remove: true });
  if (!r.ok) return r;
  revalidatePath("/settings");
  return { ok: true };
}
