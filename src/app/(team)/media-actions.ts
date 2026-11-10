"use server";

import { revalidatePath } from "next/cache";
import { AGENCY_SYSTEM, AiUnavailable, askJson, clientContext, contextBlock, getAgent, type Script } from "@/lib/ai";
import { NO_AI_MEDIA_NOTE } from "@/lib/ai-content";
import * as jobs from "@/lib/ai-media-jobs";
import { requireStaff, type Staff } from "@/lib/auth";
import { messageOf } from "@/lib/connector-http";
import { elevenlabsConfigured, listVoices, type Voice } from "@/lib/elevenlabs";
import { higgsfieldConfigured } from "@/lib/higgsfield";
import { notLive } from "@/lib/live-guard";
import { canGenerateMedia, clampVoiceSettings, extOf, hfModel, voFromScript, voModelOf, type MediaJob, type VoiceSettings, type VoModel } from "@/lib/media-models";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The media panels' server side (voiceovers, Higgsfield images and videos, Motion references) on tickets, the shot
// list and the creative workspace. The creative team, leads and execs generate; everyone else on the team can see
// and play what was made. Each call checks the person can see the ticket or client (RLS) before anything is spent.

type Fail = { ok: false; error: string };

/** noAi: the client said no to AI content (src/lib/ai-content.ts), so no AI voices, images or video are offered for them */
export type MediaAccess = { canGenerate: boolean; elevenlabs: boolean; higgsfield: boolean; noAi: string | null };

/** What this person can do here, which connectors have their keys, and whether this ticket's or client's client takes AI media */
export async function mediaAccess(where: { requestId?: string | null; clientId?: string | null } = {}): Promise<MediaAccess> {
  const me = await requireStaff();
  let noAi: string | null = null;
  if ((where.requestId || where.clientId) && adminConfigured()) {
    const clientId = where.requestId ? ((await ticketOf(where.requestId))?.client_id ?? null) : where.clientId && (await canSeeClient(where.clientId)) ? where.clientId : null;
    if (clientId) noAi = await jobs.noAiMediaFor(createAdminClient(), { clientId }).catch(() => null);
  }
  return { canGenerate: canGenerateMedia(me), elevenlabs: elevenlabsConfigured(), higgsfield: higgsfieldConfigured(), noAi };
}

/** The ticket (seen through the person's own access) and its client */
async function ticketOf(requestId: string) {
  const { data } = await (await createClient()).from("board_requests").select("id, client_id, number, title, format, angle_name, audience, brief").eq("id", requestId).maybeSingle();
  return data as { id: string; client_id: string; number: number; title: string; format: string; angle_name: string | null; audience: string | null; brief: string | null } | null;
}

async function canSeeClient(clientId: string) {
  const { data } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  return Boolean(data);
}

/** Who's generating, for which ticket or client: checked, or the reason not */
async function gate(where: { requestId?: string | null; clientId?: string | null }): Promise<{ ok: true; me: Staff; clientId: string | null; requestId: string | null } | Fail> {
  const me = await requireStaff();
  if (!canGenerateMedia(me)) return { ok: false, error: "Only the creative team, leads and execs can generate media." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  let clientId = where.clientId ?? null;
  if (where.requestId) {
    const t = await ticketOf(where.requestId);
    if (!t) return { ok: false, error: "Ticket not found." };
    clientId = t.client_id;
  } else if (clientId && !(await canSeeClient(clientId))) return { ok: false, error: "You don't work on this client." };
  if (clientId) {
    const why = await notLive(await createClient(), clientId);
    if (why) return { ok: false, error: why };
  }
  return { ok: true, me, clientId, requestId: where.requestId ?? null };
}

async function oneJob(id: string, me: string): Promise<MediaJob | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_media_jobs")
    .select("id, profile_id, client_id, request_id, provider, kind, model, title, input, status, external_id, result_paths, characters, credits, error, attached_at, drive_note, expected_ms, started_at, finished_at, seen_at, created_at, clients(name), profiles(full_name)")
    .eq("id", id)
    .maybeSingle();
  return data ? ((await jobs.toJobs(admin, [data], me))[0] ?? null) : null;
}

// ─── Voiceovers ─────────────────────────────────────────────────────────────

export async function voices(): Promise<{ ok: true; voices: Voice[] } | Fail> {
  await requireStaff();
  if (!elevenlabsConfigured()) return { ok: false, error: "ElevenLabs isn't connected yet. An exec needs to add ELEVENLABS_API_KEY in Vercel." };
  try {
    return { ok: true, voices: await listVoices() };
  } catch (e) {
    return { ok: false, error: messageOf(e, "Couldn't load the voices.") };
  }
}

