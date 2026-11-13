"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { REPORT_CC_KEY } from "@/lib/reports/cc";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings → Team: the staff copied on every client report email (besides the media buyers on the account).

/** Execs: who is always copied on a report email (active staff only; the list is replaced as given) */
export async function setReportCc(ids: string[]): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Can't save here." };
  const admin = createAdminClient();
  const asked = [...new Set((Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string"))].slice(0, 50);
  const { data } = asked.length ? await admin.from("profiles").select("id").in("id", asked).eq("is_active", true) : { data: [] };
  const valid = new Set((data ?? []).map((p) => p.id as string));
  const clean = asked.filter((id) => valid.has(id));
  const { error } = await admin.from("app_settings").upsert({ key: REPORT_CC_KEY, value: { profileIds: clean }, updated_by: me.id, updated_at: new Date().toISOString() });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true, ids: clean };
}
