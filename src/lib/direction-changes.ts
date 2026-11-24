import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { askJson } from "@/lib/ai";
import { getCursor, setCursor } from "@/lib/context/shared";
import {
  allActed,
  directionNote,
  isAsana,
  lineOf,
  noDash,
  recipientsFor,
  stageLabel,
  tasksLine,
  withClient,
  BACK_STAGES,
  type ChangeKind,
  type ChangeLineId,
  type ChangeScope,
  type ChangeSource,
  type CleanChange,
  type Fix,
  type OpenTask,
  type TaskAction,
  type TaskKind,
  type Verdict,
  cleanDetection,
} from "@/lib/direction-core";

// A client changing direction mid-production, caught early. Every 30 minutes in business hours the new client messages
// (Slack with the client, email, the portal chat, calls once read) are read for each client with open work; a small
// model first says whether anything could change direction at all, and only then a stronger one reads the messages
// against the client's open tasks (on both boards, Kaizen or still in Asana) and says which ones the change touches,
// what has to change and why. Each change is saved with the client's own words, the people who need to know are told,
// and the team sends the work back in one tap (src/app/(team)/direction). A person can log one too (a call, a
// WhatsApp): the same matcher runs on the client's open tasks.

type Db = SupabaseClient;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ─── Open work ───────────────────────────────────────────────────────────────

/** Every open task for these clients (all clients when none are given), on both boards, Kaizen and Asana */
export async function loadOpenTasks(db: Db, clientIds: string[] | null = null): Promise<Map<string, OpenTask[]>> {
  let ac = db.from("asana_tasks").select("gid, name, notes, stage, client_id, profile_id, assignee_name, url").eq("open", true).is("request_id", null).not("stage", "is", null).not("client_id", "is", null);
  let ae = db.from("email_asana_tasks").select("gid, name, notes, stage, client_id, profile_id, assignee_name, url").eq("open", true).is("ticket_id", null).is("completed_at", null).not("stage", "is", null).not("client_id", "is", null);
  let kc = db.from("requests").select("id, number, title, brief, stage, client_id, assignee_id").is("deleted_at", null).neq("stage", "launched");
  let ke = db.from("email_tickets").select("id, number, title, brief, stage, client_id, assignee_id").is("deleted_at", null).neq("stage", "live");
  if (clientIds) {
    ac = ac.in("client_id", clientIds);
    ae = ae.in("client_id", clientIds);
    kc = kc.in("client_id", clientIds);
    ke = ke.in("client_id", clientIds);
  }
  const [a1, a2, k1, k2] = await Promise.all([ac.limit(1000), ae.limit(1000), kc.limit(1000), ke.limit(1000)]);
  const out = new Map<string, OpenTask[]>();
  const add = (clientId: unknown, t: OpenTask) => {
    if (!clientId) return;
    const list = out.get(clientId as string) ?? [];
    list.push(t);
    out.set(clientId as string, list);
  };
  const { cleanTitle } = await import("@/lib/task-title");
  for (const r of a1.data ?? []) add(r.client_id, { kind: "asana_creative", ref: r.gid as string, title: cleanTitle(r.name as string).title, stage: r.stage as string, notes: r.notes as string | null, assigneeId: r.profile_id as string | null, assigneeName: r.assignee_name as string | null, url: r.url as string | null });
  for (const r of a2.data ?? []) add(r.client_id, { kind: "asana_email", ref: r.gid as string, title: cleanTitle(r.name as string).title, stage: r.stage as string, notes: r.notes as string | null, assigneeId: r.profile_id as string | null, assigneeName: r.assignee_name as string | null, url: r.url as string | null });
  for (const r of k1.data ?? []) add(r.client_id, { kind: "creative", ref: r.id as string, title: r.title as string, stage: r.stage as string, notes: r.brief as string | null, assigneeId: r.assignee_id as string | null, number: r.number as number });
  for (const r of k2.data ?? []) add(r.client_id, { kind: "email", ref: r.id as string, title: r.title as string, stage: r.stage as string, notes: r.brief as string | null, assigneeId: r.assignee_id as string | null, number: r.number as number });
  return out;
}

/** Where a task opens in the app */
export function taskHref(kind: TaskKind, ref: string, number?: number | null): string {
  if (kind === "creative") return number ? `/board?t=${number}` : "/board";
  if (kind === "email") return number ? `/board/email?t=${number}` : "/board/email";
  if (kind === "asana_email") return `/board/email?a=${ref}`;
  return `/board?a=${ref}`;
}

// ─── What the client said ────────────────────────────────────────────────────

export type ClientMessage = { source: ChangeSource; ref: string; at: string; author: string; title: string | null; body: string; url: string | null };

/** New client messages since the cursor, for these clients, from people outside the team */
async function newMessages(admin: Db, since: Date, clientIds: string[]): Promise<{ byClient: Map<string, ClientMessage[]>; callIds: string[] }> {
  const iso = since.toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [{ data: items }, { data: chat }, { data: calls }, { data: people }] = await Promise.all([
    admin.from("context_items").select("id, client_id, source, external_id, occurred_at, author, title, body, url").in("source", ["slack_external", "gmail"]).in("client_id", clientIds).gt("created_at", iso).order("occurred_at").limit(1500),
    admin.from("portal_chat_messages").select("id, client_id, ts, author_name, text, sent_at").in("client_id", clientIds).eq("from_team", false).eq("deleted", false).gt("created_at", iso).order("sent_at").limit(800),
    admin.from("client_calls").select("id, client_id, title, occurred_at, url, summary").in("client_id", clientIds).eq("status", "read").is("direction_checked_at", null).gt("occurred_at", weekAgo).limit(200),
    admin.from("profiles").select("full_name, email"),
  ]);
  const names = new Set((people ?? []).map((p) => String(p.full_name ?? "").trim().toLowerCase()).filter(Boolean));
  const emails = new Set((people ?? []).map((p) => String(p.email ?? "").trim().toLowerCase()).filter(Boolean));
  const fromTeam = (author: string | null) => {
    const a = String(author ?? "").toLowerCase();
    if (!a || a === "bot") return true;
    const email = a.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? null;
    if (email) return emails.has(email) || email.endsWith("@kaizenmarketing.agency");
    return names.has(a.trim());
  };
  const byClient = new Map<string, ClientMessage[]>();
  const add = (clientId: string, m: ClientMessage) => byClient.set(clientId, [...(byClient.get(clientId) ?? []), m]);
  for (const i of items ?? []) {
    if (fromTeam(i.author as string | null) || !String(i.body ?? "").trim()) continue;
    add(i.client_id as string, { source: i.source === "gmail" ? "gmail" : "slack", ref: `${i.source}:${i.external_id}`, at: i.occurred_at as string, author: clip(i.author, 80) || "The client", title: (i.title as string | null) ?? null, body: String(i.body ?? "").slice(0, 2500), url: (i.url as string | null) ?? null });
  }
  for (const c of chat ?? []) {
    if (!String(c.text ?? "").trim()) continue;
    add(c.client_id as string, { source: "portal", ref: `portal:${c.id}`, at: c.sent_at as string, author: clip(c.author_name, 80) || "The client", title: null, body: String(c.text).slice(0, 2500), url: null });
  }
  for (const c of calls ?? []) {
    const s = (c.summary ?? {}) as { clientSaid?: string[]; decisions?: string[]; summary?: string };
    const body = [s.clientSaid?.length ? `The client said: ${s.clientSaid.join("; ")}` : "", s.decisions?.length ? `Decided: ${s.decisions.join("; ")}` : ""].filter(Boolean).join("\n");
    if (!body) continue;
    add(c.client_id as string, { source: "call", ref: `call:${c.id}`, at: c.occurred_at as string, author: "On a call", title: (c.title as string | null) ?? null, body: body.slice(0, 3000), url: (c.url as string | null) ?? null });
  }
  return { byClient, callIds: (calls ?? []).map((c) => c.id as string) };
}

