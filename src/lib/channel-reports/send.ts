import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Delivery } from "@/lib/reports/delivery-core";
import { deliver } from "@/lib/reports/send";
import { forClient, isWhiteLabel } from "@/lib/reports/white-label";
import { channelName, isChannelPlatform, keyLines, periodMismatch } from "./core";
import { renderChannelPdf } from "./pdf";
import { ensureChannelSendable } from "./refresh";
import { loadChannelReport } from "./share";

// Sending a channel report to the client, exactly like an ads report: Slack as the person sending it, email to the people
// picked (the PDF attached, replies to the sender), or both; kept in the send history with the PDF as it went. A monthly
// goes out the same way as a weekly (one report, one send): it isn't held for another team's part. The message carries the
// link to the live page (/r/<token>), which opens once the report has gone out.

export async function sendChannelReport(admin: SupabaseClient, id: string, by: { id: string; fullName: string; email: string | null }, delivery: Delivery, note?: string | null) {
  // Right before it goes: the numbers as they are now, and the text following them
  await ensureChannelSendable(admin, id, { id: by.id, name: by.fullName });
  const { data: r } = await admin.from("reports").select("id, kind, platform, status, message, period_start, period_end, share_token, client_id, owner_id, clients(name, slack_channel_id, slug, portal_live, client_type)").eq("id", id).single();
  if (!r || !isChannelPlatform(r.platform)) throw new Error("Report not found");
  const client = r.clients as unknown as { name: string; slack_channel_id: string | null; slug?: string; portal_live?: boolean; client_type?: string | null };
  if (delivery.channels.includes("slack") && !String(r.message ?? "").trim()) throw new Error("There's no message to post yet.");
  const loaded = await loadChannelReport(admin, id);
  if (!loaded) throw new Error("The report hasn't been written yet.");
  const m = loaded.input.metrics;
  const stale = periodMismatch({ start: r.period_start as string, end: r.period_end as string }, m);
  if (stale.length) throw new Error(`The ${channelName(r.platform)} report isn't drawn for ${m.main.label} yet (${stale.join(", ")}). Regenerate it with fresh data first.`);
  const wl = isWhiteLabel(client.client_type);
  const bytes = await renderChannelPdf(loaded.input);
  const link = loaded.shareUrl;
  const base = String(r.message ?? "");
  const message = wl ? forClient(base, true) : link && !base.includes(link) ? `${base.trim()}\n\n*Your ${m.main.label} report:* ${link}` : base;
  const out = await deliver(admin, {
    client: { id: r.client_id as string, ...client },
    kind: r.kind as string,
    platform: r.platform,
    period: { start: r.period_start as string, end: r.period_end as string, label: m.main.label },
    message,
    pdf: { filename: loaded.fileName, title: loaded.fileName.replace(/\.pdf$/, ""), bytes },
    parts: [{ platform: r.platform, metrics: null, sections: (await admin.from("reports").select("sections").eq("id", id).single()).data?.sections ?? null }],
    by,
    delivery,
    slackAs: "user",
    reportId: id,
    owners: [r.owner_id as string | null],
    note,
    serviceLabel: r.platform === "klaviyo" ? "Email" : "Social",
    keyLines: keyLines(m),
  });
  if (!out.ok) return out;
  const slack = out.slack && "channel" in out.slack ? out.slack : null;
  await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id, slack_channel: slack?.channel ?? null, slack_ts: slack?.ts ?? null, updated_at: new Date().toISOString() }).eq("id", id);
  return out;
}
