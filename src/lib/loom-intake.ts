import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { addKnowledgeText, forgetIndex, type KnowledgeTarget } from "@/lib/knowledge";
import { casesDoc, DISTILL, DISTILL_RULES, saveInsights, type Distilled } from "@/lib/buying-insights";
import { listLoomFolder, readLoom } from "@/lib/loom";
import { loomFolders, loomLinks } from "@/lib/loom-links";

// Loom videos into the agents' knowledge, automatically. Every intake path (a link posted in Slack, Zapier or an email
// rule posting to /api/loom, a pasted list of links, a shared folder read daily) queues the video here; a background
// worker, a few at a time, reads each one (title and transcript, from Loom), has the Media Buyer classify it on the
// start of its transcript (fast and cheap), and only the ones worth filing get the full read:
//   ad-buying method → the Media Buyer's knowledge (every skill: auditor, launcher, fatigue…), and the Google auditor's
//   when it's about Google Ads;
//   a client situation → that client's knowledge, plus memory notes for what it settles (dated to the recording);
//   neither (internal, admin, personal) → skipped, kept as a record.
// A client situation whose client isn't clear waits in Settings › AI agents › Knowledge for someone to pick it.
// Client knowledge is never deleted.

type Admin = SupabaseClient;
export type LoomSource = "slack" | "webhook" | "bulk" | "client" | "folder";
export type LoomIntake = {
  source: LoomSource;
  by?: string | null;
  /** The client the intake points at (the Slack channel, the client page, the folder's client) */
  clientId?: string | null;
  /** A client named by the sender (Zapier's `client` field), matched to our clients when it can be */
  clientText?: string | null;
  folder?: string | null;
  folderRef?: string | null;
  sourceRef?: string | null;
  recordedAt?: string | null;
};

const MEDIA_BUYER = "role:media_buyer";
const GOOGLE = "google_auditor";
/** How much of the transcript the classification reads (the full read is only for what gets filed) */
const CLASSIFY_CHARS = 6000;
const FILE_CHARS = 90_000;
const DAY = 86_400_000;

const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").trim();
const dateOf = (iso: string | null | undefined) => (iso ?? new Date().toISOString()).slice(0, 10);

// ─── Queueing ───────────────────────────────────────────────────────────────

/** A client named in free text (a Kaizen ID, a slug, the name, or part of it when only one client fits) */
export async function matchClient(admin: Admin, text: string | null | undefined): Promise<string | null> {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (/^[0-9a-f-]{36}$/i.test(t)) {
    const { data } = await admin.from("clients").select("id").eq("id", t).maybeSingle();
    if (data) return data.id as string;
  }
  if (/^\d+$/.test(t)) {
    const { data } = await admin.from("clients").select("id").eq("kaizen_id", Number(t)).maybeSingle();
    if (data) return data.id as string;
  }
  const { data: all } = await admin.from("clients").select("id, name, slug").is("archived_at", null);
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const k = n(t);
  const exact = (all ?? []).filter((c) => n(c.name as string) === k || c.slug === t.toLowerCase());
  if (exact.length === 1) return exact[0].id as string;
  const part = (all ?? []).filter((c) => k.length >= 4 && (` ${n(c.name as string)} `.includes(` ${k} `) || ` ${k} `.includes(` ${n(c.name as string)} `)));
  return part.length === 1 ? (part[0].id as string) : null;
}

