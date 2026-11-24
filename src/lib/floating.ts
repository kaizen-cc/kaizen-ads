import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The floating-items sweep (owner, Nov 24 2026): every 30 minutes, every person's open items, every kind, so nothing
// stays open that's already done or already in motion. It's the two engines the OS already has, not a third:
// 1. The reality pass (src/lib/reality-check.ts, no model, a few batched reads): an open item whose same work is
//    already open with someone else is marked "in motion with <them>" (one owner keeps it; nobody is chased twice); one
//    whose same work was closely matched and finished after it opened (another item, the Asana mirror, the creative
//    board, a done-check close) closes with where it was done and a one-tap Reopen.
// 2. The done-check (src/lib/done-check.ts), incremental: new items, items with new messages, and items not read for
//    a few hours, read against the client's Slack, Gmail and call notes; done only on a plain, sure quote.
// Decisions, approvals and partial work never close themselves (done-check-core mayAutoClose). Unsure: left alone.

type Admin = SupabaseClient;

/** How alike an item and finished work elsewhere must be to close it on that alone (stricter than "same work") */
export const DONE_ELSEWHERE = 0.8;

export async function runFloating(admin: Admin, opts: { budget?: number } = {}) {
  const reality = await realityPass(admin).catch((e) => ({ error: String(e), inMotion: 0, closedElsewhere: 0 }));
  const { runDoneChecks } = await import("@/lib/done-check");
  const checks = await runDoneChecks(admin, { budget: opts.budget ?? 50, staleHours: 6 }).catch(() => null);
  return { ...reality, checked: checks?.checked ?? 0, closed: checks?.closed ?? 0, moving: checks?.moving ?? 0 };
}

async function realityPass(admin: Admin) {
  const { data: open } = await admin.from("agent_asks").select("id, title, detail, client_id, owner_id, created_at").eq("status", "open").not("client_id", "is", null).limit(2000);
  const items = open ?? [];
  if (!items.length) return { inMotion: 0, closedElsewhere: 0 };
  const [{ loadReality }, { decide, likeness }, { mayAutoClose }] = await Promise.all([import("@/lib/reality-check"), import("@/lib/reality-check-core"), import("@/lib/done-check-core")]);
  const found = await loadReality(admin, { clientIds: items.map((i) => i.client_id as string) });
  const { data: marked } = await admin.from("done_checks").select("key, state, closed_at, reopened_at").in("key", items.map((i) => `ask:${i.id}`).slice(0, 2000));
  const markOf = new Map((marked ?? []).map((m) => [m.key as string, m]));
  const now = new Date().toISOString();
  let inMotion = 0;
  let closedElsewhere = 0;
  for (const it of items) {
    const key = `ask:${it.id}`;
    const m = markOf.get(key);
    // Put back by someone: left as it is
    if (m?.reopened_at) continue;
    const others = found.filter((e) => !(e.source === "item" && e.id === it.id));
    const d = decide({ title: String(it.title), clientId: it.client_id as string, ownerId: it.owner_id as string }, others);
    if (d.state === "in_motion" && d.match && d.match.ownerId && d.match.ownerId !== it.owner_id) {
      // Someone else has the same work open: one owner; this one shows who's on it instead of being chased
      const quote = `In motion with ${d.match.owner ?? "a teammate"}: ${d.match.title}`.slice(0, 300);
      if (m?.state !== "moving" || !m) {
        await admin.from("done_checks").upsert({ key, kind: "ask", client_id: it.client_id, owner_id: it.owner_id, title: String(it.title).slice(0, 300), client_name: null, state: "moving", quote, source: d.match.source, link: d.match.href, said_at: null, checked_at: now, due: false }, { onConflict: "key" });
        if (!String(it.detail ?? "").includes("In motion with")) await admin.from("agent_asks").update({ detail: `${String(it.detail ?? "").trim()}\n${quote}`.trim().slice(0, 4000) }).eq("id", it.id);
        inMotion++;
      }
      continue;
    }
    // Finished elsewhere, closely matched, after this item opened: closed with where (never a decision or approval)
    if (d.state === "done" && d.match && mayAutoClose(String(it.title)) && likeness(String(it.title), d.match.title) >= DONE_ELSEWHERE && d.match.at && Date.parse(d.match.at) > Date.parse(String(it.created_at)) && ["item", "asana", "board", "done_check"].includes(d.match.source)) {
      const where = d.match.source === "asana" ? "in Asana" : d.match.source === "board" ? "on the creative board" : "on another item";
      const quote = `Done ${where}${d.match.owner ? ` by ${d.match.owner}` : ""}: ${d.match.title}`.slice(0, 300);
      await admin.from("agent_asks").update({ status: "done", done_at: now }).eq("id", it.id).eq("status", "open");
      await admin.from("done_checks").upsert({ key, kind: "ask", client_id: it.client_id, owner_id: it.owner_id, title: String(it.title).slice(0, 300), client_name: null, state: "done", quote, source: d.match.source, link: d.match.href, said_at: d.match.at, checked_at: now, closed_at: now, reopened_at: null, prev: { ask: true }, due: false }, { onConflict: "key" });
      closedElsewhere++;
    }
  }
  if (closedElsewhere) await (await import("@/lib/item-state")).reviewsChanged().catch(() => null);
  return { inMotion, closedElsewhere };
}