// ─── The AI ──────────────────────────────────────────────────────────────────

const RULES = `A direction change is something the client says that changes what several pieces of work, or all future work, should say or show, or which campaign gets the focus: a new or ended offer or price, "stop campaign X, focus on Y", "evergreen only, nothing tied to a team or date", a product dropped or added, a new audience, a new message or claim to lead with or to stop using. A revision to one piece of work is NOT a direction change, even when it's about a product, a price or what's listed: "take those 4 straps off the 12 Days list", "add the Air Raid to that list", "Day 3 is a combo price of $225", "this frame description is wrong", "make the logo bigger on this one", "change the headline on ad 3". Those edit one email, one campaign's content or one ad; they're revisions. Approval, praise, scheduling, invoices, reporting questions and small talk are not direction changes either. Be conservative: when unsure, it's not one.`;

const PREFILTER_SCHEMA = { type: "object", properties: { maybe: { type: "boolean" }, messages: { type: "array", items: { type: "integer" } } }, required: ["maybe", "messages"], additionalProperties: false };

/** The cheap first look: could any of these messages be a change of direction? (most runs stop here) */
async function prefilter(messages: ClientMessage[]): Promise<number[]> {
  const out = await askJson<{ maybe: boolean; messages: number[] }>({
    agent: "briefing",
    label: "direction prefilter",
    bare: true,
    maxTokens: 800,
    override: { model: "haiku", effort: "low" },
    system: `You screen messages from an agency's clients (paid ads, creative and email marketing). ${RULES} Answer maybe: true when any message could be a direction change, with the numbers of those messages; otherwise maybe: false and no numbers.`,
    schema: PREFILTER_SCHEMA,
    prompt: messages.map((m, i) => `${i + 1}. ${m.source}, ${m.author}${m.title ? `, "${clip(m.title, 80)}"` : ""}: ${clip(m.body, 700)}`).join("\n\n"),
  });
  return out.maybe ? (out.messages ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= messages.length) : [];
}

const DETECT_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["direction", "revision"] },
          lines: { type: "array", items: { type: "string", enum: ["meta", "google", "tiktok", "ads", "creative", "email", "social"] } },
          kind: { type: "string", enum: ["offer", "priority", "stop", "product", "messaging", "audience", "other"] },
          summary: { type: "string" },
          was: { type: "string" },
          now: { type: "string" },
          quote: { type: "string" },
          message: { type: "integer" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { n: { type: "integer" }, verdict: { type: "string", enum: ["affected", "maybe"] }, fix: { type: "string", enum: ["design", "copy", "both", "brief", "stop"] }, why: { type: "string" } },
              required: ["n", "verdict", "fix", "why"],
              additionalProperties: false,
            },
          },
        },
        required: ["scope", "lines", "kind", "summary", "was", "now", "quote", "message", "tasks"],
        additionalProperties: false,
      },
    },
  },
  required: ["changes"],
  additionalProperties: false,
};

const stageName = (t: OpenTask) => `${lineOf(t.kind) === "creative" ? "creative" : "email"}, ${stageLabel(t.kind, t.stage)}${isAsana(t.kind) ? " (in Asana)" : ""}`;

/**
 * The careful read: the client's messages against their open tasks. Returns each change with the tasks it touches.
 * logged: a person already said the client changed direction (their words are the one message): exactly one change.
 */
export async function matchChanges(client: { id: string; name: string }, messages: ClientMessage[], tasks: OpenTask[], logged = false): Promise<CleanChange[]> {
  if (!messages.length) return [];
  const raw = await askJson<{ changes: unknown[] }>({
    agent: "briefing",
    label: logged ? "direction change logged" : "direction changes",
    clientId: client.id,
    maxTokens: 6000,
    override: { model: "sonnet", effort: "medium" },
    system: `You catch a client changing direction mid-production at Kaizen, a paid ads, creative and email agency, so the team adapts work already in progress instead of finishing what the client said to stop. ${RULES}

Return revisions too, but marked as such, so each lands on the piece it's about: scope "revision" when it edits one piece of work (one email, one campaign's content, one ad or video) and you can name that open task below; scope "direction" only when it changes what several pieces or all future work should say or show, or which campaign gets the focus. A revision with no open task to put it on: leave it out. When unsure, it's a revision.
lines: whose work it is, from meta, google, tiktok (one platform's ads), ads (paid ads in general), creative (ad images and videos), email (email and SMS), social (organic posts). Only the teams it really touches: a list of products in an email is email only; a Meta campaign's focus is meta (and creative only if the ads themselves must change).

For each change: scope; lines; kind; summary (one plain line, what's different now, e.g. "Evergreen creative only; stop team-specific"); was (what it was before, short, empty if unknown); now (what it is now, short); quote (the client's own words, short, exact); message (the number of the message it's in); tasks: every open task below it touches. verdict "affected" when the task clearly has to change, "maybe" when it might. fix: "copy" when only the words change, "design" when what's on the image or video changes (the offer or price on it, the wrong theme, product or team), "both", "brief" when the task hasn't been started yet, "stop" only when the campaign is dropped and nothing in it can be adapted. Prefer adapting over stopping: the hours are already paid. why: one plain sentence about this task. Name roles, never people. Never use em dashes. Leave out tasks the change doesn't touch.`,
    schema: DETECT_SCHEMA,
    prompt: `Client: ${client.name}

<open_tasks>
${tasks.map((t, i) => `${i + 1}. [${stageName(t)}] ${clip(t.title, 160)}${t.notes ? `\n   ${clip(t.notes, 350)}` : ""}`).join("\n") || "None."}
</open_tasks>

<messages>
${messages.map((m, i) => `${i + 1}. ${m.source}, ${m.at.slice(0, 10)}, ${m.author}${m.title ? `, "${clip(m.title, 100)}"` : ""}:\n${m.body}`).join("\n\n")}
</messages>

${logged ? "The team says this client changed direction (the message above, in the team's words; use its key words as the quote). Return exactly one change and match it to the open tasks." : "Return the direction changes in these messages, if any (most messages have none: return an empty list then)."}`,
  });
  const clean = cleanDetection(raw, tasks, messages.length);
  return logged ? clean.slice(0, 1) : clean;
}

