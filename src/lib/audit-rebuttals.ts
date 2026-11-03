import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Pushing back on an audit: a person given the permission disagrees with one finding and says why. It's kept on the
// audit, every later audit of the client reads it (so the same conclusion isn't drawn again without new evidence), and
// it goes into client memory, which every agent reads.

export type Rebuttal = { id: string; itemKey: string; finding: string; reason: string; by: string; at: string };

/** Whether this person may push back on audits (a per-person permission, set in the database) */
export async function canRebut(admin: SupabaseClient, profileId: string) {
  const { data } = await admin.from("profiles").select("can_rebut_audits").eq("id", profileId).maybeSingle();
  return Boolean(data?.can_rebut_audits);
}

/** The pushback on one audit, by finding */
export async function auditRebuttals(admin: SupabaseClient, auditId: string): Promise<Record<string, Rebuttal[]>> {
  const { data } = await admin.from("audit_rebuttals").select("id, item_key, finding, reason, created_at, profiles(full_name)").eq("audit_id", auditId).order("created_at");
  const out: Record<string, Rebuttal[]> = {};
  for (const r of data ?? [])
    (out[r.item_key as string] ??= []).push({ id: r.id as string, itemKey: r.item_key as string, finding: r.finding as string, reason: r.reason as string, by: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? "The team", at: r.created_at as string });
  return out;
}

/** What the team has pushed back on in this client's past audits, for the next audit to read */
export async function rebuttalsBlock(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("audit_rebuttals").select("audit_kind, finding, reason, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(25);
  if (!data?.length) return "";
  return `<team_pushback note="senior media buyers disagreed with these findings in earlier audits of this client, and why. Don't draw the same conclusion again unless the data has clearly changed; if you still think it holds, say what's new">
${data.map((r) => `- ${String(r.created_at).slice(0, 10)} (${r.audit_kind === "business" ? "business audit" : "account audit"}) Finding: "${String(r.finding).slice(0, 300)}". Pushback: ${String(r.reason).slice(0, 600)}`).join("\n")}
</team_pushback>`;
}

/** Save one pushback, and teach it to client memory */
export async function saveRebuttal(
  admin: SupabaseClient,
  r: { clientId: string; kind: "account" | "business"; auditId: string; itemKey: string; finding: string; reason: string; by: string },
) {
  const finding = r.finding.trim().slice(0, 600);
  const reason = r.reason.trim().slice(0, 1500);
  const { data, error } = await admin
    .from("audit_rebuttals")
    .insert({ client_id: r.clientId, audit_kind: r.kind, audit_id: r.auditId, item_key: r.itemKey, finding, reason, created_by: r.by })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await admin.from("client_memory").insert({
    client_id: r.clientId,
    kind: "note",
    source: "audit",
    created_by: r.by,
    body: `A senior buyer disagreed with an audit finding ("${finding.slice(0, 200)}"): ${reason}`.replace(/\s*—\s*/g, ", ").slice(0, 1000),
  });
  return data.id as string;
}
