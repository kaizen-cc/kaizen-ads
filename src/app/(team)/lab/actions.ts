"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, aiEnabled, getAgent } from "@/lib/ai";
import { routeMessage, type Level } from "@/lib/ai-router";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { clientNumbers, proposeDeploy, readSource, tableTurn, windowSince, type ProposedTest, type Seat, type TableTurn } from "@/lib/lab";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { suggestForTest } from "@/lib/suggestions";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function lead() {
  const me = await requireStaff();
  if (!isExecOrLead(me)) throw new Error("The Ads Lab is for execs and leads.");
  return me;
}
const admin = () => {
  if (!adminConfigured() || !aiEnabled()) throw new AiUnavailable("The AI isn't connected here.");
  return createAdminClient();
};
const fail = (e: unknown, fallback: string) => ({ ok: false as const, error: e instanceof AiUnavailable ? e.message : e instanceof Error ? e.message : fallback });

// ─── Round table ───

export type Attachment = { kind: "doc" | "transcript" | "video" | "link" | "note"; title: string; url: string; body: string };

export type SentMessage = { id: string; body: string; attachments: { id: string; kind: string; title: string; url: string | null; failed?: boolean }[]; at: string; level?: Level; research?: boolean };

/**
 * Says something to the table (in a new conversation when there's no thread yet), with anything shared alongside:
 * links and videos are read first, so the seats answer with them in hand. Everything shared stays in the lab's
 * library for every conversation after. The table answers turn by turn after this (tableSpeaks).
 */
export async function sendToTable(threadId: string | null, text: string, attachments: Attachment[] = [], goDeep = false): Promise<Result<{ threadId: string; message: SentMessage }>> {
  const me = await lead();
  const body = text.trim();
  const shared = attachments.filter((a) => a.url.trim() || a.body.trim()).slice(0, 6);
  if (!body && !shared.length) return { ok: false, error: "Write something or share something first." };
  for (const a of shared) if (a.url.trim() && !/^https?:\/\/\S+\.\S+/i.test(a.url.trim())) return { ok: false, error: `"${a.url}" doesn't look like a link.` };
  const supabase = await createClient();
  try {
    const db = admin();
    let id = threadId;
    if (!id) {
      const { data, error } = await supabase.from("lab_threads").insert({ created_by: me.id }).select("id").single();
      if (error || !data) return { ok: false, error: error?.message ?? "Couldn't start the conversation." };
      id = data.id as string;
    }
    // What was shared goes into the library and is read now
    const saved: { id: string; kind: string; title: string; url: string | null }[] = [];
    for (const a of shared) {
      const url = a.url.trim();
      const { data } = await supabase
        .from("lab_sources")
        .insert({ kind: a.kind, title: a.title.trim().slice(0, 120) || url || "Shared in the round table", url: url || null, body: a.body.trim().slice(0, 200_000), status: "reading", added_by: me.id })
        .select("id, kind, title, url")
        .single();
      if (data) saved.push(data);
    }
    await Promise.all(saved.map((x) => readSource(db, x.id)));
    const { data: read } = saved.length ? await db.from("lab_sources").select("id, kind, title, url, status").in("id", saved.map((x) => x.id)) : { data: [] };
    const lines = (read ?? []).map((x) => `[Shared ${x.kind === "video" ? "a video" : x.kind === "transcript" ? "a call transcript" : x.kind === "link" ? "a link" : "a doc"}: "${x.title}"${x.status === "failed" ? " (couldn't be read)" : ""}]`);
    const attached = (read ?? []).map((x) => ({ id: x.id as string, kind: x.kind as string, title: x.title as string, url: x.url as string | null, failed: x.status === "failed" }));
    // How much this round deserves: the whole table answers it at that level (never above the Ads Lab's setting)
    const route = await routeMessage(body || lines.join("\n"), await getAgent("lab"), goDeep);
    const { data: posted, error } = await supabase
      .from("lab_messages")
      .insert({
        thread_id: id,
        role: "user",
        author_id: me.id,
        body: [body, ...lines].filter(Boolean).join("\n").slice(0, 8000),
        data: { ...(attached.length ? { attachments: attached } : {}), route },
      })
      .select("id, body, created_at")
      .single();
    if (error || !posted) return { ok: false, error: error?.message ?? "Couldn't send it." };
    await db.from("lab_threads").update({ updated_at: new Date().toISOString() }).eq("id", id);
    return { ok: true, threadId: id, message: { id: posted.id, body: posted.body, attachments: attached, at: posted.created_at, level: route.level, research: route.research } };
  } catch (e) {
    return fail(e, "Couldn't send it. Try again.");
  }
}

/**
 * The next message from the table, saved before it returns, so the page shows each seat as soon as it has spoken.
 * `seat` is who the last speaker handed to (none: the table picks). `next` null means it's the exec's turn.
 */