/** Videos into the queue. A video already queued or filed is skipped (one row per Loom video, ever). */
export async function queueLooms(admin: Admin, videos: { id: string; url: string; title?: string | null; folder?: string | null }[], intake: LoomIntake) {
  const hint = intake.clientId ?? (await matchClient(admin, intake.clientText));
  const ids: string[] = [];
  for (let i = 0; i < videos.length; i += 200) {
    const rows = videos.slice(i, i + 200).map((v) => ({
      loom_id: v.id,
      url: v.url,
      title: v.title?.slice(0, 300) || null,
      folder: (v.folder ?? intake.folder)?.slice(0, 200) || null,
      folder_ref: intake.folderRef ?? null,
      hint_client_id: hint,
      hint_client: intake.clientText?.slice(0, 200) || null,
      source: intake.source,
      source_ref: intake.sourceRef ?? null,
      recorded_at: intake.recordedAt ?? null,
      by: intake.by ?? null,
    }));
    const { data, error } = await admin.from("loom_videos").upsert(rows, { onConflict: "loom_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(error.message);
    ids.push(...(data ?? []).map((d) => d.id as string));
  }
  return { added: ids.length, skipped: videos.length - ids.length, ids };
}

/** Every Loom link in a piece of text (a Slack message, an email, a pasted list), queued */
export async function queueLoomText(admin: Admin, text: string, intake: LoomIntake) {
  const links = loomLinks(text);
  if (!links.length) return { added: 0, skipped: 0, ids: [] as string[] };
  return queueLooms(admin, links, intake);
}

// ─── Shared folders ─────────────────────────────────────────────────────────

const PRIVATE_FOLDER =
  "Loom showed no videos in this folder. In Loom, open the folder, click Share and turn on the public link (anyone with the link can view). Videos set to private inside it stay hidden: set them to anyone with the link too.";

/** A shared folder saved and read now: every video in it queued. Returns the folder row's id and what was found. */
export async function addLoomFolder(admin: Admin, url: string, opts: { clientId?: string | null; agentHint?: "method" | "client" | null; by?: string | null }) {
  const f = loomFolders(url)[0];
  if (!f) throw new Error(/loom\.com\/spaces\//i.test(url) ? "That's a Loom Space, which only its members can open. Put the videos in a folder and share the folder's link instead." : "That isn't a Loom folder link (loom.com/share/folder/…).");
  const { data, error } = await admin
    .from("loom_folders")
    .upsert({ folder_id: f.id, url: f.url, client_id: opts.clientId ?? null, agent_hint: opts.agentHint ?? null, by: opts.by ?? null }, { onConflict: "folder_id" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the folder.");
  return { id: data.id as string, ...(await syncLoomFolder(admin, data.id as string)) };
}

/** One folder read again: new videos queued, the count and any problem kept on it */
export async function syncLoomFolder(admin: Admin, folderRow: string) {
  const { data: f } = await admin.from("loom_folders").select("id, folder_id, client_id, by").eq("id", folderRow).single();
  if (!f) throw new Error("Folder not found.");
  const list = await listLoomFolder(f.folder_id as string);
  const now = new Date().toISOString();
  if (!list.readable) {
    const error = list.error && !/not authorized|not found/i.test(list.error) ? `Loom's folder page didn't answer as expected (${list.error.slice(0, 120)}). Paste the video links instead, or try again later.` : PRIVATE_FOLDER;
    await admin.from("loom_folders").update({ last_checked_at: now, error }).eq("id", f.id);
    return { found: 0, added: 0, error };
  }
  const q = await queueLooms(admin, list.videos, { source: "folder", clientId: (f.client_id as string | null) ?? null, folderRef: f.id as string, by: (f.by as string | null) ?? null });
  await admin.from("loom_folders").update({ last_checked_at: now, error: null, video_count: list.videos.length, ...(list.name ? { name: list.name.slice(0, 200) } : {}) }).eq("id", f.id);
  return { found: list.videos.length, added: q.added, error: null as string | null };
}

/** Folders not checked for a day: read again (a couple a run) */
export async function recheckLoomFolders(admin: Admin, max = 3) {
  const { data } = await admin.from("loom_folders").select("id, last_checked_at").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(20);
  const due = (data ?? []).filter((f) => !f.last_checked_at || Date.now() - new Date(f.last_checked_at as string).getTime() > 20 * 3_600_000).slice(0, max);
  const out: { found: number; added: number; error: string | null }[] = [];
  for (const f of due) out.push(await syncLoomFolder(admin, f.id as string).catch((e) => ({ found: 0, added: 0, error: e instanceof Error ? e.message : String(e) })));
  return { checked: due.length, added: out.reduce((n, o) => n + o.added, 0) };
}

// ─── Reading and filing ─────────────────────────────────────────────────────

type Row = {
  id: string;
  loom_id: string;
  url: string;
  title: string | null;
  description: string | null;
  folder: string | null;
  transcript: string | null;
  status: string;
  hint_client_id: string | null;
  hint_client: string | null;
  source: LoomSource;
  recorded_at: string | null;
  attempts: number;
  by: string | null;
  created_at: string;
  result: Record<string, unknown> | null;
};

type ClientRef = { id: string; name: string; former: boolean; aliases: string[]; industry: string | null };

/** Our clients as the classification sees them: name, website and ad account names (archived ones marked former) */
async function clientList(admin: Admin): Promise<ClientRef[]> {
  const [{ data: cs }, { data: kpis }] = await Promise.all([
    admin.from("clients").select("id, name, website, archived_at, internal, industry").order("name"),
    admin.from("kpi_targets").select("client_id, label").eq("active", true),
  ]);
  const labels = new Map<string, Set<string>>();
  for (const k of kpis ?? []) if (k.label) (labels.get(k.client_id as string) ?? labels.set(k.client_id as string, new Set()).get(k.client_id as string)!).add(String(k.label));
  return (cs ?? [])
    .filter((c) => !c.internal)
    .map((c) => {
      const site = ((c.website as string | null) ?? "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/.*$/, "");
      return { id: c.id as string, name: c.name as string, former: Boolean(c.archived_at), aliases: [...(site ? [site] : []), ...(labels.get(c.id as string) ?? [])].slice(0, 4), industry: (c.industry as string | null) ?? null };
    });
}

const SYSTEM = `You sort the agency's Loom videos into what its AI agents should learn. Kaizen is a paid ads and creative agency (Meta and Google Ads). Most videos are a senior buyer walking through an ad account (how he reads it, what he'd keep, cut, scale or test, and why) or talking through a client's situation; some are neither (internal admin, hiring, tools, personal). Refer to people by role (the exec, a senior buyer, the client), never by name.`;

const CLASSIFY = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["method", "client", "both", "other"] },
    platform: { type: "string", enum: ["meta", "google", "both", "none"] },
    clients: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, sure: { type: "boolean" } }, required: ["n", "sure"], additionalProperties: false } },
    title: { type: "string" },
    summary: { type: "string" },
  },
  required: ["kind", "platform", "clients", "title", "summary"],
  additionalProperties: false,
};

