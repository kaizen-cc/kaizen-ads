import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nyParts } from "@/lib/kpi/calc";
import { ccFrom, loadBuyerSeats, unique } from "@/lib/buyer-seats";
import { LIVE } from "@/lib/live";
import { sendEmail } from "@/lib/email";
import { emailHtml, emailText } from "@/lib/email-layout";
import { logClientEmail } from "@/lib/client-emails";
import { postAsApp, postAsUser } from "@/lib/slack-user";
import { renderReportPdf } from "./pdf";
import { jointMessage, tiktokJoins } from "./joint-core";
import { tiktokConfigured } from "@/lib/tiktok/core";
import { periodsFor, type ReportMetrics } from "./metrics";
import { platformName } from "./format";
import { draftReport, type Sections } from "./write";
import { freshen } from "./regenerate";
import { reportListeners } from "./access";
import { periodMismatch } from "./period";
import { pdfFileName, type Delivery } from "./delivery-core";
import { clientDelivery, deliver, recordSend } from "./send";
import { forClient, isWhiteLabel, WHITE_LABEL_FROM, whiteLabelFileName } from "./white-label";

// The reporting cadence. Mondays: a weekly report is queued for every live account that spent in the last week, and
// drafted a few at a time. The 1st: the monthly recap, one part per buyer on the client (Meta, Google), held until
// every part is submitted, then sent to the client in Slack and by email with the live link and the PDF.

const SITE = () => process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";

type TargetRow = { id: string; client_id: string; platform: string; owner_id: string | null; clients: { status: string; archived_at: string | null } };

/** Live accounts with an owner and spend in the window (from the KPI snapshot). */
async function liveTargets(admin: SupabaseClient, window: "d7" | "d30") {
  const [{ data: targets }, { data: snaps }] = await Promise.all([
    admin.from("kpi_targets").select("id, client_id, platform, owner_id, ad_account_id, clients!inner(status, archived_at, internal)").eq("active", true).not("ad_account_id", "is", null).is("clients.archived_at", null).eq("clients.internal", false),
    admin.from("kpi_snapshots").select("target_id, windows"),
  ]);
  const spent = new Map((snaps ?? []).map((s) => [s.target_id as string, Number((s.windows as Record<string, { spend?: number }> | null)?.[window]?.spend ?? 0)]));
  return ((targets ?? []) as unknown as TargetRow[]).filter((t) => (LIVE as readonly string[]).includes(t.clients.status) && (spent.get(t.id) ?? 0) > 0);
}

/** Queues this week's (or this month's) reports that don't exist yet (one client's, with onlyClient). Safe to run again. */
export async function queueReports(admin: SupabaseClient, kind: "weekly" | "monthly", today = nyParts(new Date()).date, onlyClient?: string) {
  const p = periodsFor(kind, today).main;
  // TikTok's own reports only once TikTok is set up
  const targets = (await liveTargets(admin, kind === "weekly" ? "d7" : "d30")).filter((t) => (!onlyClient || t.client_id === onlyClient) && (t.platform !== "tiktok" || tiktokConfigured()));
  let created = 0;
  if (kind === "weekly") return created + (await queueWeekly(admin, targets, p));
  if (kind === "monthly") {
    for (const clientId of new Set(targets.map((t) => t.client_id))) {
      const { data: bundle } = await admin.from("report_bundles").upsert({ client_id: clientId, kind: "monthly", period_start: p.start, period_end: p.end }, { onConflict: "client_id,kind,period_start", ignoreDuplicates: false }).select("id").single();
      for (const t of targets.filter((x) => x.client_id === clientId)) {
        const { data } = await admin.from("reports").upsert({ client_id: clientId, target_id: t.id, bundle_id: bundle?.id ?? null, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id }, { onConflict: "target_id,kind,period_start", ignoreDuplicates: true }).select("id");
        created += data?.length ?? 0;
      }
    }
  } else
    for (const t of targets) {
      const { data } = await admin.from("reports").upsert({ client_id: t.client_id, target_id: t.id, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id }, { onConflict: "target_id,kind,period_start", ignoreDuplicates: true }).select("id");
      created += data?.length ?? 0;
    }
  return created;
}

