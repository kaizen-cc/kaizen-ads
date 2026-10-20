"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AiUnavailable, askJson, CREATIVE_CHECK_SCHEMA, CREATIVE_CHECK_SYSTEM, type CreativeCheck } from "@/lib/ai";
import { aspectLabel } from "@/lib/uploads/media";

export type DesignFile = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  aspect: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  card: number | null;
  url: string | null; // signed, short-lived
  thumbUrl: string | null;
};
export type BriefChange = { at: string; by: string; note: string };

/**
 * The maker had to change something from the brief (it wasn't possible, an asset was missing…): kept on the ticket,
 * shown under the brief, and posted as a comment so the lead hears about it. Anyone who can see the ticket (RLS).
 */
export async function noteBriefChange(requestId: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const text = note.trim().slice(0, 2000);
  if (!text) return { ok: false, error: "Say what changed." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("requests").select("brief_changes").eq("id", requestId).maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  const list = [...((r.brief_changes ?? []) as BriefChange[]), { at: new Date().toISOString(), by: me.fullName, note: text }];
  const { error } = await supabase.from("requests").update({ brief_changes: list }).eq("id", requestId);
  if (error) return { ok: false, error: error.message };
  await supabase.rpc("comment_request", { p_request: requestId, p_body: `Adjusted the brief: ${text}` });
  revalidatePath("/board");
  return { ok: true };
}

export async function briefChanges(requestId: string): Promise<BriefChange[]> {
  await requireStaff();
  const { data } = await (await createClient()).from("requests").select("brief_changes").eq("id", requestId).maybeSingle();
  return ((data?.brief_changes ?? []) as BriefChange[]).slice(-10);
}

export type DesignVersion = { id: string; version: number; note: string | null; by: string | null; at: string; files: DesignFile[] };
export type Design = {
  id: string;
  position: number;
  name: string;
  isVariation: boolean;
  variationOf: string | null;
  currentVersion: number;
  versions: DesignVersion[]; // newest first
  clientApproved?: boolean; // locked: no new versions
};

type Fail = { ok: false; error: string };
export type Started = { designId: string; versionId: string; version: number; position?: number };

const BUCKET = "creative";

/** Everything uploaded on a ticket, newest version first, with signed links that last an hour. */
export async function ticketDesigns(requestId: string): Promise<Design[]> {
  await requireStaff();
  const supabase = await createClient();
  const { data: designs } = await supabase
    .from("designs")
    .select(
      "id, position, name, is_variation, variation_of, current_version, client_status, design_versions(id, version, note, created_at, profiles(full_name), design_files(id, path, thumb_path, original_name, mime, bytes, width, height, duration_ms, aspect, card))",
    )
    .eq("request_id", requestId)
    .order("position");
  if (!designs?.length) return [];

  type Row = { id: string; path: string; thumb_path: string | null; original_name: string; mime: string; bytes: number; width: number | null; height: number | null; duration_ms: number | null; aspect: string | null; card: number | null };
  type Ver = { id: string; version: number; note: string | null; created_at: string; profiles: { full_name: string } | null; design_files: Row[] };

  const paths = designs.flatMap((d) => (d.design_versions as unknown as Ver[]).flatMap((v) => v.design_files.flatMap((f) => [f.path, f.thumb_path].filter(Boolean) as string[])));
  const signed = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 500), 3600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }

  return designs.map((d) => ({
    id: d.id,
    position: d.position,
    name: d.name,
    isVariation: d.is_variation,
    variationOf: d.variation_of,
    currentVersion: d.current_version,
    clientApproved: d.client_status === "approved",
    versions: (d.design_versions as unknown as Ver[])
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        id: v.id,
        version: v.version,
        note: v.note,
        by: v.profiles?.full_name ?? null,
        at: v.created_at,
        files: v.design_files
          .sort((a, b) => (a.card ?? 0) - (b.card ?? 0) || a.original_name.localeCompare(b.original_name))
          .map((f) => ({
            id: f.id,
            name: f.original_name,
            mime: f.mime,
            bytes: f.bytes,
            aspect: f.aspect,
            width: f.width,
            height: f.height,
            durationMs: f.duration_ms,
            card: f.card,
            url: signed.get(f.path) ?? null,
            thumbUrl: f.thumb_path ? (signed.get(f.thumb_path) ?? null) : null,
          })),
      })),
  }));
}

