import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, clientContext, contextBlock, CREATIVE_REVIEW_SYSTEM, DESIGN_NOTES_SCHEMA, getAgent, type CreativeNote, type CreativeNotes } from "@/lib/ai";
import { aspectLabel } from "@/lib/uploads/media";
import { clientAsks } from "@/lib/client-revision";
import { transcribe, type Line } from "@/lib/transcribe";

// The AI's QA of a ticket's creative. The designer or editor runs it before sending the work to creative review, fixes
// what it finds and runs it again; the Head of Creative sees the latest run. It reviews design by design (every size,
// read at a size where small text is readable) so the progress it reports is real: files opened, designs checked.
// A video is reviewed as a timeline: frames through the whole video and what's said in it, with times.
// Its notes go on the creative as comments, pinned (or boxed) where they apply and at the moment in a video, with every
// other comment; each run checks the earlier comments and resolves the ones the new version fixed.

const BUCKET = "creative";
const MAX_PER_DESIGN = 4;
const MAX_SIDE = 1568; // the most the model looks at; bigger only costs more
const FRAME_SIDE = 768; // video frames: enough to read captions
const MAX_FRAMES = 48;
const PARALLEL = 3;
const AI_NAME = "Kaizen AI";

type Frame = { ms: number; path: string };
type FileRow = { id: string; path: string; thumb_path: string | null; mime: string; aspect: string | null; width: number | null; height: number | null; duration_ms: number | null; original_name: string; card: number | null; frames: Frame[] | null; audio_path: string | null; transcript: Line[] | null; transcript_status: string | null };
type DesignRow = { id: string; position: number; name: string; is_variation: boolean; variation_of: string | null; current_version: number; design_versions: { version: number; design_files: FileRow[] }[] };
type Pic = { label: string; data: string; fileId: string; ms: number | null };

export type DesignProgress = { ref: string; name: string; status: "waiting" | "checking" | "done" | "failed"; fixes: number; watch: number; startedAt?: number };
export type ReviewProgress = { phase: "files" | "designs" | "done"; files: { done: number; total: number; label: string }; designs: DesignProgress[] };

const FILE_COLS = "id, path, thumb_path, mime, aspect, width, height, duration_ms, original_name, card, frames, audio_path, transcript, transcript_status";

/** What's on the ticket now: the designs with their current files, and a signature that changes on any re-upload. */
export async function currentCreative(admin: SupabaseClient, requestId: string) {
  const { data } = await admin
    .from("designs")
    .select(`id, position, name, is_variation, variation_of, current_version, design_versions(version, design_files(${FILE_COLS}))`)
    .eq("request_id", requestId)
    .order("position");
  const designs = ((data ?? []) as unknown as DesignRow[]).map((d) => ({
    ...d,
    files: (d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? []).sort((a, b) => (a.card ?? 0) - (b.card ?? 0) || a.original_name.localeCompare(b.original_name)),
  }));
  const signature = designs.map((d) => `${d.id}:${d.current_version}`).join(",");
  return { designs, signature };
}

const isVideo = (f: FileRow) => f.mime.startsWith("video/");
/** The file a video design is watched in: its 9:16 when there is one (where captions and safe zones matter most) */
const mainVideo = (files: FileRow[]) => files.find((f) => isVideo(f) && f.aspect === "9x16") ?? files.find(isVideo) ?? null;
/** How many pictures a design's files come to (a video's frames count one by one) */
const picturesOf = (files: FileRow[]) => {
  const main = mainVideo(files);
  const frames = main?.frames?.length ? Math.min(MAX_FRAMES, main.frames.length) : 0;
  return frames + Math.min(files.filter((f) => f !== main || !frames).length, MAX_PER_DESIGN);
};