/**
 * The weekly reports: one per account; a client's TikTok part joins its Meta report (one report the Meta buyer sends
 * once) unless the client's report prefs send them separately.
 */
async function queueWeekly(admin: SupabaseClient, targets: TargetRow[], p: { start: string; end: string }) {
  const clients = [...new Set(targets.filter((t) => t.platform === "tiktok").map((t) => t.client_id))];
  const { data: prefs } = clients.length ? await admin.from("client_report_prefs").select("client_id, tiktok_separate").in("client_id", clients) : { data: [] };
  const separate = new Set(((prefs ?? []) as { client_id: string; tiktok_separate?: boolean | null }[]).filter((x) => x.tiktok_separate).map((x) => x.client_id));
  const joins = tiktokJoins(targets, separate);
  let created = 0;
  // The Meta (and Google) reports first, so a TikTok part has its Meta report to join
  for (const t of [...targets].sort((a, b) => Number(a.platform === "tiktok") - Number(b.platform === "tiktok"))) {
    const join = joins.get(t.id);
    let joinedTo: string | null = null;
    if (join) {
      const { data: meta } = await admin.from("reports").select("id").eq("target_id", join.metaTargetId).eq("kind", "weekly").eq("period_start", p.start).maybeSingle();
      joinedTo = (meta?.id as string | undefined) ?? null;
    }
    const row = { client_id: t.client_id, target_id: t.id, platform: t.platform, kind: "weekly", period_start: p.start, period_end: p.end, owner_id: joinedTo ? join!.owner : t.owner_id, ...(joinedTo ? { joined_to: joinedTo } : {}) };
    const { data } = await admin.from("reports").upsert(row, { onConflict: "target_id,kind,period_start", ignoreDuplicates: true }).select("id");
    created += data?.length ?? 0;
  }
  return created;
}

/**
 * Drafts queued reports, a few at a time (each is a writer and a QA pass), until the time runs out. A report queued by
 * Regenerate pulls its account's latest numbers first. `regenerated` only takes those (a batch started from the page).
 */
export async function draftQueued(admin: SupabaseClient, budgetMs = 600_000, opts: { regenerated?: boolean } = {}) {
  const until = Date.now() + budgetMs;
  const recent = (at: string | null) => Boolean(at && Date.now() - Date.parse(at) < 6 * 3_600_000);
  let done = 0;
  while (Date.now() < until - 150_000) {
    // Queued ones, and any stuck mid-draft for 20 minutes (a timeout), monthly first (they're critical)
    const stuck = new Date(Date.now() - 20 * 60_000).toISOString();
    let q = admin.from("reports").select("id, status, updated_at, target_id, regenerated_at").or(`status.eq.queued,and(status.eq.drafting,updated_at.lt.${stuck})`);
    if (opts.regenerated) q = q.gte("regenerated_at", new Date(Date.now() - 6 * 3_600_000).toISOString());
    const { data } = await q.order("kind", { ascending: true }).order("created_at").limit(opts.regenerated ? 2 : 3);
    if (!data?.length) break;
    // Each one claimed before it's written, so the schedule and a batch started from the page never write one twice
    const claimed: typeof data = [];
    for (const r of data) {
      const { data: got } = await admin.from("reports").update({ status: "drafting", updated_at: new Date().toISOString() }).eq("id", r.id).eq("status", r.status).eq("updated_at", r.updated_at).select("id").maybeSingle();
      if (got) claimed.push(r);
    }
    await Promise.all(
      claimed.map(async (r) => {
        if (recent(r.regenerated_at as string | null)) await freshen(admin, r.target_id as string);
        await draftReport(admin, r.id);
      }),
    );
    done += claimed.length;
  }
  return done;
}

type Loaded = { id: string; kind: "weekly" | "monthly" | "custom"; platform: "meta" | "google" | "tiktok"; period_start: string; period_end: string; message: string | null; sections: Sections | null; metrics: ReportMetrics | null; extras: string | null; client_id: string; bundle_id: string | null; owner: string | null; client: { name: string; slack_channel_id: string | null; slug?: string; portal_live?: boolean; client_type?: string | null } };

