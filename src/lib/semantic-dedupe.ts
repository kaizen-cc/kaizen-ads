import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// Same work, different words (Nov 25 2026 safety check: "Verify Google Ads conversion tracking events" and "Confirm
// purchase and lead events fire" from two meetings; one task made for two people; a new promise repeating one already
// in motion). Run with the floating sweep: each new item and promise is read against the client's open ones by
// meaning, and a duplicate folds into the older one (its words noted there), whoever it was made for. Never a decision
// item folded into a task; never across clients.

type Admin = SupabaseClient;
type It = { ref: string; id: string; kind: "ask" | "promise" | "asana"; done?: boolean; url?: string | null; title: string; owner: string; ownerId: string; at: string; isNew: boolean };

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
    const [{ data: asks }, { data: promises }, { data: asanaRows }] = await Promise.all([
      admin.from("agent_asks").select("id, title, owner_id, created_at").eq("client_id", clientId).eq("status", "open").order("created_at").limit(60),
      admin.from("message_promises").select("id, what, owner_id, created_at, status").eq("client_id", clientId).in("status", ["open", "overdue", "escalated", "in_motion"]).order("created_at").limit(40),
      // The people's own Asana tasks for this client (open, or done in the last three days): an exec's own runs make some
      admin.from("asana_person_tasks").select("gid, name, profile_id, completed, completed_at, url, asana_created_at").eq("client_id", clientId).limit(60),
    ]);
    const items: It[] = [
      ...(asks ?? []).map((a, i) => ({ ref: `A${i + 1}`, id: a.id as string, kind: "ask" as const, title: String(a.title), ownerId: a.owner_id as string, owner: nameOf.get(a.owner_id as string) ?? "someone", at: a.created_at as string, isNew: String(a.created_at) >= since })),
      ...(asanaRows ?? []).map((t, i) => ({ ref: `S${i + 1}`, id: t.gid as string, kind: "asana" as const, done: Boolean(t.completed), url: (t.url as string | null) ?? null, title: String(t.name).replace(/^\[[^\]]{1,24}\]\s*/, ""), ownerId: t.profile_id as string, owner: nameOf.get(t.profile_id as string) ?? "someone", at: String(t.asana_created_at ?? ""), isNew: false })),
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
          "You find duplicate work items for one client at an agency. Two items are the same when finishing one finishes the other (replying to someone about a piece of work is not the work itself): the same deliverable or check in different words (\"Verify Google Ads conversion tracking events\" and \"Confirm purchase and lead events fire in Google Ads\"), or the same task made for two people. Not the same: related but separate steps (write the copy vs launch the ads), different platforms, different dates or offers. For each NEW item that duplicates another, give item (its ref) and same_as (the OLDER one's ref). Only sure pairs.",
        schema: SCHEMA,
        prompt: items.map((i) => `${i.ref}${i.isNew ? " (NEW)" : ""}${i.kind === "asana" ? ` (Asana${i.done ? ", done" : ""})` : ""} [${i.at.slice(0, 10)} · ${i.owner}] ${i.title}`).join("\n"),
      });
    } catch {
      continue;
    }
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const gone = new Set<string>();
    for (const p of out.pairs ?? []) {
      const dup = byRef.get(p.item.trim().toUpperCase());
      const keep = byRef.get(p.same_as.trim().toUpperCase());
      // An Asana task always keeps the work (it may be newer: both run side by side)
      if (!dup || !keep || dup === keep || !dup.isNew || dup.kind === "asana" || gone.has(dup.ref) || gone.has(keep.ref) || (keep.kind !== "asana" && dup.at < keep.at)) continue;
      // Someone's own Asana task only stands for their own items (Nov 25 2026: an exec's "Send the recap" swallowed a
      // teammate's "Fix tracking"); and answering or confirming about the work isn't the work ("Answer Leann: add the
      // Glacé ad" closed the ads task itself)
      if (keep.kind === "asana" && keep.ownerId !== dup.ownerId) continue;
      const talk = /^(answer|reply|respond|tell|let\s+\w+\s+know|confirm with|follow up|update)\b/i;
      if (talk.test(keep.title) !== talk.test(dup.title)) continue;
      // A decision or approval never folds into someone else's task
      if (/\b(decide|approve|sign off|sign-off|pricing|fee|contract)\b/i.test(dup.title) !== /\b(decide|approve|sign off|sign-off|pricing|fee|contract)\b/i.test(keep.title)) continue;
      const note = keep.kind === "asana" ? `${keep.done ? "Done" : "Already"} in Asana${keep.owner === dup.owner ? "" : ` (${keep.owner})`}: "${keep.title}"${keep.url ? ` ${keep.url}` : ""}` : `Same work as ${keep.owner === dup.owner ? "" : `${keep.owner}'s `}"${keep.title}"`;
      if (dup.kind === "ask") {
        // Its own words kept (the note goes on top)
        const { data: d } = await admin.from("agent_asks").select("detail").eq("id", dup.id).maybeSingle();
        await admin.from("agent_asks").update({ status: keep.kind === "asana" && keep.done ? "done" : "dismissed", done_at: new Date().toISOString(), detail: `Duplicate: ${note}
${String(d?.detail ?? "").trim()}`.trim().slice(0, 4000) }).eq("id", dup.id).eq("status", "open");
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

const CLUSTERS = {
  type: "object",
  properties: { groups: { type: "array", items: { type: "object", properties: { refs: { type: "array", items: { type: "string" } }, deliverable: { type: "string" } }, required: ["refs", "deliverable"], additionalProperties: false } } },
  required: ["groups"],
  additionalProperties: false,
};

/**
 * Every open item on a client, grouped by deliverable (owner, Nov 27 2026: seven open items across three people for
 * one Goodmellow ad fix). In each group: one keeper per owner (their oldest; an owner's own Asana task stands for
 * theirs), the rest closed as "Duplicate of …" with their words copied onto the keeper; keepers of different owners
 * say "Also on this: X". The busiest clients first, a batch per run.
 */
export async function mergeAllOpen(admin: Admin, opts: { clients?: number; only?: string[] } = {}) {
  const { data: rows } = await admin.from("agent_asks").select("client_id").eq("status", "open").not("client_id", "is", null).limit(5000);
  const count = new Map<string, number>();
  for (const r of rows ?? []) count.set(r.client_id as string, (count.get(r.client_id as string) ?? 0) + 1);
  const { data: state } = await admin.from("sync_state").select("cursor_at, last_result").eq("source", "dedupe_all").maybeSingle();
  const done = new Set<string>(((state?.last_result as { done?: string[] } | null)?.done ?? []).slice(-400));
  const order = (opts.only ?? [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([c]) => c)).filter((c) => opts.only || !done.has(c));
  const batch = order.slice(0, opts.clients ?? 10);
  const { data: people } = await admin.from("profiles").select("id, full_name");
  const nameOf = new Map((people ?? []).map((p) => [p.id as string, String(p.full_name ?? "")]));
  const tally = { clients: 0, groups: 0, closed: 0 };
  for (const clientId of batch) {
    const [{ data: asks }, { data: asana }] = await Promise.all([
      admin.from("agent_asks").select("id, title, detail, owner_id, created_at").eq("client_id", clientId).eq("status", "open").order("created_at").limit(80),
      admin.from("asana_person_tasks").select("gid, name, profile_id, completed, url").eq("client_id", clientId).eq("completed", false).limit(40),
    ]);
    const items = [
      ...(asks ?? []).map((a, i) => ({ ref: `A${i + 1}`, kind: "ask" as const, id: a.id as string, title: String(a.title).replace(/^\[[^\]]{1,24}\]\s*/, ""), detail: String(a.detail ?? ""), owner: a.owner_id as string, at: a.created_at as string })),
      ...(asana ?? []).map((t, i) => ({ ref: `S${i + 1}`, kind: "asana" as const, id: t.gid as string, title: String(t.name).replace(/^\[[^\]]{1,24}\]\s*/, ""), detail: "", owner: t.profile_id as string, at: "", url: (t.url as string | null) ?? null })),
    ];
    tally.clients++;
    if ((asks ?? []).length < 2) continue;
    let out: { groups: { refs: string[]; deliverable: string }[] };
    try {
      out = await askJson({
        agent: "calls",
        label: "dedupe items",
        bare: true,
        clientId,
        override: { model: "haiku", effort: "low" },
        maxTokens: 2500,
        system:
          "Group a client's open work items that are the same deliverable: finishing one finishes the others, in any words (\"Update Fade ads to 5 for $60\", \"Hold the Fade ads showing 4 for $60\", \"Flag ads still showing 4 for $60\" are one fix). Not the same: separate steps (write copy vs launch), different platforms, offers or dates, and replying to someone about the work vs doing it. Only groups of two or more, only sure ones.",
        schema: CLUSTERS,
        prompt: items.map((i) => `${i.ref}${i.kind === "asana" ? " (Asana)" : ""} [${nameOf.get(i.owner) ?? "someone"}] ${i.title}`).join("\n"),
      });
    } catch {
      continue;
    }
    const byRef = new Map(items.map((i) => [i.ref, i]));
    for (const g of out.groups ?? []) {
      const members = [...new Set(g.refs.map((r) => r.trim().toUpperCase()))].map((r) => byRef.get(r)).filter((x): x is (typeof items)[number] => Boolean(x));
      if (members.length < 2) continue;
      tally.groups++;
      const owners = [...new Set(members.map((m) => m.owner))];
      const keeperOf = new Map<string, (typeof items)[number]>();
      for (const o of owners) {
        const mine = members.filter((m) => m.owner === o);
        keeperOf.set(o, mine.find((m) => m.kind === "asana") ?? mine.filter((m) => m.kind === "ask").sort((a, b) => a.at.localeCompare(b.at))[0]);
      }
      for (const m of members) {
        const keeper = keeperOf.get(m.owner)!;
        if (m === keeper || m.kind !== "ask") continue;
        const into = keeper.kind === "asana" ? `their Asana task "${keeper.title}"` : `"${keeper.title}"`;
        await admin.from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString(), detail: `Duplicate of ${into}\n${m.detail}`.trim().slice(0, 4000) }).eq("id", m.id).eq("status", "open");
        if (keeper.kind === "ask") {
          const { data: k } = await admin.from("agent_asks").select("detail").eq("id", keeper.id).maybeSingle();
          const line = `Also came up: ${m.title}${m.detail ? ` (${m.detail.split("\n")[0].slice(0, 200)})` : ""}`;
          if (k && !String(k.detail ?? "").includes(line)) await admin.from("agent_asks").update({ detail: `${String(k.detail ?? "").trim()}\n${line}`.trim().slice(0, 4000) }).eq("id", keeper.id);
        }
        tally.closed++;
      }
      // Several owners on one deliverable: each keeper names the others
      if (owners.length > 1)
        for (const o of owners) {
          const k = keeperOf.get(o)!;
          if (k.kind !== "ask") continue;
          const others = owners.filter((x) => x !== o).map((x) => nameOf.get(x) ?? "someone").join(", ");
          const { data: cur } = await admin.from("agent_asks").select("detail").eq("id", k.id).maybeSingle();
          const line = `Also on this: ${others}`;
          if (cur && !String(cur.detail ?? "").includes(line)) await admin.from("agent_asks").update({ detail: `${String(cur.detail ?? "").trim()}\n${line}`.trim().slice(0, 4000) }).eq("id", k.id);
        }
    }
  }
  if (!opts.only) {
    const left = order.length - batch.length;
    await admin.from("sync_state").upsert({ source: "dedupe_all", last_run_at: new Date().toISOString(), last_result: { done: left > 0 ? [...done, ...batch] : [], ...tally } });
  }
  return tally;
}