/** New designs on a ticket. Returns where each one's files go. */
export async function startDesigns(requestId: string, designs: { name: string; variationOf: string | null; variationOfIndex?: number | null }[]): Promise<{ ok: true; started: Started[]; prefix: string } | Fail> {
  await requireStaff();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_designs", {
    p_request: requestId,
    p_designs: designs.map((d) => ({ name: d.name.slice(0, 120), variation_of: d.variationOf, variation_of_index: d.variationOfIndex ?? null })),
  });
  if (error) return { ok: false, error: error.message };
  const { data: r } = await supabase.from("requests").select("client_id").eq("id", requestId).single();
  return {
    ok: true,
    prefix: `${r!.client_id}/${requestId}`,
    started: (data as { design_id: string; version_id: string; version: number; position: number }[]).map((s) => ({
      designId: s.design_id,
      versionId: s.version_id,
      version: s.version,
      position: s.position,
    })),
  };
}

/** Replace: a new version of a design. */
export async function startVersion(designId: string, note: string): Promise<{ ok: true; started: Started; prefix: string } | Fail> {
  await requireStaff();
  const supabase = await createClient();
  const { data: locked } = await supabase.from("designs").select("client_status").eq("id", designId).maybeSingle();
  if (locked?.client_status === "approved") return { ok: false, error: "The client approved this design, so it's locked." };
  const { data, error } = await supabase.rpc("add_design_version", { p_design: designId, p_note: note || null });
  if (error) return { ok: false, error: error.message };
  const { data: d } = await supabase.from("designs").select("client_id, request_id").eq("id", designId).single();
  const s = data as { design_id: string; version_id: string; version: number };
  return { ok: true, prefix: `${d!.client_id}/${d!.request_id}`, started: { designId: s.design_id, versionId: s.version_id, version: s.version } };
}

export type UploadedFile = {
  path: string;
  thumb_path: string | null;
  original_name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  aspect: string | null;
  card: number | null;
};

/** Called once a version's files are all in storage. */
export async function recordFiles(versionId: string, files: UploadedFile[]): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_design_files", { p_version: versionId, p_files: files });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/board");
  return { ok: true };
}

// ─── Creative check ─────────────────────────────────────────────────────────

/** One design in the upload, as the browser sees it: a small JPEG of its first file (base64) and its sizes. */
export type CheckInput = { name: string; sizes: string[]; image: string | null };
export type CheckResult = { ok: true; check: CreativeCheck; left: number | null } | Fail;

/**
 * Before an upload: the AI looks at the new designs next to what's already on the ticket and says which are
 * net new, which are variations and which are the same design in another size. `left` is what's left of the
 * client's allotment for this format (null when no allotment is set).
 */
