import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ad } from "@/lib/copy";

// What a client sees in their portal: ads waiting on them (each ticket in "With client", with its creative and its
// approved copy), what we're changing for them, what's live in their ad account, and what's approved and launching.

export type PortalFile = { id: string; url: string | null; thumbUrl: string | null; aspect: string | null; mime: string; width: number | null; height: number | null; card: number | null };
/** What the client said on the version they reviewed: a spot, a box, a moment in a video, or the whole design. */
export type PastNote = { fileId: string | null; x: number | null; y: number | null; w: number | null; h: number | null; tMs: number | null; body: string };
export type PortalDesign = {
  id: string;
  position: number;
  name: string;
  isVariation: boolean;
  version: number;
  files: PortalFile[];
  clientStatus: "approved" | "changes" | null;
  context?: boolean;
  /** A revised design: the version the client reviewed, and what they said about it */
  previous?: { version: number; files: PortalFile[]; notes: PastNote[] } | null;
};
export type PortalItem = {
  id: string;
  number: number;
  title: string;
  format: "image" | "video" | "carousel";
  designs: PortalDesign[]; // context: approved earlier (on the ticket it split into), shown in previews, not asked again
  ads: { ad: Ad; status: "approved" | "changes" | null; note: string | null; before: Ad | null }[]; // note / before: what they asked last time, and the copy they saw
  revised: { round: number; changes: { asked: string; changed: string }[] } | null;
  landingUrl: string | null;
  summary: { why: string; audience: string; strategy: string } | null;
};
/** A ticket on the home page (in revision, launching soon), with its creative and copy for a quick look. */
export type PortalRow = { id: string; title: string; note: string; thumbUrl: string | null; item: PortalItem };
export type RunningAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null };
export type PortalData = {
  items: PortalItem[];
  revising: PortalRow[];
  approved: PortalRow[];
  launched: PortalRow[]; // launched in the last 30 days (they show in Running now once they're delivering)
  running: { ads: RunningAd[]; syncedAt: string | null };
};

const BUCKET = "creative";

type FileRow = { id: string; path: string; thumb_path: string | null; mime: string; aspect: string | null; width: number | null; height: number | null; card: number | null; original_name: string };
type DesignRow = { id: string; request_id: string; position: number; name: string; is_variation: boolean; current_version: number; client_status: "approved" | "changes" | null; client_version: number | null; design_versions: { version: number; design_files: FileRow[] }[] };

