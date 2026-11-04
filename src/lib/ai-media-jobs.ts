import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConnectorError, messageOf } from "@/lib/connector-http";
import { textToSpeech } from "@/lib/elevenlabs";
import * as hf from "@/lib/higgsfield";
import { extOf, hfModel, mediaFileName, voText, type MediaFile, type MediaJob, type MediaJobStatus, type VoiceSettings, type VoModel } from "@/lib/media-models";
import { notify } from "@/lib/owed-replies";

// Every generation from ElevenLabs and Higgsfield, logged in ai_media_jobs with who asked, for which client and
// ticket, what was sent, where the files are (the private ai-media bucket) and what it cost.
//
// Voiceovers take seconds, so they're made while the person waits. Higgsfield runs in the background: the job keeps
// Higgsfield's request id, and whoever looks next (the person's page polling, any page by the bell, or the cron)
// asks Higgsfield where it is; once it's done, the files are copied into storage (Higgsfield's links expire), the
// job is ready, and a toast and a bell notification say so. A refresh never loses it.

export const MEDIA_BUCKET = "ai-media";

type Who = { id: string };
type Row = Record<string, unknown>;

const COLS =
  "id, profile_id, client_id, request_id, provider, kind, model, title, input, status, external_id, result_paths, characters, credits, error, attached_at, drive_note, expected_ms, started_at, finished_at, seen_at, created_at, clients(name), profiles(full_name)";

const FALLBACK_MS: Record<string, number> = { voiceover: 15_000, image: 50_000, video: 240_000, reference: 5_000 };

