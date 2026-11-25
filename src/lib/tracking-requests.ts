import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askingSentence, clientFor, isTrackingRequest, sameText, SOURCE_LABEL, trackingTaskTitle } from "@/lib/tracking-requests-core";
import { createItemIfNew } from "@/lib/reality-check";
import { isWebRequest } from "@/lib/client-signals-core";

const TRACKING_WORDS = /\b(track(ing|ed)?|pixel|capi|conversions? api|gtm|tag manager|ga4|google analytics|conversions?|events? (fire|firing)|purchase event|utm)\b/i;

// Requests about a landing page, a tracking setup or a fix, said in Slack, Gmail, Asana, on a call or in Gemini meeting notes
// (read from Drive into calls: context_items source "call"), become a task for
// the Tracking Specialist on their own (agent_asks, tied to the message by source_ref so it's made once). Run hourly
// with the owed-replies step. Nobody to give it to (no Tracking Specialist yet): nothing is made.

export async function trackingRequests(admin: SupabaseClient, now = new Date()): Promise<{ made: number }> {
  const { data: who } = await admin.from("profiles").select("id").eq("is_active", true).eq("role", "tracking_specialist").limit(1);
  const owner = who?.[0]?.id as string | undefined;
  if (!owner) return { made: 0 };
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const [{ data: items }, { data: tasks }, { data: calls }] = await Promise.all([
    admin.from("context_items").select("id, client_id, source, occurred_at, author, title, body, url").in("source", ["slack_external", "slack_internal", "gmail", "call"]).gte("occurred_at", since).limit(2000),
    admin.from("asana_tasks").select("gid, name, notes, url, client_id, asana_created_at").eq("open", true).gte("asana_created_at", since).limit(500),
    admin.from("call_commitments").select("id, client_id, what, why, created_at, status").gte("created_at", since).neq("status", "dismissed").limit(500),
  ]);
  const found: { ref: string; clientId: string | null; text: string; source: string; url: string | null }[] = [];
  for (const i of items ?? []) {
    const text = `${i.title ?? ""} ${i.body ?? ""}`.trim();
    // A website or landing page ask with nothing about tracking in it is the web team's (client signals routes it)
    if (isTrackingRequest(text) && !(isWebRequest(text) && !TRACKING_WORDS.test(text))) found.push({ ref: `trk:${i.source}:${i.id}`, clientId: (i.client_id as string | null) ?? null, text: String(i.body ?? i.title ?? ""), source: String(i.source), url: (i.url as string | null) ?? null });
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
  // The same message seen in several places (an email cc'd across accounts, a thread quoted twice) is one request,
  // filed under the client it names, else under none rather than the wrong one (Nov 25 2026 safety check)
  const groups = new Map<string, typeof found>();
  for (const f of found) groups.set(sameText(f.text), [...(groups.get(sameText(f.text)) ?? []), f]);
  const ids = [...new Set(found.map((f) => f.clientId).filter((x): x is string => Boolean(x)))];
  const { data: names } = ids.length ? await admin.from("clients").select("id, name").in("id", ids) : { data: [] };
  const nameOf = new Map(((names ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const one = [...groups.values()].map((g) => {
    const cands = [...new Set(g.map((f) => f.clientId).filter((x): x is string => Boolean(x)))].map((id) => ({ id, name: nameOf.get(id) ?? "" }));
    return { ...g[0], clientId: clientFor(g[0].text, cands), refs: g.map((f) => f.ref) };
  });
  const { data: have } = await admin.from("agent_asks").select("source_ref").in("source_ref", found.map((f) => f.ref));
  const done = new Set((have ?? []).map((h) => h.source_ref as string));
  let made = 0;
  for (const f of one.slice(0, 30)) {
    if (f.refs.some((r) => done.has(r))) continue;
    // Dedupe against reality (owner, Nov 24 2026): already done or in motion anywhere, nothing new is made
    const r = await createItemIfNew(admin, {
      kind: "task",
      owner_id: owner,
      asked_by: owner,
      client_id: f.clientId,
      title: trackingTaskTitle(f.text).slice(0, 300),
      // The sentence that asks, then the message around it
      detail: `Asked in ${SOURCE_LABEL[f.source] ?? f.source}: "${askingSentence(f.text).slice(0, 300)}"\n\n${f.text.replace(/\s+/g, " ").slice(0, 500)}${f.url ? `\n${f.url}` : ""}`.slice(0, 2000),
      source_ref: f.ref,
    });
    if (r.id && r.state === "new") made++;
  }
  return { made };
}
