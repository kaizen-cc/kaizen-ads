"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { processIntake } from "@/lib/onboarding";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, suggestOnboarding, type OpenSuggestion } from "@/lib/suggestions";

async function lead() {
  const me = await requireStaff();
  if (!isExecOrLead(me)) throw new Error("Only execs and leads can do this.");
  return me;
}

/** Write the first round now (before the intake arrives, or again). */
export async function writeFirstRound(clientId: string): Promise<{ ok: true; suggestion: OpenSuggestion } | { ok: false; error: string }> {
  await lead();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  try {
    const id = await suggestOnboarding(createAdminClient(), clientId);
    const s = await loadSuggestion(await createClient(), id);
    revalidatePath("/pipeline");
    return s ? { ok: true, suggestion: s } : { ok: false, error: "Couldn't open it." };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The strategist couldn't write it. Try again." };
  }
}

/** An intake that didn't match a client by name: pick the client, and it's read and briefed. */
export async function matchIntake(intakeId: string, clientId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await lead();
  const supabase = await createClient();
  const { error } = await supabase.from("client_intakes").update({ client_id: clientId, status: "received" }).eq("id", intakeId).eq("status", "unmatched");
  if (error) return { ok: false, error: error.message };
  if (adminConfigured() && aiEnabled()) {
    const admin = createAdminClient();
    after(() => processIntake(admin, intakeId).then(() => revalidatePath("/pipeline")));
  }
  revalidatePath("/pipeline");
  return { ok: true };
}