const FILE = {
  type: "object",
  properties: {
    key_points: { type: "array", items: { type: "string" } },
    lessons: { type: "array", items: { type: "object", properties: { rule: { type: "string" }, when: { type: "string" } }, required: ["rule", "when"], additionalProperties: false } },
    situation: { type: "string" },
    memory: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["prefer", "avoid", "note"] }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false } },
  },
  required: ["key_points", "lessons", "situation", "memory"],
  additionalProperties: false,
};

type Classified = { kind: "method" | "client" | "both" | "other"; platform: "meta" | "google" | "both" | "none"; clients: { n: number; sure: boolean }[]; title: string; summary: string };
type Filed = { key_points: string[]; lessons: { rule: string; when: string }[]; situation: string; memory: { kind: "prefer" | "avoid" | "note"; text: string }[]; cases?: string };

const NO_CAPTIONS =
  "Loom has no transcript for this video. In Loom, open the video and turn on captions (the Transcript or Captions option on the video, or switch on auto captions in your Loom settings so every new video gets them), then click Try again.";
const PRIVATE =
  "Loom only shows this video to people signed in to the workspace: it's shared to a Loom Space (workspace only) or private. Either set it to anyone with the link in Loom (open the video, Share, general access: anyone with the link), then Try again; or push its transcript with the Loom browser script (docs/ZAPIER.md, Loom section), which reads it while you're signed in.";