/** The VO lines from the ticket's video script (the chosen hook, then each beat), to start from */
export async function scriptVoiceover(requestId: string, hook = 0): Promise<string> {
  await requireStaff();
  const { data } = await (await createClient()).from("request_scripts").select("content").eq("request_id", requestId).maybeSingle();
  return voFromScript(data?.content as Script | null, hook);
}

export async function generateVoiceover(v: {
  voiceId: string;
  voiceName?: string | null;
  text: string;
  model?: VoModel;
  settings?: Partial<VoiceSettings>;
  requestId?: string | null;
  clientId?: string | null;
}): Promise<{ ok: true; job: MediaJob } | Fail> {
  const g = await gate(v);
  if (!g.ok) return g;
  if (!elevenlabsConfigured()) return { ok: false, error: "ElevenLabs isn't connected yet. An exec needs to add ELEVENLABS_API_KEY in Vercel." };
  const r = await jobs.makeVoiceover(createAdminClient(), g.me, {
    voiceId: v.voiceId,
    voiceName: v.voiceName ?? null,
    text: v.text,
    model: voModelOf(v.model),
    settings: clampVoiceSettings(v.settings),
    requestId: g.requestId,
    clientId: g.clientId,
    attach: Boolean(g.requestId),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const job = await oneJob(r.id, g.me.id);
  return job ? { ok: true, job } : { ok: false, error: "It was made but couldn't be read back. Refresh." };
}

// ─── Lists ──────────────────────────────────────────────────────────────────

export async function ticketMedia(requestId: string, kind?: MediaJob["kind"] | MediaJob["kind"][]): Promise<MediaJob[]> {
  const me = await requireStaff();
  if (!adminConfigured() || !(await ticketOf(requestId))) return [];
  return jobs.mediaFor(createAdminClient(), { requestId, kind }, me.id);
}

export async function clientMedia(clientId: string, kind?: MediaJob["kind"] | MediaJob["kind"][]): Promise<MediaJob[]> {
  const me = await requireStaff();
  if (!adminConfigured() || !(await canSeeClient(clientId))) return [];
  return jobs.mediaFor(createAdminClient(), { clientId, kind }, me.id);
}

// ─── Higgsfield ─────────────────────────────────────────────────────────────

/** Where the browser uploads a reference image (straight into the ai-media bucket, no size limit on the server) */
export async function referenceUpload(where: { requestId?: string | null; clientId?: string | null }, name: string, mime: string): Promise<{ ok: true; path: string; token: string } | Fail> {
  const g = await gate(where);
  if (!g.ok) return g;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return { ok: false, error: "References can be JPG, PNG, WebP or GIF." };
  const safe = name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(-60) || `reference.${extOf(mime)}`;
  const path = `${g.clientId ?? "team"}/refs/${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const { data, error } = await createAdminClient().storage.from(jobs.MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Couldn't get the reference ready. Try again." };
  return { ok: true, path: data.path, token: data.token };
}

export async function startHiggsfield(g0: { model: string; prompt: string; options?: Record<string, unknown>; referencePath?: string | null; requestId?: string | null; clientId?: string | null }): Promise<{ ok: true; job: MediaJob } | Fail> {
  const g = await gate(g0);
  if (!g.ok) return g;
  if (!higgsfieldConfigured()) return { ok: false, error: "Higgsfield isn't connected yet. An exec needs to add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in Vercel." };
  if (!hfModel(g0.model)) return { ok: false, error: "Pick a model." };
  if (g0.referencePath && !g0.referencePath.startsWith(`${g.clientId ?? "team"}/refs/`)) return { ok: false, error: "That reference isn't for this client." };
  const r = await jobs.startGeneration(createAdminClient(), g.me, { model: g0.model, prompt: g0.prompt, options: g0.options ?? {}, referencePath: g0.referencePath ?? null, requestId: g.requestId, clientId: g.clientId });
  if (!r.ok) return r;
  const job = await oneJob(r.id, g.me.id);
  return job ? { ok: true, job } : { ok: false, error: "It started but couldn't be read back. Refresh." };
}

/** The bell's list: this person's Higgsfield jobs running, and finished ones not shown yet (running ones move along) */
export async function myMedia(): Promise<MediaJob[]> {
  const db = await createClient();
  const { data: claims } = await db.auth.getClaims();
  const id = claims?.claims?.sub as string | undefined;
  if (!id || !adminConfigured()) return [];
  return jobs.myMediaJobs(createAdminClient(), id).catch(() => []);
}

export async function markMediaSeen(ids: string[]) {
  const me = await requireStaff();
  if (!adminConfigured()) return;
  await jobs.markMediaSeen(createAdminClient(), me.id, ids);
}

/** One job, moved along if it's still running (a panel following its own job) */
export async function mediaJob(id: string): Promise<MediaJob | null> {
  const me = await requireStaff();
  if (!adminConfigured()) return null;
  await jobs.advance(createAdminClient(), id).catch(() => null);
  return oneJob(id, me.id);
}

export async function cancelMedia(id: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  return jobs.cancelGeneration(createAdminClient(), id, me);
}

// ─── Where it goes ──────────────────────────────────────────────────────────

export async function attachMedia(id: string, requestId: string): Promise<{ ok: true } | Fail> {
  const g = await gate({ requestId });
  if (!g.ok) return g;
  return jobs.attachToTicket(createAdminClient(), id, requestId);
}

export async function mediaToDrive(id: string): Promise<{ ok: true; note: string } | Fail> {
  const me = await requireStaff();
  if (!canGenerateMedia(me)) return { ok: false, error: "Only the creative team, leads and execs can send media to Drive." };
  const { data } = await createAdminClient().from("ai_media_jobs").select("client_id").eq("id", id).maybeSingle();
  if (!data?.client_id || !(await canSeeClient(data.client_id as string))) return { ok: false, error: "Not found." };
  return jobs.pushToDrive(createAdminClient(), id);
}

/** An AI image or video as a deliverable on its ticket: a new design, its files copied into the creative bucket */
export async function mediaToDeliverables(id: string): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  if (!canGenerateMedia(me)) return { ok: false, error: "Only the creative team, leads and execs can add deliverables." };
  const admin = createAdminClient();
  const { data: j } = await admin.from("ai_media_jobs").select("request_id, kind, title, result_paths, status").eq("id", id).maybeSingle();
  if (!j?.request_id) return { ok: false, error: "It's not on a ticket." };
  if (j.status !== "ready") return { ok: false, error: "It isn't finished yet." };
  if (j.kind !== "image" && j.kind !== "video") return { ok: false, error: "Only images and videos can be deliverables." };
  const t = await ticketOf(j.request_id as string);
  if (!t) return { ok: false, error: "Ticket not found." };
  const files = ((j.result_paths as { path: string; mime: string; bytes: number }[] | null) ?? []).filter((f) => f.mime.startsWith(j.kind === "video" ? "video/" : "image/"));
  if (!files.length) return { ok: false, error: "There's no file to add." };
  const supabase = await createClient();
  const name = `AI ${j.kind}: ${((j.title as string | null) ?? "").slice(0, 80) || "Higgsfield"}`;
  const { data: started, error } = await supabase.rpc("add_designs", { p_request: t.id, p_designs: [{ name: name.slice(0, 120), variation_of: null, variation_of_index: null }] });
  if (error) return { ok: false, error: error.message };
  const s = (started as { design_id: string; version_id: string; version: number }[])[0];
  const dir = `${t.client_id}/${t.id}/${s.design_id}/v${s.version}`;
  const recorded: Record<string, unknown>[] = [];
  for (const [i, f] of files.entries()) {
    const { data: blob } = await admin.storage.from(jobs.MEDIA_BUCKET).download(f.path);
    if (!blob) continue;
    const base = f.path.split("/").pop() ?? `ai.${extOf(f.mime)}`;
    const path = `${dir}/${String(i + 1).padStart(2, "0")}-${crypto.randomUUID().slice(0, 4)}-${base}`;
    const up = await admin.storage.from("creative").upload(path, blob, { contentType: f.mime, upsert: true });
    if (up.error) continue;
    recorded.push({ path, thumb_path: null, original_name: base, mime: f.mime, bytes: f.bytes, width: null, height: null, duration_ms: null, aspect: null, card: t.format === "carousel" ? i + 1 : null });
  }
  if (!recorded.length) return { ok: false, error: "The files couldn't be copied. Try again." };
  const { error: recErr } = await supabase.rpc("record_design_files", { p_version: s.version_id, p_files: recorded });
  if (recErr) return { ok: false, error: recErr.message };
  (await import("@/lib/creative-drive")).driveAfterResponse([s.design_id]);
  revalidatePath("/board");
  return { ok: true };
}

// ─── The AI's prompt ────────────────────────────────────────────────────────

/** The Video script writer turns the ticket's brief (and script) into a Higgsfield prompt for an image or a video */
export async function writeMediaPrompt(requestId: string, kind: "image" | "video", note?: string): Promise<{ ok: true; prompt: string; why: string } | Fail> {
  await requireStaff();
  const t = await ticketOf(requestId);
  if (!t) return { ok: false, error: "Ticket not found." };
  const supabase = await createClient();
  const ctx = await clientContext(supabase, t.client_id);
  if (!ctx) return { ok: false, error: "You don't work on this client." };
  if (ctx.aiRule) return { ok: false, error: `${NO_AI_MEDIA_NOTE} They told us: "${ctx.aiRule}"` };
  const { data: sc } = await supabase.from("request_scripts").select("content").eq("request_id", requestId).maybeSingle();
  const script = sc?.content as Script | null;
  try {
    const { sources } = await getAgent("scripts");
    const out = await askJson<{ prompt: string; why: string }>({
      agent: "scripts",
      label: `media prompt ${ctx.name}`,
      clientId: t.client_id,
      system: AGENCY_SYSTEM,
      maxTokens: 4000,
      schema: { type: "object", properties: { prompt: { type: "string" }, why: { type: "string" } }, required: ["prompt", "why"], additionalProperties: false },
      prompt: `${contextBlock(ctx, undefined, sources)}

<ticket>
Title: ${t.title}
Format: ${t.format}
Angle: ${t.angle_name ?? "not set"}
Audience: ${t.audience ?? "not set"}
Brief:
${t.brief ?? "(no brief)"}
</ticket>
${script ? `\n<video_script>\n${script.title}\nHook: ${script.hooks?.[0]?.onScreen ?? ""}\n${(script.beats ?? []).map((b) => `${b.time}: ${b.shot}`).join("\n")}\n</video_script>\n` : ""}${note?.trim() ? `\n<change_requested>\n${note.trim()}\n</change_requested>\n` : ""}
Write one prompt for an AI ${kind === "video" ? "video model (a 5 to 10 second clip)" : "image model"} that makes the key ${kind === "video" ? "shot" : "visual"} for this ad. Describe what's seen: the subject (who or what, specific), the setting, the action${kind === "video" ? " and the camera move" : ""}, the light, the lens and framing for vertical 9:16 with the main subject inside the 4:5 safe area, and the mood. Plain, concrete words; no brand logos, no text in the image, no real people's names or likenesses; nothing the client's rules forbid. Under 120 words.
why: one line on why this shot fits the brief.`,
    });
    return { ok: true, prompt: out.prompt.trim(), why: out.why.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't write the prompt." };
  }
}

// ─── Motion references ──────────────────────────────────────────────────────

type Reference = import("@/lib/ai-tools/motion").Reference;

/** Market ads for a client (from Motion's sync): their swipe file, or a search across their market */
export async function motionReferences(clientId: string, opts: { search?: string; format?: "image" | "video" | null } = {}): Promise<{ ok: true; refs: Reference[] } | Fail> {
  await requireStaff();
  if (!(await canSeeClient(clientId))) return { ok: false, error: "You don't work on this client." };
  const { searchMarketAds } = await import("@/lib/ai-tools/motion");
  try {
    return { ok: true, refs: await searchMarketAds(createAdminClient(), { clientId, query: opts.search ?? null, format: opts.format ?? null, limit: 24 }) };
  } catch (e) {
    return { ok: false, error: messageOf(e, "Couldn't load the market ads.") };
  }
}

/** A reference onto a ticket's brief (its refs list) */
export async function addTicketRef(requestId: string, url: string): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const t = await ticketOf(requestId);
  if (!t) return { ok: false, error: "Ticket not found." };
  if (!/^https:\/\//.test(url)) return { ok: false, error: "That link isn't usable." };
  const admin = createAdminClient();
  const { data } = await admin.from("requests").select("refs").eq("id", requestId).single();
  const refs = ((data?.refs as string[] | null) ?? []).filter((r) => r !== url);
  const { error } = await admin.from("requests").update({ refs: [...refs, url].slice(-20) }).eq("id", requestId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/board");
  return { ok: true };
}

/** A reference onto one shot of a client's shot list */
export async function addShotRef(listId: string, shotId: string, ref: Reference, slug: string): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const { data: l } = await (await createClient()).from("shot_lists").select("id, list").eq("id", listId).maybeSingle();
  if (!l) return { ok: false, error: "Shot list not found." };
  const list = l.list as { shots: { id?: string; refs?: { url: string; thumb: string | null; brand: string; days: number | null; video: boolean }[] }[] };
  const shot = list.shots.find((s, i) => (s.id ?? `s${i}`) === shotId);
  if (!shot) return { ok: false, error: "Shot not found." };
  shot.refs = [...(shot.refs ?? []).filter((r) => r.url !== ref.url), { url: ref.url, thumb: ref.thumb, brand: ref.brand, days: ref.days, video: ref.video }].slice(-4);
  const { error } = await createAdminClient().from("shot_lists").update({ list }).eq("id", listId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}
