import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { canAccessReport } from "@/lib/reports/access";
import { readHistory } from "@/lib/reports/history";
import { clientDelivery } from "@/lib/reports/send";
import { canBringBack, parseLog } from "@/lib/reports/skip-log";
import { canUndo, type Previous } from "@/lib/reports/regenerate";
import { isWhiteLabel } from "@/lib/reports/white-label";
import { slackConnection, slackIdentity } from "@/lib/slack-user";
import { portalUrl } from "@/lib/site";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { channelName, isChannelPlatform, periodMismatch, type EmailMetrics, type SocialMetrics } from "@/lib/channel-reports/core";
import { refreshChannelForStudio } from "@/lib/channel-reports/refresh";
import { ChannelStudio } from "./channel-studio";

// One email or social report in the studio: the same three steps as an ads report (review, message, send), with its numbers
// brought up to date from the synced data when it opens (the text follows, after the page is sent).

const FIELDS = "id, kind, platform, status, client_id, period_start, period_end, owner_id, viewed_at, message, message_basis, sections, metrics, extras, qa, chat, error, posted_at, previous, share_token, clients(name, slug, slack_channel_id, client_type), profiles!reports_owner_id_fkey(full_name)";

export async function ChannelReportPage({ id, me }: { id: string; me: Staff }) {
  const admin = adminConfigured() ? createAdminClient() : null;
  if (!admin) notFound();
  const read = () => admin.from("reports").select(FIELDS).eq("id", id).maybeSingle();
  const { data: first } = await read();
  if (!first || !isChannelPlatform(first.platform)) notFound();
  if (!(await canAccessReport(await createClient(), me, first as unknown as { owner_id: string | null; client_id: string; platform: string }))) notFound();
  let r = first;
  // Not yet sent: its numbers are worked out again from the synced data (and its text follows them when they moved), so the
  // studio never shows numbers the account has since revised. A sent report is a record and is left alone.
  if ((r.status === "draft" || r.status === "submitted") && r.metrics) {
    await refreshChannelForStudio(admin, id, { id: me.id, name: me.fullName }).catch(() => null);
    r = (await read()).data ?? r;
  }
  if (r.owner_id === me.id && !r.viewed_at) after(async () => void (await admin.from("reports").update({ viewed_at: new Date().toISOString() }).eq("id", id).is("viewed_at", null)));

  const client = r.clients as unknown as { name: string; slug: string; slack_channel_id: string | null; client_type?: string | null };
  const metrics = (r.metrics as (EmailMetrics | SocialMetrics) | null) ?? null;
  const sentNow = r.status === "posted";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [slack, identity, delivery, history, { data: logRow }] = await Promise.all([
    slackConnection(me.id),
    slackIdentity(me.id).catch(() => null),
    sentNow ? Promise.resolve(null) : clientDelivery(admin, r.client_id as string).catch(() => null),
    readHistory(admin, { reportId: r.id as string, limit: 40 }, today),
    admin.from("reports").select("log").eq("id", id).maybeSingle().then((x) => (x.error ? { data: null } : x)),
  ]);
  const stale = !["queued", "drafting", "failed"].includes(r.status as string) && metrics ? periodMismatch({ start: r.period_start as string, end: r.period_end as string }, metrics) : [];
  const label = metrics?.main.label ?? (r.kind === "monthly" ? new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : `${r.period_start} to ${r.period_end}`);
  const whiteLabel = isWhiteLabel(client.client_type);

  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <header className="grid gap-1">
        <Link href={`/reports${me.isExec ? `?line=${r.platform === "klaviyo" ? "email" : "social"}` : ""}`} className="inline-flex min-h-11 w-fit items-center text-xs text-muted hover:text-fg md:min-h-0">
          ← Reports
        </Link>
        <h1 className="font-heading text-[28px] leading-tight [overflow-wrap:anywhere]">{client.name}</h1>
        <p className="text-sm text-muted">
          {channelName(r.platform as "klaviyo" | "social")} · {r.kind === "monthly" ? "Monthly" : "Weekly"} · {label}
        </p>
      </header>
      <ChannelStudio
        report={{
          id: r.id as string,
          kind: r.kind as "weekly" | "monthly",
          platform: r.platform as "klaviyo" | "social",
          status: r.status as string,
          periodLabel: label,
          message: (r.message as string | null) ?? "",
          sections: (r.sections as Sections | null) ?? null,
          metrics,
          extras: (r.extras as string | null) ?? "",
          qa: (r.qa as Qa | null) ?? null,
          chat: ((r.chat ?? []) as ChatTurn[]),
          error: (r.error as string | null) ?? null,
          owner: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
          stale,
          regen: canUndo({ status: r.status as string, previous: r.previous as Previous | null }) ? { at: (r.previous as Previous).at, by: (r.previous as Previous).by } : null,
          skip: { log: parseLog((logRow as { log?: unknown } | null)?.log), canBringBack: canBringBack(r.kind as string, r.period_end as string, today) },
          shareUrl: !whiteLabel && r.share_token ? `${portalUrl()}/r/${r.share_token}` : null,
        }}
        delivery={delivery}
        history={history}
        client={{ name: client.name, hasChannel: Boolean(client.slack_channel_id), whiteLabel }}
        slack={{ connected: slack.connected, name: identity?.name || null, image: identity?.image ?? null, me: me.fullName }}
      />
    </div>
  );
}
