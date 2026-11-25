import type { Metadata } from "next";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { archiveText, seesSalesPages } from "@/lib/sales-core";
import { SalesView, type ProspectRow } from "./sales-view";
import { SearchCard } from "./search-card";

export const metadata: Metadata = { title: "Sales" };
// Research and lists run here (a minute or two of web research)
export const maxDuration = 300;

// Sales › Prospects: the light pipeline the Sales agent keeps. Research a business, build a list scored by fit, and
// move each prospect through its stages. Internal for now: the executives and the leads.

// The clock, read outside render (the page is dynamic)
const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  const me = await requireStaff();
  // The executives only for now (viewing as someone else, it's that person's view)
  if (!seesSalesPages(me)) notFound();
  const db = await createClient();
  const [{ data: rows }, { data: people }, { data: partners }] = await Promise.all([
    db.from("prospects").select("id, name, website, industry, location, status, fit_score, fit_reason, owner_id, researched_at, updated_at, brief, archived_at, archived_by, archive_reason, archive_note").order("updated_at", { ascending: false }).limit(500),
    db.from("profiles").select("id, full_name").eq("is_active", true).or("is_exec.eq.true,is_lead.eq.true").order("full_name"),
    db.from("sales_partners").select("key, name").eq("active", true).order("name"),
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
    archived: p.archived_at ? { at: p.archived_at as string, by: p.archived_by ? (names.get(p.archived_by as string) ?? null) : null, label: archiveText(p.archive_reason as string | null, p.archive_note as string | null) } : null,
  }));
  // Their prospect searches: running ones, finished ones not reviewed yet (last week), and the one in the address
  const sp = await searchParams;
  const focus = typeof sp.search === "string" && /^[0-9a-f-]{36}$/i.test(sp.search) ? sp.search : null;
  const { SEARCH_COLS, searchView } = await import("@/lib/prospect-search");
  const [{ data: open }, { data: focused }] = await Promise.all([
    db.from("prospect_searches").select(SEARCH_COLS).eq("profile_id", me.id).gt("created_at", weekAgo()).or("status.in.(queued,running),and(status.eq.done,reviewed_at.is.null)").order("created_at", { ascending: false }).limit(5),
    focus ? db.from("prospect_searches").select(SEARCH_COLS).eq("id", focus).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const searches = [...(focused ? [focused] : []), ...(open ?? []).filter((x) => x.id !== focus)].map((x) => searchView(x as Record<string, unknown>));
  return (
    <Suspense>
      <SalesView prospects={prospects} meId={me.id} partners={((partners ?? []) as { key: string; name: string }[])} searches={searches.length ? <div className="grid min-w-0 gap-3">{searches.map((x) => <SearchCard key={x.id} initial={x} focused={x.id === focus} />)}</div> : null} />
    </Suspense>
  );
}