async function update(admin: Admin, id: string, patch: Record<string, unknown>) {
  await admin.from("loom_videos").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/** A knowledge document for this video in this place, once (a second run never files it twice) */
async function fileDoc(admin: Admin, t: KnowledgeTarget, row: Row, doc: { name: string; text: string; title: string; summary: string; keyPoints: string[] }, url = row.url) {
  let q = admin.from("knowledge_docs").select("id").eq("source_url", url).eq("scope", t.scope).is("removed_at", null).limit(1);
  if (t.scope === "agent") q = q.eq("agent_key", t.agentKey);
  if (t.scope === "client") q = q.eq("client_id", t.clientId);
  const { data: had } = await q;
  if (had?.length) return had[0].id as string;
  return addKnowledgeText(admin, t, row.by, { ...doc, url, mime: "text/x-loom", method: "loom" });
}

/** What the video settles for one client: its situation in their knowledge, its durable decisions in memory (dated) */
async function fileForClient(admin: Admin, row: Row, clientId: string, about: { title: string; summary: string }, filed: Filed) {
  const date = dateOf(row.recorded_at ?? row.created_at);
  const text = clean(`# ${about.title}\nA Loom recorded ${date}. ${about.summary}\n\n## The situation\n${filed.situation}\n\n${filed.cases ? `${filed.cases.replace(/^# .*\n/, "## How Kaizen's senior buyer read their account\n")}\n\n` : ""}${filed.key_points.length ? `## Key points\n${filed.key_points.map((k) => `- ${k}`).join("\n")}\n\n` : ""}## Transcript\n${row.transcript ?? ""}`);
  const id = await fileDoc(admin, { scope: "client", clientId }, row, { name: `${about.title} (Loom ${date})`, text, title: about.title, summary: about.summary, keyPoints: filed.key_points });
  const { data: known } = await admin.from("client_memory").select("body").eq("client_id", clientId).eq("source", "loom");
  const have = new Set((known ?? []).map((m) => m.body as string));
  const notes = filed.memory
    .map((m) => ({ client_id: clientId, kind: m.kind, source: "loom", dated: date, created_by: row.by, body: clean(`From a Loom (${date}, "${about.title.slice(0, 80)}"): ${m.text}`).slice(0, 1000) }))
    .filter((m) => m.body.length > 20 && !have.has(m.body))
    .slice(0, 6);
  if (notes.length) await admin.from("client_memory").insert(notes);
  return id;
}

/** Read, classify and file one video (claimed by the worker) */
export async function processLoom(admin: Admin, row: Row) {
  try {
    // 1. Loom: title and transcript (a brand-new recording may not have its captions yet: wait and look again)
    const loom = await readLoom(row.url);
    const fresh = Date.now() - new Date(row.created_at).getTime() < 0.5 * DAY;
    // (A workspace video can have no oEmbed and still a readable transcript: only both missing means Loom won't show it)
    if (!loom.found && !loom.transcript && !row.transcript) {
      if (fresh && row.attempts < 3) return update(admin, row.id, { status: "queued", next_at: new Date(Date.now() + 20 * 60_000).toISOString(), error: "Waiting for Loom to make it viewable" });
      return update(admin, row.id, { status: "failed", error: PRIVATE });
    }
    const transcript = loom.transcript ?? row.transcript;
    const title = loom.title ?? row.title;
    if (!transcript) {
      if (fresh && row.attempts < 5) return update(admin, row.id, { status: "queued", title, description: loom.description, next_at: new Date(Date.now() + 30 * 60_000).toISOString(), error: "Waiting for Loom's captions" });
      return update(admin, row.id, { status: "failed", title, description: loom.description, error: NO_CAPTIONS });
    }
    await update(admin, row.id, { title, description: loom.description ?? row.description, transcript, error: null });
    row = { ...row, title, transcript, description: loom.description ?? row.description };

    // 2. One quick classification on the start of the transcript
    const clients = await clientList(admin);
    const hint = row.hint_client_id ? clients.find((c) => c.id === row.hint_client_id) : null;
    const roster = clients.map((c, i) => `${i + 1}. ${c.name}${c.former ? " (former client)" : ""}${c.aliases.length ? ` · ${c.aliases.join(" · ")}` : ""}`).join("\n");
    const head = `Title: ${row.title ?? "(none)"}${row.description ? `\nDescription: ${row.description.slice(0, 600)}` : ""}${row.folder ? `\nLoom folder: ${row.folder}` : ""}${hint ? `\nWhere it was shared: about ${hint.name} (posted in their channel or added on their page)` : row.hint_client ? `\nThe sender said it's about: ${row.hint_client}` : ""}`;
    const c = await askJson<Classified>({
      agent: "auditor",
      label: "loom classify",
      clientId: row.hint_client_id,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 2500,
      system: SYSTEM,
      schema: CLASSIFY,
      prompt: `${head}\n\n<transcript_start>\n${transcript.slice(0, CLASSIFY_CHARS)}\n</transcript_start>\n\nOur clients (number. name · website · ad account names):\n${roster}\n\nkind: "method" when it teaches how to read, buy or fix ad accounts in a way that applies beyond one client (an account audit walkthrough is method even when it uses one client's account, and usually "both"); "client" when it's about one client's situation (results, a decision, a problem, a plan, the relationship); "both" when it does both; "other" for anything else (internal admin, hiring, tools, personal, a demo for a prospect).\nplatform: which ad platform it's about (none when neither).\nclients: the numbers of the clients it's about, matched by name, brand, website or ad account name said or shown; sure: true only when it's clearly that client. Empty when none or you can't tell.\ntitle: a clear title in a few words (keep Loom's when it's good). summary: two or three sentences on what it covers.`,
    });
    const sure = c.clients.filter((x) => x.sure).map((x) => clients[x.n - 1]).filter(Boolean);
    const unsure = c.clients.filter((x) => !x.sure).map((x) => clients[x.n - 1]).filter(Boolean);
    const about = { title: clean(c.title || row.title || "Loom video").slice(0, 160), summary: clean(c.summary).slice(0, 1500) };
    const base = { kind: c.kind, platform: c.platform, summary: about.summary };

    if (c.kind === "other") return update(admin, row.id, { ...base, status: "skipped", title: row.title ?? about.title, result: { title: about.title, classified: c } });

    // The client(s): where it was shared wins; the AI's sure matches join it
    const forClient = c.kind !== "method";
    const clientIds = [...new Set([...(hint ? [hint.id] : []), ...sure.map((x) => x.id)])];
    const industryOf = (ids: string[]) => (ids.length === 1 ? (clients.find((x) => x.id === ids[0])?.industry ?? null) : null);

    // 3. The full read, only for what gets filed. Ad-buying method is distilled (opus) into the senior buyer's
    // principles, decision rules, cases, diagnostics and voice; a client-only situation gets a lighter read.
    const what = `${head}\nWhat it is: ${c.kind === "both" ? "ad-buying method and a client situation" : c.kind === "method" ? "ad-buying method" : "a client situation"} (${c.platform === "none" ? "no ad platform" : c.platform === "both" ? "Meta and Google" : c.platform === "google" ? "Google Ads" : "Meta"})${clientIds.length ? `, about ${clientIds.map((id) => clients.find((x) => x.id === id)?.name).join(", ")}` : ""}.`;
    const SITUATION = forClient ? "what's going on with the client, as markdown: where things stand, the problem or opportunity, what was decided or recommended and why, what's next. Specific." : "empty.";
    const MEMORY = forClient ? "only durable facts or decisions about this client the team must keep in mind (a standing decision, a constraint, something they want or refuse), one sentence each; kind prefer (do this), avoid (don't), note (a fact). Empty when there are none. Not passing observations or this week's numbers." : "empty.";
    let filed: Filed;
    let distilled: Distilled | null = null;
    if (c.kind === "client") {
      filed = await askJson<Filed>({
        agent: "auditor",
        label: "loom file",
        clientId: clientIds[0] ?? null,
        override: { model: "sonnet", effort: "low" },
        maxTokens: 8000,
        system: SYSTEM,
        schema: FILE,
        prompt: `${what}\n\n<transcript>\n${transcript.slice(0, FILE_CHARS)}\n</transcript>\n\nkey_points: 3 to 8 short lines, the specifics worth knowing.\nlessons: empty.\nsituation: ${SITUATION}\nmemory: ${MEMORY}`,
      });
    } else {
      distilled = await askJson<Distilled>({
        agent: "auditor",
        label: "loom distill",
        clientId: clientIds.length === 1 ? clientIds[0] : null,
        override: { model: "opus", effort: "medium" },
        maxTokens: 24000,
        onText: () => {},
        system: SYSTEM,
        schema: DISTILL,
        prompt: `${what}${industryOf(clientIds) ? `\nThe client's industry: ${industryOf(clientIds)}.` : ""}\n\n<transcript note="[m:ss] marks when each part was said">\n${transcript.slice(0, FILE_CHARS)}\n</transcript>\n\n${DISTILL_RULES}\nkey_points: 3 to 8 short lines, the specifics worth knowing.\nsituation: ${SITUATION}\nmemory: ${MEMORY}`,
      });
      const clientCases = casesDoc(about.title, row.url, distilled, (x) => x.this_client);
      filed = {
        key_points: distilled.key_points,
        lessons: [...distilled.rules.map((r) => ({ rule: `If ${r.if}, then ${r.then}`, when: r.thresholds })), ...distilled.principles.map((p) => ({ rule: p.belief, when: "" }))],
        situation: distilled.situation,
        memory: distilled.memory,
        cases: clientCases ?? undefined,
      };
      await saveInsights(admin, { videoId: row.id, loomId: row.loom_id, clientId: clientIds.length === 1 ? clientIds[0] : null, industry: industryOf(clientIds) }, distilled);
    }
    const result = { title: about.title, classified: c, filed, unsure: unsure.map((x) => x.id) };
    const docIds: string[] = [];
    const agentKeys: string[] = [];

    // Method: the Media Buyer (all its skills), and the Google auditor for Google; the cases on their own, tagged, so
    // an audit of a similar account (a restaurant, a lead-gen roofer) finds them
    if (distilled) {
      const date = dateOf(row.recorded_at ?? row.created_at);
      const text = clean(
        `# ${about.title}\nA Loom recorded ${date} by Kaizen's senior buyer. ${about.summary}\n\n## What he teaches\n${filed.lessons.map((l) => `- ${l.rule}${l.when ? ` (${l.when})` : ""}`).join("\n") || "- (see the transcript)"}\n\n## How he reads an account\n${distilled.diagnostics.map((d) => `- ${d.check}`).join("\n") || "- (see the transcript)"}\n\n## Transcript\n${transcript}`,
      );
      const keys = c.platform === "google" ? [GOOGLE] : c.platform === "both" ? [MEDIA_BUYER, GOOGLE] : [MEDIA_BUYER];
      const cases = casesDoc(about.title, row.url, distilled);
      for (const k of keys) {
        docIds.push(await fileDoc(admin, { scope: "agent", agentKey: k }, row, { name: `${about.title} (Loom)`, text, title: about.title, summary: about.summary, keyPoints: filed.lessons.map((l) => l.rule).slice(0, 8) }));
        if (cases) docIds.push(await fileDoc(admin, { scope: "agent", agentKey: k }, row, { name: `Cases: ${about.title} (Loom)`, text: cases, title: `Cases: ${about.title}`, summary: `Account situations from this Loom, each with how Kaizen's senior buyer read it and what he did.`, keyPoints: [] }, `${row.url}#cases`));
        agentKeys.push(k);
      }
    }

    // A client situation: each client's knowledge and memory; unclear client → the review list
    if (forClient && clientIds.length) for (const id of clientIds) docIds.push(await fileForClient(admin, row, id, about, filed));
    const review = forClient && !clientIds.length;
    await update(admin, row.id, {
      ...base,
      status: review ? "review" : "filed",
      title: row.title ?? about.title,
      client_id: forClient ? (clientIds[0] ?? null) : null,
      client_ids: forClient ? clientIds : [],
      agent_keys: agentKeys,
      doc_ids: docIds,
      result,
      error: null,
    });
    forgetIndex();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A passing problem (the AI busy, a timeout): try again later, a few times
    if (row.attempts < 4) return update(admin, row.id, { status: "queued", next_at: new Date(Date.now() + 15 * 60_000 * row.attempts).toISOString(), error: msg.slice(0, 300) });
    await update(admin, row.id, { status: "failed", error: `Couldn't file it: ${msg}`.slice(0, 400) });
  }
}

/**
 * The worker: claims queued videos a few at a time and files them, until the time budget runs out (so a long queue,
 * a 500-video folder, goes through over several runs: the cron picks up where the last one stopped).
 */
export async function processLoomQueue(admin: Admin, { budgetMs = 480_000, parallel = 3 }: { budgetMs?: number; parallel?: number } = {}) {
  const until = Date.now() + budgetMs;
  let done = 0;
  // A long audit's distillation can take a few minutes: stop claiming while there's still time for one to finish
  while (Date.now() < until - 240_000) {
    const claimed: Row[] = [];
    for (let i = 0; i < parallel; i++) {
      const { data } = await admin.rpc("claim_loom_video");
      const r = (data as Row[] | null)?.[0];
      if (!r) break;
      claimed.push(r);
    }
    if (!claimed.length) break;
    await Promise.all(claimed.map((r) => processLoom(admin, r)));
    done += claimed.length;
  }
  const { count } = await admin.from("loom_videos").select("id", { count: "exact", head: true }).in("status", ["queued", "reading"]);
  return { done, left: count ?? 0 };
}

/** A video waiting for its client, assigned by hand (or marked as about no one client) */
export async function assignLoom(admin: Admin, id: string, clientId: string | null) {
  const { data } = await admin.from("loom_videos").select("*").eq("id", id).single();
  if (!data) throw new Error("Not found.");
  const row = data as unknown as Row & { doc_ids: string[]; kind: string | null; agent_keys: string[] };
  const res = (row.result ?? {}) as { title?: string; filed?: Filed };
  if (!clientId) {
    await update(admin, id, { status: row.agent_keys?.length ? "filed" : "skipped" });
    return;
  }
  const filed: Filed = res.filed ?? { key_points: [], lessons: [], situation: row.transcript?.slice(0, 4000) ?? "", memory: [] };
  const about = { title: res.title ?? row.title ?? "Loom video", summary: (data.summary as string | null) ?? "" };
  const doc = await fileForClient(admin, row, clientId, about, filed);
  await update(admin, id, { status: "filed", client_id: clientId, client_ids: [clientId], doc_ids: [...(row.doc_ids ?? []), doc] });
  forgetIndex();
}

/** A failed or skipped video tried again from the start */
export async function retryLoom(admin: Admin, id: string) {
  await admin.from("loom_videos").update({ status: "queued", next_at: new Date().toISOString(), attempts: 0, error: null, updated_at: new Date().toISOString() }).eq("id", id);
}

// ─── The status block ───────────────────────────────────────────────────────

export type LoomStatus = {
  total: number;
  filed: number;
  queued: number;
  reading: number;
  skipped: number;
  failed: number;
  review: number;
  bySource: Record<LoomSource, number>;
  toMediaBuyer: number;
  toGoogle: number;
  toClients: number;
  waiting: { id: string; url: string; title: string; summary: string | null; source: string; guesses: string[] }[];
  failures: { id: string; url: string; title: string; error: string; source: string }[];
  folders: { id: string; url: string; name: string | null; client: string | null; videos: number; checked: string | null; error: string | null }[];
};

export async function loomStatus(admin: Admin, clientId?: string): Promise<LoomStatus> {
  const empty = { slack: 0, webhook: 0, bulk: 0, client: 0, folder: 0 };
  const mine = clientId ? `hint_client_id.eq.${clientId},client_id.eq.${clientId}` : "id.not.is.null";
  let folderQ = admin.from("loom_folders").select("id, url, name, video_count, last_checked_at, error, clients(name)").order("created_at");
  if (clientId) folderQ = folderQ.eq("client_id", clientId);
  const [{ data: counts }, { data: waiting }, { data: failures }, { data: folders }] = await Promise.all([
    clientId ? Promise.resolve({ data: null }) : admin.rpc("loom_counts"),
    admin.from("loom_videos").select("id, url, title, summary, source, result").eq("status", "review").or(mine).order("created_at", { ascending: false }).limit(40),
    admin.from("loom_videos").select("id, url, title, error, source").eq("status", "failed").or(mine).order("updated_at", { ascending: false }).limit(40),
    folderQ,
  ]);
  const s: LoomStatus = { total: 0, filed: 0, queued: 0, reading: 0, skipped: 0, failed: 0, review: 0, bySource: { ...empty }, toMediaBuyer: 0, toGoogle: 0, toClients: 0, waiting: [], failures: [], folders: [] };
  let rows = (counts ?? []) as { status: string; source: LoomSource; to_media_buyer: boolean; to_google: boolean; to_client: boolean; n: number }[];
  if (clientId) {
    // One client: its own videos' states
    const { data } = await admin.from("loom_videos").select("status, source").or(`hint_client_id.eq.${clientId},client_id.eq.${clientId}`).limit(2000);
    rows = (data ?? []).map((r) => ({ status: r.status as string, source: r.source as LoomSource, to_media_buyer: false, to_google: false, to_client: r.status === "filed", n: 1 }));
  }
  for (const r of rows) {
    const n = Number(r.n);
    s.total += n;
    if (r.status in s) (s as unknown as Record<string, number>)[r.status] += n;
    s.bySource[r.source] = (s.bySource[r.source] ?? 0) + n;
    if (r.to_media_buyer) s.toMediaBuyer += n;
    if (r.to_google) s.toGoogle += n;
    if (r.to_client) s.toClients += n;
  }
  const ids = [...new Set((waiting ?? []).flatMap((w) => ((w.result as { unsure?: string[] } | null)?.unsure ?? []) as string[]))];
  const { data: names } = ids.length ? await admin.from("clients").select("id, name").in("id", ids) : { data: [] as { id: string; name: string }[] };
  const nameOf = new Map((names ?? []).map((c) => [c.id as string, c.name as string]));
  s.waiting = (waiting ?? []).map((w) => ({
    id: w.id as string,
    url: w.url as string,
    title: (w.title as string | null) ?? "Untitled Loom",
    summary: (w.summary as string | null) ?? null,
    source: w.source as string,
    guesses: (((w.result as { unsure?: string[] } | null)?.unsure ?? []) as string[]).map((id) => nameOf.get(id)).filter((x): x is string => Boolean(x)),
  }));
  s.failures = (failures ?? []).map((f) => ({ id: f.id as string, url: f.url as string, title: (f.title as string | null) ?? "Untitled Loom", error: (f.error as string | null) ?? "Couldn't be read", source: f.source as string }));
  s.folders = (folders ?? []).map((f) => ({
    id: f.id as string,
    url: f.url as string,
    name: (f.name as string | null) ?? null,
    client: (f.clients as unknown as { name: string } | null)?.name ?? null,
    videos: (f.video_count as number) ?? 0,
    checked: (f.last_checked_at as string | null) ?? null,
    error: (f.error as string | null) ?? null,
  }));
  return s;
}