/** Start a run: saved as running with its plan, so the progress shows from the first second. Returns its id. */
export async function startRun(admin: SupabaseClient, requestId: string, by: string | null) {
  const [{ designs, signature }, { data: t }] = await Promise.all([currentCreative(admin, requestId), admin.from("requests").select("client_id").eq("id", requestId).single()]);
  if (!t) throw new AiUnavailable("Ticket not found.");
  if (!designs.some((d) => d.files.length)) throw new AiUnavailable("Upload the creative first.");
  const progress: ReviewProgress = {
    phase: "files",
    files: { done: 0, total: designs.reduce((n, d) => n + picturesOf(d.files), 0), label: "Opening the files" },
    designs: designs.filter((d) => d.files.length).map((d) => ({ ref: `D${d.position}`, name: d.name, status: "waiting", fixes: 0, watch: 0 })),
  };
  const { data, error } = await admin
    .from("creative_ai_reviews")
    .insert({ request_id: requestId, client_id: t.client_id, signature, status: "running", progress, requested_by: by })
    .select("id")
    .single();
  if (error) throw new AiUnavailable(error.message);
  return data.id as string;
}

async function jpegOf(admin: SupabaseClient, path: string, side: number) {
  const { data } = await admin.storage.from(BUCKET).download(path);
  if (!data) return null;
  try {
    const jpeg = await sharp(Buffer.from(await data.arrayBuffer()), { limitInputPixels: 120_000_000 })
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return jpeg.toString("base64");
  } catch {
    return null;
  }
}

/** A still file, or a video's cover when its frames weren't captured */
async function picture(admin: SupabaseClient, f: FileRow) {
  const path = isVideo(f) ? f.thumb_path : f.mime.startsWith("image/") ? f.path : f.thumb_path;
  return path ? jpegOf(admin, path, MAX_SIDE) : null;
}

/** What's said in a video, transcribed once and kept on the file. */
async function transcriptOf(admin: SupabaseClient, f: FileRow): Promise<{ lines: Line[] | null; note: string | null }> {
  if (f.transcript) return { lines: f.transcript, note: null };
  if (f.transcript_status === "silent") return { lines: [], note: null };
  if (!f.audio_path) return { lines: null, note: f.transcript_status?.startsWith("failed") ? f.transcript_status.slice(8) : null };
  try {
    const { data } = await admin.storage.from(BUCKET).download(f.audio_path);
    if (!data) throw new Error("the audio file is missing");
    const lines = await transcribe(Buffer.from(await data.arrayBuffer()));
    await admin.from("design_files").update({ transcript: lines, transcript_status: lines.length ? "done" : "silent" }).eq("id", f.id);
    return { lines, note: null };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await admin.from("design_files").update({ transcript_status: `failed: ${why}`.slice(0, 300) }).eq("id", f.id);
    return { lines: null, note: why };
  }
}

