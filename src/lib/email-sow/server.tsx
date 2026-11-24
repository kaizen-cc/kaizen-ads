import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { documentHref, type MadeDocument } from "@/lib/documents/server";
import { cleanSow, dollarsIn, sowFileBase, sowText, SOW_SCHEMA, SOW_SYSTEM, type EmailSow, type SowPackage, type SowPrice } from "./core";
import { sowDocx } from "./docx";
import { EmailSowPdf } from "./pdf";

// The Email SOW Generator on the server: the client's facts (their email platform's numbers by month, campaigns,
// channels and health, what Kaizen built and shipped, their contact, the person's brief), the generator call (its
// instructions in ./core SOW_SYSTEM), and the document drawn twice, a Word file and a PDF in the same look, kept in
// the client's private documents as one Kaizen document (the card opens the PDF; ?format=docx gives the Word file).

const BUCKET = "client-docs";
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (x: number | null | undefined) => (x == null ? null : Math.round(x * 10000) / 100);

/** Everything the generator may quote about a client, as one JSON-ready object */
export async function emailSowFacts(admin: SupabaseClient, clientId: string) {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const [{ data: client }, { data: contacts }, { data: tickets }, { data: sprints }, { clientKlaviyo }] = await Promise.all([
    admin.from("clients").select("id, name, industry, industry_detail, website, email_package_key").eq("id", clientId).maybeSingle(),
    admin.from("contact_clients").select("contacts(email, full_name)").eq("client_id", clientId).is("removed_at", null).limit(6),
    admin.from("email_tickets").select("number, kind, title, stage, live_at").eq("client_id", clientId).is("deleted_at", null).gte("created_at", since).order("created_at").limit(60),
    admin.from("email_sprints").select("id, status, started_at, closed_at, baseline, latest").eq("client_id", clientId).order("started_at", { ascending: false }).limit(2),
    import("@/lib/klaviyo/store"),
  ]);
  if (!client) throw new Error("That client wasn't found.");
  const sprintIds = (sprints ?? []).map((s) => s.id as string);
  const { data: moves } = sprintIds.length ? await admin.from("email_sprint_actions").select("title, area, status, done_at").in("sprint_id", sprintIds).eq("status", "done").limit(40) : { data: [] };
  const k = await clientKlaviyo(admin, clientId).catch(() => null);

  const months = new Map<string, { total: number; campaigns: number; flows: number; sms: number; recipients: number }>();
  for (const d of k?.daily ?? []) {
    const m = d.date.slice(0, 7);
    const row = months.get(m) ?? { total: 0, campaigns: 0, flows: 0, sms: 0, recipients: 0 };
    row.total += d.revenue;
    row.campaigns += d.campaignRevenue;
    row.flows += d.flowRevenue;
    row.sms += d.smsRevenue;
    row.recipients += d.recipients;
    months.set(m, row);
  }
  const people = ((contacts ?? []) as unknown as { contacts: { email: string | null; full_name: string | null } | null }[]).map((c) => c.contacts).filter((c): c is { email: string | null; full_name: string | null } => Boolean(c?.full_name));
  const score = (j: unknown) => (j && typeof j === "object" && "score" in j ? Number((j as { score: unknown }).score) : null);
  return {
    client: { name: client.name as string, industry: (client.industry_detail as string | null) ?? (client.industry as string | null) ?? null, website: (client.website as string | null) ?? null, current_email_package: (client.email_package_key as string | null) ?? null },
    contacts: people.map((p) => p.full_name),
    email_platform: k
      ? {
          name: k.providerName,
          numbers_through: k.through,
          revenue_measured: k.revenueMeasured,
          by_month: [...months.entries()].sort().map(([m, v]) => ({ month: m, revenue: r2(v.total), campaign_revenue: r2(v.campaigns), flow_revenue: r2(v.flows), sms_revenue: r2(v.sms), recipients: v.recipients })),
          last_30_days: { revenue: r2(k.now.revenue), campaign_revenue: r2(k.now.campaignRevenue), flow_revenue: r2(k.now.flowRevenue), sms_revenue: r2(k.now.smsRevenue), open_rate_pct: pct(k.now.openRate), click_rate_pct: pct(k.now.clickRate), unsubscribe_rate_pct: pct(k.now.unsubscribeRate), spam_rate_pct: pct(k.now.spamRate), bounce_rate_pct: pct(k.now.bounceRate), campaigns_sent: k.now.campaignsSent },
          the_30_days_before: { revenue: r2(k.before.revenue), open_rate_pct: pct(k.before.openRate), click_rate_pct: pct(k.before.clickRate) },
          campaigns: k.campaigns
            .filter((c) => c.sendTime && c.sendTime >= since)
            .slice(0, 30)
            .map((c) => ({ name: c.name, channel: c.channel, sent: c.sendTime?.slice(0, 10), recipients: c.recipients, delivered: c.delivered, opens_unique: c.opensUnique, open_rate_pct: pct(c.openRate), clicks_unique: c.clicksUnique, click_rate_pct: pct(c.clickRate), revenue: r2(c.revenue), conversions: c.conversions, bounced: c.bounced, spam: c.spamComplaints, unsubscribes: c.unsubscribes })),
          flows: k.flows.map((f) => ({ name: f.name, status: f.status, trigger: f.trigger, revenue_90d: r2(f.revenue90), recipients_90d: f.recipients90, open_rate_90d_pct: pct(f.openRate90), click_rate_90d_pct: pct(f.clickRate90) })),
          lists: (k.audiences ?? []).filter((a) => a.kind === "list").slice(0, 5).map((a) => ({ name: a.name, profiles: a.profiles })),
          health: (k.health ?? []).slice(0, 10).map((h) => `${h.title}: ${h.detail}`),
        }
      : { connected: false, note: "No email platform connected: numbers are placeholders." },
    shipped: (tickets ?? []).filter((t) => t.live_at || t.stage === "live").map((t) => ({ kind: t.kind, title: t.title, live: (t.live_at as string | null)?.slice(0, 10) ?? null })),
    in_progress: (tickets ?? []).filter((t) => !t.live_at && t.stage !== "live").map((t) => ({ kind: t.kind, title: t.title, stage: t.stage })),
    sprint: (sprints ?? []).map((s) => ({ status: s.status, started: (s.started_at as string).slice(0, 10), closed: (s.closed_at as string | null)?.slice(0, 10) ?? null, score_at_start: score(s.baseline), score_now: score(s.latest) })),
    sprint_moves_done: (moves ?? []).map((m) => ({ title: m.title, area: m.area, done: (m.done_at as string | null)?.slice(0, 10) ?? null })),
  };
}

