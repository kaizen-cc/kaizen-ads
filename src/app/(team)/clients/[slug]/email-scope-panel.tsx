import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { emailAllotments } from "@/lib/email-request";
import type { SowScope } from "@/lib/email-allotment-core";
import { EmailScopeEditor } from "./email-scope-editor";
import { SuppliesToggle } from "./supplies-toggle";

/**
 * The client page's Allotment and SOW tab (Email): this cycle's email allotment (campaigns and flows, delivered and in
 * motion), where it comes from (the SOW's month or the package), the SOW Kaizen found or someone uploaded (replace it
 * when the scope changes), and the months it scopes.
 */
export async function EmailScopePanel({ clientId }: { clientId: string }) {
  const me = await requireStaff();
  const db = await createClient();
  const from = new Date();
  from.setMonth(from.getMonth() - 2);
  const [allotments, { data: sows }, { data: months }, { data: notes }, { data: supply }] = await Promise.all([
    emailAllotments(db, [clientId]),
    db.from("client_sows").select("id, name, url, source, found_in, scope, status, note, read_at, created_at").eq("client_id", clientId).eq("line", "email").order("created_at", { ascending: false }).limit(4),
    db.from("email_scope_months").select("month, campaigns, campaigns_min, sms, sms_min, flows, flow_emails, flow_emails_min, label, notes, source, drafted_at, status, status_note").eq("client_id", clientId).gte("month", `${from.toISOString().slice(0, 7)}-01`).order("month").limit(24),
    db.from("email_scope_notes").select("note, via, created_at, profiles(full_name)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(8),
    db.from("clients").select("email_supplies_content, email_supplies_sheet").eq("id", clientId).maybeSingle(),
  ]);
  const r = (max: unknown, min: unknown) => (max == null ? "0" : min != null && Number(min) < Number(max) ? `${min}-${max}` : String(max));
  const active = (sows ?? []).find((s) => s.status !== "replaced") ?? null;
  return (
    <div className="grid gap-6">
    <SuppliesToggle clientId={clientId} on={Boolean(supply?.email_supplies_content)} sheet={(supply?.email_supplies_sheet as string | null) ?? null} canEdit={me.isExec || me.isLead || me.role === "head_of_email"} />
    <EmailScopeEditor
      clientId={clientId}
      allotment={allotments[clientId] ?? null}
      sow={
        active
          ? {
              id: active.id as string,
              name: active.name as string,
              url: (active.url as string | null) ?? null,
              source: active.source as "found" | "upload",
              foundIn: (active.found_in as string | null) ?? null,
              scope: (active.scope ?? null) as SowScope | null,
              status: active.status as string,
              note: (active.note as string | null) ?? null,
              at: active.created_at as string,
            }
          : null
      }
      replaced={(sows ?? []).filter((s) => s.status === "replaced").map((s) => ({ name: s.name as string, at: s.created_at as string }))}
      months={(months ?? []).map((m) => ({
        month: m.month as string,
        campaigns: r(m.campaigns, m.campaigns_min),
        sms: r(m.sms, m.sms_min),
        flows: String(m.flows ?? 0),
        flowEmails: r(m.flow_emails, m.flow_emails_min),
        label: (m.label as string | null) ?? null,
        notes: (m.notes as string | null) ?? null,
        source: m.source as "sow" | "manual",
        drafted: Boolean(m.drafted_at),
        status: (m.status as "active" | "unsigned" | "removed") ?? "active",
        statusNote: (m.status_note as string | null) ?? null,
      }))}
      log={(notes ?? []).map((n) => ({ note: n.note as string, via: n.via as string, at: n.created_at as string, by: (n.profiles as unknown as { full_name: string } | null)?.full_name ?? null }))}
      canEdit={seesEmailBoard(me) || me.isExec || me.isLead}
    />
    </div>
  );
}
