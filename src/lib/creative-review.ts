import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, clientContext, contextBlock, CREATIVE_NOTES_SCHEMA, CREATIVE_REVIEW_SYSTEM, getAgent, type CreativeNotes } from "@/lib/ai";
import { aspectLabel } from "@/lib/uploads/media";

// The AI's look at a ticket's creative before the Head of Creative reviews it. It sees every file at a size where
// small text is readable, with the brief and what Kaizen knows about the client, and leaves notes for the reviewer.

const BUCKET = "creative";
const MAX_PICTURES = 16;
const MAX_SIDE = 1568; // the most the model looks at; bigger only costs more

type FileRow = { path: string; thumb_path: string | null; mime: string; aspect: string | null; width: number | null; height: number | null; original_name: string; card: number | null };
type DesignRow = { id: string; position: number; name: string; is_variation: boolean; variation_of: string | null; current_version: number; design_versions: { version: number; design_files: FileRow[] }[] };

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

/** Mark a review as started (before it runs in the background), so opening the ticket doesn't start a second one. */
export async function markRunning(admin: SupabaseClient, requestId: string) {
  const [{ signature }, { data: t }] = await Promise.all([currentCreative(admin, requestId), admin.from("requests").select("client_id").eq("id", requestId).single()]);
  if (!t) return null;
  const now = new Date().toISOString();
  await admin.from("creative_ai_reviews").upsert({ request_id: requestId, client_id: t.client_id, signature, status: "running", error: null, started_at: now, updated_at: now }, { onConflict: "request_id" });
  return now;
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

/** Run (or re-run) the AI's review of a ticket's creative and save it. Uses the server's rights; callers check access. */
export async function runCreativeReview(admin: SupabaseClient, requestId: string) {
  const { data: r } = await admin
    .from("board_requests")
    .select("id, number, client_id, angle_name, title, format, audience, brief, sizes, new_count, variation_count")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) throw new AiUnavailable("Ticket not found.");
  const { designs, signature } = await currentCreative(admin, requestId);
  const now = new Date().toISOString();
  await admin
    .from("creative_ai_reviews")
    .upsert({ request_id: requestId, client_id: r.client_id, signature, status: "running", error: null, started_at: now, updated_at: now }, { onConflict: "request_id" });

  try {
    if (!designs.some((d) => d.files.length)) throw new AiUnavailable("There's no creative uploaded to look at.");
    const [ctx, { sources, model }] = await Promise.all([clientContext(admin, r.client_id), getAgent("creativereview")]);
    if (!ctx) throw new AiUnavailable("Client not found.");

    // One picture per file, spread across designs so every design is seen before any gets a third size
    const queue: { d: (typeof designs)[number]; f: FileRow }[] = [];
    for (let round = 0; queue.length < MAX_PICTURES; round++) {
      const batch = designs.filter((d) => d.files[round]).map((d) => ({ d, f: d.files[round] }));
      if (!batch.length) break;
      queue.push(...batch.slice(0, MAX_PICTURES - queue.length));
    }
    const pics = await Promise.all(queue.map((q) => picture(admin, q.f)));
    const images: { mediaType: "image/jpeg"; data: string }[] = [];
    const lines: string[] = [];
    queue.forEach(({ d, f }, i) => {
      const p = pics[i];
      if (!p) return;
      images.push({ mediaType: "image/jpeg", data: p.data });
      const of = d.variation_of ? designs.find((x) => x.id === d.variation_of) : null;
      lines.push(
        `Picture ${images.length}: D${d.position} "${d.name}" (${d.is_variation ? `variation${of ? ` of D${of.position}` : ""}` : "net new"}) · ${
          r.format === "carousel" && f.card ? `card ${f.card}` : aspectLabel(f.aspect)
        }${f.width && f.height ? ` · ${f.width}×${f.height}` : ""}${p.frame ? " · a frame from the video" : ""}`,
      );
    });
    if (!images.length) throw new AiUnavailable("The uploaded files couldn't be opened for the review.");
    const missingFiles = designs.flatMap((d) => d.files).length - images.length;

    const notes = await askJson<CreativeNotes>({
      agent: "creativereview",
      label: `creative review #${r.number}`,
      system: CREATIVE_REVIEW_SYSTEM,
      schema: CREATIVE_NOTES_SCHEMA,
      images,
      prompt: `${contextBlock(ctx, undefined, sources)}

<ticket>
#${r.number} · ${r.title}
Format: ${r.format} · asked for ${r.new_count} net new and ${r.variation_count} variation${r.variation_count === 1 ? "" : "s"}
Sizes asked for: ${((r.sizes ?? []) as string[]).map(aspectLabel).join(", ") || "not set"}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Brief:
${r.brief ?? "(no brief)"}
</ticket>

The pictures, in order:
${lines.join("\n")}${missingFiles > 0 ? `\n(${missingFiles} more file${missingFiles === 1 ? "" : "s"} on the ticket weren't included.)` : ""}

Review the creative and leave your notes for the reviewer.`,
    });
    const order = { fix: 0, watch: 1, good: 2 } as const;
    notes.notes = notes.notes.slice().sort((a, b) => order[a.severity] - order[b.severity]);
    await admin.from("creative_ai_reviews").update({ status: "done", content: notes, model, updated_at: new Date().toISOString() }).eq("request_id", requestId);
    return notes;
  } catch (e) {
    await admin
      .from("creative_ai_reviews")
      .update({ status: "failed", error: e instanceof AiUnavailable ? e.message : "The AI review didn't finish.", updated_at: new Date().toISOString() })
      .eq("request_id", requestId);
    throw e;
  }
}