// ─── Saving and telling ──────────────────────────────────────────────────────

type SaveMeta = { source: ChangeSource; sourceRef: string | null; url: string | null; saidAt: string | null; detectedBy: "ai" | "person"; createdBy: string | null };

/** Saves a change and its tasks; null when this message's change was already saved (a rerun) */
export async function saveChange(admin: Db, clientId: string, c: CleanChange, meta: SaveMeta): Promise<string | null> {
  const row = {
    client_id: clientId,
    kind: c.kind,
    scope: c.scope,
    lines: c.lines,
    summary: noDash(c.summary).slice(0, 300) || "The client changed direction",
    was_text: c.was || null,
    now_text: c.now || null,
    quote: c.quote || null,
    source: meta.source,
    source_ref: meta.sourceRef,
    url: meta.url,
    said_at: meta.saidAt,
    detected_by: meta.detectedBy,
    created_by: meta.createdBy,
  };
  const { data, error } = meta.sourceRef
    ? await admin.from("client_direction_changes").upsert(row, { onConflict: "source,source_ref", ignoreDuplicates: true }).select("id")
    : await admin.from("client_direction_changes").insert(row).select("id");
  if (error) throw new Error(error.message);
  const id = (data ?? [])[0]?.id as string | undefined;
  if (!id) return null;
  if (c.tasks.length)
    await admin.from("direction_change_tasks").upsert(
      c.tasks.map((t) => ({ change_id: id, client_id: clientId, task_kind: t.kind, task_ref: t.ref, title: t.title.slice(0, 300), stage_at_flag: t.stage, verdict: t.verdict, why: t.why, fix: t.fix, suggested_stage: t.suggested })),
      { onConflict: "change_id,task_kind,task_ref", ignoreDuplicates: true },
    );
  return id;
}

/** Where the change opens: over the client's page */
export const changeHref = (slug: string, id: string) => `/clients/${slug}?direction=${id}`;

