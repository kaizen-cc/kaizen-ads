import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSegmentReport, segCampaignOf, type AudienceInfo, type SegCampaign, type SegmentReport } from "./segments-core";

// Reads one client's segment performance (segments-core.ts does the sums). The campaigns come from klaviyo_campaigns
// (audiences_detail says who each went to and who it left out; until the sync has filled that column, or the migration
// is applied, the older text[] of names stands in). "Similar clients" are the other live clients in the same industry
// and sub-category, read with the server's rights (`peerDb`, the admin client) and only ever shown as patterns, never
// by client. The caller has already checked that the person may see this client.

const CAMPAIGN_COLUMNS = "campaign_id, channel, send_time, recipients, delivered, opens_unique, clicks_unique, unsubscribes, bounced, spam_complaints, revenue, audiences";
const missingColumn = (msg: string | undefined) => Boolean(msg && /column|schema cache/i.test(msg));

const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** The campaigns sent since `from` for these clients, audiences_detail included when the column exists */
async function campaignRows(db: SupabaseClient, clientIds: string[], from: string) {
  const read = (cols: string) => db.from("klaviyo_campaigns").select(`client_id, ${cols}`).in("client_id", clientIds).gte("send_time", `${from}T00:00:00Z`).not("send_time", "is", null).order("send_time", { ascending: false }).limit(clientIds.length > 1 ? 8000 : 1500);
  const first = await read(`${CAMPAIGN_COLUMNS}, audiences_detail`);
  if (!first.error) return (first.data ?? []) as unknown as Record<string, unknown>[];
  // The audiences_detail migration isn't applied yet: the older names column still tells who it went to
  if (missingColumn(first.error.message)) {
    const retry = await read(CAMPAIGN_COLUMNS);
    return (retry.data ?? []) as unknown as Record<string, unknown>[];
  }
  return [];
}

/**
 * A client's segment performance over the last `days` days (default 90): per list and segment, flags, advice, and what
 * works for similar clients. Null when the client has no email data at all.
 */
export async function loadSegmentReport(db: SupabaseClient, clientId: string, opts: { days?: number; peerDb?: SupabaseClient | null } = {}): Promise<SegmentReport | null> {
  const days = opts.days ?? 90;
  const today = nyToday();
  const from = new Date(Date.parse(today) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [rows, { data: auds }, { data: client }] = await Promise.all([
    campaignRows(db, [clientId], from),
    db.from("klaviyo_audiences").select("audience_id, name, kind, profile_count").eq("client_id", clientId).limit(200),
    db.from("clients").select("industry, industry_detail").eq("id", clientId).maybeSingle(),
  ]);
  const audiences: AudienceInfo[] = (auds ?? []).filter((a) => a.name).map((a) => ({ name: a.name as string, type: a.kind === "list" ? "list" : "segment", profiles: a.profile_count == null ? null : Number(a.profile_count) }));
  if (!rows.length && !audiences.length) return null;
  const kindByName = new Map(audiences.map((a) => [a.name, a.type] as const));
  const campaigns = rows.map((r) => segCampaignOf(r, kindByName)).filter((c): c is SegCampaign => c != null);

  // Similar clients: the same industry and sub-category when at least two others share it, otherwise the industry alone
  let peers: { clientId: string; campaigns: SegCampaign[] }[] = [];
  let peerScope: SegmentReport["peerScope"] = null;
  const industry = (client?.industry as string | null) ?? null;
  const detail = (client?.industry_detail as string | null) ?? null;
  if (opts.peerDb && industry) {
    const others = async (withDetail: boolean) => {
      let q = opts.peerDb!.from("clients").select("id").eq("industry", industry).is("archived_at", null).neq("id", clientId).limit(80);
      if (withDetail && detail) q = q.eq("industry_detail", detail);
      const { data } = await q;
      return (data ?? []).map((c) => c.id as string);
    };
    let ids = detail ? await others(true) : [];
    let scopedDetail = detail && ids.length >= 2 ? detail : null;
    if (ids.length < 2) {
      ids = await others(false);
      scopedDetail = null;
    }
    if (ids.length) {
      const peerRows = await campaignRows(opts.peerDb, ids, from);
      const byClient = new Map<string, SegCampaign[]>();
      for (const r of peerRows) {
        const c = segCampaignOf(r);
        if (c) byClient.set(String(r.client_id), [...(byClient.get(String(r.client_id)) ?? []), c]);
      }
      peers = [...byClient.entries()].map(([id, list]) => ({ clientId: id, campaigns: list }));
      peerScope = { industry, detail: scopedDetail, clients: peers.length };
    }
  }
  return buildSegmentReport({ campaigns, audiences, peers, peerScope, days, today });
}
