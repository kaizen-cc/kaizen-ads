import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { portalUrl } from "@/lib/site";
import { pdfFileName } from "@/lib/reports/delivery-core";
import { isWhiteLabel, whiteLabelFileName } from "@/lib/reports/white-label";
import type { Sections } from "@/lib/reports/write";
import type { ChannelPdfInput } from "./channel-doc";
import { channelName, isChannelPlatform, type EmailMetrics, type SocialMetrics } from "./core";
import { refreshChannelForView } from "./refresh";

// Loading a channel report for reading: the PDF, and the live page the client opens from the link (/r/<token>). Read only.
// The page opens only once the report went to the client.

const FIELDS = "id, client_id, platform, kind, period_start, period_end, status, metrics, sections, share_token, clients(name, slug, portal_live, client_type)";

type Row = { id: string; client_id: string; platform: string; kind: "weekly" | "monthly"; period_start: string; period_end: string; status: string; metrics: EmailMetrics | SocialMetrics | null; sections: Sections | null; share_token: string | null; clients: { name: string; slug: string; portal_live?: boolean; client_type?: string | null } | null };

function build(r: Row) {
  if (!isChannelPlatform(r.platform) || !r.metrics || !r.sections) return null;
  const client = r.clients?.name ?? "Client";
  const whiteLabel = isWhiteLabel(r.clients?.client_type);
  const label = r.metrics.main.label;
  const service = r.platform === "klaviyo" ? "Email" : "Social";
  const input: ChannelPdfInput = { client, clientId: r.client_id, metrics: r.metrics, sections: r.sections, whiteLabel, dashboard: r.clients?.portal_live && !whiteLabel ? `${portalUrl()}/c/${r.clients.slug}/dashboard` : null };
  const fileName = whiteLabel ? whiteLabelFileName(client, r.kind, label, service) : pdfFileName(client, `${service} ${r.kind} report`, label);
  return { input, fileName, client, whiteLabel, label, title: `${channelName(r.platform)} report`, kind: r.kind, platform: r.platform, token: r.share_token, sent: r.status === "posted", shareUrl: !whiteLabel && r.share_token ? `${portalUrl()}/r/${r.share_token}` : null };
}

/** One report, ready for the PDF (numbers brought up to date first when it hasn't gone out) */
export async function loadChannelReport(admin: SupabaseClient, id: string) {
  await refreshChannelForView(admin, id).catch(() => null);
  const { data } = await admin.from("reports").select(FIELDS).eq("id", id).maybeSingle();
  return data ? build(data as unknown as Row) : null;
}

/** A sent report by its share token (the page and PDF the client opens): null for a report that hasn't gone out */
export async function loadChannelShare(admin: SupabaseClient, token: string) {
  if (!/^[\w-]{16,80}$/.test(token)) return null;
  const { data } = await admin.from("reports").select(FIELDS).eq("share_token", token).in("platform", ["klaviyo", "social"]).maybeSingle();
  const out = data ? build(data as unknown as Row) : null;
  return out && out.sent ? out : null;
}