/** Every design's current files, with links that last an hour. */
async function designsFor(db: SupabaseClient, requestIds: string[]) {
  if (!requestIds.length) return new Map<string, PortalDesign[]>();
  const { data } = await db
    .from("designs")
    .select("id, request_id, position, name, is_variation, current_version, client_status, client_version, design_versions(version, design_files(id, path, thumb_path, mime, aspect, width, height, card, original_name))")
    .in("request_id", requestIds)
    .order("position");
  const rows = (data ?? []) as unknown as DesignRow[];
  const sorted = (files: FileRow[]) => files.slice().sort((a, b) => (a.card ?? 0) - (b.card ?? 0) || a.original_name.localeCompare(b.original_name));
  // A revised design: the client asked for changes on the version they reviewed (client_version)
  const revisedFrom = (d: DesignRow) => (d.client_status === "changes" && d.client_version ? d.client_version : null);
  // ...and the old files, when there's a newer version to compare with
  const hasOlder = (d: DesignRow) => Boolean(revisedFrom(d) && revisedFrom(d)! < d.current_version);
  const current = rows.map((d) => ({
    d,
    files: sorted(d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? []),
    before: hasOlder(d) ? sorted(d.design_versions.find((v) => v.version === revisedFrom(d))?.design_files ?? []) : [],
  }));
  const paths = current.flatMap(({ files, before }) => [...files, ...before].flatMap((f) => [f.path, f.thumb_path].filter(Boolean) as string[]));
  // What the client said on the versions they reviewed
  const revised = rows.filter((d) => revisedFrom(d));
  const { data: past } = revised.length
    ? await db.from("review_comments").select("design_id, version, file_id, x, y, w, h, t_ms, body").eq("round", "client").in("design_id", revised.map((d) => d.id)).order("created_at")
    : { data: [] as { design_id: string; version: number; file_id: string | null; x: number | null; y: number | null; w: number | null; h: number | null; t_ms: number | null; body: string }[] };
  const signed = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    const { data: s } = await db.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 500), 3600);
    for (const x of s ?? []) if (x.path && x.signedUrl) signed.set(x.path, x.signedUrl);
  }
  const out = new Map<string, PortalDesign[]>();
  const toFile = (f: FileRow): PortalFile => ({ id: f.id, url: signed.get(f.path) ?? null, thumbUrl: f.thumb_path ? (signed.get(f.thumb_path) ?? null) : null, aspect: f.aspect, mime: f.mime, width: f.width, height: f.height, card: f.card });
  const num = (v: unknown) => (v == null ? null : Number(v));
  for (const { d, files, before } of current) {
    if (!files.length) continue;
    const list = out.get(d.request_id) ?? [];
    list.push({
      id: d.id,
      position: d.position,
      name: d.name,
      isVariation: d.is_variation,
      version: d.current_version,
      clientStatus: d.client_status,
      files: files.map(toFile),
      previous: revisedFrom(d)
        ? {
            version: revisedFrom(d)!,
            files: before.map(toFile),
            notes: (past ?? [])
              .filter((c) => c.design_id === d.id && c.version === revisedFrom(d))
              .map((c) => ({ fileId: c.file_id, x: num(c.x), y: num(c.y), w: num(c.w), h: num(c.h), tMs: c.t_ms, body: c.body })),
          }
        : null,
    });
    out.set(d.request_id, list);
  }
  return out;
}

const cover = (designs: PortalDesign[] | undefined) => {
  const f = designs?.[0]?.files.find((x) => x.aspect === "4x5") ?? designs?.[0]?.files[0];
  return f?.thumbUrl ?? (f?.mime.startsWith("image/") ? f.url : null) ?? null;
};

/** Every design of a ticket, as a list (for previews and thumbnails). */
export async function designsForTickets(db: SupabaseClient, requestIds: string[]) {
  return designsFor(db, requestIds);
}

