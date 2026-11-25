import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";
import { emailHtml } from "@/lib/email-layout";
import { logClientEmail } from "@/lib/client-emails";
import { postAsApp, postAsUser } from "@/lib/slack-user";
import { siteUrl } from "@/lib/site";
import type { ReportMetrics } from "./metrics";
import { forSlack, buildReportEmail, channelsLabel, normalizeDelivery, type Channel, type Delivery, type Recipient, lineDelivery, pastRecipients } from "./delivery-core";
import { defaultRecipients, firstNameFor, recipientsToUse, reportCtaUrl, withoutRemoved } from "./cc-core";
import { reportCc } from "./cc";
import { forClient, isWhiteLabel, WHITE_LABEL_FROM } from "./white-label";
import { openWithHere } from "./slack-text";

// Sending a report to the client, by Slack, email or both, and keeping what went: every send (and every resend) is a
// row in report_sends with who sent it, when, where, to whom, the period and a frozen copy of the PDF, so a sent report
// can always be opened, reviewed and sent again. Sending is always a deliberate click: nothing here runs on a schedule.

const BUCKET = "report-sends";

export const emailReady = () => Boolean(process.env.RESEND_API_KEY);

/** The client's contacts (primary first) and how they last got their reports, for the send step */
export async function clientDelivery(admin: SupabaseClient, clientId: string, line: string | null = null) {
  const [{ data: links }, prefs, { data: client }, past] = await Promise.all([
    admin.from("contact_clients").select("is_primary, created_at, removed_at, contacts(email, full_name, is_active)").eq("client_id", clientId),
    admin
      .from("client_report_prefs")
      .select("channels, recipients, delivery_updated_at, delivery_by_line")
      .eq("client_id", clientId)
      .maybeSingle()
      .then(async (r) => (r.error ? await admin.from("client_report_prefs").select("channels, recipients, delivery_updated_at").eq("client_id", clientId).maybeSingle().then((x) => (x.error ? { data: null } : x)) : r)),
    admin.from("clients").select("slack_channel_id").eq("id", clientId).maybeSingle(),
    // Who this client's report emails went to before (the last 30 sends), for the "sent to before" suggestions
    admin.from("report_sends").select("email").eq("client_id", clientId).not("email", "is", null).order("created_at", { ascending: false }).limit(30).then((r) => (r.error ? { data: [] } : r)),
  ]);
  const all = (links ?? []) as unknown as { is_primary: boolean; created_at: string | null; removed_at: string | null; contacts: { email: string; full_name: string | null; is_active: boolean } | null }[];
  // Taken off the client: out of the list, and out of a choice remembered from before
  const removed = removedOf(all);
  const contacts: (Recipient & { primary: boolean; addedAt: string | null })[] = all
    .filter((l) => !l.removed_at && l.contacts?.email && l.contacts.is_active !== false)
    .map((l) => ({ email: l.contacts!.email.toLowerCase(), name: l.contacts!.full_name, primary: Boolean(l.is_primary), addedAt: l.created_at ?? null }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
  const base = prefs.data as { channels?: string[] | null; recipients?: Recipient[] | null; delivery_updated_at?: string | null; delivery_by_line?: Record<string, { at?: string }> | null } | null;
  // This service line's own choice first (the email team sends to Juan, Eddie and Lino; the ads team to Juan alone)
  const forLine = lineDelivery(base?.delivery_by_line, line);
  const row = forLine ? { ...forLine, delivery_updated_at: base?.delivery_by_line?.[line!]?.at ?? base?.delivery_updated_at ?? null } : base;
  const kept = row && (row.recipients?.length || (row.channels?.length && !(row.channels.length === 1 && row.channels[0] === "slack"))) ? normalizeDelivery(row) : null;
  const saved = kept ? { ...kept, recipients: withoutRemoved(kept.recipients, removed) } : null;
  const slackChannel = Boolean(client?.slack_channel_id);
  // Every contact the client has is in by default; a choice remembered earlier stands, with the contacts gained since added
  const everyone = defaultRecipients(contacts).map((c) => ({ email: c.email, name: c.name }));
  const remembered = saved?.recipients.length ? recipientsToUse(contacts, saved.recipients, row?.delivery_updated_at) : everyone;
  // No choice saved yet: Slack when they have a channel, else email to every contact
  const fallback: Delivery = slackChannel ? { channels: ["slack"], recipients: everyone } : { channels: contacts.length ? ["email"] : ["slack"], recipients: everyone };
  const chosen: Delivery = saved ? { channels: saved.channels, recipients: remembered, ...(saved.cc?.length ? { cc: withoutRemoved(saved.cc, removed) } : {}) } : fallback;
  // Where in Slack this line's reports go (a standing thread the client asked for), kept whatever else was chosen
  const initial: Delivery = forLine?.slack ? { ...chosen, slack: forLine.slack } : chosen;
  // Addresses past report emails went to that this one doesn't have yet (never the team, never someone taken off)
  const { data: staff } = await admin.from("profiles").select("email").not("email", "is", null);
  const team = new Set([...(staff ?? []).map((p) => String(p.email).toLowerCase()), ...removed]);
  const suggested = pastRecipients(((past.data ?? []) as { email: { to?: unknown; cc?: unknown } | null }[]).map((s) => s.email ?? {}), initial, team).map((r) => ({ ...r, name: contacts.find((c) => c.email === r.email)?.name ?? null }));
  return { contacts, saved, initial, suggested, slackChannel, emailReady: emailReady() };
}

/** The addresses taken off a client (and not on it some other way) */
function removedOf(links: { removed_at: string | null; contacts: { email: string } | null }[]) {
  const on = new Set(links.filter((l) => !l.removed_at && l.contacts?.email).map((l) => l.contacts!.email.toLowerCase()));
  return new Set(links.filter((l) => l.removed_at && l.contacts?.email).map((l) => l.contacts!.email.toLowerCase()).filter((e) => !on.has(e)));
}

/** The addresses taken off a client, read at the moment a report goes (a delivery chosen earlier may still name them) */
export async function removedContactEmails(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("contact_clients").select("removed_at, contacts(email)").eq("client_id", clientId);
  return removedOf((data ?? []) as unknown as { removed_at: string | null; contacts: { email: string } | null }[]);
}

/** Remembers how this client gets their reports (the channels and who the email goes to), for the next one */
export async function rememberDelivery(admin: SupabaseClient, clientId: string, d: Delivery, by: string | null, line: string | null = null) {
  const at = new Date().toISOString();
  const { data } = await admin.from("client_report_prefs").select("client_id").eq("client_id", clientId).maybeSingle();
  const row = { channels: d.channels, recipients: d.recipients, delivery_updated_by: by, delivery_updated_at: at };
  if (data) await admin.from("client_report_prefs").update(row).eq("client_id", clientId);
  else await admin.from("client_report_prefs").insert({ client_id: clientId, notes: [], ...row });
  // And for this service line: To, Cc and channels as they went, so next week's report on this line starts the same
  if (line) {
    const { data: was } = await admin.from("client_report_prefs").select("delivery_by_line").eq("client_id", clientId).maybeSingle();
    if (was) {
      const byLine = { ...((was.delivery_by_line as Record<string, unknown> | null) ?? {}), [line]: { channels: d.channels, recipients: d.recipients, cc: d.cc ?? [], ...(d.slack ? { slack: d.slack } : {}), at, by } };
      await admin.from("client_report_prefs").update({ delivery_by_line: byLine }).eq("client_id", clientId);
    }
  }
}

export type SendPart = { platform: "meta" | "google" | "tiktok" | "klaviyo" | "social"; metrics: ReportMetrics | null; sections: { headline?: string | null; summary?: string | null } | null };
export type SendArgs = {
  /** client_type "whitelabel": no agency name, link or brand anywhere in what goes */
  client: { id: string; name: string; slack_channel_id: string | null; slug?: string | null; portal_live?: boolean | null; client_type?: string | null };
  kind: string;
  platform: string | null;
  period: { start: string | null; end: string | null; label: string };
  /** The message: the Slack post, and the email's body too (turned from Slack's formatting into the email's) */
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
  /** A channel report (email or social): its service and its own key numbers for the email */
  serviceLabel?: string | null;
  keyLines?: string[] | null;
  note?: string | null;
};
export type SendOutcome = {
  ok: boolean;
  sendId: string | null;
  went: Channel[];
  slack: { channel: string; ts?: string; as?: string; thread?: string; threadMissing?: boolean } | { error: string } | null;
  email: { to: string[]; cc?: string[]; failed: { email: string; error: string }[]; subject: string } | null;
  error?: string;
  needsConnect?: boolean;
};

// The client's live dashboard, linked only when their portal is open to them; never for a white label client (the agency's)
const dashboardOf = (c: SendArgs["client"]) => reportCtaUrl(c, siteUrl());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Sends a report where the buyer chose, then keeps the send (and the PDF as it went) in the history */
/** The Client Success Coordinator builds reports for anyone but never sends one (enforced here, where every send goes) */
export const NO_SEND_ROLES = new Set(["customer_success"]);
export const NO_SEND_NOTE = "The Client Success Coordinator builds reports but doesn't send them: the report's owner sends it.";

export async function deliver(admin: SupabaseClient, sent: SendArgs): Promise<SendOutcome> {
  const { data: who } = await admin.from("profiles").select("role").eq("id", sent.by.id).maybeSingle();
  if (who && NO_SEND_ROLES.has(String(who.role))) return { ok: false, sendId: null, went: [], slack: null, email: null, error: NO_SEND_NOTE };
  // A white label client: the message as it goes (and as it's kept) never names the agency or links its site
  const wl = isWhiteLabel(sent.client.client_type);
  // The message always opens with @here, never with a person's mention (whoever the buyer's draft opened with)
  const opened: SendArgs = { ...sent, message: openWithHere(sent.message) };
  const a: SendArgs = wl ? { ...opened, message: forClient(opened.message, true), note: sent.note ? forClient(sent.note, true) : sent.note, appFallback: sent.appFallback != null ? forClient(sent.appFallback, true) : sent.appFallback } : opened;
  const chosen = normalizeDelivery(a.delivery);
  // Nobody taken off the client since the delivery was chosen
  const d = { ...chosen, recipients: withoutRemoved(chosen.recipients, await removedContactEmails(admin, a.client.id)) };
  const went: Channel[] = [];
  let slack: SendOutcome["slack"] = null;
  let email: SendOutcome["email"] = null;
  let needsConnect = false;

  if (d.channels.includes("slack")) {
    // Where the buyer chose (another channel, a standing thread), else the client's channel as a new message
    const where = d.slack ?? null;
    const channelId = where?.channel || a.client.slack_channel_id;
    const thread = where?.thread ?? undefined;
    const broadcast = Boolean(where?.broadcast);
    if (!channelId) slack = { error: "This client has no Slack channel set." };
    else {
      const dash = dashboardOf(a.client);
      // Slack's own formatting (an underline the email shows goes back to plain words here)
      const text = forSlack(`${a.message.trim()}${dash && !a.message.includes(dash) ? `\n\n<${dash}|See every number on your live dashboard>` : ""}`);
      let out = a.slackAs === "app" ? await postAsApp({ channel: channelId, text, pdf: a.pdf, thread, broadcast }) : await postAsUser(a.slackUserId ?? a.by.id, { channel: channelId, text, pdf: a.pdf, thread, broadcast });
      if (!out.ok && "needsConnect" in out && out.needsConnect) needsConnect = true;
      // A joint report that couldn't attach its PDF still goes, from the app (and so does a built one whose buyer can't post)
      let viaApp = a.slackAs === "app";
      if (!out.ok && (a.slackAs === "app" || a.appFallback != null)) {
        out = await postAsApp({ channel: channelId, text: wl ? forClient(`${text}${a.appFallback ?? ""}`, true) : `${text}${a.appFallback ?? ""}`, thread, broadcast });
        viaApp = true;
      }
      if (out.ok) {
        slack = { channel: out.channel, ts: out.ts, as: viaApp ? "app" : "buyer", ...(out.thread ? { thread: out.thread } : {}), ...(out.threadMissing ? { threadMissing: true } : {}) };
        went.push("slack");
      } else slack = { error: out.error };
    }
  }

  if (d.channels.includes("email")) {
    // One email to every contact picked (To), the team in Cc, the PDF always attached
    const to = d.recipients.map((r) => r.email);
    const e = buildReportEmail({ client: a.client.name, kind: a.kind, periodLabel: a.period.label, parts: a.parts, from: { name: a.by.fullName, email: a.by.email }, first: firstNameFor(d.recipients), dashboard: dashboardOf(a.client), note: a.note, whiteLabel: wl, serviceLabel: a.serviceLabel, keyLines: a.keyLines, message: a.message });
    const failed: { email: string; error: string }[] = [];
    let sent: string[] = [];
    let cc: string[] = [];
    if (!d.recipients.length) failed.push({ email: "", error: "No one to send it to." });
    else if (!emailReady()) for (const r of d.recipients) failed.push({ email: r.email, error: "Email isn't set up (RESEND_API_KEY missing)." });
    else {
      const team = await reportCc(admin, { clientId: a.client.id, platforms: a.parts.map((p) => p.platform), owners: a.owners ?? [], to }).catch(() => [] as string[]);
      // The people the sender copied, then the team the send copies by itself (nobody twice, nobody in To)
      cc = [...new Set([...(d.cc ?? []).map((r) => r.email), ...team])].filter((e) => !to.includes(e));
      const html = emailHtml({ preheader: e.preheader, kicker: e.kicker, title: e.title, highlight: e.highlight, hello: e.hello, lines: e.lines, blocks: e.blocks, bullets: e.bullets, cta: e.cta ?? undefined, note: e.note, ...(wl ? { whiteLabel: true } : {}) });
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
  const s = o.slack && "channel" in o.slack ? o.slack : null;
  // The standing thread was gone: it went to the channel itself, and the buyer hears it
  const thread = s?.threadMissing ? " The Slack thread it was set to go in is gone, so it posted in the channel instead: pick the new thread on the send step." : s?.thread ? " It went in the thread." : "";
  const out = `${base}${thread}`;
  return o.error ? `${out} ${o.error}` : out;
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
    .map((r) => ({ platform: r.platform === "google" ? ("google" as const) : r.platform === "tiktok" ? ("tiktok" as const) : r.platform === "klaviyo" ? ("klaviyo" as const) : r.platform === "social" ? ("social" as const) : ("meta" as const), metrics: r.platform === "klaviyo" || r.platform === "social" ? null : r.metrics, sections: r.sections }))
    .sort((a, b) => ["meta", "tiktok", "google"].indexOf(a.platform) - ["meta", "tiktok", "google"].indexOf(b.platform));
  // A channel report (email or social): its own key numbers and service in the email
  const channel = ((rows ?? []) as { platform: string; metrics: unknown }[]).find((r) => r.platform === "klaviyo" || r.platform === "social");
  const chanLines = channel?.metrics ? (await import("@/lib/channel-reports/core")).keyLines(channel.metrics as never) : null;
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
    ...(channel ? { serviceLabel: channel.platform === "klaviyo" ? "Email" : "Social", keyLines: chanLines } : {}),
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
    // An email or social report sent before copies were kept: drawn again from its own document
    const { data: kind } = await admin.from("reports").select("platform").eq("id", s.report_id).maybeSingle();
    if (kind?.platform === "klaviyo" || kind?.platform === "social") {
      const loaded = await (await import("@/lib/channel-reports/share")).loadChannelReport(admin, s.report_id);
      return loaded ? (await import("@/lib/channel-reports/pdf")).renderChannelPdf(loaded.input) : null;
    }
    const { loadReport } = await import("./share");
    const r = await loadReport(admin, s.report_id);
    if (r) return (await import("./pdf")).renderReportPdf(r.input);
  }
  return null;
}