async function load(admin: SupabaseClient, id: string): Promise<Loaded> {
  const { data: r } = await admin.from("reports").select("id, kind, platform, period_start, period_end, message, sections, metrics, extras, client_id, bundle_id, clients(name, slack_channel_id, slug, portal_live, client_type), profiles!reports_owner_id_fkey(full_name)").eq("id", id).single();
  if (!r) throw new Error("Report not found");
  return { ...(r as unknown as Loaded), owner: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null, client: r.clients as unknown as Loaded["client"] };
}

/** A post from the Kaizen app itself (its bot), when it can't go out as a person. */
async function botPost(channel: string, text: string): Promise<{ ok: boolean; ts?: string }> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false };
  const res = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel, text, unfurl_links: false }) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string };
  return { ok: Boolean(body.ok), ts: body.ts };
}

const label = (start: string, end: string) => {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}`;
};
const monthOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** The PDF for one report, or for a whole monthly bundle (every submitted part). */
export async function reportPdf(admin: SupabaseClient, reports: Loaded[]) {
  const first = reports[0];
  return renderReportPdf({
    whiteLabel: whiteLabelOf(first),
    dashboard: dashboardUrl(first),
    shots: first.kind === "monthly" ? await shotsAsk(admin, first) : null,
    client: first.client.name,
    // An on-demand recap reads like a weekly one (its period, against the days before it)
    kind: first.kind === "monthly" ? "monthly" : "weekly",
    periodLabel: first.kind === "monthly" ? monthOf(first.period_start) : label(first.period_start, first.period_end),
    parts: reports.filter((r) => r.metrics && r.sections).map((r) => ({ platform: r.platform, buyer: r.owner, metrics: r.metrics!, sections: r.sections!, extras: r.extras })),
  });
}

/** The monthly recap's ask for clients on a creative package: next cycle's shot list, still to send */
async function shotsAsk(admin: SupabaseClient, r: Loaded) {
  const { currentShotList } = await import("@/lib/shot-list");
  const cur = await currentShotList(admin, r.client_id).catch(() => null);
  const open = (cur?.list.shots ?? []).filter((s) => !s.delivered);
  if (!cur || !open.length) return null;
  return { month: cur.list.month, items: open.map((s) => s.what), url: r.client.portal_live && r.client.slug && !whiteLabelOf(r) ? `${SITE()}/c/${r.client.slug}/shots` : null };
}

/** A white label client: generic reports, no agency name, brand or link anywhere (the PDF, its name, Slack, email) */
const whiteLabelOf = (r: { client: { client_type?: string | null } }) => isWhiteLabel(r.client.client_type);

/** The client's live dashboard, linked under each report (when their portal is open; never for a white label client) */
const dashboardUrl = (r: { client: { slug?: string; portal_live?: boolean; client_type?: string | null } }) => (r.client.portal_live && r.client.slug && !whiteLabelOf(r) ? `${SITE()}/c/${r.client.slug}/dashboard` : null);
const dashboardLine = (r: { client: { slug?: string; portal_live?: boolean; client_type?: string | null } }) => {
  const url = dashboardUrl(r);
  return url ? `\n\n<${url}|See every number on your live dashboard>` : "";
};

/**
 * A weekly report (or an on-demand recap) goes to the client where the buyer chose: their Slack channel as the buyer,
 * email to the people picked (the PDF attached, replies to the buyer), or both. Every page must be for the report's
 * dates first; what went is kept in the history.
 */
export async function sendWeekly(admin: SupabaseClient, id: string, by: { id: string; fullName: string; email: string | null }, delivery: Delivery, note?: string | null) {
  const r = await load(admin, id);
  // A TikTok part joined to its Meta report goes out with it, never on its own
  const { data: self } = await admin.from("reports").select("joined_to").eq("id", id).maybeSingle();
  if ((self as { joined_to?: string | null } | null)?.joined_to) throw new Error("This TikTok part goes out with the client's Meta report: send that one (or set TikTok to go separately in the client's report settings).");
  const { data: joinedRows } = await admin.from("reports").select("id").eq("joined_to", id).neq("status", "skipped");
  const joined = await Promise.all(((joinedRows ?? []) as { id: string }[]).map((x) => load(admin, x.id)));
  const unready = joined.filter((j) => !j.sections || !j.metrics);
  if (unready.length) throw new Error("The TikTok part of this report is still being written. Send once it's ready (it goes out with this one).");
  if (delivery.channels.includes("slack") && !r.message?.trim()) throw new Error("There's no message to post yet.");
  for (const x of [r, ...joined]) {
    const stale = periodMismatch({ start: x.period_start, end: x.period_end }, x.metrics, x.sections);
    if (stale.length) throw new Error(`Part of the ${platformName(x.platform)} report isn't for ${label(x.period_start, x.period_end)} yet (${stale.join(", ")}). Regenerate it with fresh data first.`);
  }
  const bytes = await reportPdf(admin, [r, ...joined]);
  const service = joined.length ? "Meta + TikTok" : r.platform === "google" ? "Google" : r.platform === "tiktok" ? "TikTok" : "Meta";
  const period = label(r.period_start, r.period_end);
  const message = joined.length ? jointMessage(r.message, joined) : (r.message ?? "");
  const out = await deliver(admin, {
    client: { id: r.client_id, ...r.client },
    kind: r.kind,
    platform: joined.length ? null : r.platform,
    period: { start: r.period_start, end: r.period_end, label: period },
    message: whiteLabelOf(r) ? forClient(message, true) : message,
    pdf: { filename: whiteLabelOf(r) ? whiteLabelFileName(r.client.name, r.kind, period, service) : pdfFileName(r.client.name, service, period), title: `${r.client.name} · ${service}${joined.length ? "" : " Ads"} · ${period}`, bytes },
    parts: [r, ...joined].map((x) => ({ platform: x.platform, metrics: x.metrics, sections: x.sections })),
    by,
    delivery,
    slackAs: "user",
    reportId: id,
    note,
  });
  if (!out.ok) return out;
  const slack = out.slack && "channel" in out.slack ? out.slack : null;
  await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id, slack_channel: slack?.channel ?? null, slack_ts: slack?.ts ?? null, updated_at: new Date().toISOString() }).in("id", [id, ...joined.map((j) => j.id)]);
  return out;
}

