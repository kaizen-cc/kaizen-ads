import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// What an exec does with an Escalated card, shared by the Overview's buttons and the assistant's tools: nudge the lead
// (a notice in the lead's Kaizen OS with the exec's words; the team stays in the OS, never Slack) or take it over.

/** The exec's message reaches the lead in Kaizen OS, and the cards show it was nudged */
export async function nudgeLeadAsExec(admin: SupabaseClient, me: { id: string; name: string }, o: { nudgeIds: string[]; leadId: string; text: string; client?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = o.text.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Write the message first." };
  if (!o.nudgeIds.length || !o.leadId) return { ok: false, error: "Nothing to nudge about." };
  const { data: rows } = await admin.from("ladder_nudges").select("id, lead_id, client_id").in("id", o.nudgeIds.slice(0, 200));
  const mine = (rows ?? []).filter((r) => r.lead_id === o.leadId);
  if (!mine.length) return { ok: false, error: "That isn't with this lead any more." };
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const { error } = await admin.from("notifications").upsert(
    {
      profile_id: o.leadId,
      actor_id: me.id,
      kind: "nudge",
      title: `${me.name.split(" ")[0]} asked about stuck work${o.client ? ` on ${o.client}` : ""}`.slice(0, 300),
      body: text,
      href: "/pipeline",
      key: `exec-nudge:${me.id}:${o.leadId}:${o.client ?? "team"}:${day}`.slice(0, 200),
      client_id: mine[0].client_id ?? null,
      priority: "critical",
      read_at: null,
    },
    { onConflict: "profile_id,key" },
  );
  if (error) return { ok: false, error: "Couldn't send it. Try again." };
  await admin.from("ladder_nudges").update({ exec_nudged_at: now, exec_nudged_by: me.id }).in("id", mine.map((r) => r.id as string));
  return { ok: true };
}

/** The exec takes the work over: each stuck item is transferred to them (their Needs me), its escalations close */
export async function takeEscalated(admin: SupabaseClient, meId: string, nudgeIds: string[], meName = "An exec"): Promise<{ ok: true; n: number } | { ok: false; error: string }> {
  if (!nudgeIds.length) return { ok: false, error: "Nothing to take." };
  const { data: rows } = await admin.from("ladder_nudges").select("id, item_key, client_id, client_name, what, href, client:clients(slug)").in("id", nudgeIds.slice(0, 200)).in("status", ["open", "sent"]);
  const { transferItem } = await import("@/lib/item-owners");
  let n = 0;
  for (const r of (rows ?? []) as unknown as { item_key: string; client_id: string | null; client_name: string | null; what: string; href: string | null; client: { slug: string | null } | null }[]) {
    const t = await transferItem(admin, { id: meId, name: meName }, { key: r.item_key, to: meId, snapshot: { topic: "needs", client: r.client_name, clientId: r.client_id, clientSlug: r.client?.slug ?? null, title: r.what.replace(/^./, (c) => c.toUpperCase()), story: "You took it over from Escalated", href: r.href } });
    if (t.ok) n++;
  }
  return n ? { ok: true, n } : { ok: false, error: "That isn't stuck any more." };
}