const sizeOf = (format: string, f: FileRow) => (format === "carousel" && f.card ? `card ${f.card}` : aspectLabel(f.aspect));
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}${ms % 1000 ? `.${Math.floor((ms % 1000) / 100)}` : ""}`;

/** The verdict and a one-line summary, from the notes. */
function summarize(notes: CreativeNote[], designs: number): Pick<CreativeNotes, "verdict" | "headline"> {
  const fixes = notes.filter((n) => n.severity === "fix");
  const watch = notes.filter((n) => n.severity === "watch");
  if (fixes.length) {
    const first = fixes[0];
    return { verdict: "fix", headline: `${fixes.length} thing${fixes.length === 1 ? "" : "s"} to fix, pinned on the creative. First: ${first.design}${first.size ? ` (${first.size})` : ""}: ${first.note}` };
  }
  if (watch.length) return { verdict: "minor", headline: `Nothing to fix. ${watch.length} thing${watch.length === 1 ? "" : "s"} worth a second look, pinned on the creative.` };
  return { verdict: "ready", headline: designs === 1 ? "Clean: nothing to fix." : `All ${designs} designs are clean: nothing to fix.` };
}

type Earlier = { id: string; version: number; body: string; t_ms: number | null; x: number | null; author_name: string | null; ai_review_id: string | null };

/** Run a review that startRun created. Uses the server's rights; callers check access. */
export async function runCreativeReview(admin: SupabaseClient, runId: string) {
  const { data: run } = await admin.from("creative_ai_reviews").select("request_id, progress").eq("id", runId).single();
  if (!run) return;
  const requestId = run.request_id as string;
  const progress = run.progress as ReviewProgress;
  let saving = Promise.resolve();
  const save = (extra: Record<string, unknown> = {}) =>
    (saving = saving.then(async () => {
      await admin.from("creative_ai_reviews").update({ progress, updated_at: new Date().toISOString(), ...extra }).eq("id", runId);
    }));

  try {
    const { data: r } = await admin
      .from("board_requests")
      .select("id, number, client_id, angle_name, title, format, audience, brief, sizes, new_count, variation_count")
      .eq("id", requestId)
      .maybeSingle();
    if (!r) throw new AiUnavailable("Ticket not found.");
    const [{ designs }, ctx, { sources, model }] = await Promise.all([currentCreative(admin, requestId), clientContext(admin, r.client_id), getAgent("creativereview")]);
    if (!ctx) throw new AiUnavailable("Client not found.");
    const withFiles = designs.filter((d) => d.files.length);

    // 1. Open every file, and every frame of a video (real progress: one step per picture)
    const pics = new Map<string, Pic[]>();
    const said = new Map<string, { lines: Line[] | null; note: string | null }>();
    for (const d of withFiles) {
      const list: Pic[] = [];
      const main = mainVideo(d.files);
      const frames = main?.frames?.length ? pickFrames(main.frames) : [];
      if (main && frames.length) {
        progress.files.label = `Watching D${d.position} · ${frames.length} frames`;
        void save();
        for (const fr of frames) {
          const data = await jpegOf(admin, fr.path, FRAME_SIDE);
          progress.files.done++;
          if (data) list.push({ data, fileId: main.id, ms: fr.ms, label: `${sizeOf(r.format, main)} video at ${clock(fr.ms)}${main.duration_ms ? ` (of ${clock(main.duration_ms)})` : ""}` });
          if (progress.files.done % 6 === 0) void save();
        }
        progress.files.label = `Listening to D${d.position}`;
        void save();
        said.set(d.id, await transcriptOf(admin, main));
      }
      for (const f of d.files.filter((f) => f !== main || !frames.length).slice(0, MAX_PER_DESIGN)) {
        progress.files.label = `Opening D${d.position} · ${sizeOf(r.format, f)}`;
        void save();
        const data = await picture(admin, f);
        progress.files.done++;
        if (data) list.push({ data, fileId: f.id, ms: null, label: `${sizeOf(r.format, f)}${f.width && f.height ? ` · ${f.width}×${f.height}` : ""}${isVideo(f) ? " · the video's cover frame only" : ""}` });
      }
      pics.set(d.id, list);
    }
    progress.phase = "designs";
    progress.files.label = "Files ready";
    await save();

    const ticket = `<ticket>
