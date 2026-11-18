import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { siteUrl } from "@/lib/site";
import {
  detectUrgency,
  evidenceSentences,
  hasUrgencyWords,
  mergeDuplicates,
  promiseBody,
  promiseTitle,
  routeCommitment,
  type CallRow,
  type Commitment,
  type Person,
  type Seat,
} from "@/lib/promise-routing-core";

// What was promised on a call reaches the people who have to act on it, once, and says what it is. A meeting recorded
// by both Gemini and Fireflies is one meeting: its promises are merged. Creative promises get a brief written at once
// (on the head of creative's Overview, one tap to send); launch promises go on the buyer's Next for me; urgent ones are
// critical (bell, email, Slack DM). Runs after the calls are read (every 30 minutes) and is the backfill too: anything
// from the last day and a half not routed yet is routed on the next run.

type Admin = SupabaseClient;
const OPEN = ["open", "briefed"];
const MAKE = ["creative", "copy", "offer"];

type Row = {
  id: string;
  call_id: string;
  client_id: string;
  kind: string;
  what: string;
  why: string | null;
  due_at: string;
  status: string;
  suggestion_id: string | null;
  routed_at: string | null;
  client_calls: { id: string; client_id: string | null; title: string; occurred_at: string; attendees: string[] | null; host: string | null; source: string; url: string | null; notes: string | null };
  clients: { name: string; slug: string; archived_at: string | null; status: string };
};

export type RouteResult = { looked: number; merged: number; routed: number; notices: number; briefed: number; critical: number };

