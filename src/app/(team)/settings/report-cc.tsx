import { alwaysCopiedIds } from "@/lib/reports/cc";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { ReportCcCard } from "./report-cc-card";

/** Execs: the staff copied on every client report email, as a multi-select of the active team */
export async function ReportCc() {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  const [{ data: profiles }, selected] = await Promise.all([admin.from("profiles").select("id, full_name, email, role").eq("is_active", true).order("full_name"), alwaysCopiedIds(admin)]);
  const people = (profiles ?? []).filter((p) => p.email).map((p) => ({ id: p.id as string, name: (p.full_name as string | null) || (p.email as string), role: roleLabel(p.role as TeamRole) }));
  return <ReportCcCard people={people} selected={selected.filter((id) => people.some((p) => p.id === id))} />;
}