/** A monthly recap's whole PDF (every finished part), for a send in the history drawn again */
export async function bundlePdf(admin: SupabaseClient, bundleId: string) {
  const { data: ids } = await admin.from("reports").select("id").eq("bundle_id", bundleId).in("status", ["submitted", "posted"]);
  if (!ids?.length) return null;
  return reportPdf(admin, await Promise.all(ids.map((x) => load(admin, x.id))));
}

/** Who's sending, for the history and the email's reply-to */
async function sender(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("profiles").select("full_name, email").eq("id", id).maybeSingle();
  return { id, fullName: (data?.full_name as string | null) ?? "Kaizen", email: (data?.email as string | null) ?? null };
}

/** The people this client's recap emails go to: the ones picked for their reports, else every contact (primary first) */
async function recapRecipients(admin: SupabaseClient, clientId: string) {
  const { saved, contacts } = await clientDelivery(admin, clientId);
  const picked = saved?.channels.includes("email") && saved.recipients.length ? saved.recipients : contacts;
  return picked.slice(0, 6).map((c) => ({ email: c.email, full_name: c.name ?? null }));
}

/**
 * A buyer submits their part of the monthly recap. It waits for every other part on the client (the other platform's
 * buyer); when the last one is in, the recap goes to the client. Returns what happened, for the buyer to see.
 */
