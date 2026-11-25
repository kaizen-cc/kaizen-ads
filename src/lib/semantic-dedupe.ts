import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// Same work, different words (Nov 25 2026 safety check: "Verify Google Ads conversion tracking events" and "Confirm
// purchase and lead events fire" from two meetings; one task made for two people; a new promise repeating one already
// in motion). Run with the floating sweep: each new item and promise is read against the client's open ones by
// meaning, and a duplicate folds into the older one (its words noted there), whoever it was made for. Never a decision
// item folded into a task; never across clients.

type Admin = SupabaseClient;
type It = { ref: string; id: string; kind: "ask" | "promise"; title: string; owner: string; ownerId: string; at: string; isNew: boolean };

const SCHEMA = {
  type: "object",
  properties: { pairs: { type: "array", items: { type: "object", properties: { item: { type: "string" }, same_as: { type: "string" } }, required: ["item", "same_as"], additionalProperties: false } } },
  required: ["pairs"],
  additionalProperties: false,
};

export async function dedupeNew(admin: Admin, opts: { hours?: number; clients?: number } = {}) {
  const since = new Date(Date.now() - (opts.hours ?? 3) * 3_600_000).toISOString();
  const [{ data: newAsks }, { data: newPromises }] = await Promise.all([
    admin.from("agent_asks").select("client_id").eq("status", "open").not("client_id", "is", null).gte("created_at", since).limit(500),
    admin.from("message_promises").select("client_id").eq("status", "open").not("client_id", "is", null).gte("created_at", since).limit(500),
  ]);
  const clients = [...new Set([...(newAsks ?? []), ...(newPromises ?? [])].map((r) => r.client_id as string))].slice(0, opts.clients ?? 12);
  const { data: people } = await admin.from("profiles").select("id, full_name");
  const nameOf = new Map((people ?? []).map((p) => [p.id as string, String(p.full_name ?? "")]));
  const tally = { clients: clients.length, folded: 0 };
  for (const clientId of clients) {
    const [{ data: asks }, { data: promises }] = await Promise.all([
      admin.from("agent_asks").select("id, title, owner_id, created_at").eq("client_id", clientId).eq("status", "open").order("created_at").limit(60),
      admin.from("message_promises").select("id, what, owner_id, created_at, status").eq("client_id", clientId).in("status", ["open", "overdue", "escalated", "in_motion"]).order("created_at").limit(40),
    ]);
    const items: It[] = [
      ...(asks ?? []).map((a, i) => ({ ref: `A${i + 1}`, id: a.id as string, kind: "ask" as const, title: String(a.title), ownerId: a.owner_id as string, owner: nameOf.get(a.owner_id as string) ?? "someone", at: a.created_at as string, isNew: String(a.created_at) >= since })),
      ...(promises ?? []).map((p, i) => ({ ref: `P${i + 1}`, id: p.id as string, kind: "promise" as const, title: String(p.what ?? ""), ownerId: p.owner_id as string, owner: nameOf.get(p.owner_id as string) ?? "someone", at: p.created_at as string, isNew: String(p.created_at) >= since && p.status === "open" })),
    ];
    if (items.length < 2 || !items.some((i) => i.isNew)) continue;
    let out: { pairs: { item: string; same_as: string }[] };
    try {
      out = await askJson({
        agent: "calls",
        label: "dedupe items",
        bare: true,
        clientId,
        override: { model: "haiku", effort: "low" },
        maxTokens: 1500,
        system:
          "You find duplicate work items for one client at an agency. Two items are the same when finishing one finishes the other: the same deliverable or check in different words (\"Verify Google Ads conversion tracking events\" and \"Confirm purchase and lead events fire in Google Ads\"), or the same task made for two people. Not the same: related but separate steps (write the copy vs launch the ads), different platforms, different dates or offers. For each NEW item that duplicates another, give item (its ref) and same_as (the OLDER one's ref). Only sure pairs.",
        schema: SCHEMA,
        prompt: items.map((i) => `${i.ref}${i.isNew ? " (NEW)" : ""} [${i.at.slice(0, 10)} · ${i.owner}] ${i.title}`).join("\n"),
      });
    } catch {
      continue;
    }
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const gone = new Set<string>();
    for (const p of out.pairs ?? []) {
      const dup = byRef.get(p.item.trim().toUpperCase());
      const keep = byRef.get(p.same_as.trim().toUpperCase());
      if (!dup || !keep || dup === keep || !dup.isNew || gone.has(dup.ref) || gone.has(keep.ref) || dup.at < keep.at) continue;
      // A decision or approval never folds into someone else's task
      if (/\b(decide|approve|sign off|sign-off|pricing|fee|contract)\b/i.test(dup.title) !== /\b(decide|approve|sign off|sign-off|pricing|fee|contract)\b/i.test(keep.title)) continue;
      const note = `Same work as ${keep.owner === dup.owner ? "" : `${keep.owner}'s `}"${keep.title}"`;
      if (dup.kind === "ask") {
        await admin.from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString(), detail: `Duplicate: ${note}` }).eq("id", dup.id).eq("status", "open");
      } else {
        await admin.from("message_promises").update({ status: "in_motion", evidence: note.slice(0, 300), checked_at: new Date().toISOString() }).eq("id", dup.id);
      }
      if (keep.kind === "ask") {
        const { data: k } = await admin.from("agent_asks").select("detail").eq("id", keep.id).maybeSingle();
        const line = `Also came up${dup.owner !== keep.owner ? ` (for ${dup.owner})` : ""}: ${dup.title}`;
        if (k && !String(k.detail ?? "").includes(line)) await admin.from("agent_asks").update({ detail: `${String(k.detail ?? "").trim()}\n${line}`.trim().slice(0, 4000) }).eq("id", keep.id);
      }
      gone.add(dup.ref);
      tally.folded++;
    }
  }
  return tally;
}
