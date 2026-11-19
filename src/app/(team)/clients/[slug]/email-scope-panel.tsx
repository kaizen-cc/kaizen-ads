import { requireStaff } from "@/lib/auth";
import { seesEmailBoard } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { emailAllotments } from "@/lib/email-request";
import type { SowScope } from "@/lib/email-allotment-core";
import { EmailScopeEditor } from "./email-scope-editor";

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
  const [allotments, { data: sows }, { data: months }] = await Promise.all([
    emailAllotments(db, [clientId]),
    db.from("client_sows").select("id, name, url, source, found_in, scope, status, note, read_at, created_at").eq("client_id", clientId).eq("line", "email").order("created_at", { ascending: false }).limit(4),
    db.from("email_scope_months").select("month, campaigns, sms, flows, flow_emails, label, notes, source, drafted_at").eq("client_id", clientId).gte("month", `${from.toISOString().slice(0, 7)}-01`).order("month").limit(24),
  ]);
  const active = (sows ?? []).find((s) => s.status !== "replaced") ?? null;
  return (
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
      months={(months ?? []).map((m) => ({ month: m.month as string, campaigns: Number(m.campaigns), sms: Number(m.sms) || 0, flows: Number(m.flows), flowEmails: Number(m.flow_emails) || 0, label: (m.label as string | null) ?? null, notes: (m.notes as string | null) ?? null, source: m.source as "sow" | "manual", drafted: Boolean(m.drafted_at) }))}
      canEdit={seesEmailBoard(me) || me.isExec || me.isLead}
    />
  );
}
