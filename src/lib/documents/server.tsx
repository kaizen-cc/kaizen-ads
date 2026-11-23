import "server-only";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICES, type ServiceSlug } from "@/lib/services";
import { cleanDocument, docFileName, hasBody, packageKnowledge, plainText, storedPrices, DOC_LABEL, type DocContent, type KnowledgeItem, type StoredPrice } from "./core";
import { KaizenDocument } from "./doc";

// create_document's work on the server: the stored prices for the client and service (package records, then what
// Stripe bills them via Kaizen Track), the PDF drawn in the report look with the client's logo and colour, kept in
// the private client-docs bucket under the client (or the person's own folder in ai-files when there's no client),
// filed as one of the client's documents, and opened through /api/documents/<id> (a fresh signed link each time, so
// the card's buttons never expire). Changing the text draws a new version in place.

Font.registerHyphenationCallback((word) => [word]);

const AI_BUCKET = "ai-files";
const DOCS_BUCKET = "client-docs";

/** A service by slug or by name ("email", "Email Marketing"); email when not said */
export function serviceOf(v: unknown): (typeof SERVICES)[number] {
  const k = String(v ?? "")
    .toLowerCase()
    .trim();
  return SERVICES.find((s) => s.slug === k || s.short.toLowerCase() === k || s.label.toLowerCase() === k || s.slug.startsWith(k)) ?? SERVICES.find((s) => s.slug === "email-marketing")!;
}

const serviceKeys = (s: (typeof SERVICES)[number]) => [s.slug, s.short.toLowerCase(), s.label.toLowerCase(), s.short, s.label];

export type PackageFacts = {
  service: string;
  tiers: { tier: string; includes: string | null; price_monthly: number | null; price_one_time: number | null; price_note: string | null }[];
  clientTier: { tier: string | null; includes: string | null; note: string | null } | null;
  knowledge: KnowledgeItem[];
  stored: StoredPrice[];
};