/** A logo (data URL or URL) as PNG bytes for the Word file */
async function png(src: string | null): Promise<Buffer | null> {
  if (!src) return null;
  try {
    const raw = src.startsWith("data:") ? Buffer.from(src.slice(src.indexOf(",") + 1), "base64") : Buffer.from(await (await fetch(src, { signal: AbortSignal.timeout(8000) })).arrayBuffer());
    return await sharp(raw).resize({ height: 132, withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

/** Every revenue figure in the facts, and the sums of each kind (an account total, a month's campaigns), so the client's own numbers stay */
export function revenueFigures(facts: unknown): number[] {
  const byKey = new Map<string, number[]>();
  JSON.stringify(facts, (k, v) => {
    if (/revenue/i.test(k) && typeof v === "number" && v > 0) byKey.set(k, [...(byKey.get(k) ?? []), v]);
    return v;
  });
  const all = [...byKey.values()].flat();
  const sums = [...byKey.values()].map((xs) => xs.reduce((a, b) => a + b, 0));
  return [...all, ...sums];
}

export type MadeSow = MadeDocument & { docx: string; placeholdersText: string[] };

/** The generator's writing step: the client's facts and the AI's document, cleaned and priced (no files drawn) */
export async function writeEmailSow(opts: { admin: SupabaseClient; client: { id: string; name: string }; brief: string; confirmed?: readonly SowPrice[]; prior?: EmailSow | null; contact?: string | null }): Promise<{ sow: EmailSow }> {
  const { admin, client } = opts;
  const [facts, { data: pkgs }] = await Promise.all([
    emailSowFacts(admin, client.id),
    admin.from("email_packages").select("key, label, kind, price_monthly, campaigns_min, campaigns, flow_emails_min, flow_emails, sms_min, sms, design_hours, note").eq("active", true).order("sort_order"),
  ]);
  const packages = (pkgs ?? []) as SowPackage[];
  const confirmed = [...(opts.confirmed ?? [])];
  const priorSow = opts.prior ?? null;
  const today = new Date();
  const dated = today.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" });
  const factsJson = JSON.stringify(facts);
  const platform = `Email & SMS Marketing | ${facts.email_platform && "name" in facts.email_platform ? facts.email_platform.name : "Klaviyo"}`;

  const raw = await askJson<Record<string, unknown>>({
    agent: "email_desk",
    label: "email sow",
    clientId: client.id,
    system: SOW_SYSTEM,
    maxTokens: 24000,
    schema: SOW_SCHEMA,
    prompt: [
      `Today: ${today.toISOString().slice(0, 10)}. Client: ${client.name}.`,
      `<packages>\n${packages.map((p) => `${p.key}: ${p.label} (${p.kind})${p.note ? `, ${p.note}` : ""}`).join("\n")}\n</packages>`,
      confirmed.length ? `<confirmed_prices>\n${confirmed.map((c) => `${c.label}: $${c.amount} ${c.cadence === "month" ? "a month" : "one time"}`).join("\n")}\n</confirmed_prices>` : "",
      `<facts>\n${factsJson}\n</facts>`,
      opts.brief.trim() ? `<brief from the person>\n${opts.brief.trim().slice(0, 12000)}\n</brief>` : "",
      priorSow ? `<previous version, revise it with the brief>\n${sowText(priorSow)}\n</previous version>` : "",
      "Write the whole document now.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  return { sow: cleanSow(raw, { client: client.name, contact: opts.contact ?? null, dated, packages, confirmed, dataFigures: [...revenueFigures(facts), ...dollarsIn(opts.brief)], platform }) };
}

/**
 * Writes and keeps an email SOW: a new one, or a new version of `id`. `brief` is what the person asked for and anything
 * they said (the starting tier, add-ons, the pitch, facts from a doc); `prior` is the earlier version's text to revise.
 */
export async function generateEmailSow(opts: {
  admin: SupabaseClient;
  me: { id: string; fullName: string };
  client: { id: string; name: string };
  brief: string;
  confirmed?: readonly SowPrice[];
  id?: string | null;
  contact?: string | null;
}): Promise<MadeSow> {
  const { admin, me, client } = opts;
  const prior = opts.id ? await admin.from("kaizen_documents").select("id, version, client_document_id, profile_id, content").eq("id", opts.id).maybeSingle() : { data: null };
  const priorSow = (prior.data?.content as { sow?: EmailSow } | null)?.sow ?? null;
  const confirmed = [...(opts.confirmed ?? [])];
  const { sow } = await writeEmailSow({ admin, client, brief: opts.brief, confirmed, prior: priorSow, contact: opts.contact ?? null });

  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, mark] = await Promise.all([reportBrand(admin, client.id).catch(() => null), agencyLogo()]);
  const [pdf, docx] = await Promise.all([renderToBuffer(<EmailSowPdf input={{ sow, agencyLogo: mark, clientLogo: brand?.logo ?? null }} />), Promise.all([png(mark), png(brand?.logo ?? null)]).then(([agency, logo]) => sowDocx(sow, { agency, client: logo }))]);

  const id = (prior.data?.id as string | undefined) ?? crypto.randomUUID();
  const version = Number(prior.data?.version ?? 0) + 1;
  const base = sowFileBase(client.name);
  const pdfPath = `${client.id}/kaizen/${id}/v${version}.pdf`;
  const docxPath = `${client.id}/kaizen/${id}/v${version}.docx`;
  const [a, b] = await Promise.all([
    admin.storage.from(BUCKET).upload(pdfPath, pdf, { contentType: "application/pdf", upsert: true }),
    admin.storage.from(BUCKET).upload(docxPath, docx, { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: true }),
  ]);
  if (a.error || b.error) throw new Error(`Couldn't save the SOW: ${(a.error ?? b.error)!.message}`);

  const text = sowText(sow);
  const summary = (sow.recap?.paragraphs[0] ?? sow.scope.intro).slice(0, 600) || null;
  const entry = { client_id: client.id, kind: "file", name: `${base}.pdf`, path: pdfPath, mime: "application/pdf", bytes: pdf.length, title: `Scope of Work: ${sow.title}`, summary, text, status: "ready", via: "assistant", uploaded_by: me.id };
  let clientDocId = (prior.data?.client_document_id as string | null | undefined) ?? null;
  if (clientDocId) await admin.from("client_documents").update(entry).eq("id", clientDocId);
  else {
    const { data: cd } = await admin.from("client_documents").insert(entry).select("id").single();
    clientDocId = (cd?.id as string | undefined) ?? null;
  }
  // The card and Edit read DocContent's fields; the generator's own content rides along as `sow`
  const content = {
    kind: "sow",
    generator: "email_sow",
    title: sow.title,
    subtitle: sow.subtitle,
    client: client.name,
    period: sow.dated,
    summary: summary ?? "",
    stats: [],
    sections: [],
    deliverables: [],
    cadence: [],
    pricing: [],
    inclusions: [],
    exclusions: [],
    nextSteps: sow.closing.nextSteps,
    preparedBy: me.fullName,
    service: "email-marketing",
    sow,
    docxPath,
    brief: opts.brief.slice(0, 12000),
    confirmed,
  };
  const row = { id, client_id: client.id, profile_id: (prior.data?.profile_id as string | undefined) ?? me.id, kind: "sow", title: sow.title, content, bucket: BUCKET, path: pdfPath, file_name: `${base}.pdf`, version, placeholders: sow.placeholders, client_document_id: clientDocId, updated_at: new Date().toISOString() };
  const { error } = await admin.from("kaizen_documents").upsert(row);
  if (error) throw new Error(`Couldn't keep the SOW: ${error.message}`);
  return { id, version, title: sow.title, kind: "sow", fileName: `${base}.pdf`, placeholders: sow.placeholders, href: documentHref(id), download: documentHref(id, true), client: client.name, docx: `/api/documents/${id}?format=docx`, placeholdersText: sow.placeholders };
}

/** The Word file of a generated SOW (for an email attachment or the docx download) */
export async function sowDocxFile(admin: SupabaseClient, content: unknown, bucket: string): Promise<Buffer | null> {
  const p = (content as { docxPath?: string } | null)?.docxPath;
  if (!p) return null;
  const { data } = await admin.storage.from(bucket).download(p);
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}
