import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fromWithName } from "@/lib/email";
import { emailHtml } from "@/lib/email-layout";
import { siteUrl } from "@/lib/site";
import { platformName } from "./format";
import type { ReportMetrics } from "./metrics";
import { buildReportEmail } from "./delivery-core";
import { forClient, isWhiteLabel, WHITE_LABEL_FROM } from "./white-label";

// The report's email exactly as the send builds it (the same builders and the same layout), for the studio's Message
// step: who it's from (a white label client's never says Kaizen), the subject, the body's HTML and whether the PDF is
// attached. A monthly recap's email has its own short layout (see submitMonthly in run.ts) and links the recap page.

export type EmailPreview = { fromName: string; fromAddress: string | null; subject: string; html: string; attached: boolean };

type Row = {
  id: string;
  kind: string;
  platform: string;
  period_start: string;
  period_end: string;
  bundle_id: string | null;
  metrics: ReportMetrics | null;
  sections: { headline?: string | null; summary?: string | null; did?: string[] | null; next?: string[] | null } | null;
  clients: { name: string; slug: string | null; portal_live: boolean | null; client_type: string | null } | null;
};

const asPlatform = (p: string) => (p === "google" ? ("google" as const) : p === "tiktok" ? ("tiktok" as const) : ("meta" as const));
const ORDER = ["meta", "tiktok", "google"];
const rangeLabel = (start: string, end: string) => {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}`;
};
const monthOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export async function reportEmailPreview(admin: SupabaseClient, id: string, by: { fullName: string; email: string | null }, first: string | null, note: string | null): Promise<EmailPreview | null> {
  const cols = "id, kind, platform, period_start, period_end, bundle_id, metrics, sections, clients(name, slug, portal_live, client_type)";
  const { data } = await admin.from("reports").select(cols).eq("id", id).maybeSingle();
  const r = data as unknown as Row | null;
  if (!r?.clients) return null;
  const wl = isWhiteLabel(r.clients.client_type);
  // The same parts the send carries: this report and the TikTok one riding on it, or a built report's every part
  const { data: more } =
    r.kind === "built" && r.bundle_id
      ? await admin.from("reports").select(cols).eq("bundle_id", r.bundle_id).neq("status", "skipped").neq("id", id)
      : await admin.from("reports").select(cols).eq("joined_to", id).neq("status", "skipped");
  const rows = [r, ...((more ?? []) as unknown as Row[])].sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform));
  const sender = fromWithName(process.env.RESEND_FROM_EMAIL || "Kaizen Ads <ads@contact.kaizenmarketing.agency>", wl ? WHITE_LABEL_FROM : undefined);
  const fromName = wl ? WHITE_LABEL_FROM : sender.match(/^(.*?)\s*</)?.[1] || "Kaizen Ads";
  // A white label client's sender shows no address (it's the agency's domain)
  const fromAddress = wl ? null : (sender.match(/<([^>]+)>/)?.[1] ?? null);

  if (r.kind === "monthly") {
    const month = monthOf(r.period_start);
    const service = rows.length > 1 ? "Meta + TikTok" : platformName(r.platform as "meta");
    const headline = r.sections?.headline ?? `The ${service} part of your ${month} recap is ready.`;
    const hello = `Hi ${first ?? "there"},`;
    const parts = wl
      ? { kicker: r.clients.name, title: `${service} is in your ${month} recap`, hello, lines: [forClient(headline, true), "The full report is attached as a PDF."], whiteLabel: true as const }
      : { kicker: r.clients.name, title: `${service} is in your ${month} recap`, hello, lines: [headline], cta: { label: "See the recap →", url: `${siteUrl()}/r/recap` } };
    return { fromName, fromAddress, subject: wl ? `Your ${month} recap: ${service} is in` : `Your ${month} recap from Kaizen: ${service} is in`, html: emailHtml(parts), attached: wl };
  }

  const c = r.clients;
  const dashboard = c.portal_live && c.slug && !wl ? `${siteUrl()}/c/${c.slug}/dashboard` : null;
  const mail = buildReportEmail({
    client: c.name,
    kind: r.kind,
    periodLabel: rangeLabel(r.period_start, r.period_end),
    parts: rows.map((x) => ({ platform: asPlatform(x.platform), metrics: x.metrics, sections: x.sections })),
    from: { name: by.fullName, email: by.email },
    first,
    dashboard,
    note,
    whiteLabel: wl,
  });
  const html = emailHtml({ preheader: mail.preheader, kicker: mail.kicker, title: mail.title, highlight: mail.highlight, hello: mail.hello, lines: mail.lines, bullets: mail.bullets, cta: mail.cta ?? undefined, note: mail.note, ...(wl ? { whiteLabel: true } : {}) });
  return { fromName, fromAddress, subject: mail.subject, html, attached: true };
}