/** Tells the people who need to know, once each (in the app, and by Slack DM when their Slack is connected) */
export async function notifyChange(admin: Db, changeId: string, skip: string | null = null) {
  const { data: ch } = await admin.from("client_direction_changes").select("id, client_id, summary, quote, scope, lines, clients(name, slug)").eq("id", changeId).maybeSingle();
  if (!ch) return { told: 0 };
  const client = ch.clients as unknown as { name: string; slug: string };
  const [{ data: tasks }, { data: seats }, { data: heads }, { data: execs }] = await Promise.all([
    admin.from("direction_change_tasks").select("task_kind, task_ref, stage_at_flag, verdict").eq("change_id", changeId),
    admin.from("client_assignments").select("profile_id, role, is_primary").eq("client_id", ch.client_id),
    admin.from("profiles").select("id").eq("role", "head_of_creative").eq("is_active", true),
    admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true),
  ]);
  // Who holds each flagged task (an Asana task's matched person, a ticket's assignee)
  const flagged = tasks ?? [];
  const holder = new Map<string, string | null>();
  const refs = (k: TaskKind) => flagged.filter((t) => t.task_kind === k).map((t) => t.task_ref as string);
  const [a1, a2, k1, k2] = await Promise.all([
    refs("asana_creative").length ? admin.from("asana_tasks").select("gid, profile_id").in("gid", refs("asana_creative")) : Promise.resolve({ data: [] }),
    refs("asana_email").length ? admin.from("email_asana_tasks").select("gid, profile_id").in("gid", refs("asana_email")) : Promise.resolve({ data: [] }),
    refs("creative").length ? admin.from("requests").select("id, assignee_id").in("id", refs("creative")) : Promise.resolve({ data: [] }),
    refs("email").length ? admin.from("email_tickets").select("id, assignee_id").in("id", refs("email")) : Promise.resolve({ data: [] }),
  ]);
  for (const r of (a1.data ?? []) as { gid: string; profile_id: string | null }[]) holder.set(`asana_creative:${r.gid}`, r.profile_id);
  for (const r of (a2.data ?? []) as { gid: string; profile_id: string | null }[]) holder.set(`asana_email:${r.gid}`, r.profile_id);
  for (const r of (k1.data ?? []) as { id: string; assignee_id: string | null }[]) holder.set(`creative:${r.id}`, r.assignee_id);
  for (const r of (k2.data ?? []) as { id: string; assignee_id: string | null }[]) holder.set(`email:${r.id}`, r.assignee_id);
  const { ids, critical } = recipientsFor({
    seats: (seats ?? []) as { profile_id: string; role: string }[],
    headsOfCreative: (heads ?? []).map((h) => h.id as string),
    execs: (execs ?? []).map((e) => e.id as string),
    tasks: flagged.map((t) => ({ kind: t.task_kind as TaskKind, stage: t.stage_at_flag as string | null, verdict: t.verdict as Verdict, assigneeId: holder.get(`${t.task_kind}:${t.task_ref}`) ?? null })),
    lines: ((ch.lines ?? []) as ChangeLineId[]).filter(Boolean),
    scope: (ch.scope as ChangeScope | null) ?? "direction",
  });
  const revision = ch.scope === "revision";
  const to = ids.filter((id) => id !== skip);
  await admin.from("client_direction_changes").update({ notified: ids }).eq("id", changeId);
  if (!to.length) return { told: 0 };
  const n = flagged.length;
  const title = noDash(revision ? `${client.name} asked for a revision: ${n === 1 ? "1 piece" : `${n} pieces`} to change` : `${client.name} changed direction: ${n ? tasksLine(n) : "check the open work"}`);
  const body = noDash(`${ch.summary}${ch.quote ? `. In their words: "${clip(ch.quote, 200)}"` : ""}`);
  const href = changeHref(client.slug, changeId);
  await admin.from("notifications").upsert(
    to.map((profile_id) => ({ profile_id, kind: "direction", title: title.slice(0, 200), body: body.slice(0, 1000), href, client_id: ch.client_id, key: `direction:${changeId}`, priority: critical ? "critical" : "normal" })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
  // The client saying they're leaving or furious with it: every exec hears it's on fire (never for a one-piece revision)
  if (!revision) await import("@/lib/exec-focus/server").then(({ raiseFire }) => raiseFire(admin, { clientId: ch.client_id as string, client: client.name, href, body, signal: { kind: "client_message", text: `${ch.summary ?? ""} ${ch.quote ?? ""}`, fromClient: true } })).catch(() => false);
  try {
    const { slackConnection, postAsApp } = await import("@/lib/slack-user");
    const { siteUrl } = await import("@/lib/site");
    for (const id of to) {
      const s = await slackConnection(id).catch(() => ({ connected: false as const }));
      if (s.connected && "slackUserId" in s && s.slackUserId) await postAsApp({ channel: s.slackUserId, text: `${title}. ${body} ${siteUrl()}${href}` }).catch(() => undefined);
    }
  } catch (e) {
    console.error("[direction] slack dm", e instanceof Error ? e.message : e);
  }
  return { told: to.length };
}

// ─── The cron step ───────────────────────────────────────────────────────────

/** The "direction" step: new client messages since the last run, read against each client's open work */
export async function runDirectionChanges(admin: Db) {
  const started = new Date();
  const since = await getCursor(admin, "direction", 1);
  const tasks = await loadOpenTasks(admin);
  const clientIds = [...tasks.keys()];
  const out = { clients: 0, screened: 0, read: 0, changes: 0, told: 0, errors: [] as string[] };
  if (!clientIds.length) {
    await setCursor(admin, "direction", started, out);
    return out;
  }
  const [{ byClient, callIds }, { data: clients }] = await Promise.all([newMessages(admin, since, clientIds), admin.from("clients").select("id, name, archived_at").in("id", clientIds)]);
  const names = new Map((clients ?? []).filter((c) => !c.archived_at).map((c) => [c.id as string, c.name as string]));
  for (const [clientId, messages] of byClient) {
    const name = names.get(clientId);
    if (!name) continue;
    out.clients++;
    try {
      const picked = await prefilter(messages.slice(-40));
      out.screened += Math.min(40, messages.length);
      if (!picked.length) continue;
      // The flagged messages, with a little of what came just before each for context
      const shown = messages.slice(-40).filter((_, i) => picked.includes(i + 1) || picked.includes(i + 2));
      out.read += shown.length;
      const found = await matchChanges({ id: clientId, name }, shown, tasks.get(clientId) ?? []);
      for (const [i, c] of found.entries()) {
        const m = c.message ? shown[c.message - 1] : null;
        const id = await saveChange(admin, clientId, c, { source: m?.source ?? "slack", sourceRef: m ? `${m.ref}#${i}` : `run:${started.toISOString()}:${clientId}#${i}`, url: m?.url ?? null, saidAt: m?.at ?? started.toISOString(), detectedBy: "ai", createdBy: null });
        if (!id) continue;
        out.changes++;
        out.told += (await notifyChange(admin, id)).told;
      }
    } catch (e) {
      out.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (callIds.length) await admin.from("client_calls").update({ direction_checked_at: started.toISOString() }).in("id", callIds);
  await setCursor(admin, "direction", started, out);
  return out;
}

// ─── A person logs one ───────────────────────────────────────────────────────

export type LoggedResult = { ok: true; id: string; summary: string; tasks: { title: string; stage: string; suggestion: string; why: string; verdict: Verdict }[] } | { ok: false; error: string };

/** A change someone heard about (a call, a WhatsApp, anywhere): the same matcher on the client's open tasks */
export async function logChange(db: Db, admin: Db, me: Staff, clientId: string, said: string, source: "team" | "assistant" = "team", line: ChangeLineId | null = null): Promise<LoggedResult> {
  const words = String(said ?? "").trim().slice(0, 3000);
  if (words.length < 8) return { ok: false, error: "Say what the client changed, in a sentence." };
  const { data: client } = await db.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "That client isn't one you can see." };
  const tasks = (await loadOpenTasks(admin, [clientId])).get(clientId) ?? [];
  const now = new Date().toISOString();
  let found: CleanChange[] = [];
  try {
    found = await matchChanges({ id: clientId, name: client.name as string }, [{ source, ref: "logged", at: now, author: me.fullName.split(" ")[0] || "The team", title: null, body: words, url: null }], tasks, true);
  } catch (e) {
    console.error("[direction] match", e instanceof Error ? e.message : e);
  }
  const picked: CleanChange = found[0] ?? { kind: "other", scope: "direction", lines: [], summary: noDash(clip(words, 150)), was: "", now: "", quote: noDash(clip(words, 300)), message: 1, tasks: [] };
  // Logged from a team's tab: that team's, whatever else it touches
  const change: CleanChange = line && !picked.lines.includes(line) ? { ...picked, lines: [...picked.lines, line] } : picked;
  const id = await saveChange(admin, clientId, change, { source, sourceRef: null, url: null, saidAt: now, detectedBy: "person", createdBy: me.id });
  if (!id) return { ok: false, error: "It couldn't be saved." };
  await notifyChange(admin, id, me.id);
  // The person who logged it sees it in their list too
  const { data: row } = await admin.from("client_direction_changes").select("notified").eq("id", id).maybeSingle();
  const notified = new Set(((row?.notified ?? []) as string[]).concat(me.id));
  await admin.from("client_direction_changes").update({ notified: [...notified] }).eq("id", id);
  return { ok: true, id, summary: change.summary, tasks: change.tasks.map((t) => ({ title: t.title, stage: stageLabel(t.kind, t.stage), suggestion: t.fix === "stop" ? "Stop" : t.suggested ? `Send back to ${stageLabel(t.kind, t.suggested)}` : "Update the brief", why: t.why, verdict: t.verdict })) };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export type ChangeTask = {
  id: string;
  kind: TaskKind;
  ref: string;
  title: string;
  stage: string | null;
  stageLabel: string;
  verdict: Verdict;
  why: string | null;
  fix: Fix;
  suggested: string | null;
  action: TaskAction;
  toStage: string | null;
  actedBy: string | null;
  actedAt: string | null;
  href: string;
  url: string | null;
  withClient: boolean;
};
export type ChangeView = {
  id: string;
  client: { id: string; name: string; slug: string };
  kind: ChangeKind;
  scope: ChangeScope;
  summary: string;
  was: string | null;
  now: string | null;
  quote: string | null;
  source: ChangeSource;
  url: string | null;
  saidAt: string | null;
  detectedBy: "ai" | "person";
  createdBy: string | null;
  status: "open" | "handled" | "dismissed";
  handledAt: string | null;
  createdAt: string;
  tasks: ChangeTask[];
};

/** One change, whole, as this person may see it (their own session) */
export async function loadChange(db: Db, id: string): Promise<ChangeView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data: c } = await db.from("client_direction_changes").select("*, clients(id, name, slug), creator:profiles!client_direction_changes_created_by_fkey(full_name)").eq("id", id).maybeSingle();
  if (!c) return null;
  const { data: rows } = await db.from("direction_change_tasks").select("*, actor:profiles!direction_change_tasks_acted_by_fkey(full_name)").eq("change_id", id).order("created_at");
  const list = rows ?? [];
  const refs = (k: TaskKind) => list.filter((t) => t.task_kind === k).map((t) => t.task_ref as string);
  // Where each one is now, and its link
  const [a1, a2, k1, k2] = await Promise.all([
    refs("asana_creative").length ? db.from("asana_tasks").select("gid, stage, url").in("gid", refs("asana_creative")) : Promise.resolve({ data: [] }),
    refs("asana_email").length ? db.from("email_asana_tasks").select("gid, stage, url").in("gid", refs("asana_email")) : Promise.resolve({ data: [] }),
    refs("creative").length ? db.from("requests").select("id, number, stage").in("id", refs("creative")) : Promise.resolve({ data: [] }),
    refs("email").length ? db.from("email_tickets").select("id, number, stage").in("id", refs("email")) : Promise.resolve({ data: [] }),
  ]);
  const live = new Map<string, { stage: string | null; url?: string | null; number?: number | null }>();
  for (const r of (a1.data ?? []) as { gid: string; stage: string | null; url: string | null }[]) live.set(`asana_creative:${r.gid}`, r);
  for (const r of (a2.data ?? []) as { gid: string; stage: string | null; url: string | null }[]) live.set(`asana_email:${r.gid}`, r);
  for (const r of (k1.data ?? []) as { id: string; number: number; stage: string }[]) live.set(`creative:${r.id}`, r);
  for (const r of (k2.data ?? []) as { id: string; number: number; stage: string }[]) live.set(`email:${r.id}`, r);
  const client = c.clients as unknown as { id: string; name: string; slug: string };
  return {
    id: c.id as string,
    client,
    kind: c.kind as ChangeKind,
    scope: ((c.scope as ChangeScope | null) ?? "direction") as ChangeScope,
    summary: c.summary as string,
    was: (c.was_text as string | null) ?? null,
    now: (c.now_text as string | null) ?? null,
    quote: (c.quote as string | null) ?? null,
    source: c.source as ChangeSource,
    url: (c.url as string | null) ?? null,
    saidAt: (c.said_at as string | null) ?? null,
    detectedBy: c.detected_by as "ai" | "person",
    createdBy: (c.creator as unknown as { full_name: string } | null)?.full_name ?? null,
    status: c.status as ChangeView["status"],
    handledAt: (c.handled_at as string | null) ?? null,
    createdAt: c.created_at as string,
    tasks: list.map((t) => {
      const kind = t.task_kind as TaskKind;
      const now = live.get(`${kind}:${t.task_ref}`);
      const stage = (now?.stage ?? (t.stage_at_flag as string | null)) || null;
      return {
        id: t.id as string,
        kind,
        ref: t.task_ref as string,
        title: t.title as string,
        stage,
        stageLabel: stageLabel(kind, stage),
        verdict: t.verdict as Verdict,
        why: (t.why as string | null) ?? null,
        fix: t.fix as Fix,
        suggested: (t.suggested_stage as string | null) ?? null,
        action: t.action as TaskAction,
        toStage: (t.to_stage as string | null) ?? null,
        actedBy: (t.actor as unknown as { full_name: string } | null)?.full_name ?? null,
        actedAt: (t.acted_at as string | null) ?? null,
        href: taskHref(kind, t.task_ref as string, now?.number ?? null),
        url: now?.url ?? null,
        withClient: withClient(kind, stage),
      };
    }),
  };
}

export type ChangeLine = { id: string; clientId: string; client: string; slug: string; summary: string; quote: string | null; source: ChangeSource; saidAt: string | null; createdAt: string; pending: number; total: number; withClient: boolean; href: string; scope: ChangeScope; lines: ChangeLineId[] };

/** Open changes: for one client, or the ones this person was told about */
export async function openChanges(db: Db, opts: { clientId?: string | null; notified?: string | null; limit?: number; /** Revisions to one piece too (the client page's team tabs); off everywhere else */ revisions?: boolean }): Promise<ChangeLine[]> {
  let q = db.from("client_direction_changes").select("id, client_id, summary, quote, source, said_at, created_at, scope, lines, clients(name, slug), direction_change_tasks(action, verdict, stage_at_flag, task_kind)").eq("status", "open").order("created_at", { ascending: false }).limit(opts.limit ?? 20);
  if (!opts.revisions) q = q.eq("scope", "direction");
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  if (opts.notified) q = q.contains("notified", [opts.notified]);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []).map((c) => {
    const cl = c.clients as unknown as { name: string; slug: string };
    const tasks = (c.direction_change_tasks ?? []) as { action: string; verdict: string; stage_at_flag: string | null; task_kind: TaskKind }[];
    const pending = tasks.filter((t) => t.action === "pending");
    return {
      id: c.id as string,
      clientId: c.client_id as string,
      client: cl?.name ?? "",
      slug: cl?.slug ?? "",
      summary: c.summary as string,
      quote: (c.quote as string | null) ?? null,
      source: c.source as ChangeSource,
      saidAt: (c.said_at as string | null) ?? null,
      createdAt: c.created_at as string,
      pending: pending.length,
      total: tasks.length,
      withClient: pending.some((t) => t.verdict === "affected" && withClient(t.task_kind, t.stage_at_flag)),
      href: changeHref(cl?.slug ?? "", c.id as string),
      scope: ((c.scope as ChangeScope | null) ?? "direction") as ChangeScope,
      lines: ((c.lines ?? []) as ChangeLineId[]).filter(Boolean),
    };
  });
}