export async function loadPortal(db: SupabaseClient, clientId: string): Promise<PortalData> {
  const [{ data: tickets }, { data: snap }] = await Promise.all([
    db
      .from("requests")
      .select("id, number, title, format, stage, stage_entered_at, launched_at, landing_url, client_summary, parent_id")
      .eq("client_id", clientId)
      .is("deleted_at", null)
      .or(`stage.in.(client_review,client_revision,in_production,internal_review,copy,copy_review,ready_for_client,ready_for_launch),and(stage.eq.launched,launched_at.gte.${new Date(Date.now() - 30 * 86_400_000).toISOString()})`)
      .order("stage_entered_at"),
    db.from("meta_snapshots").select("fetched_at, ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const all = tickets ?? [];
  const ids = all.map((t) => t.id);
  // Tickets split off from these (the pieces the client approved): their designs show as context on copy-only reworks
  const { data: kids } = ids.length ? await db.from("requests").select("id, parent_id").in("parent_id", ids).is("deleted_at", null) : { data: [] as { id: string; parent_id: string }[] };
  const [designs, { data: copy }, { data: rounds }] = await Promise.all([
    designsFor(db, [...ids, ...(kids ?? []).map((k) => k.id)]),
    ids.length ? db.from("copy_sets").select("request_id, ads, previous_ads, status, client_status").in("request_id", ids) : Promise.resolve({ data: [] as { request_id: string; ads: Ad[]; previous_ads: unknown; status: string; client_status: unknown }[] }),
    ids.length ? db.from("client_rounds").select("request_id, round, decision, targets, copy_notes, design_note, changes, sent_back_at, created_at").in("request_id", ids).order("round", { ascending: false }) : Promise.resolve({ data: [] as never[] }),
  ]);
  const copyOf = new Map((copy ?? []).map((c) => [c.request_id, c]));
  const latest = new Map<string, NonNullable<typeof rounds>[number]>();
  for (const r of rounds ?? []) if (!latest.has(r.request_id)) latest.set(r.request_id, r);

  // A ticket as the client sees it. `copy`: which copy to show (in revision, the copy they reviewed)
  const toItem = (t: (typeof all)[number], copy: "current" | "reviewed" = "current"): PortalItem => {
    const r = latest.get(t.id);
    const c = copyOf.get(t.id);
    const status = (c?.client_status ?? []) as { status: "approved" | "changes" | null; note?: string | null }[];
    const before = (c?.previous_ads ?? null) as Ad[] | null;
    const own = designs.get(t.id) ?? [];
    const context = own.length ? [] : (kids ?? []).filter((k) => k.parent_id === t.id).flatMap((k) => (designs.get(k.id) ?? []).map((d) => ({ ...d, clientStatus: "approved" as const, context: true })));
    const ads = copy === "reviewed" && before?.length ? before : c?.status === "approved" || copy === "reviewed" ? ((c?.ads ?? []) as Ad[]) : [];
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      format: t.format,
      designs: [...own, ...context],
      ads: ads.map((ad, i) => ({
        ad,
        status: status[i]?.status ?? null,
        note: status[i]?.status === "changes" ? (status[i]?.note ?? null) : null,
        before: copy === "current" && status[i]?.status === "changes" && before?.[i] ? before[i] : null,
      })),
      revised: r?.decision === "revise" && r.sent_back_at ? { round: r.round, changes: (r.changes ?? []) as { asked: string; changed: string }[] } : null,
      landingUrl: t.landing_url ?? null,
      summary: (t.client_summary as PortalItem["summary"]) ?? null,
    };
  };

  // Only what's whole: its designs (or its split-off pieces) and its approved copy, so nothing half-moved reaches the client
  const items: PortalItem[] = all
    .filter((t) => t.stage === "client_review" && (designs.get(t.id)?.length || (kids ?? []).some((k) => k.parent_id === t.id)) && copyOf.get(t.id)?.status === "approved")
    .map((t) => toItem(t));

  const revising: PortalRow[] = all
    .filter((t) => ["client_revision", "copy", "copy_review", "ready_for_client", "internal_review", "in_production"].includes(t.stage))
    .flatMap((t) => {
      const r = latest.get(t.id);
      if (r?.decision !== "revise" || r.sent_back_at) return [];
      const asked = r.design_note ?? r.copy_notes ?? (r.targets.includes("design") ? "changes to the design" : "changes to the copy");
      return [{ id: t.id, title: t.title, note: `You asked: ${asked}`, thumbUrl: cover(designs.get(t.id)), item: toItem(t, "reviewed") }];
    });

  const approved: PortalRow[] = all
    .filter((t) => t.stage === "ready_for_launch")
    .map((t) => ({
      id: t.id,
      title: t.title,
      note: `Approved ${new Date(t.stage_entered_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })} · we're setting it up`,
      thumbUrl: cover(designs.get(t.id)),
      item: toItem(t),
    }));

  const launched: PortalRow[] = all
    .filter((t) => t.stage === "launched")
    .sort((a, b) => (b.launched_at ?? "").localeCompare(a.launched_at ?? ""))
    .map((t) => ({
      id: t.id,
      title: t.title,
      note: `Launched ${new Date(t.launched_at ?? t.stage_entered_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`,
      thumbUrl: cover(designs.get(t.id)),
      item: toItem(t),
    }));

  // Live in their ad account: the ads that spent in the last sync, biggest first (no numbers shown to the client)
  type SnapAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null; image?: string | null; live?: boolean; spend?: number };
  const running = ((snap?.ads ?? []) as SnapAd[])
    .filter((a) => (a.spend ?? 0) > 0 && a.live !== false)
    .sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0))
    .slice(0, 9)
    .map((a) => ({ id: a.id, name: a.name, headline: a.headline, text: a.text, thumbnail: a.image ?? a.thumbnail }));

  return { items, revising, approved, launched, running: { ads: running, syncedAt: snap?.fetched_at ?? null } };
}
