import "server-only";
import type { Staff } from "@/lib/auth";
import { clientNamed } from "@/lib/client-named";
import { channelMaySee } from "@/lib/kaizen-ai/channel-access";
import { loadSegmentReport } from "@/lib/klaviyo/segments";
import { PATTERN_LABEL, segmentDigest } from "@/lib/klaviyo/segments-core";
import { isChannelOnly } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, num, type AiTool, type ChatExtra } from "./types";

// Segment performance for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   segment_performance   one client's email segments: campaigns, recipients, open, click, revenue and revenue per
//                         recipient per list and segment, the ones underperforming or overused, who to include and leave
//                         out, and what kinds of segment earn for similar clients (src/lib/klaviyo/segments-core.ts).
// Read with the person's own session first (only clients they can see); the similar clients are aggregated, never named.

const segmentPerformance: AiTool = {
  name: "segment_performance",
  description:
    "How one client's email lists and segments perform: per segment the campaigns sent to it, recipients, open, click, revenue and revenue per recipient over 30, 90 or 120 days, flagged underperforming or overused; advice on who to include and who to exclude (engaged 30 days and leaving out the unengaged when deliverability is low, targeting zero-time purchasers while excluding recent buyers, resting an overused segment); and which kinds of segment work for other clients in the same industry and sub-category. Use it for 'which segments are working for X', 'who should we send to', 'what should we exclude'. To show it, open_screen to the client's email Audience tab (or the KPI board's email sheet, Segments tab).",
  input_schema: { type: "object", properties: { client: { type: "string", description: "The client's name or slug (the one this chat is about when left out)" }, days: { type: "number", enum: [30, 90, 120], description: "The window; 90 when left out" } }, additionalProperties: false },
  run: async (user: Staff, input: Record<string, unknown>, chat?: ChatExtra) => {
    const db = await createClient();
    const asked = str(input.client);
    type Row = { id: string; name: string; slug: string };
    let row = null as Row | null;
    if (asked) {
      try {
        row = await clientNamed(db, asked);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `No client called "${asked}" that you can see.` };
      }
    } else if (chat?.clientId) {
      const { data } = await db.from("clients").select("id, name, slug").eq("id", chat.clientId).maybeSingle();
      row = (data as Row | null) ?? null;
    }
    if (!row) return { ok: false, error: "Which client? Name one." };
    if (!adminConfigured()) return { ok: false, error: "Not set up here." };
    const admin = createAdminClient();
    // The email and social teams see a client only as their line allows (the same rule the database applies)
    if (isChannelOnly(user.role)) {
      const [{ data: c }, { data: seats }] = await Promise.all([
        admin.from("clients").select("archived_at, services, services_extra, services_removed").eq("id", row.id).maybeSingle(),
        admin.from("client_assignments").select("profile_id").eq("client_id", row.id),
      ]);
      if (!c || !channelMaySee({ id: user.id, role: user.role }, { archived: Boolean(c.archived_at), services: servicesOf(c), seatHolders: (seats ?? []).map((a) => String(a.profile_id)) })) return { ok: false, error: "You can't see this client." };
    }
    const d = num(input.days);
    const days = d === 30 || d === 120 ? d : 90;
    const report = await loadSegmentReport(admin, row.id, { days, peerDb: admin });
    if (!report) return { ok: true, client: row.name, note: "No email campaigns or audiences are read for this client yet." };
    return {
      ok: true,
      client: row.name,
      days,
      summary: segmentDigest(report),
      campaigns: report.campaigns,
      campaignsWithAudiences: report.withAudiences,
      segments: report.segments.slice(0, 20).map((s) => ({ name: s.name, type: s.type, kind: PATTERN_LABEL[s.pattern], campaigns: s.campaigns, recipients: s.recipients, openRate: s.openRate, clickRate: s.clickRate, revenue: s.revenue, revenuePerRecipient: s.rpr, flags: s.flags })),
      advice: report.advice,
      similarClients: report.peerScope ? { scope: report.peerScope, patterns: report.peers.slice(0, 6) } : null,
      open: `/clients/${row.slug}?service=email&tab=audience`,
    };
  },
};

export const tools: AiTool[] = [segmentPerformance];
