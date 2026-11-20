import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Handing something already on a person's plate to a teammate (from the assistant's send_to_teammate, or Delegate on
// the Overview): the new task is tied back to it, and it leaves the old owner's dashboard for good, staying with the
// new owner only. The item can be one of their own reminders or tasks (ask:<id>, its checklist goes along), a call
// promise or brief (promise:<id>, suggestion:<id>: Next for me hides what's delegated), or anything on their day (a
// my_day key, set aside for them as delegated).

export type Handed = { ref: string; checklist?: { text: string; done: boolean }[]; clear: (admin: SupabaseClient, toName: string) => Promise<void> };

export async function handedItem(db: SupabaseClient, meId: string, item: string): Promise<Handed | null> {
  const key = item.trim();
  if (!key) return null;
  if (key.startsWith("ask:")) {
    const id = key.slice(4);
    const { data } = await db.from("agent_asks").select("id, owner_id, status, checklist, detail").eq("id", id).maybeSingle();
    if (!data || data.owner_id !== meId || data.status !== "open") return null;
    const checklist = Array.isArray(data.checklist) && data.checklist.length ? (data.checklist as { text: string; done: boolean }[]) : undefined;
    return {
      ref: key,
      checklist,
      clear: async (admin, toName) => {
        const now = new Date().toISOString();
        await admin.from("agent_asks").update({ status: "done", done_at: now, detail: `${String(data.detail ?? "").trim()}\nHanded to ${toName}.`.trim().slice(0, 2000) }).eq("id", id).eq("owner_id", meId);
        await admin.from("notifications").update({ read_at: now }).eq("profile_id", meId).eq("key", `agent-ask:${id}`).is("read_at", null);
      },
    };
  }
  // A call promise or a brief: Next for me hides it once a delegation of it exists (src/lib/delegate-core.ts)
  if (/^(promise|suggestion):/.test(key)) return { ref: key, clear: async () => {} };
  const [{ stableKeyOf }, { markItem }] = await Promise.all([import("@/lib/today-counts"), import("@/lib/item-state")]);
  return {
    ref: `item:${stableKeyOf(key)}`.slice(0, 200),
    clear: async (_admin, toName) => {
      await markItem(db, meId, key, "dismissed", {}, { label: `Delegated to ${toName}` });
    },
  };
}
