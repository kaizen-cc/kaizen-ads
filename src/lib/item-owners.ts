import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TodayDraft, TopicKey } from "@/lib/today";
import { stableKeyOf } from "@/lib/today-counts";
import { ladderKeyOf, ownerOf, type OwnerContext } from "@/lib/item-owners-core";

// One item, one person (rules in ./item-owners-core.ts): who owns each item on anyone's day, transfers and new due dates
// (kept in item_owners, logged in item_owner_log), and what a transfer brings to the new owner's day.

const ids = (drafts: readonly TodayDraft[], p: string) => [...new Set(drafts.filter((d) => d.key.startsWith(`${p}:`)).map((d) => d.key.slice(p.length + 1).split(":")[0]))].slice(0, 500);

export type Ownership = { owner: Map<string, string | null>; due: Map<string, string> };

/** Who owns each of these items (by stable key), and any due date someone set */
export async function ownership(admin: SupabaseClient, me: string, drafts: readonly TodayDraft[]): Promise<Ownership> {
  const stable = drafts.map((d) => stableKeyOf(d.key));
  const owedIds = [...new Set(stable.filter((k) => k.startsWith("owed:")).map((k) => k.slice(5)))];
  const saidIds = [...new Set(stable.filter((k) => k.startsWith("said:")).map((k) => k.slice(5)))];
  const clientIds = [...new Set(drafts.map((d) => d.clientId).filter((x): x is string => Boolean(x)))];
  const none = Promise.resolve({ data: [] as Record<string, unknown>[] });
  const [ov, owed, said, kpi, rep, et, dogs, seatRows, roles] = await Promise.all([
    stable.length ? admin.from("item_owners").select("key, owner_id, due_at").in("key", [...new Set(stable)].slice(0, 1000)) : none,
    owedIds.length ? admin.from("owed_replies").select("id, target_id").in("id", owedIds) : none,
    saidIds.length ? admin.from("message_promises").select("id, owner_id").in("id", saidIds) : none,
    ids(drafts, "kpi").length ? admin.from("kpi_targets").select("id, owner_id").in("id", ids(drafts, "kpi")) : none,
    ids(drafts, "report").length ? admin.from("reports").select("id, owner_id").in("id", ids(drafts, "report")) : none,
    ids(drafts, "email-ticket").length ? admin.from("email_board").select("id, assignee_id").in("id", ids(drafts, "email-ticket")) : none,
    ids(drafts, "dog").length ? admin.from("watch_flags").select("id, client_id, line").in("id", ids(drafts, "dog")) : none,
    clientIds.length ? admin.from("client_assignments").select("client_id, profile_id, role").in("client_id", clientIds.slice(0, 1000)) : none,
    admin.from("profiles").select("id, role").eq("is_active", true).in("role", ["head_of_creative", "onboarding_specialist"]),
  ]);
  const named = new Map<string, string>();
  const put = (k: string, v: unknown) => v && named.set(k, String(v));
  for (const r of owed.data ?? []) put(`owed:${r.id}`, r.target_id);
  for (const r of said.data ?? []) put(`said:${r.id}`, r.owner_id);
  for (const r of kpi.data ?? []) put(`kpi:${r.id}`, r.owner_id);
  for (const r of rep.data ?? []) put(`report:${r.id}`, r.owner_id);
  for (const r of et.data ?? []) put(`email-ticket:${r.id}`, r.assignee_id);
  const seats = new Map<string, Map<string, string>>();
  for (const s of (seatRows.data ?? []) as { client_id: string; profile_id: string; role: string }[]) {
    const m = seats.get(s.client_id) ?? new Map<string, string>();
    if (!m.has(s.role)) m.set(s.role, s.profile_id);
    seats.set(s.client_id, m);
  }
  // A watch alert: the seat on its line
  const LINE_SEAT: Record<string, string> = { "facebook-ads": "meta_buyer", "google-ads": "google_buyer", "tiktok-ads": "tiktok_buyer", "email-marketing": "email_strategist", "social-media": "social_manager" };
  for (const f of (dogs.data ?? []) as { id: string; client_id: string; line: string | null }[]) put(`dog:${f.id}`, seats.get(f.client_id)?.get(LINE_SEAT[f.line ?? ""] ?? ""));
  const roleHolder = new Map<string, string>();
  for (const r of (roles.data ?? []) as { id: string; role: string }[]) if (!roleHolder.has(r.role)) roleHolder.set(r.role, r.id);
  const overrides = new Map<string, string>();
  const due = new Map<string, string>();
  for (const r of (ov.data ?? []) as { key: string; owner_id: string; due_at: string | null }[]) {
    overrides.set(r.key, r.owner_id);
    if (r.due_at) due.set(r.key, r.due_at);
  }
  const ctx: OwnerContext = { overrides, named, seats, roleHolder };
  const owner = new Map<string, string | null>();
  for (const d of drafts) {
    const s = stableKeyOf(d.key);
    owner.set(s, ownerOf({ key: d.key, stable: s, topic: d.topic, title: d.title, clientId: d.clientId }, me, ctx));
  }
  return { owner, due };
}