/** Kaizen's package definitions for a service, the client's package, and the prices that are stored */
export async function packageFacts(admin: SupabaseClient, clientId: string | null, service: unknown, tier: string | null): Promise<PackageFacts> {
  const svc = serviceOf(service);
  const keys = serviceKeys(svc);
  // The email and social tiers (Basic, Silver, Gold...) and their prices live in their own package tables
  const channel = svc.slug === "email-marketing" ? "email_packages" : svc.slug === "social-media" ? "social_packages" : null;
  const [{ data: tiers }, { data: pick }, { data: billedRow }, { data: knowledge }, { data: channelPkgs }] = await Promise.all([
    admin.from("service_tiers").select("id, service, label, includes, price_monthly, price_one_time, price_note, sort_order").in("service", keys).order("sort_order"),
    clientId ? admin.from("client_service_tiers").select("tier_id, note").eq("client_id", clientId).in("service", keys).maybeSingle() : Promise.resolve({ data: null }),
    clientId ? admin.from("clients").select("billed_services").eq("id", clientId).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("ai_knowledge").select("title, body, agent_key").eq("active", true).or(`agent_key.eq.${svc.slug === "email-marketing" ? "email_strategist" : "strategist"},agent_key.is.null`).limit(200),
    channel ? admin.from(channel).select("*").eq("active", true).order("sort_order") : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  type Tier = { id: string; label: string; includes: string | null; price_monthly: number | null; price_one_time: number | null; price_note: string | null };
  const rows = [...((tiers ?? []) as Tier[]), ...((channelPkgs ?? []) as Record<string, unknown>[]).map(channelTier)];
  const mine = pick?.tier_id ? rows.find((t) => t.id === pick.tier_id) : null;
  const billed = ((billedRow?.billed_services ?? {}) as Partial<Record<ServiceSlug, { amount: number }>>)[svc.slug as ServiceSlug];
  // Only the tier asked for (or the client's) and the client's own billing count as its prices
  const wanted = tier ? rows.filter((t) => t.label.toLowerCase().includes(tier.toLowerCase())) : mine ? [mine] : rows;
  return {
    service: svc.label,
    tiers: rows.map((t) => ({ tier: t.label, includes: t.includes, price_monthly: t.price_monthly == null ? null : Number(t.price_monthly), price_one_time: t.price_one_time == null ? null : Number(t.price_one_time), price_note: t.price_note })),
    clientTier: pick ? { tier: mine?.label ?? null, includes: mine?.includes ?? null, note: (pick.note as string | null) ?? null } : null,
    knowledge: packageKnowledge((knowledge ?? []) as KnowledgeItem[], tier ?? mine?.label ?? null),
    stored: storedPrices(wanted.length ? wanted : rows, billed ?? null, svc.label),
  };
}

/** An email or social package as a tier: its label, what it includes and its monthly price */
function channelTier(p: Record<string, unknown>): { id: string; label: string; includes: string | null; price_monthly: number | null; price_one_time: number | null; price_note: string | null } {
  const n = (k: string) => (p[k] == null ? null : Number(p[k]));
  const parts =
    typeof p.includes === "string" && p.includes
      ? [p.includes]
      : [n("campaigns") != null ? `${n("campaigns")} campaigns a month` : "", n("sms") ? `${n("sms")} SMS` : "", n("flows") != null ? `${n("flows")} flows` : "", n("posts") != null ? `${n("posts")} posts a month` : "", n("months") ? `${n("months")} months` : ""].filter(Boolean);
  return { id: `pkg:${String(p.key ?? p.label)}`, label: String(p.label ?? p.key ?? ""), includes: parts.join(", ") || null, price_monthly: n("price_monthly"), price_one_time: n("setup_fee"), price_note: (p.price_note as string | null | undefined) ?? (p.note as string | null | undefined) ?? null };
}

export type MadeDocument = { id: string; version: number; title: string; kind: DocContent["kind"]; fileName: string; placeholders: string[]; href: string; download: string; client: string | null };

/** The links the card uses (they sign a fresh link on each open) */
export const documentHref = (id: string, download = false) => `/api/documents/${id}${download ? "?download=1" : ""}`;

/**
 * Draws and keeps a document: new, or a new version of `id` (its text edited). The person's access to the client is
 * checked by the caller; this writes with the server's rights.
 */
export async function makeDocument(opts: {
  admin: SupabaseClient;
  me: { id: string; fullName: string };
  client: { id: string; name: string } | null;
  loose: unknown;
  service?: unknown;
  dataFigures?: number[];
  id?: string | null;
  /** Prices the person confirmed in the conversation (src/lib/documents/core.ts confirmedPrices) */
  confirmed?: StoredPrice[];
}): Promise<MadeDocument> {
  const { admin, me, client } = opts;
  const prior = opts.id ? await admin.from("kaizen_documents").select("id, version, path, bucket, client_document_id, profile_id").eq("id", opts.id).maybeSingle() : { data: null };
  const facts = await packageFacts(admin, client?.id ?? null, opts.service, null);
  const { doc, placeholders } = cleanDocument(opts.loose, { stored: [...facts.stored, ...(opts.confirmed ?? [])], dataFigures: opts.dataFigures, client: client?.name ?? null, preparedBy: me.fullName });
  if (!hasBody(doc)) throw new Error("The document has nothing in it yet: write its summary and sections, then make it again.");

  const { agencyLogo, reportBrand } = await import("@/lib/reports/brand-server");
  const [brand, mark] = await Promise.all([client ? reportBrand(admin, client.id).catch(() => null) : Promise.resolve(null), agencyLogo()]);
  const pdf = await renderToBuffer(<KaizenDocument input={{ doc, brand: { logo: brand?.logo ?? null, light: brand?.light ?? false, color: brand?.color ?? null, agencyLogo: mark } }} />);

  const id = (prior.data?.id as string | undefined) ?? crypto.randomUUID();
  const version = Number(prior.data?.version ?? 0) + 1;
  const fileName = docFileName(doc);
  const bucket = client ? DOCS_BUCKET : AI_BUCKET;
  const path = client ? `${client.id}/kaizen/${id}/v${version}.pdf` : `${me.id}/documents/${id}/v${version}.pdf`;
  const { error } = await admin.storage.from(bucket).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Couldn't save the document: ${error.message}`);

  const now = new Date().toISOString();
  const text = plainText(doc);
  let clientDocId = (prior.data?.client_document_id as string | null | undefined) ?? null;
  if (client) {
    // Filed with the client's documents (what the AI reads when it works on them); a new version updates the same entry
    const entry = { client_id: client.id, kind: "file", name: fileName, path, mime: "application/pdf", bytes: pdf.length, title: `${DOC_LABEL[doc.kind]}: ${doc.title}`.slice(0, 200), summary: doc.summary.slice(0, 600) || null, text, status: "ready", via: "assistant", uploaded_by: me.id };
    if (clientDocId) await admin.from("client_documents").update(entry).eq("id", clientDocId);
    else {
      const { data: cd } = await admin.from("client_documents").insert(entry).select("id").single();
      clientDocId = (cd?.id as string | undefined) ?? null;
    }
  }
  const row = { id, client_id: client?.id ?? null, profile_id: (prior.data?.profile_id as string | undefined) ?? me.id, kind: doc.kind, title: doc.title, content: { ...doc, service: serviceOf(opts.service).slug, dataFigures: opts.dataFigures ?? [] }, bucket, path, file_name: fileName, version, placeholders, client_document_id: clientDocId, updated_at: now };
  const { error: saveErr } = await admin.from("kaizen_documents").upsert(row);
  if (saveErr) throw new Error(`Couldn't keep the document: ${saveErr.message}`);
  return { id, version, title: doc.title, kind: doc.kind, fileName, placeholders, href: documentHref(id), download: documentHref(id, true), client: client?.name ?? null };
}

/** A fresh signed link to a document's current version (the caller checked the person may read it) */
export async function signedDocumentUrl(admin: SupabaseClient, d: { bucket: string; path: string; file_name: string | null }, download: boolean): Promise<string | null> {
  const { data } = await admin.storage.from(d.bucket).createSignedUrl(d.path, 300, download ? { download: d.file_name ?? "Kaizen document.pdf" } : undefined);
  return data?.signedUrl ?? null;
}

/** A document's file, for an email attachment */
export async function documentFile(admin: SupabaseClient, d: { bucket: string; path: string }): Promise<Buffer | null> {
  const { data } = await admin.storage.from(d.bucket).download(d.path);
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

/** The documents a person may attach: read through their own session (row-level security decides) */
export async function readableDocuments(db: SupabaseClient, ids: string[]): Promise<{ id: string; title: string; file_name: string | null; bucket: string; path: string; client_id: string | null }[]> {
  if (!ids.length) return [];
  const { data } = await db.from("kaizen_documents").select("id, title, file_name, bucket, path, client_id").in("id", ids.slice(0, 5));
  return ((data ?? []) as { id: string; title: string; file_name: string | null; bucket: string; path: string | null; client_id: string | null }[]).filter((d): d is { id: string; title: string; file_name: string | null; bucket: string; path: string; client_id: string | null } => Boolean(d.path));
}