/** The routing step: merges duplicate meetings, then routes every commitment of the last `sinceHours` not routed yet. */
export async function routePromises(admin: Admin, opts: { sinceHours?: number; clientId?: string; briefMax?: number; budgetMs?: number } = {}): Promise<RouteResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  const since = new Date(Date.now() - (opts.sinceHours ?? 36) * 3_600_000).toISOString();
  let q = admin
    .from("call_commitments")
    .select("id, call_id, client_id, kind, what, why, due_at, status, suggestion_id, routed_at, client_calls!inner(id, client_id, title, occurred_at, attendees, host, source, url, notes), clients!inner(name, slug, archived_at, status)")
    .gte("client_calls.occurred_at", since)
    .is("clients.archived_at", null)
    .in("clients.status", LIVE)
    .in("status", OPEN)
    .limit(400);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const { data, error } = await q;
  if (error) throw new Error(`routePromises: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  const out: RouteResult = { looked: rows.length, merged: 0, routed: 0, notices: 0, briefed: 0, critical: 0 };
  if (!rows.length) return out;

  // 1. The same meeting recorded twice: one item per real action
  const calls: CallRow[] = [...new Map(rows.map((r) => [r.client_calls.id, r.client_calls])).values()].map((c) => ({ id: c.id, clientId: c.client_id, title: c.title, occurredAt: c.occurred_at, attendees: c.attendees ?? [], host: c.host, source: c.source }));
  const items: Commitment[] = rows.map((r) => ({ id: r.id, callId: r.call_id, clientId: r.client_id, kind: r.kind, what: r.what, why: r.why, dueAt: r.due_at, routed: Boolean(r.routed_at) }));
  const merges = mergeDuplicates(calls, items);
  const gone = new Set<string>();
  for (const m of merges) {
    const drop = rows.find((r) => r.id === m.drop);
    await admin.from("call_commitments").update({ what: m.what.slice(0, 600), why: m.why ? m.why.slice(0, 400) : null }).eq("id", m.keep);
    await admin.from("call_commitments").update({ status: "dismissed", merged_into: m.keep, dismiss_reason: "Same meeting recorded by two note-takers: merged into one", routed_at: drop?.routed_at ?? new Date().toISOString(), checked_at: new Date().toISOString() }).eq("id", m.drop);
    if (drop?.suggestion_id) await admin.from("creative_suggestions").update({ status: "expired" }).eq("id", drop.suggestion_id).eq("status", "open");
    const keep = rows.find((r) => r.id === m.keep);
    if (keep) {
      keep.what = m.what;
      keep.why = m.why;
    }
    gone.add(m.drop);
    out.merged++;
  }

  // 2. Route what's new
  const fresh = rows.filter((r) => !r.routed_at && !gone.has(r.id));
  if (!fresh.length) return out;
  const clientIds = [...new Set(fresh.map((r) => r.client_id))];
  const [{ data: seatRows }, { data: peopleRows }, { data: kpiRows }] = await Promise.all([
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary").in("client_id", clientIds),
    admin.from("profiles").select("id, role, is_exec, email").eq("is_active", true).not("joined_at", "is", null),
    admin.from("kpi_targets").select("client_id, owner_id").in("client_id", clientIds).eq("active", true).not("owner_id", "is", null),
  ]);
  const people: Person[] = (peopleRows ?? []).map((p) => ({ id: p.id as string, role: p.role as string, isExec: Boolean(p.is_exec), email: (p.email as string | null) ?? null }));
  const execEmails = new Set(people.filter((p) => p.isExec && p.email).map((p) => p.email!.toLowerCase()));

  // Urgent first, so a short budget never leaves the urgent ones for last
  const prepared = fresh
    .map((r) => {
      const call = r.client_calls;
      const attendees = (call.attendees ?? []).map((e) => e.toLowerCase());
      const execIn = attendees.some((e) => execEmails.has(e)) || (call.host ? execEmails.has(call.host.toLowerCase()) : false);
      const said = evidenceSentences(call.notes, r.what).some(hasUrgencyWords);
      const u = detectUrgency({ what: r.what, why: r.why, dueAt: r.due_at }, { notes: call.notes, execAsked: execIn && said });
      return { r, call, u };
    })
    .sort((a, b) => Number(b.u.urgent) - Number(a.u.urgent));

  let briefBudget = opts.briefMax ?? 3;
  const dm: { to: string; title: string; body: string; href: string }[] = [];
  for (const { r, call, u } of prepared) {
    const seats = ((seatRows ?? []) as (Seat & { client_id: string })[]).filter((s) => s.client_id === r.client_id);
    const kpiOwners = (kpiRows ?? []).filter((k) => k.client_id === r.client_id).map((k) => k.owner_id as string);
    const route = routeCommitment(r, { seats, people, kpiOwners, urgent: u.urgent, attendeeEmails: call.attendees ?? [], hostEmail: call.host });

    // Creative work becomes a brief right away (the summary path: the full brief is written when someone picks it)
    let suggestionId = r.suggestion_id;
    if (MAKE.includes(r.kind) && !suggestionId && briefBudget > 0 && Date.now() < deadline - 90_000) {
      briefBudget--;
      try {
        const { briefPromise } = await import("@/lib/calls");
        suggestionId = (await briefPromise(admin, r.id, null, true)) ?? null;
        if (suggestionId) out.briefed++;
      } catch (e) {
        console.error("[promise-routing] brief failed:", e instanceof Error ? e.message : e);
      }
    }
    const briefReady = Boolean(suggestionId);
    const title = promiseTitle({ client: r.clients.name, what: r.what, why: r.why, dueAt: r.due_at });
    const href = `/clients/${r.clients.slug}`;
    const key = `promise:n:${r.id}`;
    if (route.to.length) {
      const rowsOut = route.to.map((id) => ({
        profile_id: id,
        kind: "promise",
        title,
        body: promiseBody({ what: r.what, why: r.why, callTitle: call.title, callAt: call.occurred_at, callUrl: call.url, reasons: u.urgent ? u.reasons : undefined, briefReady: briefReady && people.find((p) => p.id === id)?.role === "head_of_creative" }),
        href,
        client_id: r.client_id,
        key,
        priority: u.urgent ? "critical" : "normal",
      }));
      const { error: e } = await admin.from("notifications").upsert(rowsOut, { onConflict: "profile_id,key", ignoreDuplicates: true });
      if (e) console.error("[promise-routing] notify failed:", e.message);
      else out.notices += rowsOut.length;
      if (u.urgent) for (const x of rowsOut) dm.push({ to: x.profile_id, title: x.title, body: x.body, href });
    }
    await admin.from("call_commitments").update({ routed_at: new Date().toISOString(), routed_to: route.to, urgent: u.urgent }).eq("id", r.id);
    out.routed++;
    if (u.urgent) out.critical++;
  }
  await slackDms(dm);
  return out;
}

/** Critical ones also reach people on Slack, when theirs is connected */
async function slackDms(dms: { to: string; title: string; body: string; href: string }[]) {
  if (!dms.length) return;
  try {
    const { slackConnection, postAsApp } = await import("@/lib/slack-user");
    const base = siteUrl();
    for (const d of dms) {
      const s = await slackConnection(d.to).catch(() => ({ connected: false as const }));
      if (s.connected && "slackUserId" in s && s.slackUserId) await postAsApp({ channel: s.slackUserId, text: `*${d.title}*\n${d.body} ${base}${d.href}` }).catch(() => undefined);
    }
  } catch (e) {
    console.error("[promise-routing] slack dm", e instanceof Error ? e.message : e);
  }
}

export type RoutedPromise = { id: string; clientId: string; client: string; clientSlug: string; title: string; what: string; why: string | null; dueAt: string; urgent: boolean; kind: string; callTitle: string };

/** Promises routed to this person that are work to do and not a brief (launches, changes, strategy): their Next for me */
export async function loadRoutedPromises(db: Admin, profileId: string): Promise<RoutedPromise[]> {
  const { data } = await db
    .from("call_commitments")
    .select("id, client_id, kind, what, why, due_at, urgent, clients!inner(name, slug, archived_at, status), client_calls!inner(title, occurred_at)")
    .contains("routed_to", [profileId])
    .eq("status", "open")
    .not("kind", "in", "(creative,copy,offer)")
    .gte("client_calls.occurred_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .order("due_at")
    .limit(20);
  return (data ?? [])
    .filter((r) => {
      const c = r.clients as unknown as { archived_at: string | null; status: string };
      return !c.archived_at && (LIVE as readonly string[]).includes(c.status);
    })
    .map((r) => {
      const c = r.clients as unknown as { name: string; slug: string };
      const call = r.client_calls as unknown as { title: string };
      return { id: r.id as string, clientId: r.client_id as string, client: c.name, clientSlug: c.slug, title: promiseTitle({ client: c.name, what: r.what as string, why: (r.why as string | null) ?? null, dueAt: r.due_at as string }), what: r.what as string, why: (r.why as string | null) ?? null, dueAt: r.due_at as string, urgent: Boolean(r.urgent), kind: r.kind as string, callTitle: call.title };
    });
}

