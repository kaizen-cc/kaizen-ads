import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, clientContext, contextBlock, CREATIVE_REVIEW_SYSTEM, DESIGN_NOTES_SCHEMA, getAgent, type CreativeNote, type CreativeNotes } from "@/lib/ai";
import { aspectLabel } from "@/lib/uploads/media";
import { clientAsks } from "@/lib/client-revision";

// The AI's QA of a ticket's creative. The designer or editor runs it before sending the work to creative review, fixes
// what it finds and runs it again; the Head of Creative sees the latest run. It reviews design by design (every size,
// read at a size where small text is readable) so the progress it reports is real: files opened, designs checked.

const BUCKET = "creative";
const MAX_PER_DESIGN = 4;
const MAX_SIDE = 1568; // the most the model looks at; bigger only costs more
const PARALLEL = 3;

type FileRow = { path: string; thumb_path: string | null; mime: string; aspect: string | null; width: number | null; height: number | null; original_name: string; card: number | null };
type DesignRow = { id: string; position: number; name: string; is_variation: boolean; variation_of: string | null; current_version: number; design_versions: { version: number; design_files: FileRow[] }[] };

export type DesignProgress = { ref: string; name: string; status: "waiting" | "checking" | "done" | "failed"; fixes: number; watch: number; startedAt?: number };
export type ReviewProgress = { phase: "files" | "designs" | "done"; files: { done: number; total: number; label: string }; designs: DesignProgress[] };

/** What's on the ticket now: the designs with their current files, and a signature that changes on any re-upload. */
export async function currentCreative(admin: SupabaseClient, requestId: string) {
  const { data } = await admin
    .from("designs")
    .select("id, position, name, is_variation, variation_of, current_version, design_versions(version, design_files(path, thumb_path, mime, aspect, width, height, original_name, card))")
    .eq("request_id", requestId)
    .order("position");
  const designs = ((data ?? []) as unknown as DesignRow[]).map((d) => ({
    ...d,
    files: (d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? []).sort((a, b) => (a.card ?? 0) - (b.card ?? 0) || a.original_name.localeCompare(b.original_name)),
  }));
  const signature = designs.map((d) => `${d.id}:${d.current_version}`).join(",");
  return { designs, signature };
}

/** Start a run: saved as running with its plan, so the progress shows from the first second. Returns its id. */
export async function startRun(admin: SupabaseClient, requestId: string, by: string | null) {
  const [{ designs, signature }, { data: t }] = await Promise.all([currentCreative(admin, requestId), admin.from("requests").select("client_id").eq("id", requestId).single()]);
  if (!t) throw new AiUnavailable("Ticket not found.");
  if (!designs.some((d) => d.files.length)) throw new AiUnavailable("Upload the creative first.");
  const progress: ReviewProgress = {
    phase: "files",
    files: { done: 0, total: designs.reduce((n, d) => n + Math.min(d.files.length, MAX_PER_DESIGN), 0), label: "Opening the files" },
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

async function picture(admin: SupabaseClient, f: FileRow): Promise<{ data: string; frame: boolean } | null> {
  const video = f.mime.startsWith("video/");
  const path = video ? f.thumb_path : f.mime.startsWith("image/") ? f.path : f.thumb_path;
  if (!path) return null;
  const { data } = await admin.storage.from(BUCKET).download(path);
  if (!data) return null;
  try {
    const jpeg = await sharp(Buffer.from(await data.arrayBuffer()), { limitInputPixels: 120_000_000 })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { data: jpeg.toString("base64"), frame: video };
  } catch {
    return null;
  }
}

const sizeOf = (format: string, f: FileRow) => (format === "carousel" && f.card ? `card ${f.card}` : aspectLabel(f.aspect));

/** The verdict and a one-line summary, from the notes. */
function summarize(notes: CreativeNote[], designs: number): Pick<CreativeNotes, "verdict" | "headline"> {
  const fixes = notes.filter((n) => n.severity === "fix");
  const watch = notes.filter((n) => n.severity === "watch");
  if (fixes.length) {
    const first = fixes[0];
    return { verdict: "fix", headline: `${fixes.length} thing${fixes.length === 1 ? "" : "s"} to fix. First: ${first.design}${first.size ? ` (${first.size})` : ""}: ${first.note}` };
  }
  if (watch.length) return { verdict: "minor", headline: `Nothing to fix. ${watch.length} thing${watch.length === 1 ? "" : "s"} worth a second look.` };
  return { verdict: "ready", headline: designs === 1 ? "Clean: nothing to fix." : `All ${designs} designs are clean: nothing to fix.` };
}

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

    // 1. Open every file (real progress: one step per file)
    const pics = new Map<string, { label: string; data: string }[]>();
    for (const d of withFiles) {
      const list: { label: string; data: string }[] = [];
      for (const f of d.files.slice(0, MAX_PER_DESIGN)) {
        progress.files.label = `Opening D${d.position} · ${sizeOf(r.format, f)}`;
        void save();
        const p = await picture(admin, f);
        progress.files.done++;
        if (p) list.push({ data: p.data, label: `${sizeOf(r.format, f)}${f.width && f.height ? ` · ${f.width}×${f.height}` : ""}${p.frame ? " · a frame from the video" : ""}` });
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
          ...compare.map((x, i) => `Picture ${own.length + i + 1}: D${parent!.position} "${parent!.name}" · ${x.label} · ONLY FOR COMPARISON (the design this one varies)`),
        ];
        try {
          const out = await askJson<{ notes: Omit<CreativeNote, "design">[] }>({
            agent: "creativereview",
            label: `creative review #${r.number} D${d.position}`,
            system: CREATIVE_REVIEW_SYSTEM,
            schema: DESIGN_NOTES_SCHEMA,
            images: [...own, ...compare].map((x) => ({ mediaType: "image/jpeg" as const, data: x.data })),
            prompt: `${context}

${ticket}

You're reviewing D${d.position} "${d.name}" (${d.is_variation ? `a variation${parent ? ` of D${parent.position} "${parent.name}"` : ""}` : "net new"}).
The pictures, in order:
${lines.join("\n")}${d.files.length > MAX_PER_DESIGN ? `\n(${d.files.length - MAX_PER_DESIGN} more files of this design weren't included.)` : ""}

${(() => {
  const mine = asks.pins.filter((p) => p.designId === d.id).map((p) => `- ${p.text}`);
  const overall = asks.round?.design_note ? [`- Overall: ${asks.round.design_note}`] : [];
  return mine.length || overall.length
    ? `\n<client_asked_for_changes>\nThe client reviewed the previous version and asked for these changes. For each one, add a note with area "Client ask": severity "good" if it's clearly done, "fix" if it isn't (or only partly), saying what you see.\n${[...mine, ...overall].join("\n")}\n</client_asked_for_changes>\n`
    : "";
})()}
Review it and leave your notes.`,
          });
          const mine = out.notes.map((n) => ({ ...n, design: `D${d.position}` }));
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
    notes.sort((a, b) => order[a.severity] - order[b.severity] || pos(a.design) - pos(b.design));
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