export type TaskFlag = { changeId: string; taskId: string; /** A revision to this piece, or the client changing direction */ scope: ChangeScope; summary: string; quote: string | null; why: string | null; verdict: Verdict; fix: Fix; suggested: string | null; client: string; slug: string };

/** Every pending flag on open changes, by "<kind>:<ref>" (the boards' chips and the ticket banners) */
export async function loadTaskFlags(db: Db): Promise<Record<string, TaskFlag>> {
  const { data, error } = await db
    .from("direction_change_tasks")
    .select("id, task_kind, task_ref, why, verdict, fix, suggested_stage, change:client_direction_changes!inner(id, summary, quote, status, scope, clients(name, slug))")
    .eq("action", "pending")
    .eq("change.status", "open")
    .limit(1000);
  if (error) return {};
  const out: Record<string, TaskFlag> = {};
  for (const t of data ?? []) {
    const ch = t.change as unknown as { id: string; summary: string; quote: string | null; scope: ChangeScope | null; clients: { name: string; slug: string } | null };
    const key = `${t.task_kind}:${t.task_ref}`;
    if (out[key] && out[key].verdict === "affected") continue;
    out[key] = { changeId: ch.id, taskId: t.id as string, scope: ch.scope ?? "direction", summary: ch.summary, quote: ch.quote, why: (t.why as string | null) ?? null, verdict: t.verdict as Verdict, fix: t.fix as Fix, suggested: (t.suggested_stage as string | null) ?? null, client: ch.clients?.name ?? "", slug: ch.clients?.slug ?? "" };
  }
  return out;
}

