import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { archiveText, cleanBrief, cleanPitch, cleanReview, seesSalesPages } from "@/lib/sales-core";
import { getProspect } from "@/lib/sales-agent";
import { ProspectView, type ProspectNote } from "./prospect-view";
import { GtmCard } from "./gtm-card";
import { SwipeBlock, type SwipeRow } from "./swipe-block";

export const metadata: Metadata = { title: "Prospect" };
// Research, pitch drafts and call reviews run from here (a minute or two)
export const maxDuration = 300;

export default async function ProspectPage({ params }: PageProps<"/sales/[id]">) {
  const me = await requireStaff();
  if (!seesSalesPages(me)) notFound();
  const { id } = await params;
  const db = await createClient();
  const p = await getProspect(db, id);
  if (!p) notFound();
  const [{ data: notes }, { data: people }, { data: docs }, { data: client }, { data: calls }] = await Promise.all([
    db.from("prospect_notes").select("id, kind, title, body, created_at, created_by").eq("prospect_id", p.id).in("kind", ["pitch", "call_review"]).order("created_at", { ascending: false }).limit(30),
    db.from("profiles").select("id, full_name").eq("is_active", true).or("is_exec.eq.true,is_lead.eq.true").order("full_name"),
    db.from("kaizen_documents").select("id, title, template, google_url, folder_place, created_at").ilike("prospect_name", p.name.replace(/[%_]/g, "")).order("created_at", { ascending: false }).limit(20),
    p.client_id ? db.from("clients").select("name, slug").eq("id", p.client_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("sales_call_briefs").select("id, title, starts_at, status").eq("prospect_id", p.id).order("starts_at", { ascending: false }).limit(10),
  ]);
  // The latest go-to-market strategy, and the white-label partners to brand one for
  const [{ data: g }, { data: partners }] = await Promise.all([
    db.from("prospect_gtms").select("id, status, stage, partner_key, document_id, notes, error, created_at").eq("prospect_id", p.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("sales_partners").select("key, name, kit_confirmed_at").eq("active", true).order("name"),
  ]);
  // Its email flows and its competitors', from the swipe file
  const { data: sb } = await db.from("swipe_brands").select("id, name, source, status").eq("prospect_id", p.id).limit(8);
  const { data: sf } = (sb ?? []).length ? await db.from("swipe_flows").select("brand_id, flow_type, steps, cadence, offers").in("brand_id", (sb ?? []).map((x) => x.id as string)).neq("flow_type", "campaign").order("steps", { ascending: false }).limit(40) : { data: [] };
  const swipeRows: SwipeRow[] = ((sb ?? []) as { id: string; name: string; source: string; status: string }[])
    .sort((a, b) => (a.source === "prospect" ? -1 : b.source === "prospect" ? 1 : 0))
    .map((x) => ({ brand: x.name, role: x.source === "prospect" ? "prospect" : "competitor", status: x.status, flows: ((sf ?? []) as { brand_id: string; flow_type: SwipeRow["flows"][number]["type"]; steps: number; cadence: string | null; offers: string | null }[]).filter((f) => f.brand_id === x.id).map((f) => ({ type: f.flow_type, steps: f.steps, cadence: f.cadence, offers: f.offers })) }));
  const { cleanNotes } = await import("@/lib/sales-gtm-core");
  const partnerName = (k: string | null) => ((partners ?? []) as { key: string; name: string }[]).find((x) => x.key === k)?.name ?? null;
  const gtm = g ? { id: g.id as string, status: g.status as string, stage: (g.stage as string | null) ?? null, partner: partnerName(g.partner_key as string | null), documentId: (g.document_id as string | null) ?? null, notes: g.notes ? cleanNotes(g.notes, partnerName(g.partner_key as string | null)) : null, error: (g.error as string | null) ?? null, createdAt: g.created_at as string } : null;
  const list: ProspectNote[] = (notes ?? []).map((n) =>
    n.kind === "pitch"
      ? { id: n.id as string, kind: "pitch", title: (n.title as string) ?? "Pitch drafts", at: n.created_at as string, pitch: cleanPitch(n.body) }
      : { id: n.id as string, kind: "call_review", title: (n.title as string) ?? "Call review", at: n.created_at as string, review: cleanReview(n.body) },
  );
  return (
    <Suspense>
      <ProspectView
        p={{ id: p.id, name: p.name, website: p.website, industry: p.industry, location: p.location, status: p.status, fit: p.fit_score, fitReason: p.fit_reason, ownerId: p.owner_id, notes: p.notes, lostReason: p.lost_reason, researchedAt: p.researched_at, source: p.source, mode: { relationship: p.relationship, partner: partnerName(p.partner_key) }, archived: p.archived_at ? { at: p.archived_at, by: p.archived_by ? (people ?? []).find((x) => x.id === p.archived_by)?.full_name ?? null : null, label: archiveText(p.archive_reason, p.archive_note) } : null }}
        brief={p.brief ? cleanBrief(p.brief) : null}
        notes={list}
        people={(people ?? []).map((x) => ({ id: x.id as string, name: x.full_name as string }))}
        docs={(docs ?? []).map((d) => ({ id: d.id as string, title: (d.title as string) ?? "Document", link: (d.google_url as string | null) ?? null, folder: (d.folder_place as string | null) ?? null }))}
        client={client ? { name: client.name as string, slug: client.slug as string } : null}
        calls={(calls ?? []).map((c) => ({ id: c.id as string, title: c.title as string, startsAt: c.starts_at as string, status: c.status as string }))}
        meId={me.id}
        swipeSlot={<SwipeBlock rows={swipeRows} />}
        gtmSlot={<GtmCard prospectId={p.id} gtm={gtm} relationship={p.relationship} partnerKey={p.partner_key} partners={((partners ?? []) as { key: string; name: string; kit_confirmed_at: string | null }[]).map((x) => ({ key: x.key, name: x.name, confirmed: Boolean(x.kit_confirmed_at) }))} />}
      />
    </Suspense>
  );
}