#${r.number} · ${r.title}
Format: ${r.format} · asked for ${r.new_count} net new and ${r.variation_count} variation${r.variation_count === 1 ? "" : "s"}
Sizes asked for: ${((r.sizes ?? []) as string[]).map(aspectLabel).join(", ") || "not set"}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
</ticket>`;
    const context = contextBlock(ctx, undefined, sources);
    // In a client revision: what the client asked for, so the check confirms each one was done
    const asks = await clientAsks(admin, requestId);
    // Comments still open on earlier versions (ours and the AI's), for the review to check off
    const { data: openComments } = await admin
      .from("review_comments")
      .select("id, design_id, version, body, t_ms, x, author_name, ai_review_id")
      .eq("request_id", requestId)
      .eq("round", "internal")
      .is("resolved_at", null);

    // 2. Review design by design, a few at a time
    const notes: CreativeNote[] = [];
    const queue = [...withFiles];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const p = progress.designs.find((x) => x.ref === `D${d.position}`)!;
        p.status = "checking";
        p.startedAt = Date.now();
        void save();
        const own = pics.get(d.id) ?? [];
        const parent = d.variation_of ? withFiles.find((x) => x.id === d.variation_of) : null;
        const compare = parent ? (pics.get(parent.id) ?? []).slice(0, 1) : [];
        if (!own.length) {
          p.status = "failed";
          void save();
          continue;
        }
        const lines = [
          ...own.map((x, i) => `Picture ${i + 1}: D${d.position} "${d.name}" · ${x.label}`),
          ...compare.map((x, i) => `Picture ${own.length + i + 1}: D${parent!.position} "${parent!.name}" · ${x.label} · ONLY FOR COMPARISON (the design this one varies): don't place notes on it`),
        ];
        const audio = said.get(d.id);
        const earlier = ((openComments ?? []) as (Earlier & { design_id: string })[]).filter((c) => c.design_id === d.id && (c.version < d.current_version || c.ai_review_id));
        // The AI's own open comments on this same version (an earlier run on unchanged files) are replaced by this run
        const replaced = earlier.filter((c) => c.version === d.current_version).map((c) => c.id);
        const toCheck = earlier.filter((c) => c.version < d.current_version).slice(0, 20);
        try {
          const out = await askJson<{ notes: (Omit<CreativeNote, "design"> & { picture: number; x: number; y: number; w: number; h: number })[]; fixed: number[] }>({
            agent: "creativereview",
            label: `creative review #${r.number} D${d.position}`,
            system: CREATIVE_REVIEW_SYSTEM,
            schema: DESIGN_NOTES_SCHEMA,
            maxTokens: 16000,
            images: [...own, ...compare].map((x) => ({ mediaType: "image/jpeg" as const, data: x.data })),
            prompt: `${context}

${ticket}

You're reviewing D${d.position} "${d.name}" (${d.is_variation ? `a variation${parent ? ` of D${parent.position} "${parent.name}"` : ""}` : "net new"}), version ${d.current_version}.
The pictures, in order:
${lines.join("\n")}${d.files.length > MAX_PER_DESIGN ? `\n(${d.files.length - MAX_PER_DESIGN} more files of this design weren't included.)` : ""}
${audio?.lines ? (audio.lines.length ? `\n<what_is_said>\n${audio.lines.map((l) => `${clock(l.ms)}: ${l.text}`).join("\n")}\n</what_is_said>\n` : "\nNothing is said in the video (music or silence only).\n") : audio?.note ? `\n(The audio couldn't be transcribed: ${audio.note}. Review what's on screen.)\n` : ""}${
              toCheck.length
                ? `\n<earlier_comments>\nStill open from earlier versions. Check each against this version and list in fixed the ones it clearly fixes:\n${toCheck.map((c, i) => `${i + 1}. (v${c.version}${c.t_ms != null ? ` at ${clock(c.t_ms)}` : c.x != null ? ", pinned" : ""}, ${c.author_name ?? "a teammate"}) ${c.body.slice(0, 400)}`).join("\n")}\n</earlier_comments>\n`
                : ""
            }
${(() => {
  const mine = asks.pins.filter((p) => p.designId === d.id).map((p) => `- ${p.text}`);
  const overall = asks.round?.design_note ? [`- Overall: ${asks.round.design_note}`] : [];
  return mine.length || overall.length
    ? `\n<client_asked_for_changes>\nThe client reviewed the previous version and asked for these changes. For each one, add a note with area "Client ask": severity "good" if it's clearly done, "fix" if it isn't (or only partly), saying what you see.\n${[...mine, ...overall].join("\n")}\n</client_asked_for_changes>\n`
    : "";
})()}
Review it and leave your notes, each placed on the creative.`,
          });
          const now = new Date().toISOString();
          // Earlier comments the new version fixed, and the AI's own replaced ones: resolved, kept in the history
          const fixedIds = (out.fixed ?? []).map((n) => toCheck[n - 1]?.id).filter((x): x is string => Boolean(x));
          if (fixedIds.length) await admin.from("review_comments").update({ resolved_at: now, resolved_by: null, resolved_by_ai: true }).in("id", fixedIds);
          if (replaced.length) await admin.from("review_comments").update({ resolved_at: now, resolved_by: null, resolved_by_ai: true }).in("id", replaced);

          const mine: CreativeNote[] = out.notes.map((n) => {
            const pic = n.picture >= 1 && n.picture <= own.length ? own[n.picture - 1] : null;
            const box = pic && n.w > 0.005 && n.h > 0.005 ? { x: clamp(n.x), y: clamp(n.y), w: Math.min(1 - clamp(n.x), clamp(n.w)), h: Math.min(1 - clamp(n.y), clamp(n.h)) } : null;
            return { severity: n.severity, size: n.size, area: n.area, note: n.note, design: `D${d.position}`, designId: d.id, fileId: pic?.fileId ?? null, atMs: pic?.ms ?? null, box: pic?.ms != null ? null : box };
          });
          // The fixes and things to watch go on the creative as comments, like a reviewer's
          const pinned = mine.filter((n) => n.severity !== "good");
          if (pinned.length) {
            const { data: rows } = await admin
              .from("review_comments")
              .insert(
                pinned.map((n) => ({
                  request_id: requestId,
                  client_id: r.client_id,
                  design_id: d.id,
                  version: d.current_version,
                  file_id: n.fileId,
                  x: n.box?.x ?? null,
                  y: n.box?.y ?? null,
                  w: n.box?.w ?? null,
                  h: n.box?.h ?? null,
                  t_ms: n.atMs,
                  body: `${n.severity === "fix" ? "Fix" : "Worth a look"}${n.area ? ` · ${n.area}` : ""}: ${n.note}`.slice(0, 2000),
                  round: "internal",
                  author_id: null,
                  author_name: AI_NAME,
                  ai_review_id: runId,
                  severity: n.severity,
                  area: n.area || null,
                })),
              )
              .select("id");
            (rows ?? []).forEach((row, i) => (pinned[i].commentId = row.id as string));
          }
          notes.push(...mine);
          p.status = "done";
          p.fixes = mine.filter((n) => n.severity === "fix").length;
          p.watch = mine.filter((n) => n.severity === "watch").length;
        } catch (e) {
          p.status = "failed";
          if (e instanceof AiUnavailable && withFiles.length === 1) throw e;
        }
        void save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, withFiles.length) }, worker));
    if (progress.designs.every((x) => x.status === "failed")) throw new AiUnavailable("The AI couldn't review the designs. Try again.");

    const order = { fix: 0, watch: 1, good: 2 } as const;
    const pos = (ref: string) => Number(ref.slice(1)) || 0;
    notes.sort((a, b) => order[a.severity] - order[b.severity] || pos(a.design) - pos(b.design) || (a.atMs ?? 0) - (b.atMs ?? 0));
    const content: CreativeNotes = { ...summarize(notes, withFiles.length), notes };
    progress.phase = "done";
    await save({ status: "done", content, model });
    return content;
  } catch (e) {
    await saving;
    await admin
      .from("creative_ai_reviews")
      .update({ status: "failed", progress, error: e instanceof AiUnavailable ? e.message : "The AI review didn't finish.", updated_at: new Date().toISOString() })
      .eq("id", runId);
  }
}

const clamp = (n: number) => Math.min(1, Math.max(0, Number(n) || 0));

/** At most MAX_FRAMES, keeping all of the hook and spreading the rest evenly */
function pickFrames(frames: Frame[]) {
  const sorted = [...frames].sort((a, b) => a.ms - b.ms);
  if (sorted.length <= MAX_FRAMES) return sorted;
  const hook = sorted.filter((f) => f.ms < 3000);
  const rest = sorted.filter((f) => f.ms >= 3000);
  const room = MAX_FRAMES - hook.length;
  const step = rest.length / room;
  return [...hook, ...Array.from({ length: room }, (_, i) => rest[Math.floor(i * step)])];
}

// ─── Preparing videos ───────────────────────────────────────────────────────

/** The current versions' videos that haven't had their frames captured yet (the browser does it before a review). */
export async function videosToPrepare(admin: SupabaseClient, requestId: string) {
  const { designs } = await currentCreative(admin, requestId);
  const files = designs.flatMap((d) => {
    const main = mainVideo(d.files);
    return main && !main.frames ? [main] : [];
  });
  return Promise.all(
    files.map(async (f) => {
      const { data } = await admin.storage.from(BUCKET).createSignedUrl(f.path, 3600);
      return { fileId: f.id, path: f.path, url: data?.signedUrl ?? null, durationMs: f.duration_ms };
    }),
  );
}
