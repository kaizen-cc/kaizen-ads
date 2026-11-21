import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Handing something already on a person's plate to a teammate (from the assistant's send_to_teammate, or Delegate on
// the Overview): the new task is tied back to it, and it leaves the old owner's dashboard for good, staying with the
// new owner only. The item can be one of their own reminders or tasks (ask:<id>, its checklist goes along; ask:<id>#<n>, just that line of it), a call
// promise or brief (promise:<id>, suggestion:<id>: Next for me hides what's delegated), or anything on their day (a
// my_day key, set aside for them as delegated).

export type Handed = { ref: string; title?: string; clientId?: string | null; checklist?: { text: string; done: boolean }[]; clear: (admin: SupabaseClient, toName: string) => Promise<void> };

export async function handedItem(db: SupabaseClient, meId: string, item: string): Promise<Handed | null> {
  const key = item.trim();
  if (!key) return null;
  if (key.startsWith("ask:")) {
    const { askRefOf, cleanItems, handOverLine } = await import("@/lib/agent-call/ask-rules");
    const ref = askRefOf(key);
    if (!ref) return null;
    const id = ref.id;
    const { data } = await db.from("agent_asks").select("id, owner_id, status, checklist, detail, client_id").eq("id", id).maybeSingle();
    if (!data || data.owner_id !== meId || data.status !== "open") return null;
    const now = () => new Date().toISOString();
    const note = (toName: string, what?: string) => `${String(data.detail ?? "").trim()}\nHanded${what ? ` "${what}"` : ""} to ${toName}.`.trim().slice(0, 2000);
    const closeAsk = async (admin: SupabaseClient, extra: Record<string, unknown>) => {
      await admin.from("agent_asks").update({ status: "done", done_at: now(), ...extra }).eq("id", id).eq("owner_id", meId);
      await admin.from("notifications").update({ read_at: now() }).eq("profile_id", meId).eq("key", `agent-ask:${id}`).is("read_at", null);
    };
    // One line of a client's follow-ups (issue #99): only that line goes, the rest stay with them for someone else
    if (ref.line !== null) {
      const h = handOverLine(cleanItems(data.checklist), ref.line);
      if (!h) return null;
      return {
        ref: key,
        title: h.line.text,
        clientId: (data.client_id as string | null) ?? null,
        clear: async (admin, toName) => {
          if (h.close) return closeAsk(admin, { checklist: h.rest, detail: note(toName, h.line.text) });
          await admin.from("agent_asks").update({ checklist: h.rest, detail: note(toName, h.line.text) }).eq("id", id).eq("owner_id", meId);
        },
      };
    }
    const checklist = Array.isArray(data.checklist) && data.checklist.length ? (data.checklist as { text: string; done: boolean }[]) : undefined;
    return {
      ref: key,
      checklist,
      clientId: (data.client_id as string | null) ?? null,
      clear: (admin, toName) => closeAsk(admin, { detail: note(toName) }),
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
