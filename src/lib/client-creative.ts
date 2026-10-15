import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { designsForTickets } from "@/lib/portal";
import { BOARD_ORDER, stageInfo, type Stage } from "@/lib/stages";

// The client page's record of their creative: what's moving and where, what we've launched, and what's live or paused
// in their ad account. The board is for the work in motion; this is the history.

export type CreativeRow = {
  number: number;
  title: string;
  format: "image" | "video" | "carousel";
  stage: Stage;
  stageLabel: string;
  at: string; // entered this stage (launched: when it launched)
  thumbUrl: string | null;
  internalRounds: number;
  clientRounds: number;
  late: boolean;
};
export type MetaRow = {
  id: string;
  name: string;
  headline: string | null;
  text: string | null;
  thumbnail: string | null;
  spend: number;
  results: number;
  result: string | null;
  costPerResult: number | null;
  ctr: number;
};
export type ClientCreative = { moving: CreativeRow[]; launched: CreativeRow[]; live: MetaRow[]; paused: MetaRow[]; syncedAt: string | null };

type Row = {
  id: string;
  number: number;
  title: string;
  format: CreativeRow["format"];
  stage: Stage;
  stage_entered_at: string;
  launched_at: string | null;
  internal_rounds: number | null;
  client_rounds: number | null;
  minutes_over: number | null;
};

export async function loadClientCreative(db: SupabaseClient, clientId: string): Promise<ClientCreative> {
  const cols = "id, number, title, format, stage, stage_entered_at, launched_at, internal_rounds, client_rounds, minutes_over";
  const [{ data: moving }, { data: launched }, { data: snap }] = await Promise.all([
    db.from("board_requests").select(cols).eq("client_id", clientId).neq("stage", "launched").order("created_at", { ascending: false }).limit(200),
    db.from("board_requests").select(cols).eq("client_id", clientId).eq("stage", "launched").order("launched_at", { ascending: false }).limit(60),
    db.from("meta_snapshots").select("fetched_at, ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const rows = [...((moving ?? []) as Row[]), ...((launched ?? []) as Row[])];
  const designs = await designsForTickets(db, rows.map((r) => r.id));
  const cover = (id: string) => {
    const d = designs.get(id)?.[0];
    const f = d?.files.find((x) => x.aspect === "4x5") ?? d?.files[0];
    return f?.thumbUrl ?? (f && !f.mime.startsWith("video/") ? f.url : null) ?? null;
  };
  const toRow = (r: Row): CreativeRow => ({
    number: r.number,
    title: r.title,
    format: r.format,
    stage: r.stage,
    stageLabel: stageInfo(r.stage)?.label ?? r.stage,
    at: r.stage === "launched" ? (r.launched_at ?? r.stage_entered_at) : r.stage_entered_at,
    thumbUrl: cover(r.id),
    internalRounds: r.internal_rounds ?? 0,
    clientRounds: r.client_rounds ?? 0,
    late: (r.minutes_over ?? 0) > 0,
  });
  // In motion: in board order, so it reads like the board
  const order = (s: Stage) => (BOARD_ORDER.indexOf(s) < 0 ? 99 : BOARD_ORDER.indexOf(s));

  type SnapAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null; image?: string | null; live?: boolean; spend?: number; results?: number; result?: string | null; costPerResult?: number | null; ctr?: number };
  const ads = ((snap?.ads ?? []) as SnapAd[]).map((a) => ({
    row: {
      id: a.id,
      name: a.name,
      headline: a.headline,
      text: a.text,
      thumbnail: a.image ?? a.thumbnail,
      spend: a.spend ?? 0,
      results: a.results ?? 0,
      result: a.result ?? null,
      costPerResult: a.costPerResult ?? null,
      ctr: a.ctr ?? 0,
    },
    live: a.live,
  }));

  return {
    moving: ((moving ?? []) as Row[]).map(toRow).sort((a, b) => order(a.stage) - order(b.stage)),
    launched: ((launched ?? []) as Row[]).map(toRow),
    // Delivering now (and, until Meta says otherwise, anything that spent in the last sync)
    live: ads.filter((a) => a.live !== false && a.row.spend > 0).map((a) => a.row),
    paused: ads.filter((a) => a.live === false).map((a) => a.row),
    syncedAt: snap?.fetched_at ?? null,
  };
}