/** Kaizen creative tickets held back from client reminders and auto-approval: flagged affected and not acted on yet */
export async function heldRequestIds(admin: Db): Promise<Set<string>> {
  const { data, error } = await admin.from("direction_change_tasks").select("task_ref, change:client_direction_changes!inner(status)").eq("task_kind", "creative").eq("action", "pending").eq("verdict", "affected").eq("change.status", "open");
  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.task_ref as string));
}

// ─── Acting ──────────────────────────────────────────────────────────────────

export type ActHow = "send_back" | "keep" | "stop";
export type ActResult = { ok: true; done: number; failed: { title: string; error: string }[]; handled: boolean; /** The tasks acted on, for Undo */ acted: string[] } | { ok: false; error: string; /** They haven't connected their own Asana: show Connect */ connect?: boolean };

/** Moves an Asana Creative task to the column for a stage, and the mirror with it */
async function moveAsanaCreative(admin: Db, gid: string, stage: string) {
  return moveAsanaCreativeTo(admin, gid, stage);
}

/** The stage an Asana task sits in now (from the mirror), so Undo can put it back */
async function asanaStageOf(admin: Db, kind: TaskKind, gid: string): Promise<string | null> {
  const { data } = await admin.from(kind === "asana_email" ? "email_asana_tasks" : "asana_tasks").select("stage").eq("gid", gid).maybeSingle();
  return (data?.stage as string | null) ?? null;
}

async function moveAsanaCreativeTo(admin: Db, gid: string, stage: string) {
  const { asana, asanaWrite, projectGid, stageForColumn } = await import("@/lib/asana");
  const project = await projectGid(admin);
  const { data: sections } = await asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" });
  const to = sections.find((x) => stageForColumn(x.name) === stage);
  if (!to) throw new Error(`The Creative board in Asana has no column for ${stage.replace(/_/g, " ")}.`);
  await asanaWrite(`/sections/${to.gid}/addTask`, { task: gid });
  const { data: task } = await admin.from("asana_tasks").select("section, moves").eq("gid", gid).maybeSingle();
  const moves = [...((task?.moves ?? []) as { from: string | null; to: string | null; at: string }[]), { from: (task?.section as string | null) ?? null, to: to.name, at: new Date().toISOString() }].slice(-30);
  await admin.from("asana_tasks").update({ section: to.name, stage, moves, synced_at: new Date().toISOString() }).eq("gid", gid);
}

/** A comment on the Asana task, so the maker sees it inside Asana; its id comes back (Undo takes it off) */
async function asanaStory(gid: string, text: string): Promise<string | null> {
  const { asanaWrite } = await import("@/lib/asana");
  const s = await asanaWrite<{ gid?: string }>(`/tasks/${gid}/stories`, { text: text.slice(0, 6000) });
  return s?.gid ?? null;
}

/** The comment in Asana's rich text (the client's feedback quoted, links clickable); its id comes back */
async function asanaRichStory(gid: string, html: string): Promise<string | null> {
  const { asanaWrite } = await import("@/lib/asana");
  const s = await asanaWrite<{ gid?: string }>(`/tasks/${gid}/stories`, { html_text: html.slice(0, 60000) });
  return s?.gid ?? null;
}

/**
 * Acts on flagged tasks as the person (only tasks on clients they can see): sends each back to its suggested stage (or
 * the one they picked) with the client's new direction as the note, keeps it as it is, or stops it (a Kaizen ticket is
 * removed the board's own way, never deleted for good; an Asana task gets a comment and is left for its owner). When
 * every task of a change is acted on, the change is handled.
 */
