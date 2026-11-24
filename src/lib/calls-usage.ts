import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUDIO_BUCKET } from "@/lib/agent-call/safety";
import type { SafetyMoment } from "@/lib/assistant/core";
import { costOf, type Usage } from "@/lib/ai-costs";
import { createAdminClient } from "@/lib/supabase/admin";
import { projectMonth, teamOf, type LogEntry, type TeamKey, type UsagePerson } from "@/lib/calls-usage-core";

// Settings › Calls & usage: every assistant and agent call and chat (flagged by the safety review first), and who
// uses the agents most and what it costs. The owner only (profiles.can_view_as, never while viewing as someone):
// ownerOnly() is checked on the server before anything here is read, and the reads use the server's rights because
// the calls, the safety reviews and the AI runs are everyone's. Retention isn't changed here: an unflagged call's
// audio is deleted after its review, a flagged call's about 90 days later, so a normal call shows its transcript only.

export type OwnerWho = { canViewAs?: boolean | null; viewAs?: unknown };
export const ownerOnly = (me: OwnerWho) => Boolean(me.canViewAs) && !me.viewAs;

const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const UUID = /^[0-9a-f-]{36}$/i;
const roleName = (k: string | null | undefined) => (k === "assistant" ? "Assistant" : String(k ?? "agent").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

type Person = { id: string; full_name: string | null; role: string | null; is_exec: boolean | null; is_active: boolean | null };
async function people(admin: SupabaseClient): Promise<Map<string, Person>> {
  const { data } = await admin.from("profiles").select("id, full_name, role, is_exec, is_active").limit(1000);
  return new Map(((data ?? []) as Person[]).map((p) => [p.id, p]));
}

export type LogFilters = { team: string | null; person: string | null; from: string; to: string; flag: "flagged" | "normal" | null; q: string };
export type CallLogEntry = LogEntry & {
  person: string;
  personId: string | null;
  seconds: number;
  mode: "voice" | "text" | "kaizen_ai";
  agents: string[];
  clients: string[];
  topic: string | null;
  severity: string | null;
  reason: string | null;
  categories: string[];
  messages: number | null;
  href: string;
};

/** Every call and chat in the range that passes the filters, flagged or not, with who, how long, which agents and clients */
export async function loadCallLog(f: LogFilters): Promise<{ entries: CallLogEntry[]; people: { id: string; name: string; team: TeamKey }[]; capped: boolean }> {
  const admin = createAdminClient();
  const from = `${f.from}T00:00:00-05:00`;
  const to = `${f.to}T23:59:59-05:00`;
  const staff = await people(admin);
  // A search reads the transcripts: the calls and Kaizen AI chats where it was said
  const q = f.q.replace(/[%_,()]/g, " ").trim().slice(0, 80);
  const [callHits, threadHits] = q
    ? await Promise.all([
        admin.from("ai_role_chats").select("call_id").not("call_id", "is", null).gte("created_at", from).lte("created_at", to).ilike("content", `%${q}%`).limit(2000),
        admin.from("ai_messages").select("thread_id").gte("created_at", from).lte("created_at", to).ilike("content", `%${q}%`).limit(2000),
      ]).then(([a, b]) => [new Set((a.data ?? []).map((r) => String(r.call_id))), new Set((b.data ?? []).map((r) => String(r.thread_id)))])
    : [null, null];
  let callsQ = admin.from("ai_role_calls").select("id, profile_id, role_key, guest_roles, mode, started_at, ended_at, last_turn_at, topic, summary, notes").gte("started_at", from).lte("started_at", to).order("started_at", { ascending: false }).limit(800);
  if (f.person && UUID.test(f.person)) callsQ = callsQ.eq("profile_id", f.person);
  if (callHits) callsQ = callsQ.in("id", [...callHits].slice(0, 500));
  const [{ data: calls }, counts] = await Promise.all([
    callHits && !callHits.size ? Promise.resolve({ data: [] }) : callsQ,
    admin.rpc("owner_thread_counts" as never, { p_from: from, p_to: to } as never).then((r) => (r.data ?? []) as { thread_id: string; profile_id: string; user_messages: number; messages: number; first_at: string; last_at: string }[]),
  ]);
  const callRows = (calls ?? []) as { id: string; profile_id: string | null; role_key: string; guest_roles: string[] | null; mode: string | null; started_at: string; ended_at: string | null; last_turn_at: string | null; topic: string | null; summary: string | null; notes: { agents?: { label?: string }[] } | null }[];
  const ids = callRows.map((c) => c.id);
  const [reviews, mentions] = ids.length
    ? await Promise.all([
        admin.from("call_safety_reviews").select("call_id, flagged, severity, summary, categories").in("call_id", ids).then((r) => r.data ?? []),
        admin.from("call_mentions").select("call_id, clients(name)").in("call_id", ids).then((r) => r.data ?? []),
      ])
    : [[], []];
  const reviewOf = new Map((reviews as { call_id: string; flagged: boolean; severity: string | null; summary: string | null; categories: string[] | null }[]).map((r) => [r.call_id, r]));
  const clientsOf = new Map<string, string[]>();
  for (const m of mentions as unknown as { call_id: string; clients: { name: string } | null }[]) if (m.clients?.name) clientsOf.set(m.call_id, [...(clientsOf.get(m.call_id) ?? []), m.clients.name]);
  const entries: CallLogEntry[] = [];
  for (const c of callRows) {
    const p = c.profile_id ? staff.get(c.profile_id) : undefined;
    const r = reviewOf.get(c.id);
    const end = c.ended_at ?? c.last_turn_at ?? c.started_at;
    const agents = [...new Set([roleName(c.role_key), ...(c.guest_roles ?? []).map(roleName), ...(c.notes?.agents ?? []).map((a) => a.label ?? "").filter(Boolean)])];
    entries.push({
      id: c.id,
      kind: "call",
      team: teamOf(p?.role, p?.is_exec),
      flagged: Boolean(r?.flagged),
      at: c.started_at,
      person: p?.full_name ?? "Someone",
      personId: c.profile_id,
      seconds: Math.max(0, (Date.parse(end) - Date.parse(c.started_at)) / 1000),
      mode: c.mode === "text" ? "text" : "voice",
      agents,
      clients: [...new Set(clientsOf.get(c.id) ?? [])],
      topic: c.topic ?? (c.summary ? c.summary.slice(0, 140) : null),
      severity: r?.flagged ? r.severity : null,
      reason: r?.flagged ? r.summary : null,
      categories: r?.flagged ? (r.categories ?? []) : [],
      messages: null,
      href: `/settings?tab=calls&call=${c.id}`,
    });
  }
  // Kaizen AI chats with messages in the range
  let threadCounts = counts;
  if (f.person && UUID.test(f.person)) threadCounts = threadCounts.filter((t) => t.profile_id === f.person);
  if (threadHits) threadCounts = threadCounts.filter((t) => threadHits.has(t.thread_id));
  const tIds = threadCounts.map((t) => t.thread_id).slice(0, 600);
  if (tIds.length) {
    const { data: threads } = await admin.from("ai_threads").select("id, title, agent_key, clients(name)").in("id", tIds);
    const byId = new Map(((threads ?? []) as unknown as { id: string; title: string | null; agent_key: string | null; clients: { name: string } | null }[]).map((t) => [t.id, t]));
    for (const t of threadCounts) {
      const th = byId.get(t.thread_id);
      if (!th) continue;
      const p = staff.get(t.profile_id);
      entries.push({
        id: t.thread_id,
        kind: "chat",
        team: teamOf(p?.role, p?.is_exec),
        flagged: false,
        at: t.last_at,
        person: p?.full_name ?? "Someone",
        personId: t.profile_id,
        seconds: Math.max(0, (Date.parse(t.last_at) - Date.parse(t.first_at)) / 1000),
        mode: "kaizen_ai",
        agents: [th.agent_key ? `Kaizen AI · ${roleName(th.agent_key)}` : "Kaizen AI"],
        clients: th.clients?.name ? [th.clients.name] : [],
        topic: th.title,
        severity: null,
        reason: null,
        categories: [],
        messages: Number(t.messages) || 0,
        href: `/settings?tab=calls&thread=${t.thread_id}`,
      });
    }
  }
  const filtered = entries.filter((e) => (!f.team || e.team === f.team) && (!f.flag || (f.flag === "flagged") === e.flagged));
  const seen = [...new Set(entries.map((e) => e.personId).filter((x): x is string => Boolean(x)))];
  const list = [...staff.values()].filter((p) => p.is_active || seen.includes(p.id)).map((p) => ({ id: p.id, name: p.full_name ?? "Someone", team: teamOf(p.role, p.is_exec) })).sort((a, b) => a.name.localeCompare(b.name));
  return { entries: filtered, people: list, capped: callRows.length >= 800 };
}

async function audioParts(admin: SupabaseClient, callId: string): Promise<{ url: string; start: number }[]> {
  const { data: files } = await admin.storage.from(AUDIO_BUCKET).list(callId, { limit: 100, sortBy: { column: "name", order: "asc" } });
  const signed = await Promise.all(
    (files ?? []).map(async (f) => {
      const { data } = await admin.storage.from(AUDIO_BUCKET).createSignedUrl(`${callId}/${f.name}`, 60 * 60);
      const start = Number(f.name.split("-")[1]?.split(".")[0] ?? 0);
      return data ? { url: data.signedUrl, start: Number.isFinite(start) ? start : 0 } : null;
    }),
  );
  return signed.filter((p): p is { url: string; start: number } => Boolean(p)).sort((a, b) => a.start - b.start);
}

export type CallDetail = {
  id: string;
  person: string;
  agent: string;
  mode: "voice" | "text";
  at: string;
  seconds: number;
  topic: string | null;
  summary: string | null;
  review: { flagged: boolean; severity: string | null; summary: string | null; categories: string[]; moments: SafetyMoment[]; reviewedAt: string | null; audioDeleted: boolean } | null;
  lines: { at: number; who: string; text: string; person: boolean }[];
  parts: { url: string; start: number }[];
  did: { label: string; did: string[] }[];
  decisions: string[];
  followUps: string[];
  tasks: { title: string; status: string; kind: string }[];
  clients: string[];
};

/** One call: the transcript, what the agents did, the tasks it made, the review, and its audio while it's kept */
export async function loadCallDetail(callId: string): Promise<CallDetail | null> {
  if (!UUID.test(callId)) return null;
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, mode, started_at, ended_at, last_turn_at, topic, summary, notes, profiles:profile_id(full_name)").eq("id", callId).maybeSingle();
  if (!call) return null;
  const [{ data: review }, { data: rows }, { data: asks }, { data: commitments }, { data: mentions }] = await Promise.all([
    admin.from("call_safety_reviews").select("flagged, severity, summary, categories, moments, reviewed_at, audio_deleted_at").eq("call_id", callId).maybeSingle(),
    admin.from("ai_role_chats").select("role, role_key, content, created_at").eq("call_id", callId).order("created_at").limit(600),
    admin.from("agent_asks").select("title, status, kind").eq("call_id", callId).limit(100),
    admin.from("call_commitments").select("what, status, kind").eq("call_id", callId).limit(100),
    admin.from("call_mentions").select("clients(name)").eq("call_id", callId),
  ]);
  const who = ((call as unknown as { profiles: { full_name: string } | null }).profiles?.full_name ?? "The caller") as string;
  const t0 = Date.parse(call.started_at as string);
  const end = (call.ended_at ?? call.last_turn_at ?? call.started_at) as string;
  const notes = (call.notes ?? {}) as { agents?: { label?: string; did?: string[] }[]; decisions?: string[]; followUps?: string[] };
  const audioDeleted = Boolean(review?.audio_deleted_at);
  return {
    id: callId,
    person: who,
    agent: roleName(call.role_key as string),
    mode: call.mode === "text" ? "text" : "voice",
    at: call.started_at as string,
    seconds: Math.max(0, (Date.parse(end) - t0) / 1000),
    topic: (call.topic as string | null) ?? null,
    summary: (call.summary as string | null) ?? null,
    review: review ? { flagged: Boolean(review.flagged), severity: (review.severity as string | null) ?? null, summary: (review.summary as string | null) ?? null, categories: (review.categories as string[] | null) ?? [], moments: ((review.moments ?? []) as SafetyMoment[]) ?? [], reviewedAt: (review.reviewed_at as string | null) ?? null, audioDeleted } : null,
    lines: (rows ?? []).map((r) => ({ at: Math.max(0, Math.round((Date.parse(r.created_at as string) - t0) / 1000)), who: r.role === "user" ? who : `AI · ${roleName(r.role_key as string)}`, text: r.content as string, person: r.role === "user" })),
    // Audio while it's kept (before the review, or a flagged call's ~90 days); never re-kept here
    parts: call.mode === "text" || audioDeleted ? [] : await audioParts(admin, callId),
    did: (notes.agents ?? []).map((a) => ({ label: a.label ?? "Agent", did: (a.did ?? []).slice(0, 20) })).filter((a) => a.did.length),
    decisions: (notes.decisions ?? []).slice(0, 20),
    followUps: (notes.followUps ?? []).slice(0, 20),
    tasks: [...(asks ?? []).map((a) => ({ title: String(a.title), status: String(a.status), kind: String(a.kind ?? "task") })), ...(commitments ?? []).map((c) => ({ title: String(c.what), status: String(c.status), kind: `promise · ${String(c.kind ?? "")}` }))],
    clients: [...new Set(((mentions ?? []) as unknown as { clients: { name: string } | null }[]).map((m) => m.clients?.name).filter((n): n is string => Boolean(n)))],
  };
}

export type ThreadDetail = { id: string; person: string; title: string | null; agent: string; client: string | null; messages: { role: string; who: string; text: string; at: string }[] };

/** One Kaizen AI chat, read in full */
export async function loadThreadDetail(threadId: string): Promise<ThreadDetail | null> {
  if (!UUID.test(threadId)) return null;
  const admin = createAdminClient();
  const { data: t } = await admin.from("ai_threads").select("id, title, agent_key, profiles:profile_id(full_name), clients(name)").eq("id", threadId).maybeSingle();
  if (!t) return null;
  const { data: msgs } = await admin.from("ai_messages").select("role, content, agent_key, created_at").eq("thread_id", threadId).order("created_at").limit(600);
  const th = t as unknown as { id: string; title: string | null; agent_key: string | null; profiles: { full_name: string } | null; clients: { name: string } | null };
  const person = th.profiles?.full_name ?? "Someone";
  return {
    id: th.id,
    person,
    title: th.title,
    agent: th.agent_key ? roleName(th.agent_key) : "Kaizen AI",
    client: th.clients?.name ?? null,
    messages: (msgs ?? []).map((m) => ({ role: String(m.role), who: m.role === "user" ? person : `AI · ${m.agent_key ? roleName(m.agent_key as string) : "Kaizen AI"}`, text: String(m.content ?? ""), at: String(m.created_at) })),
  };
}

export type UsageReport = {
  monthStart: string;
  today: string;
  people: UsagePerson[];
  teams: { team: TeamKey; calls: number; chats: number; minutes: number; messages: number; tokens: number; cost: number; projected: number; people: number }[];
  total: { cost: number; projected: number; people: number };
  // Runs not tied to a person: the background automation, and any call or chat run older code didn't attribute
  unattributed: { cost: number; runs: number; callOrChatRuns: number };
  voice: { characters: number; audioMinutes: number };
};

type RollRow = { profile_id: string | null; day: string; model: string | null; kind: string; runs: number; input: number; output: number; cache_w: number; cache_r: number; searches: number; characters: number; audio_seconds: number };

/** This month to date, per person and team: calls, chats, minutes, messages, tokens and their cost (priced like Settings › AI agents), and the projection */
export async function loadUsage(now = new Date()): Promise<UsageReport> {
  const admin = createAdminClient();
  const today = nyDay(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = `${monthStart}T00:00:00-05:00`;
  const to = new Date(now.getTime() + 86_400_000).toISOString();
  const [staff, roll, threadCounts, calls, callMsgs] = await Promise.all([
    people(admin),
    admin.rpc("owner_usage_rollup" as never, { p_from: from, p_to: to } as never).then((r) => {
      if (r.error) throw new Error(r.error.message);
      return (r.data ?? []) as RollRow[];
    }),
    admin.rpc("owner_thread_counts" as never, { p_from: from, p_to: to } as never).then((r) => (r.data ?? []) as { profile_id: string; user_messages: number }[]),
    admin.from("ai_role_calls").select("profile_id, mode, started_at, ended_at, last_turn_at").gte("started_at", from).limit(5000).then((r) => (r.data ?? []) as { profile_id: string | null; mode: string | null; started_at: string; ended_at: string | null; last_turn_at: string | null }[]),
    admin.from("ai_role_chats").select("created_by").eq("role", "user").not("call_id", "is", null).gte("created_at", from).limit(20000).then((r) => (r.data ?? []) as { created_by: string | null }[]),
  ]);
  type Acc = UsagePerson & { days: Map<string, number> };
  const acc = new Map<string, Acc>();
  const get = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      const p = staff.get(id);
      a = { id, name: p?.full_name ?? "Someone", team: teamOf(p?.role, p?.is_exec), calls: 0, chats: 0, minutes: 0, messages: 0, input: 0, output: 0, cacheW: 0, cacheR: 0, cost: 0, projected: 0, activeDays: 0, daily: [], days: new Map() };
      acc.set(id, a);
    }
    return a;
  };
  const unattributed = { cost: 0, runs: 0, callOrChatRuns: 0 };
  const voice = { characters: 0, audioMinutes: 0 };
  for (const r of roll) {
    const u: Usage = { runs: Number(r.runs), failed: 0, input: Number(r.input), output: Number(r.output), cacheW: Number(r.cache_w), cacheR: Number(r.cache_r), searches: Number(r.searches) };
    // A voice row (no model) is ElevenLabs only: characters and audio, no token cost
    const cost = r.model ? costOf(r.model, u) : 0;
    voice.characters += Number(r.characters) || 0;
    voice.audioMinutes += (Number(r.audio_seconds) || 0) / 60;
    if (!r.profile_id) {
      unattributed.cost += cost;
      unattributed.runs += u.runs;
      if (r.kind !== "other") unattributed.callOrChatRuns += u.runs;
      continue;
    }
    const a = get(r.profile_id);
    a.input += u.input;
    a.output += u.output;
    a.cacheW += u.cacheW;
    a.cacheR += u.cacheR;
    a.cost += cost;
    const day = String(r.day).slice(0, 10);
    a.days.set(day, (a.days.get(day) ?? 0) + cost);
  }
  for (const c of calls) {
    if (!c.profile_id) continue;
    const a = get(c.profile_id);
    if (c.mode === "text") a.chats++;
    else {
      a.calls++;
      const end = c.ended_at ?? c.last_turn_at ?? c.started_at;
      a.minutes += Math.max(0, (Date.parse(end) - Date.parse(c.started_at)) / 60_000);
    }
  }
  for (const t of threadCounts) {
    if (!t.profile_id) continue;
    const a = get(t.profile_id);
    a.chats++;
    a.messages += Number(t.user_messages) || 0;
  }
  for (const m of callMsgs) if (m.created_by) get(m.created_by).messages++;
  // Every day of the month so far, for the trend
  const days: string[] = [];
  for (let d = new Date(`${monthStart}T12:00:00Z`); nyDay(d) <= today; d = new Date(d.getTime() + 86_400_000)) days.push(nyDay(d));
  const list: UsagePerson[] = [...acc.values()]
    .filter((a) => a.cost > 0 || a.calls || a.chats || a.messages)
    .map(({ days: byDay, ...a }) => {
      const activeDays = [...byDay.values()].filter((v) => v > 0).length;
      return { ...a, minutes: Math.round(a.minutes), activeDays, projected: projectMonth(a.cost, activeDays, today).projected, daily: days.map((day) => ({ day, cost: byDay.get(day) ?? 0 })) };
    });
  const teams = new Map<TeamKey, UsageReport["teams"][number]>();
  for (const p of list) {
    const t = teams.get(p.team) ?? { team: p.team, calls: 0, chats: 0, minutes: 0, messages: 0, tokens: 0, cost: 0, projected: 0, people: 0 };
    t.calls += p.calls;
    t.chats += p.chats;
    t.minutes += p.minutes;
    t.messages += p.messages;
    t.tokens += p.input + p.output + p.cacheW + p.cacheR;
    t.cost += p.cost;
    t.projected += p.projected;
    t.people++;
    teams.set(p.team, t);
  }
  const total = { cost: list.reduce((s, p) => s + p.cost, 0), projected: list.reduce((s, p) => s + p.projected, 0), people: list.length };
  return { monthStart, today, people: list, teams: [...teams.values()].sort((a, b) => b.cost - a.cost), total, unattributed, voice: { characters: voice.characters, audioMinutes: Math.round(voice.audioMinutes) } };
}