export async function checkCreative(requestId: string, staged: CheckInput[]): Promise<CheckResult> {
  await requireStaff();
  const supabase = await createClient();
  const { data: r } = await supabase
    .from("requests")
    .select("id, client_id, number, title, format, sizes, new_count, variation_count, angle, clients(name)")
    .eq("id", requestId)
    .single();
  if (!r) return { ok: false, error: "Ticket not found." };

  // What's already uploaded: the cover of each design's newest version
  const { data: rows } = await supabase
    .from("designs")
    .select("id, position, name, is_variation, variation_of, current_version, design_versions(version, design_files(thumb_path, aspect))")
    .eq("request_id", requestId)
    .order("position");
  type Ver = { version: number; design_files: { thumb_path: string | null; aspect: string | null }[] };
  const existing = await Promise.all(
    (rows ?? []).slice(0, 8).map(async (d) => {
      const v = (d.design_versions as unknown as Ver[]).find((x) => x.version === d.current_version);
      const cover = v?.design_files.find((f) => f.aspect === "4x5" && f.thumb_path) ?? v?.design_files.find((f) => f.thumb_path);
      let image: string | null = null;
      if (cover?.thumb_path) {
        const { data } = await supabase.storage.from(BUCKET).download(cover.thumb_path);
        if (data) image = Buffer.from(await data.arrayBuffer()).toString("base64");
      }
      const of = d.variation_of ? (rows ?? []).find((x) => x.id === d.variation_of) : null;
      return { position: d.position, name: d.name, isVariation: d.is_variation, of: of?.position ?? null, sizes: [...new Set(v?.design_files.map((f) => f.aspect).filter(Boolean) ?? [])] as string[], image };
    }),
  );

  const { data: usage } = await supabase.from("client_allotment_usage").select("images_per_month, videos_per_month, images_used, videos_used").eq("client_id", r.client_id).maybeSingle();
  const video = r.format === "video";
  const cap = usage ? (video ? usage.videos_per_month : usage.images_per_month) : null;
  const left = cap === null || cap === undefined ? null : cap - (video ? usage!.videos_used : usage!.images_used);

  const list = staged.slice(0, 12);
  const pictures: { mediaType: "image/jpeg" | "image/webp"; data: string }[] = [];
  const lines: string[] = [];
  list.forEach((d, i) => {
    if (d.image) pictures.push({ mediaType: "image/jpeg", data: d.image });
    lines.push(`S${i + 1} "${d.name}" · sizes ${d.sizes.map(aspectLabel).join(", ") || "unknown"} · ${d.image ? `picture ${pictures.length}` : "no picture (couldn't be read)"}`);
  });
  existing.forEach((d) => {
    if (d.image) pictures.push({ mediaType: "image/webp", data: d.image });
    lines.push(
      `D${d.position} "${d.name}" (already uploaded, ${d.isVariation ? `variation${d.of ? ` of D${d.of}` : ""}` : "net new"}) · sizes ${d.sizes.map(aspectLabel).join(", ") || "unknown"} · ${d.image ? `picture ${pictures.length}` : "no picture"}`,
    );
  });
  if (!pictures.length) return { ok: false, error: "There's nothing the AI can look at in these files." };

  const client = (r.clients as unknown as { name: string } | null)?.name ?? "the client";
  const prompt = `Ticket #${r.number} for ${client}: "${r.title}"${r.angle ? ` · angle: ${r.angle}` : ""}
Format: ${r.format}. Asked for: ${r.new_count} net new and ${r.variation_count} variation${r.variation_count === 1 ? "" : "s"}. Sizes asked for: ${(r.sizes as string[]).map(aspectLabel).join(", ") || "not set"}.

The pictures, in order:
${lines.join("\n")}

Classify every S design.`;

  try {
    const check = await askJson<CreativeCheck>({ agent: "creativecheck", label: `creative check #${r.number}`, system: CREATIVE_CHECK_SYSTEM, prompt, schema: CREATIVE_CHECK_SCHEMA, images: pictures });
    // Keep only answers about designs in this upload that point somewhere real
    const refs = new Set([...list.map((_, i) => `S${i + 1}`), ...existing.map((d) => `D${d.position}`)]);
    check.designs = check.designs
      .filter((d) => /^S\d+$/.test(d.ref) && Number(d.ref.slice(1)) <= list.length)
      .map((d) => (d.kind !== "new" && (!refs.has(d.of) || d.of === d.ref) ? { ...d, kind: "new" as const, of: "" } : d));
    return { ok: true, check, left };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "The creative check didn't work this time." };
  }
}

/** Correct how many net new and variations a ticket is for. Net new is what counts toward the allotment. */
export async function setTicketCounts(requestId: string, newCount: number, variations: number, reason: string): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_request_counts", { p_request: requestId, p_new: newCount, p_variations: variations, p_reason: reason });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/board");
  return { ok: true };
}
