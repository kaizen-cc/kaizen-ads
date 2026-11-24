import type { Metadata } from "next";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { worksSales } from "@/lib/sales-core";
import { SalesView, type ProspectRow } from "./sales-view";

export const metadata: Metadata = { title: "Sales" };
// Research and lists run here (a minute or two of web research)
export const maxDuration = 300;

// Sales › Prospects: the light pipeline the Sales agent keeps. Research a business, build a list scored by fit, and
// move each prospect through its stages. Internal for now: the executives and the leads.

export default async function SalesPage() {
  const me = await requireStaff();
  if (!worksSales(me))
    return (
      <div className="mx-auto grid max-w-xl gap-2 py-16 text-center">
        <h1 className="font-heading text-[24px]">Sales</h1>
        <p className="text-[14px] text-muted">Sales is for the executives and leads for now.</p>
      </div>
    );
  const db = await createClient();
  const [{ data: rows }, { data: people }] = await Promise.all([
    db.from("prospects").select("id, name, website, industry, location, status, fit_score, fit_reason, owner_id, researched_at, updated_at, brief").order("updated_at", { ascending: false }).limit(500),
    db.from("profiles").select("id, full_name").eq("is_active", true).or("is_exec.eq.true,is_lead.eq.true").order("full_name"),
  ]);
  const names = new Map((people ?? []).map((p) => [p.id as string, p.full_name as string]));
  const prospects: ProspectRow[] = (rows ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    website: (p.website as string | null) ?? null,
    industry: (p.industry as string | null) ?? null,
    location: (p.location as string | null) ?? null,
    status: p.status as ProspectRow["status"],
    fit: (p.fit_score as number | null) ?? null,
    fitReason: (p.fit_reason as string | null) ?? null,
    summary: ((p.brief as { summary?: string } | null)?.summary ?? null) || null,
    ownerId: (p.owner_id as string | null) ?? null,
    owner: p.owner_id ? (names.get(p.owner_id as string) ?? null) : null,
    researched: Boolean(p.researched_at),
    updated: p.updated_at as string,
  }));
  return (
    <Suspense>
      <SalesView prospects={prospects} meId={me.id} />
    </Suspense>
  );
}