export async function submitMonthly(admin: SupabaseClient, id: string, by: { id: string }) {
  const r = await load(admin, id);
  if (!r.bundle_id) throw new Error("This report isn't part of a monthly recap.");
  await admin.from("reports").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
  // The rest of the recap already went out (another buyer sent theirs on its own): this part follows by itself
  const { data: bundle } = await admin.from("report_bundles").select("status").eq("id", r.bundle_id).single();
  if (bundle?.status === "sent") {
    await deliverLatePart(admin, id, by);
    return { sent: true, waitingOn: [] as string[] };
  }
  const { data: parts } = await admin.from("reports").select("id, platform, status, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", r.bundle_id).neq("status", "skipped");
  const waiting = (parts ?? []).filter((p) => p.status !== "submitted" && p.status !== "posted");
  if (waiting.length)
    return {
      sent: false,
      waitingOn: waiting.map((p) => `${(p.profiles as unknown as { full_name: string } | null)?.full_name ?? "the other buyer"} (${p.platform === "google" ? "Google" : p.platform === "tiktok" ? "TikTok" : "Meta"})`),
    };
  await deliverBundle(admin, r.bundle_id, by);
  return { sent: true, waitingOn: [] as string[] };
}

/**
 * A buyer doesn't wait on the other one: the recap goes to the client now with the parts that are approved (theirs).
 * The other part follows on its own when its buyer approves it, on the same recap link. They hear it.
 */
export async function sendPartNow(admin: SupabaseClient, id: string, by: { id: string; fullName: string }) {
  const r = await load(admin, id);
  if (!r.bundle_id) throw new Error("This report isn't part of a monthly recap.");
  await admin.from("reports").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id).neq("status", "submitted");
  const { data: waiting } = await admin.from("reports").select("id, platform, owner_id").eq("bundle_id", r.bundle_id).not("status", "in", "(submitted,posted,skipped)");
  await deliverBundle(admin, r.bundle_id, by);
  const name = (p: string) => (p === "google" ? "Google" : p === "tiktok" ? "TikTok" : "Meta");
  // Each waiting part's owner, with the client's secondary buyers on that platform copied in (only executives and
  // media buyers hear about reports)
  const seats = await loadBuyerSeats(admin, [r.client_id]);
  const to = (waiting ?? []).flatMap((w) => ccFrom(seats, w.platform as string, [w.owner_id as string | null]).map((id) => ({ ...w, to: id })));
  const told = await reportListeners(admin, to.map((w) => w.to));
  if (to.some((w) => told.has(w.to)))
    await admin.from("notifications").upsert(
      to
        .filter((w) => told.has(w.to))
        .map((w) => ({
          profile_id: w.to,
          kind: "report",
          title: `${by.fullName.split(" ")[0]} sent the ${name(r.platform)} part of ${r.client.name}'s recap on its own`,
          body: `Your ${name(w.platform)} part goes to the client by itself as soon as you approve it, on the same recap link.`,
          href: `/reports/${w.id}`,
          client_id: r.client_id,
          key: `report-sent-alone:${w.id}`,
          priority: "normal",
        })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  return { sent: true, waitingOn: [] as string[] };
}

/** A part approved after the rest of the recap went out: its own Slack post and email, on the same recap link */
async function deliverLatePart(admin: SupabaseClient, id: string, by: { id: string }) {
  const r = await load(admin, id);
  const { data: b } = await admin.from("report_bundles").select("token, client_id, period_start").eq("id", r.bundle_id!).single();
  if (!b) return;
  const wl = whiteLabelOf(r);
  // A white label client gets no link to the agency's recap page: the PDF is the recap
  const link = wl ? null : `${SITE()}/r/${b.token}`;
  const month = monthOf(b.period_start);
  const service = platformName(r.platform);
  const bytes = await reportPdf(admin, [r]);
  const text = wl ? forClient(`${r.message?.trim() ?? ""}\n\n*Your ${month} recap, now with ${service}, is attached.*`, true) : `${r.message?.trim() ?? ""}\n\n*Your ${month} recap, now with ${service}:* ${link}`.trim();
  const filename = wl ? whiteLabelFileName(r.client.name, "monthly", month, service) : `${r.client.name} - ${service} ${month}.pdf`;
  const pdf = { filename, title: `${r.client.name} · ${service} · ${month}`, bytes };
  const delivered: Record<string, unknown> = {};
  if (r.client.slack_channel_id) {
    const out = await postAsUser(by.id, { channel: r.client.slack_channel_id, text, pdf });
    const fallback = !out.ok ? await appPost(r.client.slack_channel_id, text, wl ? pdf : null) : null;
    delivered.slack = out.ok ? { channel: out.channel, ts: out.ts } : fallback?.ok ? { channel: r.client.slack_channel_id, ts: fallback.ts, as: "app" } : { error: out.error };
  }
  const sentTo: string[] = [];
  let logged: { subject: string; text: string; html: string } | null = null;
  for (const c of await recapRecipients(admin, b.client_id as string)) {
    const headline = r.sections?.headline ?? `The ${service} part of your ${month} recap is ready.`;
    const parts = wl
      ? { kicker: r.client.name, title: `${service} is in your ${month} recap`, hello: `Hi ${c.full_name?.split(" ")[0] ?? "there"},`, lines: [forClient(headline, true), "The full report is attached as a PDF."], whiteLabel: true }
      : { kicker: r.client.name, title: `${service} is in your ${month} recap`, hello: `Hi ${c.full_name?.split(" ")[0] ?? "there"},`, lines: [headline], cta: { label: "See the recap →", url: link! } };
    const mail = { subject: wl ? `Your ${month} recap: ${service} is in` : `Your ${month} recap from Kaizen: ${service} is in`, text: emailText(parts), html: emailHtml(parts) };
    const res = await sendEmail({ to: c.email, ...mail, ...(wl ? { fromName: WHITE_LABEL_FROM, attachments: [{ filename, content: Buffer.from(bytes).toString("base64") }] } : {}) });
    if (res.ok) sentTo.push(c.email);
    if (res.ok && sentTo.length === 1) logged = mail;
  }
  if (logged) await logClientEmail(admin, { clientId: b.client_id as string, kind: "recap", ...logged, to: sentTo, by: by.id });
  delivered.email = sentTo;
  await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id }).eq("id", id);
  await keepRecapSend(admin, { clientId: b.client_id as string, name: r.client.name, bundleId: r.bundle_id!, reportId: id, platform: r.platform, start: r.period_start, end: r.period_end, month, text, bytes, filename, delivered, by: by.id, parts: [r], whiteLabel: wl });
}

