import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Closing a task or reminder asked through an assistant from the Overview or the recap (src/lib/today.ts withAsks):
// it leaves the owner's day, and a teammate who asked hears it in the app (never Slack: team work stays in the OS).

/** Done (or set aside) by its owner: closed, its bell notice read, and the teammate who asked is told */
export async function closeAsk(admin: SupabaseClient, me: { id: string; fullName: string }, id: string, how: "done" | "dismissed"): Promise<boolean> {
  const now = new Date().toISOString();
  const { data } = await admin.from("agent_asks").update({ status: how, done_at: now }).eq("id", id).eq("owner_id", me.id).eq("status", "open").select("asked_by, title, clients(slug)").maybeSingle();
  if (!data) return false;
  await admin.from("notifications").update({ read_at: now }).eq("profile_id", me.id).eq("key", `agent-ask:${id}`).is("read_at", null);
  const asker = data.asked_by as string | null;
  if (asker && asker !== me.id) {
    const slug = (data as unknown as { clients: { slug: string } | null }).clients?.slug;
    const first = me.fullName.split(" ")[0];
    await admin.from("notifications").upsert(
      {
        profile_id: asker,
        actor_id: me.id,
        kind: "agent",
        title: `${first} ${how === "done" ? "finished" : "set aside"}: ${String(data.title).slice(0, 200)}`,
        body: how === "done" ? "Marked done on their Overview." : "They set it aside as not needed. Ask them if it still matters.",
        href: slug ? `/clients/${slug}` : "/pipeline",
        key: `ask-done:${id}`,
        priority: "normal",
        read_at: null,
      },
      { onConflict: "profile_id,key" },
    );
  }
  return true;
}

/**
 * One line of a reminder's checklist closed from its group card (n from 1): Done or Dismiss closes that line (in place,
 * so the other lines keep their numbers). When nothing open is left, the reminder itself is done, as if closed whole.
 */
export async function closeAskLine(admin: SupabaseClient, me: { id: string; fullName: string }, id: string, n: number): Promise<boolean> {
  const { data } = await admin.from("agent_asks").select("checklist, status").eq("id", id).eq("owner_id", me.id).maybeSingle();
  if (!data || data.status !== "open") return false;
  const { cleanItems, tickItem } = await import("@/lib/agent-call/ask-rules");
  const items = cleanItems(data.checklist);
  if (!items[n - 1]) return false;
  const { lineClosed } = await import("@/lib/agent-asks-core");
  const r = lineClosed(tickItem(items, n - 1, true));
  if (r.close) {
    await admin.from("agent_asks").update({ checklist: r.items }).eq("id", id).eq("owner_id", me.id);
    return closeAsk(admin, me, id, "done");
  }
  await admin.from("agent_asks").update({ checklist: r.items }).eq("id", id).eq("owner_id", me.id);
  return true;
}

/** Done on the card of their own saved reminders: every one of them still open is done */
export async function closeOwnReminders(admin: SupabaseClient, me: string): Promise<void> {
  const { data } = await admin.from("agent_asks").select("id, source_ref").eq("owner_id", me).eq("asked_by", me).eq("status", "open").limit(200);
  const ids = ((data ?? []) as { id: string; source_ref: string | null }[]).filter((r) => !String(r.source_ref ?? "").startsWith("trk:")).map((r) => r.id);
  if (!ids.length) return;
  const now = new Date().toISOString();
  await admin.from("agent_asks").update({ status: "done", done_at: now }).in("id", ids).eq("owner_id", me);
  await admin.from("notifications").update({ read_at: now }).eq("profile_id", me).in("key", ids.map((i) => `agent-ask:${i}`)).is("read_at", null);
}
