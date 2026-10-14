"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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
export type DesignVersion = { id: string; version: number; note: string | null; by: string | null; at: string; files: DesignFile[] };
export type Design = {
  id: string;
  position: number;
  name: string;
  isVariation: boolean;
  variationOf: string | null;
  currentVersion: number;
  versions: DesignVersion[]; // newest first
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
      "id, position, name, is_variation, variation_of, current_version, design_versions(id, version, note, created_at, profiles(full_name), design_files(id, path, thumb_path, original_name, mime, bytes, width, height, duration_ms, aspect, card))",
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
export async function startDesigns(requestId: string, designs: { name: string; variationOf: string | null }[]): Promise<{ ok: true; started: Started[]; prefix: string } | Fail> {
  await requireStaff();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_designs", {
    p_request: requestId,
    p_designs: designs.map((d) => ({ name: d.name.slice(0, 120), variation_of: d.variationOf })),
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
