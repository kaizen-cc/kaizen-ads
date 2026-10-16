"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { processIntake, writeFirstRoundJob } from "@/lib/onboarding";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadSuggestion, type OpenSuggestion } from "@/lib/suggestions";

async function lead() {
  const me = await requireStaff();
  if (!isExecOrLead(me)) throw new Error("Only execs and leads can do this.");
  return me;
}

/**
 * Start writing the first round (before the intake arrives, or again). It runs in the background as a tracked job;
 * the card shows its progress and opens the brief when it's ready. Execs, leads, and the client's own team.
 */
export async function writeFirstRound(clientId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireStaff();
  const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "You don't work on this client." };
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  // Shown as writing from now on, even before the background work picks up
  await admin.from("clients").update({ first_round_started_at: new Date().toISOString(), first_round_error: null }).eq("id", clientId);
  after(() => writeFirstRoundJob(admin, clientId).then(() => revalidatePath("/pipeline")));
  revalidatePath("/pipeline");
  return { ok: true };
}

/** The first round, once it's written, to open from the card. */
export async function openFirstRound(id: string): Promise<OpenSuggestion | null> {
  await requireStaff();
  return loadSuggestion(await createClient(), id);
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
