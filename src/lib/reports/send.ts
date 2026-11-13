import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";
import { emailHtml } from "@/lib/email-layout";
import { logClientEmail } from "@/lib/client-emails";
import { postAsApp, postAsUser } from "@/lib/slack-user";
import { siteUrl } from "@/lib/site";
import type { ReportMetrics } from "./metrics";
import { buildReportEmail, channelsLabel, normalizeDelivery, type Channel, type Delivery, type Recipient } from "./delivery-core";
import { defaultRecipients, firstNameFor, recipientsToUse, reportCtaUrl } from "./cc-core";
import { reportCc } from "./cc";
import { forClient, isWhiteLabel, WHITE_LABEL_FROM } from "./white-label";
import { openWithHere } from "./slack-text";

// Sending a report to the client, by Slack, email or both, and keeping what went: every send (and every resend) is a
// row in report_sends with who sent it, when, where, to whom, the period and a frozen copy of the PDF, so a sent report
// can always be opened, reviewed and sent again. Sending is always a deliberate click: nothing here runs on a schedule.

const BUCKET = "report-sends";

export const emailReady = () => Boolean(process.env.RESEND_API_KEY);

/** The client's contacts (primary first) and how they last got their reports, for the send step */
export async function clientDelivery(admin: SupabaseClient, clientId: string) {
  const [{ data: links }, prefs, { data: client }] = await Promise.all([
    admin.from("contact_clients").select("is_primary, created_at, contacts(email, full_name, is_active)").eq("client_id", clientId),
    admin
      .from("client_report_prefs")
      .select("channels, recipients, delivery_updated_at")
      .eq("client_id", clientId)
      .maybeSingle()
      .then((r) => (r.error ? { data: null } : r)),
    admin.from("clients").select("slack_channel_id").eq("id", clientId).maybeSingle(),
  ]);
  const contacts: (Recipient & { primary: boolean; addedAt: string | null })[] = ((links ?? []) as unknown as { is_primary: boolean; created_at: string | null; contacts: { email: string; full_name: string | null; is_active: boolean } | null }[])
    .filter((l) => l.contacts?.email && l.contacts.is_active !== false)
    .map((l) => ({ email: l.contacts!.email.toLowerCase(), name: l.contacts!.full_name, primary: Boolean(l.is_primary), addedAt: l.created_at ?? null }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const row = prefs.data as { channels?: string[] | null; recipients?: Recipient[] | null; delivery_updated_at?: string | null } | null;
  const saved = row && (row.recipients?.length || (row.channels?.length && !(row.channels.length === 1 && row.channels[0] === "slack"))) ? normalizeDelivery(row) : null;
  const slackChannel = Boolean(client?.slack_channel_id);
  // Every contact the client has is in by default; a choice remembered earlier stands, with the contacts gained since added
  const everyone = defaultRecipients(contacts).map((c) => ({ email: c.email, name: c.name }));
  const remembered = saved?.recipients.length ? recipientsToUse(contacts, saved.recipients, row?.delivery_updated_at) : everyone;
  // No choice saved yet: Slack when they have a channel, else email to every contact
  const fallback: Delivery = slackChannel ? { channels: ["slack"], recipients: everyone } : { channels: contacts.length ? ["email"] : ["slack"], recipients: everyone };
  const initial: Delivery = saved ? { channels: saved.channels, recipients: remembered } : fallback;
  return { contacts, saved, initial, slackChannel, emailReady: emailReady() };
}

/** Remembers how this client gets their reports (the channels and who the email goes to), for the next one */
export async function rememberDelivery(admin: SupabaseClient, clientId: string, d: Delivery, by: string | null) {
  const { data } = await admin.from("client_report_prefs").select("client_id").eq("client_id", clientId).maybeSingle();
  const row = { channels: d.channels, recipients: d.recipients, delivery_updated_by: by, delivery_updated_at: new Date().toISOString() };
  if (data) await admin.from("client_report_prefs").update(row).eq("client_id", clientId);
  else await admin.from("client_report_prefs").insert({ client_id: clientId, notes: [], ...row });
}

export type SendPart = { platform: "meta" | "google" | "tiktok"; metrics: ReportMetrics | null; sections: { headline?: string | null; summary?: string | null } | null };
export type SendArgs = {
  /** client_type "whitelabel": no agency name, link or brand anywhere in what goes */
  client: { id: string; name: string; slack_channel_id: string | null; slug?: string | null; portal_live?: boolean | null; client_type?: string | null };
  kind: string;
  platform: string | null;
  period: { start: string | null; end: string | null; label: string };
  /** The Slack message (the email has its own short text) */
  message: string;
  pdf: { bytes: Uint8Array; filename: string; title: string };
  parts: SendPart[];
  by: { id: string; fullName: string; email: string | null };
  delivery: Delivery;
  /** A joint report posts from the Kaizen app; one buyer's goes out as them */
  slackAs: "user" | "app";
  /** Whose Slack it posts as, when not the sender's own (a built report on one service goes out as its buyer) */
  slackUserId?: string | null;
  /** Posting as the buyer failed: post from the app instead, with this added (the report's link) */
  appFallback?: string | null;
  reportId?: string | null;
  bundleId?: string | null;
  /** The profiles that own the report's parts: copied on the email with the client's buyers on those platforms */
  owners?: (string | null | undefined)[];
  resendOf?: string | null;
  note?: string | null;
};
export type SendOutcome = {
  ok: boolean;
  sendId: string | null;
  went: Channel[];
  slack: { channel: string; ts?: string; as?: string } | { error: string } | null;
  email: { to: string[]; cc?: string[]; failed: { email: string; error: string }[]; subject: string } | null;
  error?: string;
  needsConnect?: boolean;
};

// The client's live dashboard, linked only when their portal is open to them; never for a white label client (the agency's)
const dashboardOf = (c: SendArgs["client"]) => reportCtaUrl(c, siteUrl());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Sends a report where the buyer chose, then keeps the send (and the PDF as it went) in the history */
export async function deliver(admin: SupabaseClient, sent: SendArgs): Promise<SendOutcome> {
  // A white label client: the message as it goes (and as it's kept) never names the agency or links its site
  const wl = isWhiteLabel(sent.client.client_type);
  // The message always opens with @here, never with a person's mention (whoever the buyer's draft opened with)
  const opened: SendArgs = { ...sent, message: openWithHere(sent.message) };
  const a: SendArgs = wl ? { ...opened, message: forClient(opened.message, true), note: sent.note ? forClient(sent.note, true) : sent.note, appFallback: sent.appFallback != null ? forClient(sent.appFallback, true) : sent.appFallback } : opened;
  const d = normalizeDelivery(a.delivery);
  const went: Channel[] = [];
  let slack: SendOutcome["slack"] = null;
  let email: SendOutcome["email"] = null;
  let needsConnect = false;

  if (d.channels.includes("slack")) {
    if (!a.client.slack_channel_id) slack = { error: "This client has no Slack channel set." };
    else {
      const dash = dashboardOf(a.client);
      const text = `${a.message.trim()}${dash && !a.message.includes(dash) ? `\n\n<${dash}|See every number on your live dashboard>` : ""}`;
      let out = a.slackAs === "app" ? await postAsApp({ channel: a.client.slack_channel_id, text, pdf: a.pdf }) : await postAsUser(a.slackUserId ?? a.by.id, { channel: a.client.slack_channel_id, text, pdf: a.pdf });
      if (!out.ok && "needsConnect" in out && out.needsConnect) needsConnect = true;
      // A joint report that couldn't attach its PDF still goes, from the app (and so does a built one whose buyer can't post)
      let viaApp = a.slackAs === "app";
      if (!out.ok && (a.slackAs === "app" || a.appFallback != null)) {
        out = await postAsApp({ channel: a.client.slack_channel_id, text: wl ? forClient(`${text}${a.appFallback ?? ""}`, true) : `${text}${a.appFallback ?? ""}` });
        viaApp = true;
      }
      if (out.ok) {
        slack = { channel: out.channel, ts: out.ts, as: viaApp ? "app" : "buyer" };
        went.push("slack");
      } else slack = { error: out.error };
    }
  }

  if (d.channels.includes("email")) {
    // One email to every contact picked (To), the team in Cc, the PDF always attached
    const to = d.recipients.map((r) => r.email);
    const e = buildReportEmail({ client: a.client.name, kind: a.kind, periodLabel: a.period.label, parts: a.parts, from: { name: a.by.fullName, email: a.by.email }, first: firstNameFor(d.recipients), dashboard: dashboardOf(a.client), note: a.note, whiteLabel: wl });
    const failed: { email: string; error: string }[] = [];
    let sent: string[] = [];
    let cc: string[] = [];
    if (!d.recipients.length) failed.push({ email: "", error: "No one to send it to." });
    else if (!emailReady()) for (const r of d.recipients) failed.push({ email: r.email, error: "Email isn't set up (RESEND_API_KEY missing)." });
    else {
      cc = await reportCc(admin, { clientId: a.client.id, platforms: a.parts.map((p) => p.platform), owners: a.owners ?? [], to }).catch(() => []);
      const html = emailHtml({ preheader: e.preheader, kicker: e.kicker, title: e.title, highlight: e.highlight, hello: e.hello, lines: e.lines, bullets: e.bullets, cta: e.cta ?? undefined, note: e.note, ...(wl ? { whiteLabel: true } : {}) });
      const res = await sendEmail({ to, cc, subject: e.subject, html, text: e.text, replyTo: e.replyTo ?? undefined, attachments: [{ filename: a.pdf.filename, content: b64(a.pdf.bytes) }], ...(wl ? { fromName: WHITE_LABEL_FROM } : {}) });
      if (res.ok) {
        sent = to;
        await logClientEmail(admin, { clientId: a.client.id, kind: "report", subject: e.subject, text: e.text, html, to, by: a.by.id, manual: true }).catch(() => null);
      } else for (const r of d.recipients) failed.push({ email: r.email, error: res.error });
    }
    email = { to: sent, cc, failed, subject: e.subject };
    if (sent.length) went.push("email");
  }

  const status = went.length === 0 ? "failed" : went.length < d.channels.length || (email?.failed.length ?? 0) > 0 ? "partial" : "sent";
  const sendId = went.length ? await recordSend(admin, { ...a, delivery: d }, { went, slack, email, status }) : null;
  const problems = [slack && "error" in slack ? `Slack: ${slack.error}` : null, email?.failed.length ? `Email didn't reach ${email.failed.map((f) => f.email || "anyone").join(", ")} (${email.failed[0].error})` : null].filter(Boolean).join(" ");
  return { ok: went.length > 0, sendId, went, slack, email, ...(problems ? { error: problems } : {}), ...(needsConnect ? { needsConnect } : {}) };
}

/** A send in the history, with the PDF as it went (kept in private storage) */
export async function recordSend(admin: SupabaseClient, a: SendArgs, r: { went: Channel[]; slack: SendOutcome["slack"]; email: SendOutcome["email"]; status: string }) {
  const id = crypto.randomUUID();
  const path = `${a.client.id}/${id}.pdf`;
  const up = await admin.storage
    .from(BUCKET)
    .upload(path, a.pdf.bytes, { contentType: "application/pdf", upsert: true })
    .catch((e: unknown) => ({ error: e }));
  const kept = !("error" in up && up.error);
  const { error } = await admin.from("report_sends").insert({
    id,
    client_id: a.client.id,
    report_id: a.reportId ?? null,
    bundle_id: a.bundleId ?? null,
    kind: a.kind,
    platform: a.platform,
    period_start: a.period.start,
    period_end: a.period.end,
    period_label: a.period.label,
    sent_by: a.by.id,
    channels: r.went,
    slack: r.slack,
    email: r.email ? { ...r.email, reply_to: a.by.email } : null,
    status: r.status,
    message: a.message,
    snapshot: { parts: a.parts.map((p) => ({ platform: p.platform, headline: p.sections?.headline ?? null, summary: p.sections?.summary ?? null, main: p.metrics?.main ?? null, compare: p.metrics?.compare ?? null, conversion: p.metrics?.conversion ?? null })), recipients: a.delivery.recipients, note: a.note ?? null },
    pdf_path: kept ? path : null,
    file_name: a.pdf.filename,
    resend_of: a.resendOf ?? null,
  });
  // The history table not there yet (its migration not applied): the report still went, it just isn't logged
  if (error) {
    console.error("[report send] history", error.message);
    return null;
  }
  return id;
}

/** One line on where a send went, for the buyer */
export function sentNote(o: SendOutcome, clientName: string) {
  const where = channelsLabel(o.went);
  const to = o.email?.to.length ? ` to ${o.email.to.join(", ")}${o.email.cc?.length ? ` (copying ${o.email.cc.join(", ")})` : ""}` : "";
  const base = o.went.length ? `Sent to ${clientName} by ${where.toLowerCase()}${o.went.includes("email") ? to : ""}.` : "It didn't go out.";
  return o.error ? `${base} ${o.error}` : base;
}

export type SendRow = {
  id: string;
  client_id: string;
  report_id: string | null;
  bundle_id: string | null;
  kind: string;
  platform: string | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  message: string | null;
  pdf_path: string | null;
  file_name: string | null;
};

/**
 * Sends a report again, exactly as it went (the same PDF and message), by the same channel or another and to whoever
 * is picked now; the resend is its own line in the history, pointing at the first.
 */
export async function resendReport(admin: SupabaseClient, sendId: string, by: { id: string; fullName: string; email: string | null }, delivery: Delivery, note?: string | null): Promise<SendOutcome> {
  const { data } = await admin.from("report_sends").select("id, client_id, report_id, bundle_id, kind, platform, period_start, period_end, period_label, message, pdf_path, file_name").eq("id", sendId).maybeSingle();
  const s = data as SendRow | null;
  if (!s) throw new Error("That send isn't in the history.");
  const { data: client } = await admin.from("clients").select("id, name, slack_channel_id, slug, portal_live, client_type").eq("id", s.client_id).single();

  if (!client) throw new Error("Client not found.");
  const bytes = await sendPdf(admin, s);
  if (!bytes) throw new Error("The PDF that went couldn't be found.");
  // The numbers for the email's key lines: the sent report itself (sent reports can't be edited)
  const { data: rows } = s.report_id
    ? await admin.from("reports").select("platform, metrics, sections, owner_id").eq("id", s.report_id)
    : s.bundle_id
      ? await admin.from("reports").select("platform, metrics, sections, owner_id").eq("bundle_id", s.bundle_id).in("status", ["submitted", "posted"])
      : { data: [] };
  const owners = ((rows ?? []) as { owner_id?: string | null }[]).map((r) => r.owner_id);
  const parts: SendPart[] = ((rows ?? []) as { platform: string; metrics: ReportMetrics | null; sections: SendPart["sections"] }[])
    .map((r) => ({ platform: r.platform === "google" ? ("google" as const) : r.platform === "tiktok" ? ("tiktok" as const) : ("meta" as const), metrics: r.metrics, sections: r.sections }))
    .sort((a, b) => ["meta", "tiktok", "google"].indexOf(a.platform) - ["meta", "tiktok", "google"].indexOf(b.platform));
  const label = s.period_label ?? (s.period_start && s.period_end ? `${s.period_start} to ${s.period_end}` : "");
  const joint = parts.length > 1;
  return deliver(admin, {
    client: client as SendArgs["client"],
    kind: s.kind,
    platform: s.platform,
    period: { start: s.period_start, end: s.period_end, label },
    message: s.message ?? "",
    pdf: { bytes, filename: s.file_name ?? pdfFileFor(client.name as string, label), title: (s.file_name ?? pdfFileFor(client.name as string, label)).replace(/\.pdf$/, "") },
    parts,
    by,
    delivery,
    slackAs: joint ? "app" : "user",
    reportId: s.report_id,
    bundleId: s.bundle_id,
    owners,
    resendOf: s.id,
    note,
  });
}

const pdfFileFor = (client: string, label: string) => `${client} - Report - ${label}.pdf`.replace(/[\\/:*?"<>|]/g, "-");

/** The PDF a send went with: the frozen copy, else (sent before copies were kept) drawn again from the sent report */
export async function sendPdf(admin: SupabaseClient, s: { pdf_path: string | null; report_id: string | null; bundle_id: string | null; kind: string }): Promise<Uint8Array | null> {
  if (s.pdf_path) {
    const { data } = await admin.storage.from(BUCKET).download(s.pdf_path);
    if (data) return new Uint8Array(await data.arrayBuffer());
  }
  if (s.bundle_id && s.kind === "built") return (await import("./builder")).builtPdf(admin, s.bundle_id);
  if (s.bundle_id && s.kind === "monthly" && !s.report_id) return (await import("./run")).bundlePdf(admin, s.bundle_id);
  if (s.report_id) {
    const { loadReport } = await import("./share");
    const r = await loadReport(admin, s.report_id);
    if (r) return (await import("./pdf")).renderReportPdf(r.input);
  }
  return null;
}
