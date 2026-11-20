import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTrackingRequest, SOURCE_LABEL, trackingTaskTitle } from "@/lib/tracking-requests-core";

// Requests about a landing page, a tracking setup or a fix, said in Slack, Gmail, Asana or on a call, become a task for
// the Tracking Specialist on their own (agent_asks, tied to the message by source_ref so it's made once). Run hourly
// with the owed-replies step. Nobody to give it to (no Tracking Specialist yet): nothing is made.

export async function trackingRequests(admin: SupabaseClient, now = new Date()): Promise<{ made: number }> {
  const { data: who } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", "tracking_specialist").limit(1);
  const owner = who?.[0]?.id as string | undefined;
  if (!owner) return { made: 0 };
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const [{ data: items }, { data: tasks }, { data: calls }] = await Promise.all([
    admin.from("context_items").select("id, client_id, source, occurred_at, author, title, body, url").in("source", ["slack_external", "slack_internal", "gmail"]).gte("occurred_at", since).limit(2000),
    admin.from("asana_tasks").select("gid, name, notes, url, client_id, asana_created_at").eq("open", true).gte("asana_created_at", since).limit(500),
    admin.from("call_commitments").select("id, client_id, what, why, created_at, status").gte("created_at", since).neq("status", "dismissed").limit(500),
  ]);
  const found: { ref: string; clientId: string | null; text: string; source: string; url: string | null }[] = [];
  for (const i of items ?? []) {
    const text = `${i.title ?? ""} ${i.body ?? ""}`.trim();
    if (isTrackingRequest(text)) found.push({ ref: `trk:${i.source}:${i.id}`, clientId: (i.client_id as string | null) ?? null, text: String(i.body ?? i.title ?? ""), source: String(i.source), url: (i.url as string | null) ?? null });
  }
  for (const t of tasks ?? []) {
    const text = `${t.name ?? ""} ${t.notes ?? ""}`;
    if (isTrackingRequest(text)) found.push({ ref: `trk:asana:${t.gid}`, clientId: (t.client_id as string | null) ?? null, text: String(t.name), source: "asana", url: (t.url as string | null) ?? null });
  }
  for (const c of calls ?? []) {
    const text = `${c.what ?? ""} ${c.why ?? ""}`;
    if (isTrackingRequest(text)) found.push({ ref: `trk:call:${c.id}`, clientId: (c.client_id as string | null) ?? null, text: String(c.what), source: "call", url: null });
  }
  if (!found.length) return { made: 0 };
  const { data: have } = await admin.from("agent_asks").select("source_ref").in("source_ref", found.map((f) => f.ref));
  const done = new Set((have ?? []).map((h) => h.source_ref as string));
  let made = 0;
  for (const f of found.slice(0, 30)) {
    if (done.has(f.ref)) continue;
    const { error } = await admin.from("agent_asks").insert({
      kind: "task",
      owner_id: owner,
      asked_by: owner,
      client_id: f.clientId,
      title: trackingTaskTitle(f.text).slice(0, 300),
      detail: `Asked in ${SOURCE_LABEL[f.source] ?? f.source}: "${f.text.replace(/\s+/g, " ").slice(0, 600)}"${f.url ? `\n${f.url}` : ""}`.slice(0, 2000),
      source_ref: f.ref,
    });
    if (!error) made++;
  }
  return { made };
}