/** A person's day keeps only what they own (or what nobody owns); a due date someone set replaces the item's own */
export async function ownDay(admin: SupabaseClient, me: string, drafts: TodayDraft[]): Promise<TodayDraft[]> {
  const o = await ownership(admin, me, drafts);
  return drafts
    .filter((d) => {
      const who = o.owner.get(stableKeyOf(d.key));
      return !who || who === me;
    })
    .map((d) => {
      const due = o.due.get(stableKeyOf(d.key));
      return due ? { ...d, due } : d;
    });
}

type Snap = { topic?: TopicKey; client?: string | null; clientId?: string | null; clientSlug?: string | null; title?: string; story?: string; href?: string | null };

/** What was transferred to this person and isn't on their day from their own sources: shown from its snapshot */
export async function transferredTo(admin: SupabaseClient, me: string, have: ReadonlySet<string>, topic: TopicKey = "mine"): Promise<TodayDraft[]> {
  const { data } = await admin.from("item_owners").select("key, due_at, snapshot, updated_at, updated_by, by:profiles!item_owners_updated_by_fkey(full_name)").eq("owner_id", me).limit(200);
  const out: TodayDraft[] = [];
  for (const r of (data ?? []) as unknown as { key: string; due_at: string | null; snapshot: Snap; updated_at: string; updated_by: string | null; by: { full_name: string } | null }[]) {
    if (have.has(r.key)) continue;
    const s = r.snapshot ?? {};
    if (!s.title) continue;
    const from = r.updated_by && r.updated_by !== me ? (r.by?.full_name.split(" ")[0] ?? "A teammate") : null;
    const overdue = r.due_at && Date.parse(r.due_at) < Date.now();
    out.push({
      key: r.key,
      topic,
      score: overdue ? 82 : 66,
      client: s.client ?? "Team",
      clientSlug: s.clientSlug ?? "",
      clientId: s.clientId ?? null,
      stat: r.due_at ? { value: new Date(r.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }), label: overdue ? "overdue" : "due" } : { value: "Yours", label: from ? `from ${from}` : "" },
      title: s.title,
      story: `${s.story ?? ""}${from ? `${s.story ? " · " : ""}Transferred to you by ${from}` : ""}`.trim(),
      why: from ? `${from} transferred it to you` : "Yours now",
      evidence: [],
      action: { label: "Open it", href: s.href ?? (s.clientSlug ? `/clients/${s.clientSlug}` : "/pipeline") },
      due: r.due_at,
    });
  }
  return out;
}

/** Re-starts the ladder for an item: its lead and exec items close, and it climbs again from the new owner or due date */
async function reclock(admin: SupabaseClient, stable: string) {
  await admin.from("ladder_nudges").delete().in("item_key", [...new Set([stable, ladderKeyOf(stable)])]).in("status", ["open", "sent"]);
}

/**
 * Transfers an item to a teammate: it leaves the current owner's day, shows on theirs (from its snapshot when their own
 * sources don't bring it), the ladder starts over from them, and it's logged.
 */