export async function tableSpeaks(threadId: string, seat: Seat | null): Promise<Result<{ message: TableTurn | null }>> {
  await lead();
  try {
    return { ok: true, message: await tableTurn(admin(), threadId, seat) };
  } catch (e) {
    return fail(e, "The table couldn't answer. Try again.");
  }
}

export async function deleteThread(id: string): Promise<Result> {
  await lead();
  const supabase = await createClient();
  const { error } = await supabase.from("lab_threads").delete().eq("id", id);
  revalidatePath("/lab");
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ─── What was shared ───

export async function deleteSource(id: string): Promise<Result> {
  await lead();
  const supabase = await createClient();
  const { error } = await supabase.from("lab_sources").delete().eq("id", id);
  revalidatePath("/lab");
  return error ? { ok: false, error: error.message } : { ok: true };
}

// ─── Tests ───

/**
 * A proposed test becomes real: started on the chosen clients (baseline taken now, and the strategist writes each
 * client's brief as a suggestion on Home for a person to approve), or kept as an idea.
 */
export async function createTest(p: ProposedTest & { threadId: string | null; parentId?: string | null; days: number; start: boolean }): Promise<Result<{ id: string }>> {
  const me = await lead();
  if (p.start && !p.clientIds.length) return { ok: false, error: "Pick at least one client." };
  const supabase = await createClient();
  const baseline = p.start ? await clientNumbers(supabase, p.clientIds, "d14") : {};
  const days = Math.max(3, Math.min(60, Math.round(p.days || 14)));
  const { data, error } = await supabase
    .from("lab_tests")
    .insert({
      thread_id: p.threadId,
      parent_id: p.parentId ?? null,
      title: p.title.slice(0, 120),
      hypothesis: p.hypothesis,
      change: p.change,
      metric: p.metric,
      success: p.success,
      target_lift: p.targetLift,
      client_ids: p.clientIds,
      status: p.start ? "running" : "proposed",
      baseline,
      started_at: p.start ? new Date().toISOString() : null,
      ends_at: p.start ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
      created_by: me.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't save the test." };
  if (p.start) briefClients(data.id, p.clientIds, p);
  revalidatePath("/lab");
  return { ok: true, id: data.id };
}

/** An idea from the list, started now. */
export async function startTest(id: string, clientIds: string[], days: number): Promise<Result> {
  await lead();
  if (!clientIds.length) return { ok: false, error: "Pick at least one client." };
  const supabase = await createClient();
  const { data: t } = await supabase.from("lab_tests").select("title, hypothesis, change, success, status").eq("id", id).single();
  if (!t || t.status !== "proposed") return { ok: false, error: "This test already started." };
  const baseline = await clientNumbers(supabase, clientIds, "d14");
  const d = Math.max(3, Math.min(60, Math.round(days || 14)));
  const { error } = await supabase
    .from("lab_tests")
    .update({ status: "running", client_ids: clientIds, baseline, started_at: new Date().toISOString(), ends_at: new Date(Date.now() + d * 86_400_000).toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  briefClients(id, clientIds, t);
  revalidatePath("/lab");
  return { ok: true };
}

function briefClients(id: string, clientIds: string[], t: { title: string; hypothesis: string; change: string; success: string }) {
  if (!adminConfigured() || !aiEnabled()) return;
  const db = createAdminClient();
  after(async () => {
    for (let i = 0; i < clientIds.length; i += 3) await Promise.allSettled(clientIds.slice(i, i + 3).map((c) => suggestForTest(db, c, { id, ...t })));
    revalidatePath("/pipeline");
  });
}

/** The call on a test: the numbers are read now and kept with the verdict. A flop's note goes to the tested clients' memory. */
export async function decideTest(id: string, won: boolean, note: string): Promise<Result> {
  const me = await lead();
  if (note.trim().length < 3) return { ok: false, error: "Say what happened, so the table learns." };
  const supabase = await createClient();
  const { data: t } = await supabase.from("lab_tests").select("title, client_ids, started_at, status").eq("id", id).single();
  if (!t || t.status !== "running") return { ok: false, error: "Only a running test can be called." };
  const result = await clientNumbers(supabase, t.client_ids as string[], windowSince(t.started_at));
  const { error } = await supabase
    .from("lab_tests")
    .update({ status: won ? "won" : "lost", result, verdict_note: note.trim().slice(0, 1000), learning: won ? null : note.trim().slice(0, 1000), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (!won && adminConfigured())
    await createAdminClient()
      .from("client_memory")
      .insert((await liveClients(supabase, t.client_ids as string[])).map((c) => ({ client_id: c, kind: "note", source: "lab", created_by: me.id, body: `Tested "${t.title}" here and it didn't win: ${note.trim()}`.slice(0, 1000) })));
  revalidatePath("/lab");
  return { ok: true };
}

/** For a win: the AI's learning and the clients it fits, for the person to check before deploying. */
export async function draftDeploy(id: string): Promise<Result<{ learning: string; clients: { id: string; why: string }[] }>> {
  await lead();
  try {
    return { ok: true, ...(await proposeDeploy(admin(), id)) };
  } catch (e) {
    return fail(e, "Couldn't draft the learning.");
  }
}

/** The learning goes into every chosen client's memory (and the tested ones'): every agent reads it from now on. */
export async function deployLearning(id: string, learning: string, clientIds: string[]): Promise<Result> {
  const me = await lead();
  const text = learning.trim();
  if (text.length < 10) return { ok: false, error: "Write the learning first." };
  const supabase = await createClient();
  const { data: t } = await supabase.from("lab_tests").select("client_ids, deployed_to, deploy_baseline, status").eq("id", id).single();
  if (!t || t.status !== "won") return { ok: false, error: "Only a winning test can be deployed." };
  const all = await liveClients(supabase, [...new Set([...(t.client_ids as string[]), ...clientIds])]);
  const fresh = all.filter((c) => !(t.deployed_to as string[]).includes(c));
  if (!adminConfigured()) return { ok: false, error: "Can't write client memory here." };
  const db = createAdminClient();
  if (fresh.length) {
    const { error } = await db.from("client_memory").insert(fresh.map((c) => ({ client_id: c, kind: "prefer", source: "lab", created_by: me.id, body: `Ads Lab learning: ${text}`.slice(0, 1000) })));
    if (error) return { ok: false, error: error.message };
  }
  // The agents get better too: the learning goes to the skill it belongs to, as an edit an exec approves in its Coach
  const { data: test } = await supabase.from("lab_tests").select("title, change").eq("id", id).single();
  const about = `${test?.title ?? ""} ${test?.change ?? ""} ${text}`.toLowerCase();
  const skill = /\b(video|reel|script|voice ?over|ugc|first 3 seconds)\b/.test(about) ? "scripts" : /\b(headline|primary text|copy|caption|cta|wording)\b/.test(about) ? "copy" : "strategist";
  await db.from("ai_agent_chats").insert({
    agent_key: skill,
    role: "coach",
    content: `From the Ads Lab: the test "${test?.title ?? ""}" won. I'd add what it taught us to this skill so every brief uses it, not just the clients it was deployed to.`,
    changes: [
      {
        op: "add_item",
        item_id: "",
        kind: "knowledge",
        scope: "agent",
        title: `Ads Lab: ${test?.title ?? "a winning test"}`.slice(0, 120),
        body: text,
        model: "",
        effort: "",
        reason: "Proven in an Ads Lab test",
        applied: false,
      },
    ],
    created_by: me.id,
  });
  const baseline = await clientNumbers(supabase, fresh, "d14");
  await supabase
    .from("lab_tests")
    .update({
      learning: text,
      deployed_to: all,
      deploy_baseline: { ...(t.deploy_baseline as object), ...baseline },
      deployed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/lab");
  return { ok: true };
}

/** A flop, back to the table: why it likely didn't work and what to try next. */
export async function iterateTest(id: string): Promise<Result<{ threadId: string }>> {
  const me = await lead();
  const supabase = await createClient();
  const { data: t } = await supabase.from("lab_tests").select("title, hypothesis, change, verdict_note, thread_id, baseline, result").eq("id", id).single();
  if (!t) return { ok: false, error: "Test not found." };
  let threadId = t.thread_id as string | null;
  if (!threadId) {
    const { data } = await supabase.from("lab_threads").insert({ created_by: me.id, title: `Iterating: ${t.title}`.slice(0, 80) }).select("id").single();
    threadId = data?.id ?? null;
  }
  if (!threadId) return { ok: false, error: "Couldn't open a conversation." };
  return sendToTable(
    threadId,
    `The test "${t.title}" flopped. Hypothesis: ${t.hypothesis}. Change: ${t.change}. What we saw: ${t.verdict_note ?? "no note"}. Numbers before: ${JSON.stringify(t.baseline)}; after: ${JSON.stringify(t.result)}. Why did it likely flop, and what should we test next? Propose the next test (iterate on this one, don't repeat it).`,
  );
}

export async function dropTest(id: string): Promise<Result> {
  await lead();
  const supabase = await createClient();
  const { error } = await supabase.from("lab_tests").update({ status: "dropped", updated_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/lab");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Of these clients, the ones not archived (nothing new is written into an archived client). */
async function liveClients(db: Awaited<ReturnType<typeof createClient>>, ids: string[]) {
  if (!ids.length) return [];
  const { data } = await db.from("clients").select("id").in("id", ids).is("archived_at", null);
  return (data ?? []).map((c) => c.id as string);
}
