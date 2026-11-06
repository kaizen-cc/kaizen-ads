"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { mayRebut, saveRebuttal } from "@/lib/audit-rebuttals";
import { businessItemPlatform, platformOf, whoCanTeach } from "@/lib/rebut-permission";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Disagree with one finding of an account audit or a business audit, and say why. Allowed for the people given the
 * permission, and the head of the finding's platform (src/lib/rebut-permission.ts).
 */
export async function rebutFinding(input: { kind: "account" | "business"; auditId: string; itemKey: string; finding: string; reason: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  if (!input.reason.trim()) return { ok: false, error: "Say why you disagree." };
  // Read with the viewer's own access, so only an audit they can see
  const db = await createClient();
  const { data: a } =
    input.kind === "business"
      ? await db.from("business_audits").select("id, client_id, result").eq("id", input.auditId).maybeSingle()
      : await db.from("account_audits").select("id, client_id, kpi_targets(platform)").eq("id", input.auditId).maybeSingle();
  if (!a) return { ok: false, error: "Audit not found." };
  const platform =
    input.kind === "business"
      ? businessItemPlatform((a as { result?: Parameters<typeof businessItemPlatform>[0] }).result, input.itemKey)
      : platformOf(((a as { kpi_targets?: unknown }).kpi_targets as { platform: string } | null)?.platform);
  if (!(await mayRebut(admin, me.id, platform))) return { ok: false, error: whoCanTeach(platform).replace("can teach it this.", "can push back on this finding.") };
  try {
    await saveRebuttal(admin, { clientId: a.client_id as string, kind: input.kind, auditId: input.auditId, itemKey: input.itemKey, finding: input.finding, reason: input.reason, by: me.id, platform });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save it." };
  }
  revalidatePath(input.kind === "business" ? "/clients" : `/kpis/audit/${input.auditId}`);
  return { ok: true };
}