export async function transferItem(admin: SupabaseClient, me: { id: string; name: string }, o: { key: string; to: string; snapshot: Snap; due?: string | null; note?: string | null }): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const stable = stableKeyOf(o.key);
  const { data: to } = await admin.from("profiles").select("id, full_name, is_active").eq("id", o.to).maybeSingle();
  if (!to?.is_active) return { ok: false, error: "That teammate isn't active." };
  const { data: was } = await admin.from("item_owners").select("owner_id, due_at").eq("key", stable).maybeSingle();
  const due = o.due === undefined ? ((was?.due_at as string | null) ?? null) : o.due;
  const { error } = await admin.from("item_owners").upsert({ key: stable, owner_id: o.to, due_at: due, snapshot: o.snapshot, updated_by: me.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return { ok: false, error: "Couldn't transfer it. Try again." };
  await admin.from("item_owner_log").insert({ key: stable, from_id: (was?.owner_id as string | null) ?? me.id, to_id: o.to, due_from: (was?.due_at as string | null) ?? null, due_to: due, by_id: me.id, note: o.note ?? null });
  await reclock(admin, stable);
  if (o.to !== me.id)
    await admin.from("notifications").upsert(
      { profile_id: o.to, actor_id: me.id, kind: "handoff", title: `${me.name.split(" ")[0]} transferred to you: ${[o.snapshot.client, o.snapshot.title].filter(Boolean).join(": ")}`.slice(0, 300), body: o.note ?? null, href: o.snapshot.href ?? "/pipeline", key: `transfer:${stable}:${o.to}`.slice(0, 200), client_id: o.snapshot.clientId ?? null, priority: "normal", read_at: null },
      { onConflict: "profile_id,key" },
    );
  return { ok: true, to: String(to.full_name) };
}

/** A new due date: kept on the item, logged, and the ladder's clock counts from it */
export async function setItemDue(admin: SupabaseClient, me: { id: string }, o: { key: string; due: string | null; snapshot: Snap }): Promise<{ ok: true } | { ok: false; error: string }> {
  const stable = stableKeyOf(o.key);
  const due = o.due ? new Date(o.due.length === 10 ? `${o.due}T21:00:00Z` : o.due).toISOString() : null;
  const { data: was } = await admin.from("item_owners").select("owner_id, due_at").eq("key", stable).maybeSingle();
  const owner = (was?.owner_id as string | null) ?? me.id;
  const { error } = await admin.from("item_owners").upsert({ key: stable, owner_id: owner, due_at: due, snapshot: o.snapshot, updated_by: me.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return { ok: false, error: "Couldn't change the date. Try again." };
  await admin.from("item_owner_log").insert({ key: stable, from_id: owner, to_id: owner, due_from: (was?.due_at as string | null) ?? null, due_to: due, by_id: me.id });
  await reclock(admin, stable);
  return { ok: true };
}

/** For the ladder: transfers and due dates by the ladder's own keys */
export async function ladderOverrides(admin: SupabaseClient): Promise<Map<string, { owner: string; due: string | null; at: string }>> {
  const { data } = await admin.from("item_owners").select("key, owner_id, due_at, updated_at").limit(5000);
  return new Map(((data ?? []) as { key: string; owner_id: string; due_at: string | null; updated_at: string }[]).map((r) => [ladderKeyOf(r.key), { owner: r.owner_id, due: r.due_at, at: r.updated_at }]));
}

/**
 * The ladder's items closed by their owner (Done on their day) or by evidence (src/lib/done-check.ts): off the ladder,
 * so the lead's and the exec's linked items close with them
 */
export async function closedLadderKeys(admin: SupabaseClient, items: readonly { key: string; ownerId: string }[]): Promise<Set<string>> {
  const variants = (k: string) => (k.startsWith("ticket:") ? [k, `mine:ticket:${k.slice(7)}`] : k.startsWith("email:") ? [k, `email-ticket:${k.slice(6)}`] : [k]);
  const all = [...new Set(items.flatMap((i) => variants(i.key)))];
  const out = new Set<string>();
  for (let i = 0; i < all.length; i += 300) {
    const part = all.slice(i, i + 300);
    const [{ data: done }, { data: auto }] = await Promise.all([
      admin.from("daily_items").select("key, profile_id").in("key", part).eq("status", "done"),
      admin.from("done_checks").select("key").in("key", part).not("closed_at", "is", null).is("reopened_at", null),
    ]);
    const byOwner = new Set((done ?? []).map((d) => `${d.profile_id}|${d.key}`));
    for (const it of items) if (variants(it.key).some((v) => byOwner.has(`${it.ownerId}|${v}`))) out.add(it.key);
    const closed = new Set((auto ?? []).map((a) => a.key as string));
    for (const it of items) if (variants(it.key).some((v) => closed.has(v))) out.add(it.key);
  }
  return out;
}
