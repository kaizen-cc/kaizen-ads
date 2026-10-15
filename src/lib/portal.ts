import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ad } from "@/lib/copy";

// What a client sees in their portal: ads waiting on them (each ticket in "With client", with its creative and its
// approved copy), what we're changing for them, what's live in their ad account, and what's approved and launching.

export type PortalFile = { id: string; url: string | null; thumbUrl: string | null; aspect: string | null; mime: string; width: number | null; height: number | null; card: number | null };
export type PortalDesign = { id: string; position: number; name: string; isVariation: boolean; version: number; files: PortalFile[]; clientStatus: "approved" | "changes" | null; context?: boolean };
export type PortalItem = {
  id: string;
  number: number;
  title: string;
  format: "image" | "video" | "carousel";
  designs: PortalDesign[]; // context: approved earlier (on the ticket it split into), shown in previews, not asked again
  ads: { ad: Ad; status: "approved" | "changes" | null }[];
  revised: { round: number; changes: { asked: string; changed: string }[] } | null;
  landingUrl: string | null;
  summary: { why: string; audience: string; strategy: string } | null;
};
export type PortalRow = { id: string; title: string; note: string; thumbUrl: string | null };
export type RunningAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null };
export type PortalData = {
  items: PortalItem[];
  revising: PortalRow[];
  approved: PortalRow[];
  running: { ads: RunningAd[]; syncedAt: string | null };
};

const BUCKET = "creative";

type FileRow = { id: string; path: string; thumb_path: string | null; mime: string; aspect: string | null; width: number | null; height: number | null; card: number | null; original_name: string };
type DesignRow = { id: string; request_id: string; position: number; name: string; is_variation: boolean; current_version: number; client_status: "approved" | "changes" | null; design_versions: { version: number; design_files: FileRow[] }[] };

/** Every design's current files, with links that last an hour. */
async function designsFor(db: SupabaseClient, requestIds: string[]) {
  if (!requestIds.length) return new Map<string, PortalDesign[]>();
  const { data } = await db
    .from("designs")
    .select("id, request_id, position, name, is_variation, current_version, client_status, design_versions(version, design_files(id, path, thumb_path, mime, aspect, width, height, card, original_name))")
    .in("request_id", requestIds)
    .order("position");
  const rows = (data ?? []) as unknown as DesignRow[];
  const current = rows.map((d) => ({ d, files: (d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? []).sort((a, b) => (a.card ?? 0) - (b.card ?? 0) || a.original_name.localeCompare(b.original_name)) }));
  const paths = current.flatMap(({ files }) => files.flatMap((f) => [f.path, f.thumb_path].filter(Boolean) as string[]));
  const signed = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const { data: s } = await db.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 500), 3600);
    for (const x of s ?? []) if (x.path && x.signedUrl) signed.set(x.path, x.signedUrl);
  }
  const out = new Map<string, PortalDesign[]>();
  for (const { d, files } of current) {
    if (!files.length) continue;
    const list = out.get(d.request_id) ?? [];
    list.push({
      id: d.id,
      position: d.position,
      name: d.name,
      isVariation: d.is_variation,
      version: d.current_version,
      clientStatus: d.client_status,
      files: files.map((f) => ({ id: f.id, url: signed.get(f.path) ?? null, thumbUrl: f.thumb_path ? (signed.get(f.thumb_path) ?? null) : null, aspect: f.aspect, mime: f.mime, width: f.width, height: f.height, card: f.card })),
    });
    out.set(d.request_id, list);
  }
  return out;
}

const cover = (designs: PortalDesign[] | undefined) => {
  const f = designs?.[0]?.files.find((x) => x.aspect === "4x5") ?? designs?.[0]?.files[0];
  return f?.thumbUrl ?? (f?.mime.startsWith("image/") ? f.url : null) ?? null;
};