export async function actOnTasks(db: Db, admin: Db, me: Staff, taskIds: string[], how: ActHow, opts: { to?: Record<string, string>; note?: string | null } = {}): Promise<ActResult> {
  const ids = [...new Set(taskIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 60);
  if (!ids.length) return { ok: false, error: "Pick the tasks first." };
  const { data: rows } = await db.from("direction_change_tasks").select("*, change:client_direction_changes!inner(id, summary, quote, was_text, now_text, status, scope, source_ref, url, said_at)").in("id", ids);
  const tasks = rows ?? [];
  if (!tasks.length) return { ok: false, error: "Those tasks aren't ones you can see." };
  // Asana comments and moves go in as the person (their own Asana), never as someone else: connect first
  const { asanaAsPerson, hasMyAsana } = await import("@/lib/asana-user");
  if (how !== "keep" && tasks.some((t) => isAsana(t.task_kind as TaskKind)) && !(await hasMyAsana(admin, me.id))) {
    const { ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
    return { ok: false, error: ASANA_CONNECT_SAY, connect: true };
  }
  return asanaAsPerson(admin, me.id, () => actOnTasksAs(db, admin, me, tasks, how, opts));
}

async function actOnTasksAs(db: Db, admin: Db, me: Staff, tasks: Record<string, unknown>[], how: ActHow, opts: { to?: Record<string, string>; note?: string | null }): Promise<ActResult> {
  const note = clip(opts.note, 600) || null;
  const failed: { title: string; error: string }[] = [];
  const acted: string[] = [];
  let done = 0;
  // The client's own message behind each change, read once: quoted whole with its links and files in every comment
  const { loadFeedback, attachSlackFiles } = await import("@/lib/direction-feedback");
  const { feedbackCommentHtml, feedbackCommentText } = await import("@/lib/direction-feedback-core");
  const feedbacks = new Map<string, Awaited<ReturnType<typeof loadFeedback>>>();
  const feedbackFor = async (ch: { id: string; source_ref?: string | null; url?: string | null; said_at?: string | null; quote: string | null }) => {
    if (!feedbacks.has(ch.id)) feedbacks.set(ch.id, await loadFeedback(admin, { source_ref: ch.source_ref ?? null, url: ch.url ?? null, said_at: ch.said_at ?? null, quote: ch.quote }).catch(() => null));
    return feedbacks.get(ch.id) ?? null;
  };
  const now = new Date().toISOString();
  const { asanaConfigured } = await import("@/lib/asana");
  for (const t of tasks) {
    const kind = t.task_kind as TaskKind;
    const ref = t.task_ref as string;
    const ch = t.change as unknown as { id: string; summary: string; quote: string | null; was_text: string | null; now_text: string | null; scope: string | null; source_ref: string | null; url: string | null; said_at: string | null };
    const fix = t.fix as Fix;
    const undo: { stories: string[]; attachments: string[]; from: string | null; kind: TaskKind; at: string } = { stories: [], attachments: [], from: null, kind, at: now };
    const text = directionNote({ summary: ch.summary, quote: ch.quote, was: ch.was_text, now: ch.now_text, scope: ch.scope }, { fix: how === "stop" ? "stop" : fix, why: t.why as string | null }, note);
    const picked = opts.to?.[t.id as string] ?? null;
    const line = lineOf(kind);
    const allowed = (BACK_STAGES[line] as string[]).concat(line === "creative" ? ["client_revision"] : ["revisions"]);
    const target = how === "send_back" ? (picked && allowed.includes(picked) ? picked : (t.suggested_stage as string | null)) : null;
    try {
      if (how === "send_back") {
        if (isAsana(kind)) {
          if (!asanaConfigured()) throw new Error("Asana isn't connected here.");
          undo.from = await asanaStageOf(admin, kind, ref);
          if (target) {
            if (kind === "asana_creative") await moveAsanaCreative(admin, ref, target);
            else {
              const { moveEmailTaskInAsana } = await import("@/lib/asana-email");
              await moveEmailTaskInAsana(admin, ref, target as never);
            }
          }
          // The direction and the client's full feedback (links clickable, files attached), as the person
          const fb = await feedbackFor(ch);
          const files = fb?.slackFiles.length ? await attachSlackFiles(ref, fb.slackFiles) : { attached: [], ids: [] };
          undo.attachments.push(...files.ids);
          const story = await asanaRichStory(ref, feedbackCommentHtml(text, fb, files.attached, target ? `Moved back to ${stageLabel(kind, target)} from Kaizen OS.` : null)).catch(async (e) => {
            const { isAsanaConnectNeeded } = await import("@/lib/asana-connect");
            if (isAsanaConnectNeeded(e)) throw e;
            // Asana refused the rich text: the same as plain text
            return asanaStory(ref, `${feedbackCommentText(text, fb)}${target ? `\n\nMoved back to ${stageLabel(kind, target)} from Kaizen OS.` : ""}`);
          });
          if (story) undo.stories.push(story);
        } else if (kind === "creative") {
          const { data: r } = await db.from("requests").select("id, stage, client_id").eq("id", ref).maybeSingle();
          if (!r) throw new Error("That ticket isn't on the board any more.");
          undo.from = r.stage as string;
          if (target && r.stage !== target) {
            const { moveTicket } = await import("@/app/(team)/board/actions");
            const res = await moveTicket(ref, target as never, text);
            if (!res.ok) throw new Error(res.error);
          }
          await admin.from("request_events").insert({ request_id: ref, kind: "direction", actor_id: me.id, body: feedbackCommentText(text, await feedbackFor(ch)), data: { change: ch.id, to: target } });
        } else {
          const { data: e } = await db.from("email_tickets").select("id, stage, client_id").eq("id", ref).is("deleted_at", null).maybeSingle();
          if (!e) throw new Error("That ticket isn't on the board any more.");
          undo.from = e.stage as string;
          const { moveEmailTicket, logEvent } = await import("@/lib/email-board");
          if (target && e.stage !== target) await moveEmailTicket(admin, ref, target as never, { id: me.id, name: me.fullName }, text);
          await logEvent(admin, { ticketId: ref, clientId: e.client_id as string, kind: "direction", actorId: me.id, actorName: me.fullName, body: feedbackCommentText(text, await feedbackFor(ch)), data: { change: ch.id, to: target } });
        }
      } else if (how === "stop") {
        const reason = `Client changed direction: ${ch.summary}`.slice(0, 300);
        if (isAsana(kind)) {
          if (asanaConfigured()) {
            const story = await asanaRichStory(ref, feedbackCommentHtml(`The client stopped this: ${ch.summary}.\nCheck before finishing it. Left open in Asana for its owner to close.`, await feedbackFor(ch))).catch(() => null);
            if (story) undo.stories.push(story);
          }
        } else if (kind === "creative") {
          const { deleteTicket } = await import("@/app/(team)/board/actions");
          const res = await deleteTicket(ref, reason);
          if (!res.ok) await admin.from("request_events").insert({ request_id: ref, kind: "direction", actor_id: me.id, body: `${text}\nStopped: an exec or lead removes it from the board.`, data: { change: ch.id, stopped: true } });
        } else {
          const { deleteEmailTicket } = await import("@/app/(team)/board/email/actions");
          const res = await deleteEmailTicket(ref, reason);
          if (!res.ok) {
            const { data: e } = await admin.from("email_tickets").select("client_id").eq("id", ref).maybeSingle();
            const { logEvent } = await import("@/lib/email-board");
            if (e) await logEvent(admin, { ticketId: ref, clientId: e.client_id as string, kind: "direction", actorId: me.id, actorName: me.fullName, body: `${text}\nStopped: an exec or the Head of Email removes it from the board.`, data: { change: ch.id, stopped: true } });
          }
        }
      }
      const action: TaskAction = how === "send_back" ? "sent_back" : how === "keep" ? "kept" : "stopped";
      await db.from("direction_change_tasks").update({ action, to_stage: target, acted_by: me.id, acted_at: now, undo }).eq("id", t.id);
      acted.push(t.id as string);
      done++;
    } catch (e) {
      const { isAsanaConnectNeeded, ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
      if (isAsanaConnectNeeded(e)) return { ok: false, error: ASANA_CONNECT_SAY, connect: true };
      failed.push({ title: t.title as string, error: e instanceof Error ? e.message.replace(/^Asana: /, "Asana said: ") : "It didn't go through." });
    }
  }
  const changeIds = [...new Set(tasks.map((t) => (t.change as unknown as { id: string }).id))];
  let handled = false;
  for (const cid of changeIds) handled = (await closeIfDone(db, cid, me.id)) || handled;
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/board");
  revalidatePath("/board/email");
  return { ok: true, done, failed, handled, acted };
}

/**
 * Undo, right after applying: the comments and files Kaizen OS posted on Asana tasks are taken off and each task goes
 * back to the stage it was in (as the person who applied it), Kaizen tickets go back too, and the tasks are flagged
 * again. Only the person who applied it, within an hour.
 */
export async function undoActs(db: Db, admin: Db, me: Staff, taskIds: string[]): Promise<{ ok: true; undone: number; failed: string[] } | { ok: false; error: string; connect?: boolean }> {
  const ids = [...new Set(taskIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 60);
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { data: rows } = ids.length ? await db.from("direction_change_tasks").select("id, change_id, task_kind, task_ref, title, undo, to_stage, acted_by, acted_at").in("id", ids).eq("acted_by", me.id).gte("acted_at", since) : { data: [] };
  const tasks = rows ?? [];
  if (!tasks.length) return { ok: false, error: "There's nothing of yours to undo here any more (Undo works for an hour)." };
  const { asanaAsPerson, hasMyAsana } = await import("@/lib/asana-user");
  if (tasks.some((t) => isAsana(t.task_kind as TaskKind)) && !(await hasMyAsana(admin, me.id))) {
    const { ASANA_CONNECT_SAY } = await import("@/lib/asana-connect");
    return { ok: false, error: ASANA_CONNECT_SAY, connect: true };
  }
  return asanaAsPerson(admin, me.id, async () => {
    const { asanaRemove } = await import("@/lib/asana");
    const failed: string[] = [];
    let undone = 0;
    for (const t of tasks) {
      const u0 = (t.undo ?? {}) as { stories?: string[]; attachments?: string[]; from?: string | null };
      // Moved only when it was moved: a note left in place goes back to nothing
      const u = { ...u0, from: t.to_stage ? (u0.from ?? null) : null };
      const kind = t.task_kind as TaskKind;
      const ref = t.task_ref as string;
      try {
        if (isAsana(kind)) {
          for (const s of u.stories ?? []) await asanaRemove(`/stories/${s}`).catch(() => undefined);
          for (const a of u.attachments ?? []) await asanaRemove(`/attachments/${a}`).catch(() => undefined);
          if (u.from) {
            if (kind === "asana_creative") await moveAsanaCreativeTo(admin, ref, u.from);
            else {
              const { moveEmailTaskInAsana } = await import("@/lib/asana-email");
              await moveEmailTaskInAsana(admin, ref, u.from as never);
            }
          }
        } else if (kind === "creative" && u.from) {
          const { moveTicket } = await import("@/app/(team)/board/actions");
          await moveTicket(ref, u.from as never, "Undone: back where it was before the client's feedback was applied.");
        } else if (kind === "email" && u.from) {
          const { moveEmailTicket } = await import("@/lib/email-board");
          await moveEmailTicket(admin, ref, u.from as never, { id: me.id, name: me.fullName }, "Undone: back where it was before the client's feedback was applied.");
        }
        await db.from("direction_change_tasks").update({ action: "pending", to_stage: null, acted_by: null, acted_at: null, undo: null }).eq("id", t.id);
        await db.from("client_direction_changes").update({ status: "open", handled_by: null, handled_at: null }).eq("id", t.change_id as string).eq("status", "handled");
        undone++;
      } catch (e) {
        failed.push(`${t.title as string}: ${e instanceof Error ? e.message : "it couldn't be undone"}`);
      }
    }
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/board");
    revalidatePath("/board/email");
    return { ok: true as const, undone, failed };
  });
}

/** Every task acted on: the change is handled */
async function closeIfDone(db: Db, changeId: string, by: string): Promise<boolean> {
  const { data } = await db.from("direction_change_tasks").select("action").eq("change_id", changeId);
  if (!allActed((data ?? []) as { action: TaskAction }[])) return false;
  await db.from("client_direction_changes").update({ status: "handled", handled_by: by, handled_at: new Date().toISOString() }).eq("id", changeId).eq("status", "open");
  return true;
}

/** Closes a change: dismissed (the AI misread it) or handled (nothing left to do) */
export async function closeChange(db: Db, me: Staff, changeId: string, status: "dismissed" | "handled"): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await db.from("client_direction_changes").update({ status, handled_by: me.id, handled_at: new Date().toISOString() }).eq("id", changeId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "That change isn't one you can see." };
  return { ok: true };
}

/** The heads-up on the request form: this client's open changes and their flagged tasks still waiting */
export async function headsUpFor(db: Db, clientId: string): Promise<{ id: string; summary: string; pending: number; href: string; titles: string[] } | null> {
  const lines = await openChanges(db, { clientId, limit: 5 });
  const first = lines.find((l) => l.pending > 0);
  if (!first) return null;
  const { data } = await db.from("direction_change_tasks").select("title").eq("change_id", first.id).eq("action", "pending").limit(12);
  return { id: first.id, summary: first.summary, pending: first.pending, href: first.href, titles: (data ?? []).map((t) => t.title as string) };
}