/** The app's own post when the buyer can't post: a white label client's carries the PDF (it has no recap link) */
async function appPost(channel: string, text: string, pdf: { filename: string; title: string; bytes: Uint8Array } | null): Promise<{ ok: boolean; ts?: string }> {
  if (!pdf) return botPost(channel, text);
  const out = await postAsApp({ channel, text, pdf });
  return out.ok ? { ok: true, ts: out.ts } : { ok: false };
}

/** A monthly recap (or a late part of one) in the send history, with its PDF as it went */
async function keepRecapSend(admin: SupabaseClient, x: { clientId: string; name: string; bundleId: string; reportId?: string; platform: string | null; start: string; end: string; month: string; text: string; bytes: Uint8Array; filename: string; delivered: Record<string, unknown>; by: string; parts: Loaded[]; whiteLabel?: boolean }) {
  const slack = (x.delivered.slack ?? null) as { channel: string; ts?: string; as?: string } | { error: string } | null;
  const to = (x.delivered.email ?? []) as string[];
  const went = [...(slack && "channel" in slack ? (["slack"] as const) : []), ...(to.length ? (["email"] as const) : [])];
  if (!went.length) return;
  await recordSend(
    admin,
    {
      client: { id: x.clientId, name: x.name, slack_channel_id: null },
      kind: "monthly",
      platform: x.platform,
      period: { start: x.start, end: x.end, label: x.month },
      message: x.text,
      pdf: { bytes: x.bytes, filename: x.filename, title: x.filename.replace(/\.pdf$/, "") },
      parts: x.parts.map((p) => ({ platform: p.platform, metrics: p.metrics, sections: p.sections })),
      by: await sender(admin, x.by),
      delivery: { channels: [...went], recipients: to.map((email) => ({ email })) },
      slackAs: "user",
      reportId: x.reportId ?? null,
      bundleId: x.bundleId,
    },
    { went: [...went], slack, email: to.length ? { to, failed: [], subject: x.whiteLabel ? `Your ${x.month} recap` : `Your ${x.month} recap from Kaizen` } : null, status: "sent" },
  ).catch(() => null);
}