export async function loadPortal(db: SupabaseClient, clientId: string): Promise<PortalData> {
  const [{ data: tickets }, { data: snap }] = await Promise.all([
    db
      .from("requests")
      .select("id, number, title, format, stage, stage_entered_at, landing_url, client_summary, parent_id")
      .eq("client_id", clientId)
      .in("stage", ["client_review", "client_revision", "copy", "copy_review", "ready_for_client", "ready_for_launch"])
      .order("stage_entered_at"),
    db.from("meta_snapshots").select("fetched_at, ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const all = tickets ?? [];
  const ids = all.map((t) => t.id);
  // Tickets split off from these (the pieces the client approved): their designs show as context on copy-only reworks
  const { data: kids } = ids.length ? await db.from("requests").select("id, parent_id").in("parent_id", ids) : { data: [] as { id: string; parent_id: string }[] };
  const [designs, { data: copy }, { data: rounds }] = await Promise.all([
    designsFor(db, [...ids, ...(kids ?? []).map((k) => k.id)]),
    ids.length ? db.from("copy_sets").select("request_id, ads, status, client_status").in("request_id", ids) : Promise.resolve({ data: [] as { request_id: string; ads: Ad[]; status: string; client_status: unknown }[] }),
    ids.length ? db.from("client_rounds").select("request_id, round, decision, targets, copy_notes, design_note, changes, sent_back_at, created_at").in("request_id", ids).order("round", { ascending: false }) : Promise.resolve({ data: [] as never[] }),
  ]);
  const copyOf = new Map((copy ?? []).map((c) => [c.request_id, c]));
  const latest = new Map<string, NonNullable<typeof rounds>[number]>();
  for (const r of rounds ?? []) if (!latest.has(r.request_id)) latest.set(r.request_id, r);

  const items: PortalItem[] = all
    .filter((t) => t.stage === "client_review" && (designs.get(t.id)?.length || (kids ?? []).some((k) => k.parent_id === t.id)))
    .map((t) => {
      const r = latest.get(t.id);
      const c = copyOf.get(t.id);
      const status = ((c?.client_status ?? []) as { status: "approved" | "changes" | null }[]).map((x) => x?.status ?? null);
      const own = designs.get(t.id) ?? [];
      const context = own.length ? [] : (kids ?? []).filter((k) => k.parent_id === t.id).flatMap((k) => (designs.get(k.id) ?? []).map((d) => ({ ...d, clientStatus: "approved" as const, context: true })));
      return {
        id: t.id,
        number: t.number,
        title: t.title,
        format: t.format,
        designs: [...own, ...context],
        ads: c?.status === "approved" ? ((c.ads ?? []) as Ad[]).map((ad, i) => ({ ad, status: status[i] ?? null })) : [],
        revised: r?.decision === "revise" && r.sent_back_at ? { round: r.round, changes: (r.changes ?? []) as { asked: string; changed: string }[] } : null,
        landingUrl: t.landing_url ?? null,
        summary: (t.client_summary as PortalItem["summary"]) ?? null,
      };
    });

  const revising: PortalRow[] = all
    .filter((t) => ["client_revision", "copy", "copy_review", "ready_for_client"].includes(t.stage))
    .flatMap((t) => {
      const r = latest.get(t.id);
      if (r?.decision !== "revise" || r.sent_back_at) return [];
      const asked = r.design_note ?? r.copy_notes ?? (r.targets.includes("design") ? "changes to the design" : "changes to the copy");
      return [{ id: t.id, title: t.title, note: `You asked: ${asked}`, thumbUrl: cover(designs.get(t.id)) }];
    });

  const approved: PortalRow[] = all
    .filter((t) => t.stage === "ready_for_launch")
    .map((t) => ({
      id: t.id,
      title: t.title,
      note: `Approved ${new Date(t.stage_entered_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })} · we're setting it up`,
      thumbUrl: cover(designs.get(t.id)),
    }));

  // Live in their ad account: the ads that spent in the last sync, biggest first (no numbers shown to the client)
  type SnapAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null; image?: string | null; live?: boolean; spend?: number };
  const running = ((snap?.ads ?? []) as SnapAd[])
    .filter((a) => (a.spend ?? 0) > 0 && a.live !== false)
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))
    .slice(0, 9)
    .map((a) => ({ id: a.id, name: a.name, headline: a.headline, text: a.text, thumbnail: a.image ?? a.thumbnail }));

  return { items, revising, approved, running: { ads: running, syncedAt: snap?.fetched_at ?? null } };
}