async function clientName(admin: SupabaseClient, clientId: string | null) {
  if (!clientId) return null;
  const { data } = await admin.from("clients").select("name").eq("id", clientId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

/** Where a job's files go: by client (or "team"), then the job */
const folderOf = (clientId: string | null, jobId: string) => `${clientId ?? "team"}/${jobId}`;

/** How long this model usually takes, from its last finished runs (the progress bar), else a typical time */
async function expectedMs(admin: SupabaseClient, kind: string, model: string | null) {
  const { data } = await admin
    .from("ai_media_jobs")
    .select("started_at, finished_at")
    .eq("kind", kind)
    .eq("status", "ready")
    .eq("model", model ?? "")
    .not("started_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(8);
  const spans = (data ?? []).map((r) => Date.parse(r.finished_at as string) - Date.parse(r.started_at as string)).filter((n) => n > 0 && n < 3600_000);
  if (spans.length >= 2) return Math.round(spans.sort((a, b) => a - b)[Math.floor(spans.length / 2)] * 1.1);
  return hfModel(model)?.typicalMs ?? FALLBACK_MS[kind] ?? 60_000;
}

// ─── Voiceovers (ElevenLabs) ────────────────────────────────────────────────

export type VoiceoverInput = { voiceId: string; voiceName?: string | null; text: string; model?: VoModel; settings?: Partial<VoiceSettings>; clientId?: string | null; requestId?: string | null; attach?: boolean };

/** Reads the text in the voice, keeps the MP3, logs it. Returns the job id (failed jobs are logged too). */
export async function makeVoiceover(admin: SupabaseClient, who: Who, v: VoiceoverInput): Promise<{ ok: true; id: string } | { ok: false; error: string; id?: string }> {
  const t = voText(v.text);
  if (!t.ok) return t;
  const started = new Date();
  const { data: job, error } = await admin
    .from("ai_media_jobs")
    .insert({
      profile_id: who.id,
      client_id: v.clientId ?? null,
      request_id: v.requestId ?? null,
      provider: "elevenlabs",
      kind: "voiceover",
      model: v.model ?? null,
      title: v.voiceName ? `Voiceover · ${v.voiceName}` : "Voiceover",
      input: { voiceId: v.voiceId, voiceName: v.voiceName ?? null, text: t.text, settings: v.settings ?? null, model: v.model ?? null },
      status: "running",
      started_at: started.toISOString(),
      attempts: 1,
      attached_at: v.attach && v.requestId ? started.toISOString() : null,
    })
    .select("id")
    .single();
  if (error || !job) return { ok: false, error: "Couldn't start the voiceover." };
  const id = job.id as string;
  try {
    const speech = await textToSpeech({ voiceId: v.voiceId, text: t.text, model: v.model, settings: v.settings });
    const name = mediaFileName("voiceover", await clientName(admin, v.clientId ?? null), started, 1, speech.mime);
    const path = `${folderOf(v.clientId ?? null, id)}/${name}`;
    const up = await admin.storage.from(MEDIA_BUCKET).upload(path, speech.audio, { contentType: speech.mime, upsert: true });
    if (up.error) throw new ConnectorError("The voiceover was made but couldn't be saved. Try again.");
    await admin
      .from("ai_media_jobs")
      .update({ status: "ready", result_paths: [{ path, mime: speech.mime, bytes: speech.audio.length }], characters: speech.characters, finished_at: new Date().toISOString(), seen_at: new Date().toISOString() })
      .eq("id", id);
    return { ok: true, id };
  } catch (e) {
    const message = messageOf(e, "The voiceover couldn't be made. Try again.");
    if (!(e instanceof ConnectorError)) console.error("[ai-media] voiceover", id, e instanceof Error ? e.message : e);
    await admin.from("ai_media_jobs").update({ status: "failed", error: message, finished_at: new Date().toISOString(), seen_at: new Date().toISOString() }).eq("id", id);
    return { ok: false, error: message, id };
  }
}

// ─── Higgsfield (background) ────────────────────────────────────────────────

export type GenerateInput = {
  model: string;
  prompt: string;
  options?: Record<string, unknown> | null;
  /** A reference image already in the ai-media bucket (uploaded from the panel) */
  referencePath?: string | null;
  clientId?: string | null;
  requestId?: string | null;
  title?: string | null;
};

/** Starts an image or video on Higgsfield and returns the job; it finishes in the background. */
export async function startGeneration(admin: SupabaseClient, who: Who, g: GenerateInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const m = hfModel(g.model);
  if (!m) return { ok: false, error: "Pick a model." };
  const prompt = g.prompt.trim();
  const now = new Date().toISOString();
  const { data: job, error } = await admin
    .from("ai_media_jobs")
    .insert({
      profile_id: who.id,
      client_id: g.clientId ?? null,
      request_id: g.requestId ?? null,
      provider: "higgsfield",
      kind: m.kind,
      model: m.key,
      title: g.title?.trim() || (prompt ? prompt.slice(0, 80) : `${m.label} ${m.kind}`),
      input: { prompt, options: g.options ?? {}, referencePath: g.referencePath ?? null },
      status: "queued",
      expected_ms: await expectedMs(admin, m.kind, m.key),
      attached_at: g.requestId ? now : null,
    })
    .select("id")
    .single();
  if (error || !job) return { ok: false, error: "Couldn't start it." };
  const id = job.id as string;
  try {
    let referenceUrl: string | null = null;
    if (g.referencePath && m.reference !== "none") {
      const { data: file } = await admin.storage.from(MEDIA_BUCKET).download(g.referencePath);
      if (!file) throw new ConnectorError("The reference image wasn't found. Add it again.");
      referenceUrl = await hf.uploadReference(Buffer.from(await file.arrayBuffer()), file.type || "image/jpeg");
    }
    const s = await hf.submit(m.key, { prompt, options: g.options, referenceUrl }, id);
    await admin
      .from("ai_media_jobs")
      .update({ status: s.status === "queued" ? "queued" : "running", external_id: s.requestId, started_at: new Date().toISOString(), attempts: 1, input: { prompt, options: g.options ?? {}, referencePath: g.referencePath ?? null, sent: s.body, path: s.path } })
      .eq("id", id);
    return { ok: true, id };
  } catch (e) {
    const message = messageOf(e, "Higgsfield couldn't start it. Try again.");
    if (!(e instanceof ConnectorError)) console.error("[ai-media] start", id, e instanceof Error ? e.message : e);
    await admin.from("ai_media_jobs").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", id);
    return { ok: false, error: message };
  }
}

/** Where a background job is: asks Higgsfield (at most every few seconds), and finishes it when it's done */
export async function advance(admin: SupabaseClient, id: string, minGapMs = 4000): Promise<MediaJobStatus | null> {
  const since = new Date(Date.now() - minGapMs).toISOString();
  const { data: job } = await admin
    .from("ai_media_jobs")
    .update({ checked_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["queued", "running"])
    .not("external_id", "is", null)
    .or(`checked_at.is.null,checked_at.lt.${since}`)
    .select("id, profile_id, client_id, request_id, kind, model, title, external_id, created_at")
    .maybeSingle();
  if (!job) return null;
  try {
    const p = await hf.status(job.external_id as string);
    if (p.status === "queued" || p.status === "running") {
      if (p.status === "running") await admin.from("ai_media_jobs").update({ status: "running" }).eq("id", id).eq("status", "queued");
      return p.status;
    }
    if (p.status !== "ready") {
      await finish(admin, job, p.status, [], p.error ?? "Higgsfield stopped it.");
      return p.status;
    }
    const client = await clientName(admin, job.client_id as string | null);
    const files: MediaFile[] = [];
    const at = new Date(job.created_at as string);
    for (const [i, o] of p.outputs.entries()) {
      const { bytes, mime } = await hf.download(o.url);
      const name = mediaFileName(o.kind === "audio" ? "audio" : (job.kind as string), client, at, p.outputs.length > 1 ? i + 1 : 1, mime);
      const path = `${folderOf(job.client_id as string | null, id)}/${name}`;
      const up = await admin.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
      if (up.error) throw new ConnectorError("The result was made but couldn't be saved. It'll be tried again.", null, true);
      files.push({ path, mime, bytes: bytes.length });
    }
    if (!files.length) {
      await finish(admin, job, "failed", [], "Higgsfield finished without a file. Try again.");
      return "failed";
    }
    await finish(admin, job, "ready", files, null);
    return "ready";
  } catch (e) {
    // A hiccup asking Higgsfield or copying the file: left running, tried again on the next look
    if (!(e instanceof ConnectorError)) console.error("[ai-media] advance", id, e instanceof Error ? e.message : e);
    return "running";
  }
}

async function finish(admin: SupabaseClient, job: Row, status: MediaJobStatus, files: MediaFile[], error: string | null) {
  const { data: done } = await admin
    .from("ai_media_jobs")
    .update({ status, result_paths: files, error, finished_at: new Date().toISOString() })
    .eq("id", job.id as string)
    .in("status", ["queued", "running"])
    .select("id")
    .maybeSingle();
  if (!done || status !== "ready") return;
  const client = await clientName(admin, job.client_id as string | null);
  let href: string | null = `/board?media=${job.id}`;
  if (job.request_id) {
    const { data: r } = await admin.from("requests").select("number").eq("id", job.request_id as string).maybeSingle();
    if (r?.number) href = `/board?t=${r.number}&media=${job.id}`;
  }
  await notify(admin, [job.profile_id as string], {
    key: `media_ready:${job.id}`,
    kind: "media_ready",
    title: `${job.kind === "video" ? "Your video is" : files.length > 1 ? "Your images are" : "Your image is"} ready${client ? ` — ${client}` : ""}`,
    body: (job.title as string | null) ?? "Made with Higgsfield.",
    href,
    clientId: (job.client_id as string | null) ?? null,
    priority: "normal",
  }).catch(() => null);
}

/** Stops a job waiting in Higgsfield's queue */
export async function cancelGeneration(admin: SupabaseClient, id: string, who: Who & { isExec?: boolean; isLead?: boolean }) {
  const { data: job } = await admin.from("ai_media_jobs").select("profile_id, external_id, status").eq("id", id).maybeSingle();
  if (!job) return { ok: false as const, error: "Not found." };
  if (job.profile_id !== who.id && !who.isExec && !who.isLead) return { ok: false as const, error: "Only the person who started it can stop it." };
  if (job.status !== "queued" && job.status !== "running") return { ok: false as const, error: "It's already finished." };
  const stopped = job.external_id ? await hf.cancel(job.external_id as string).catch(() => false) : true;
  if (!stopped) return { ok: false as const, error: "It's already being made, so Higgsfield can't stop it now." };
  await admin.from("ai_media_jobs").update({ status: "canceled", error: "Stopped.", finished_at: new Date().toISOString(), seen_at: new Date().toISOString() }).eq("id", id);
  return { ok: true as const };
}

/** The cron: every job still running is asked about, and ones running far too long are closed */
export async function pickUpMediaJobs(admin: SupabaseClient) {
  const dead = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: stuck } = await admin.from("ai_media_jobs").select("id").in("status", ["queued", "running"]).lt("created_at", dead).limit(20);
  for (const j of stuck ?? [])
    await admin.from("ai_media_jobs").update({ status: "failed", error: "It took over an hour, so it was stopped. Try again.", finished_at: new Date().toISOString() }).eq("id", j.id).in("status", ["queued", "running"]);
  // Started but never handed to Higgsfield (the server was cut off): failed, so the person can try again
  const lost = new Date(Date.now() - 5 * 60_000).toISOString();
  await admin.from("ai_media_jobs").update({ status: "failed", error: "It didn't start. Try again.", finished_at: new Date().toISOString() }).eq("status", "queued").is("external_id", null).lt("created_at", lost);
  const { data: open } = await admin.from("ai_media_jobs").select("id").in("status", ["queued", "running"]).not("external_id", "is", null).order("created_at").limit(10);
  let finished = 0;
  for (const j of open ?? []) if ((await advance(admin, j.id as string, 15_000)) === "ready") finished++;
  return { checked: open?.length ?? 0, finished, closed: stuck?.length ?? 0 };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Rows into what the screens show, with short-lived links to the files */
export async function toJobs(admin: SupabaseClient, rows: Row[], me: string | null): Promise<MediaJob[]> {
  const paths = rows.flatMap((r) => ((r.result_paths as MediaFile[] | null) ?? []).map((f) => f.path));
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await admin.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  return rows.map((r) => {
    const input = (r.input ?? {}) as { prompt?: string; text?: string };
    return {
      id: r.id as string,
      provider: r.provider as MediaJob["provider"],
      kind: r.kind as MediaJob["kind"],
      model: (r.model as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      status: r.status as MediaJobStatus,
      error: (r.error as string | null) ?? null,
      files: ((r.result_paths as MediaFile[] | null) ?? []).map((f) => ({ ...f, url: signed.get(f.path) ?? null })),
      prompt: input.prompt ?? input.text ?? null,
      requestId: (r.request_id as string | null) ?? null,
      clientId: (r.client_id as string | null) ?? null,
      client: (r.clients as { name?: string } | null)?.name ?? null,
      by: (r.profiles as { full_name?: string } | null)?.full_name ?? null,
      mine: r.profile_id === me,
      attached: Boolean(r.attached_at),
      driveNote: (r.drive_note as string | null) ?? null,
      characters: (r.characters as number | null) ?? null,
      credits: r.credits == null ? null : Number(r.credits),
      expectedMs: (r.expected_ms as number | null) ?? hfModel(r.model)?.typicalMs ?? FALLBACK_MS[r.kind as string] ?? 60_000,
      createdAt: r.created_at as string,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      seen: Boolean(r.seen_at),
    };
  });
}

/** A ticket's generations (or a client's, without a ticket), newest first */
export async function mediaFor(admin: SupabaseClient, where: { requestId?: string; clientId?: string; kind?: MediaJob["kind"] | MediaJob["kind"][] }, me: string | null, limit = 24) {
  let q = admin.from("ai_media_jobs").select(COLS).order("created_at", { ascending: false }).limit(limit);
  if (where.requestId) q = q.eq("request_id", where.requestId);
  else if (where.clientId) q = q.eq("client_id", where.clientId).is("request_id", null);
  else return [];
  if (where.kind) q = Array.isArray(where.kind) ? q.in("kind", where.kind) : q.eq("kind", where.kind);
  q = q.neq("status", "canceled");
  const { data } = await q;
  return toJobs(admin, (data ?? []) as Row[], me);
}

/** One person's background jobs still running, and finished ones not shown yet; running ones are moved along */
export async function myMediaJobs(admin: SupabaseClient, profileId: string): Promise<MediaJob[]> {
  const since = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: open } = await admin.from("ai_media_jobs").select("id").eq("profile_id", profileId).eq("provider", "higgsfield").in("status", ["queued", "running"]).gte("created_at", since).limit(6);
  await Promise.all((open ?? []).map((j) => advance(admin, j.id as string).catch(() => null)));
  const { data } = await admin.from("ai_media_jobs").select(COLS).eq("profile_id", profileId).eq("provider", "higgsfield").gte("created_at", since).order("created_at", { ascending: false }).limit(12);
  const rows = ((data ?? []) as Row[]).filter((r) => r.status === "queued" || r.status === "running" || !r.seen_at);
  return toJobs(admin, rows, profileId);
}

export async function markMediaSeen(admin: SupabaseClient, profileId: string, ids: string[]) {
  if (!ids.length) return;
  await admin.from("ai_media_jobs").update({ seen_at: new Date().toISOString() }).in("id", ids.slice(0, 20)).eq("profile_id", profileId).is("seen_at", null);
}

// ─── Where the files go ─────────────────────────────────────────────────────

/** On a ticket's files (its voiceover and AI media lists) */
export async function attachToTicket(admin: SupabaseClient, id: string, requestId: string) {
  const { data: r } = await admin.from("requests").select("client_id").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false as const, error: "Ticket not found." };
  await admin.from("ai_media_jobs").update({ request_id: requestId, client_id: r.client_id, attached_at: new Date().toISOString() }).eq("id", id);
  return { ok: true as const };
}

/** Into the client's Drive folder ("Kaizen AI media"), reusing the onboarding guide's uploader */
export async function pushToDrive(admin: SupabaseClient, id: string) {
  const { data: j } = await admin.from("ai_media_jobs").select("client_id, result_paths, kind, created_at").eq("id", id).maybeSingle();
  if (!j?.client_id) return { ok: false as const, error: "Pick the client first: AI media goes to a client's Drive." };
  const files = ((j.result_paths as MediaFile[] | null) ?? []).map((f) => ({ path: f.path, name: f.path.split("/").pop() ?? `${j.kind}.${extOf(f.mime)}`, mime: f.mime }));
  if (!files.length) return { ok: false as const, error: "There's no file yet." };
  const { filesToDrive } = await import("@/lib/onboarding-guide");
  const r = await filesToDrive(admin, j.client_id as string, files, { bucket: MEDIA_BUCKET, folder: "Kaizen AI media" });
  const note = r.drive === "saved" ? "In their Drive (Kaizen AI media)" : r.drive === "partly" ? `Partly in their Drive: ${r.note ?? ""}` : `Not in Drive: ${r.note ?? "Drive isn't connected"}`;
  await admin.from("ai_media_jobs").update({ drive_note: note }).eq("id", id);
  return r.drive === "kept here" ? { ok: false as const, error: note } : { ok: true as const, note };
}
