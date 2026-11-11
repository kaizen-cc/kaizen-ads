import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { toAllotment, type UsageRow } from "@/lib/allotment";
import { primaryOf, type SeatRow } from "@/lib/buyer-seats";
import { MAKER_ROLE, dayLabel, dueFor, fitStructure, headerLine, picked, slidesFor, structureKey, versionsStrip, type BriefStructure, type PdfCounts, type PdfFormat } from "@/lib/brief-pdf-model";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  clientId: string;
  title: string;
  formats: Partial<Record<PdfFormat, PdfCounts>>;
  sizes: string[];
  priority: string;
  angle: string;
  audience: string;
  brief: string;
  refs: string;
  landing?: string;
  origin?: { kind?: string; label?: string; link?: string | null; thumb?: string | null; suggestionId?: string | null } | null;
  savedRefIds?: string[];
  /** The request's number once it's sent */
  number?: number | null;
  /** "structure": only the restructured brief (to keep on the draft); otherwise the PDF */
  mode?: "structure" | "pdf";
  /** The structure kept on the draft from an earlier export: used when the brief hasn't changed since */
  pdfCache?: { key: string; structure: BriefStructure } | null;
};

const num = (x: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(x) || 0)));

// POST /api/requests/brief-pdf: a creative request as a Kaizen-branded PDF (from the request form, for anyone on the
// team who can see the client), two pages in the brief's one structure. A brief written in today's sections is read as
// it is; an older one is restructured once (the AI, cached on the draft by key). The references it's built on come with
// their pictures and links.
export async function POST(request: Request) {
  const me = await requireStaff();
  const b = (await request.json().catch(() => null)) as Body | null;
  if (!b || !/^[0-9a-f-]{36}$/i.test(b.clientId ?? "")) return new Response("Bad request", { status: 400 });
  const db = await createClient();
  const { data: client } = await db.from("clients").select("name").eq("id", b.clientId).maybeSingle();
  if (!client) return new Response("Not found", { status: 404 });

  const formats: Partial<Record<PdfFormat, PdfCounts>> = {};
  for (const f of ["image", "video", "carousel"] as const) {
    const k = b.formats?.[f];
    if (k) formats[f] = { new: num(k.new, 20), variations: num(k.variations, 20), ...(f === "carousel" ? { cards: num(k.cards ?? 5, 10) || 5 } : {}) };
  }
  const landing = b.landing && /^https?:\/\/\S+$/i.test(b.landing.trim()) ? b.landing.trim().slice(0, 500) : null;
  const source = {
    title: String(b.title ?? "").slice(0, 200),
    angle: String(b.angle ?? "").slice(0, 500),
    audience: String(b.audience ?? "").slice(0, 1500),
    brief: String(b.brief ?? "").slice(0, 20000),
    formats,
    landing,
  };
  const key = structureKey(source);
  const cached = b.pdfCache?.key === key && b.pdfCache.structure ? fitStructure(b.pdfCache.structure, source, Boolean(b.pdfCache.structure.ai)) : null;
  const structure = cached ?? (await (await import("@/lib/brief-pdf-data")).structureBrief({ ...source, clientId: b.clientId, client: client.name as string }));
  if (b.mode === "structure") return Response.json({ key, structure }, { headers: { "cache-control": "private, no-store" } });

  const admin = adminConfigured() ? createAdminClient() : null;
  const read = admin ?? db;
  const { gatherReferences } = await import("@/lib/brief-pdf-data");
  const [{ data: usage }, { data: seats }, { data: rules }, refs] = await Promise.all([
    db.from("client_allotment_usage").select("*").eq("client_id", b.clientId).maybeSingle(),
    db.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name)").eq("client_id", b.clientId),
    read.from("client_bible_rules").select("rule, polarity").eq("client_id", b.clientId).eq("status", "rule").order("count", { ascending: false }).limit(12),
    gatherReferences(db, admin, {
      origin: b.origin ?? null,
      savedRefIds: Array.isArray(b.savedRefIds) ? b.savedRefIds.map(String) : [],
      refs: String(b.refs ?? "").split(/\s+/).filter((u) => /^(https?:\/\/|\/)/i.test(u)).slice(0, 20),
      appOrigin: new URL(request.url).origin,
    }),
  ]);

  // Who makes each format, and when it's due if it's sent today
  const fs = picked(formats);
  // Each seat's primary
  const seat = (role: string) => primaryOf((seats ?? []) as unknown as (SeatRow & { profiles: { full_name?: string } | null })[], role)?.profiles?.full_name?.trim() || null;
  const makers = [...new Set(fs.map((f) => MAKER_ROLE[f]))].map((m) => {
    const name = seat(m.role);
    return name ? `${name} (${m.label})` : `The ${m.label} (unassigned)`;
  });
  const priority = b.priority === "urgent" || b.priority === "high" ? b.priority : "normal";
  const dues = fs.map((f) => ({ f, d: dueFor(f, priority) }));
  const due = !dues.length ? null : dues.length === 1 || dues.every((x) => dayLabel(x.d) === dayLabel(dues[0].d)) ? dayLabel(dues[0].d) : dues.map((x) => `${x.f === "video" ? "Video" : x.f === "carousel" ? "Carousel" : "Image"} ${dayLabel(x.d)}`).join(" · ");
  const sizes = (b.sizes ?? []).map((z) => String(z).replace("x", ":")).filter((z) => /^\d{1,2}:\d{1,2}$/.test(z));

  // The client's standing rules (Brand Bible rules in force) folded in only where the brief leaves room: Must and Never
  // stay five each, the brief's own first
  const ruleDos = (rules ?? []).filter((r) => r.polarity === "do").map((r) => String(r.rule));
  const ruleDonts = (rules ?? []).filter((r) => r.polarity === "dont").map((r) => String(r.rule));
  const merge = (a: string[], extra: string[]) => [...new Set([...a, ...extra.filter((x) => x.length <= 140 && !a.some((y) => y.toLowerCase() === x.toLowerCase()))])].slice(0, 5);

  // The brief's insight, what's the maker's call, the facts still to confirm with the client, and the review stamp
  // when someone reviewed this exact brief (text and sizes)
  const { parseBrief, exportLineFor } = await import("@/lib/brief-spec");
  const { openFacts, withDetectedFacts } = await import("@/lib/brief-facts");
  const spec = withDetectedFacts(parseBrief(source.brief).spec, source.title);
  let reviewed: string | null = null;
  if (admin && source.brief.trim()) {
    const [{ briefHash, stampAndOverride }, { stampLine }] = await Promise.all([import("@/lib/brief-check"), import("@/lib/brief-gate")]);
    const rawSizes = (b.sizes ?? []).map((z) => String(z).replace(":", "x"));
    const { stamp } = await stampAndOverride(admin, b.clientId, briefHash(source.brief, rawSizes)).catch(() => ({ stamp: null }));
    reviewed = stamp ? stampLine(stamp) : null;
  }

  const { briefPdf } = await import("@/lib/brief-pdf");
  const cards = slidesFor(formats);
  const pdf = await briefPdf({
    confirm: openFacts(spec).map((f) => f.question),
    reviewed,
    client: client.name as string,
    title: source.title,
    number: typeof b.number === "number" && b.number > 0 ? Math.floor(b.number) : null,
    header: headerLine(formats, sizes, structure.stage),
    due,
    makers,
    priority,
    versions: versionsStrip(formats, usage ? toAllotment(usage as UsageRow) : null),
    measure: formats.video && structure.length ? { label: "Length", value: structure.length } : cards ? { label: "Slides", value: String(cards) } : null,
    references: refs.refs,
    structure: { ...structure, must: merge(structure.must, ruleDos), never: merge(structure.never, ruleDonts) },
    exportLine: spec.exportLine || exportLineFor(fs, sizes, client.name as string, source.title),
    links: [...(landing ? [{ label: "Landing page", url: landing }] : []), ...refs.links],
    formats: fs,
    by: me.fullName,
  });
  const name = `${client.name} - ${b.title || "Creative request"}.pdf`.replace(/[^\w .()-]+/g, "").slice(0, 120);
  return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
}
