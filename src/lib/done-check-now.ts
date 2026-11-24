import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inScope, NOW_CAP, pickForNow, summarize, type NowItem, type NowResult, type Scope } from "@/lib/done-check-now-core";

// The done-check on demand (owner, Nov 24 2026): the asker's open items (or a named client or item, or for an exec or a
// lead their team's) checked right now, the same way the scheduled sweeps do it, and closed the same way:
// - the general done-check items (tracking, watchdog flags, asks between people, Asana tasks, onboarding blockers):
//   their client's Slack (ours and theirs), Gmail and call/Gemini notes since each opened (src/lib/done-check.ts)
// - messages waiting on their reply: the Slack thread (or DM, read with their own Slack) or the email (owed-replies)
// - things they said yes to in Slack or email: the follow-up read (message-promises recheckPromise)
// Same precision guardrails (done-check-core); every close writes through and the Overview counts update.

type Admin = SupabaseClient;
type Me = { id: string; role: string; isExec: boolean; isLead: boolean };

export async function checkNow(admin: Admin, me: Me, o: { scope?: Scope; client?: string | null; about?: string | null; cap?: number } = {}) {
  const scope: Scope = o.scope === "team" && (me.isExec || me.isLead || me.role.startsWith("head_of_")) ? "team" : "mine";
  const [{ openCheckables, runDoneChecks }, { LEAD_OF, recheckOwed }, { recheckPromise }] = await Promise.all([import("@/lib/done-check"), import("@/lib/owed-replies"), import("@/lib/message-promises")]);
  const { data: people } = await admin.from("profiles").select("id, role").eq("is_active", true);
  const roleOf = new Map((people ?? []).map((p) => [p.id as string, p.role as string]));
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const [checkables, { data: owed }, { data: said }] = await Promise.all([
    openCheckables(admin).catch(() => []),
    admin.from("owed_replies").select("id, target_id, from_name, gist, asked_at, clients(name)").in("status", ["watching", "nudged", "escalated"]).gte("asked_at", cutoff).limit(500),
    admin.from("message_promises").select("id, owner_id, what, said_at, clients(name)").in("status", ["open", "overdue", "escalated"]).limit(500),
  ]);
  const opts = { scope, client: o.client ?? null, about: o.about ?? null, leadOf: LEAD_OF };
  const items: NowItem[] = [
    ...checkables.map((c) => ({ key: c.key, kind: c.kind, ownerId: c.ownerId, ownerRole: c.ownerId ? (roleOf.get(c.ownerId) ?? null) : null, client: c.client, title: c.title, since: c.since })),
    ...(owed ?? []).map((r) => ({ key: `owed:${r.id}`, kind: "owed", ownerId: r.target_id as string, ownerRole: roleOf.get(r.target_id as string) ?? null, client: (r.clients as unknown as { name: string } | null)?.name ?? "Team", title: `Reply to ${r.from_name}: ${r.gist ?? ""}`.trim(), since: r.asked_at as string })),
    ...(said ?? []).map((r) => ({ key: `said:${r.id}`, kind: "said", ownerId: r.owner_id as string, ownerRole: roleOf.get(r.owner_id as string) ?? null, client: (r.clients as unknown as { name: string } | null)?.name ?? "Team", title: `You said you'd ${r.what}`, since: r.said_at as string })),
  ].filter((i) => inScope(i, me, opts));
  const { now, later } = pickForNow(items, Math.min(o.cap ?? NOW_CAP, 30));
  if (!now.length) return { ...summarize([], 0), note: o.client || o.about ? "Nothing open of theirs matches that." : "Nothing of theirs is open to check." };

  const general = now.filter((i) => i.kind !== "owed" && i.kind !== "said");
  const byKey = new Map(now.map((i) => [i.key, i]));
  // All three at once; the general ones are read four at a time inside runDoneChecks
  const [sweep, owedRes, saidRes] = await Promise.all([
    general.length ? runDoneChecks(admin, { onlyKeys: general.map((i) => i.key), force: true, budget: general.length }).catch(() => null) : null,
    mapLimit(now.filter((i) => i.kind === "owed"), 4, async (i) => ({ i, r: await recheckOwed(admin, i.key.slice(5)).catch(() => null) })),
    mapLimit(now.filter((i) => i.kind === "said"), 4, async (i) => ({ i, r: await recheckPromise(admin, i.key.slice(5)).catch(() => null) })),
  ]);
  const results: NowResult[] = [...(sweep?.results ?? [])];
  for (const { i, r } of owedRes) if (r && r.state !== "unknown") results.push({ key: i.key, kind: i.kind, client: i.client, title: i.title, state: r.state === "done" || r.state === "closed" ? "done" : "nothing", quote: r.evidence, source: "thread", link: r.link, at: null });
  for (const { i, r } of saidRes) if (r && r.state !== "unknown") results.push({ key: i.key, kind: i.kind, client: i.client, title: i.title, state: r.state === "closed" ? "done" : r.state, quote: r.evidence, source: "thread", link: null, at: null });
  // Anything the sweep skipped: closed by an earlier pass reads as done, otherwise nothing found
  const skipped = general.filter((g) => !results.some((r) => r.key === g.key));
  const closedBefore = skipped.length ? await (await import("@/lib/done-check")).closedKeys(admin, skipped.map((g) => g.key)) : new Set<string>();
  for (const g of skipped) results.push({ key: g.key, kind: g.kind, client: g.client, title: g.title, state: closedBefore.has(g.key) ? "done" : "nothing", quote: closedBefore.has(g.key) ? "Closed by an earlier check" : "", source: null, link: null, at: null });
  if (results.some((r) => r.state === "done")) await (await import("@/lib/item-state")).reviewsChanged().catch(() => null);
  return summarize(results.filter((r) => byKey.has(r.key)), later);
}

/** Puts something closed by a check back: the item comes back for everyone (and its source, where it was written to) */
export async function reopenChecked(admin: Admin, key: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  if (key.startsWith("owed:")) {
    const { error } = await admin.from("owed_replies").update({ status: "nudged", answered_at: null, checked_at: now }).eq("id", key.slice(5)).eq("status", "answered");
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  if (key.startsWith("said:")) {
    const { error } = await admin.from("message_promises").update({ status: "overdue", closed_at: null, evidence: null, checked_at: now }).eq("id", key.slice(5)).in("status", ["done", "in_motion"]);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  const { reopen } = await import("@/lib/done-check");
  return reopen(admin, key, by);
}

async function mapLimit<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...(await Promise.all(xs.slice(i, i + n).map(fn))));
  return out;
}