/** Sends the monthly recap to the client: a Slack post (as the buyer who completed it) and an email to their contacts. */
export async function deliverBundle(admin: SupabaseClient, bundleId: string, by: { id: string }) {
  const { data: b } = await admin.from("report_bundles").update({ status: "sending" }).eq("id", bundleId).eq("status", "collecting").select("id, token, client_id, period_start").maybeSingle();
  if (!b) return; // already sent (or being sent)
  try {
    const { data: ids } = await admin.from("reports").select("id").eq("bundle_id", bundleId).in("status", ["submitted", "posted"]);
    const parts = await Promise.all((ids ?? []).map((x) => load(admin, x.id)));
    const client = parts[0].client;
    const wl = whiteLabelOf(parts[0]);
    // A white label client gets no link to the agency's recap page or portal: the PDF is the recap
    const link = wl ? null : `${SITE()}/r/${b.token}`;
    const month = monthOf(b.period_start);
    const bytes = await reportPdf(admin, parts);
    const intro = parts.map((p) => p.message?.trim()).filter(Boolean).join("\n\n");
    const shots = await shotsAsk(admin, parts[0]);
    const ask = shots ? `\n\n*For ${shots.month}, we need ${shots.items.length === 1 ? "one shot" : `${shots.items.length} shots`} from you* so the next round of ads stays fresh${shots.url ? `: <${shots.url}|send them on your shot list>` : ` (${shots.items.slice(0, 3).join("; ")}${shots.items.length > 3 ? "…" : ""})`}` : "";
    const text = wl ? forClient(`${intro}\n\n*Your ${month} recap is attached.*${ask}`, true) : `${intro}\n\n*Your ${month} recap:* ${link}${dashboardLine(parts[0])}${ask}`;
    const filename = wl ? whiteLabelFileName(client.name, "monthly", month) : `${client.name} - ${month} recap.pdf`;
    const pdf = { filename, title: `${client.name} · ${month} recap`, bytes };
    const delivered: Record<string, unknown> = {};
    if (client.slack_channel_id) {
      const out = await postAsUser(by.id, { channel: client.slack_channel_id, text, pdf });
      // The buyer who completed it hasn't connected Slack: the recap still goes out, from the Kaizen app (with the link; a white label client's with the PDF)
      const fallback = !out.ok ? await appPost(client.slack_channel_id, text, wl ? pdf : null) : null;
      delivered.slack = out.ok ? { channel: out.channel, ts: out.ts } : fallback?.ok ? { channel: client.slack_channel_id, ts: fallback.ts, as: "app" } : { error: out.error };
    }
    // Email to the people picked for this client's reports, else their contacts (primary first)
    const to = await recapRecipients(admin, b.client_id as string);
    const headline = parts.map((p) => p.sections?.headline).filter(Boolean).join(" · ");
    const sentTo: string[] = [];
    let logged: { subject: string; text: string; html: string } | null = null;
    for (const c of to.slice(0, 6)) {
      const dash = dashboardUrl(parts[0]);
      const shotsNote = shots ? `For ${shots.month}, we need a few photos and clips from you so your ads stay fresh: ${shots.items.slice(0, 4).join("; ")}${shots.items.length > 4 ? "…" : ""}.${shots.url ? ` Send them here: ${shots.url}` : ""}` : "";
      const mail = wl
        ? {
            preheader: forClient(headline, true),
            kicker: client.name,
            title: `Your ${month} recap is ready`,
            highlight: month,
            hello: `Hi ${c.full_name?.split(" ")[0] ?? "there"},`,
            lines: ["Here's the short version:"],
            bullets: parts.map((x) => forClient(`${platformName(x.platform)}: ${x.sections?.headline ?? ""}`, true)).filter((x) => !x.endsWith(":")),
            note: forClient(["The full recap is attached as a PDF.", shotsNote].filter(Boolean).join(" "), true),
            whiteLabel: true,
          }
        : {
            preheader: headline,
            kicker: client.name,
            title: `Your ${month} recap is ready`,
            highlight: month,
            hello: `Hi ${c.full_name?.split(" ")[0] ?? "there"},`,
            lines: ["Here's the short version:"],
            bullets: parts.map((x) => `${platformName(x.platform)}: ${x.sections?.headline ?? ""}`).filter((x) => !x.endsWith(": ")),
            cta: { label: "Read the recap →", url: link! },
            note: [dash ? `For every number, any dates: ${dash}` : "You can download it as a PDF from the page.", shotsNote].filter(Boolean).join(" "),
          };
      const out = { subject: wl ? `Your ${month} recap` : `Your ${month} recap from Kaizen`, text: emailText(mail), html: emailHtml(mail) };
      const res = await sendEmail({ to: c.email, ...out, ...(wl ? { fromName: WHITE_LABEL_FROM, attachments: [{ filename, content: Buffer.from(bytes).toString("base64") }] } : {}) });
      if (res.ok) sentTo.push(c.email);
      if (res.ok && sentTo.length === 1) logged = out;
    }
    if (logged) await logClientEmail(admin, { clientId: b.client_id as string, kind: "recap", ...logged, to: sentTo, by: by.id });
    delivered.email = sentTo;
    await admin.from("report_bundles").update({ status: "sent", sent_at: new Date().toISOString(), delivered }).eq("id", bundleId);
    await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id }).eq("bundle_id", bundleId).eq("status", "submitted");
    await keepRecapSend(admin, { clientId: b.client_id as string, name: client.name, bundleId, platform: parts.length === 1 ? parts[0].platform : null, start: parts[0].period_start, end: parts[0].period_end, month, text, bytes, filename, delivered, by: by.id, parts, whiteLabel: wl });

  } catch (e) {
    await admin.from("report_bundles").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400) }).eq("id", bundleId);
    throw e;
  }
}

