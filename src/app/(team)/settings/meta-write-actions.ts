"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { metaWriteSetting, writeAccess } from "@/lib/meta-write";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings → Sync health: the sandbox switch for every write to Meta, and a check of write access on an account.

/** Execs: sandbox on (only Kaizen's own ad account can be written to) or off (any account the system user manages). */
export async function setMetaSandbox(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const admin = createAdminClient();
  const cur = await metaWriteSetting(admin);
  const { error } = await admin.from("app_settings").upsert({ key: "meta_write", value: { ...cur, sandbox: on }, updated_by: me.id, updated_at: new Date().toISOString() });
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Execs: can Kaizen Ads write to this ad account? A dry run with Meta; nothing is created. */
export async function checkMetaWrite(account: string): Promise<{ ok: boolean; detail: string }> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, detail: "Can't check here." };
  const id = account.replace(/^act_/, "").replace(/\D/g, "");
  if (!id) return { ok: false, detail: "Enter an ad account ID." };
  return writeAccess(createAdminClient(), id);
}
