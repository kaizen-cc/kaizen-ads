"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canAccessReport } from "@/lib/reports/access";
import { lineOfPlatform } from "@/lib/reports/style-core";

// A client's report style from the report page: undo the last change (the version before is used again) or forget one
// rule. Only someone who may work on this report (its buyer, the leads of its line, an exec).

type Result = { ok: true; note: string } | { ok: false; error: string };

async function reportOf(id: string) {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: r } = await admin.from("reports").select("id, owner_id, client_id, platform, kpi_targets(id, client_id, platform, owner_id)").eq("id", id).maybeSingle();
  if (!r || !(await canAccessReport(await createClient(), me, r as unknown as { owner_id: string | null; client_id: string; platform: string; kpi_targets: unknown }))) return null;
  return { me, admin, r: r as unknown as { id: string; client_id: string; platform: string } };
}

export async function undoReportStyle(reportId: string): Promise<Result> {
  const got = await reportOf(reportId);
  if (!got) return { ok: false, error: "Not found." };
  const { undoStyle } = await import("@/lib/reports/style");
  const out = await undoStyle(got.admin, got.r.client_id, lineOfPlatform(got.r.platform), { id: got.me.id, name: got.me.fullName });
  if (out.undone == null) return { ok: false, error: "Nothing to undo." };
  revalidatePath(`/reports/${reportId}`);
  return { ok: true, note: out.now ? `Back to version ${out.now.version}. The next report is drafted with it.` : "Back to no style. The next report is drafted the standard way." };
}

export async function forgetStyleRule(reportId: string, rule: string): Promise<Result> {
  const got = await reportOf(reportId);
  if (!got) return { ok: false, error: "Not found." };
  const { teachStyle } = await import("@/lib/reports/style");
  const out = await teachStyle(got.admin, { clientId: got.r.client_id, line: lineOfPlatform(got.r.platform), remove: [String(rule).slice(0, 300)], source: "studio_ask", by: { id: got.me.id, name: got.me.fullName }, reportId });
  if (!out.changed) return { ok: false, error: "That rule isn't in the style any more." };
  revalidatePath(`/reports/${reportId}`);
  return { ok: true, note: "Forgotten. Undo brings it back." };
}
