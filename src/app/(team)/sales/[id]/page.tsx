import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cleanBrief, cleanPitch, cleanReview, worksSales } from "@/lib/sales-core";
import { getProspect } from "@/lib/sales-agent";
import { ProspectView, type ProspectNote } from "./prospect-view";

export const metadata: Metadata = { title: "Prospect" };
// Research, pitch drafts and call reviews run from here (a minute or two)
export const maxDuration = 300;

export default async function ProspectPage({ params }: PageProps<"/sales/[id]">) {
  const me = await requireStaff();
  if (!worksSales(me)) notFound();
  const { id } = await params;
  const db = await createClient();
  const p = await getProspect(db, id);
  if (!p) notFound();
  const [{ data: notes }, { data: people }, { data: docs }, { data: client }] = await Promise.all([
    db.from("prospect_notes").select("id, kind, title, body, created_at, created_by").eq("prospect_id", p.id).in("kind", ["pitch", "call_review"]).order("created_at", { ascending: false }).limit(30),
    db.from("profiles").select("id, full_name").eq("is_active", true).or("is_exec.eq.true,is_lead.eq.true").order("full_name"),
    db.from("kaizen_documents").select("id, title, template, google_url, folder_place, created_at").ilike("prospect_name", p.name.replace(/[%_]/g, "")).order("created_at", { ascending: false }).limit(20),
    p.client_id ? db.from("clients").select("name, slug").eq("id", p.client_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const list: ProspectNote[] = (notes ?? []).map((n) =>
    n.kind === "pitch"
      ? { id: n.id as string, kind: "pitch", title: (n.title as string) ?? "Pitch drafts", at: n.created_at as string, pitch: cleanPitch(n.body) }
      : { id: n.id as string, kind: "call_review", title: (n.title as string) ?? "Call review", at: n.created_at as string, review: cleanReview(n.body) },
  );
  return (
    <Suspense>
      <ProspectView
        p={{ id: p.id, name: p.name, website: p.website, industry: p.industry, location: p.location, status: p.status, fit: p.fit_score, fitReason: p.fit_reason, ownerId: p.owner_id, notes: p.notes, lostReason: p.lost_reason, researchedAt: p.researched_at, source: p.source }}
        brief={p.brief ? cleanBrief(p.brief) : null}
        notes={list}
        people={(people ?? []).map((x) => ({ id: x.id as string, name: x.full_name as string }))}
        docs={(docs ?? []).map((d) => ({ id: d.id as string, title: (d.title as string) ?? "Document", link: (d.google_url as string | null) ?? null, folder: (d.folder_place as string | null) ?? null }))}
        client={client ? { name: client.name as string, slug: client.slug as string } : null}
        meId={me.id}
      />
    </Suspense>
  );
}
