"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { whoActs, type Ref } from "./who";

export type HandledResult = { ok: true; closed: boolean; message: string } | { ok: false; error: string };

/** It's handled, or here's what's missing (and which client it is). */
export async function submitHandled(ref: Ref, how: "done" | "context", text: string, clientId: string | null): Promise<HandledResult> {
  const who = await whoActs(ref);
  if (!who) return { ok: false, error: "This link has expired or isn't yours. Open it from the bell in Kaizen Ads instead." };
  if (how === "context" && !text.trim() && !clientId) return { ok: false, error: "Write what's missing, or pick the client." };
  const { resolveNotice } = await import("@/lib/notice-resolve");
  try {
    const r = await resolveNotice(createAdminClient(), { kind: who.kind, id: who.id, profileId: who.profileId, how, text, clientId, via: "t" in ref ? "email" : "app" });
    revalidatePath("/pipeline");
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save that just now." };
  }
}