/** Reminders: weekly reports not posted by Monday afternoon; monthly parts not submitted as the 5th nears (Slack-free: in the app and by email via notifications). */
export async function remindReports(admin: SupabaseClient, today = nyParts(new Date()).date) {
  const { data } = await admin.from("reports").select("id, kind, platform, owner_id, client_id, period_start, status, clients(name)").in("status", ["draft", "failed"]).gte("period_start", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
  const day = Number(today.slice(8, 10));
  let n = 0;
  // The report's owner, with the client's secondary buyers on that platform copied in
  const seats = await loadBuyerSeats(admin, unique((data ?? []).map((r) => r.client_id as string)));
  const toOf = (r: { client_id: unknown; platform: unknown; owner_id: unknown }) => ccFrom(seats.filter((s) => s.client_id === r.client_id), String(r.platform), [r.owner_id as string | null]);
  // Only executives and media buyers hear about reports
  const told = await reportListeners(admin, (data ?? []).flatMap(toOf));
  for (const r of data ?? []) {
    const to = r.owner_id ? toOf(r).filter((id) => told.has(id)) : [];
    if (!to.length) continue;
    const name = (r.clients as unknown as { name: string }).name;
    const monthly = r.kind === "monthly";
    if (monthly && day > 5) continue;
    await admin.from("notifications").upsert(
      to.map((id) => ({
        profile_id: id,
        kind: "report",
        title: monthly ? `${name}: the monthly recap is due by the 5th` : `${name}: this week's report hasn't gone out`,
        body: monthly ? "Submit your part so it can go to the client. It goes out once every buyer on the account has submitted." : "It's drafted and checked: read it over and post it.",
        href: `/reports/${r.id}`,
        client_id: r.client_id,
        key: `report-remind:${r.id}:${today}`,
        priority: monthly && day >= 4 ? "critical" : "normal",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
    n++;
  }
  return n;
}
