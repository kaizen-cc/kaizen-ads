import type { Metadata } from "next";
import Link from "next/link";
import Market from "../market/page";
import Winners from "../winners/page";
import { LIVE } from "@/lib/live";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadVerticals } from "@/lib/verticals";
import { VerticalsView } from "./verticals-view";
import { FameLibrary } from "./fame-library";
import { loadHallOfFame } from "@/lib/hall-of-fame";
import { toAllotment, type UsageRow } from "@/lib/allotment";
import type { PickClient } from "../winners/winners-library";

export const metadata: Metadata = { title: "Ideas" };

// The strategist writes a full brief from a winner or a market ad while the person waits
export const maxDuration = 300;

const TABS = [
  ["fame", "Hall of Fame", "Our ads that beat their target over 30+ days, kept six months"],
  ["winners", "Live winners", "What's beating its own account right now"],
  ["market", "In the market", "Live Meta ads from comparable brands, from Motion"],
  ["verticals", "Verticals", "The markets we serve, with their benchmarks"],
] as const;

/** Where ideas come from: what's working in our accounts, and what's working out in the market. */
export default async function Ideas({ searchParams }: PageProps<"/ideas">) {
  const sp = await searchParams;
  const tab = sp.tab === "market" ? "market" : sp.tab === "verticals" ? "verticals" : sp.tab === "winners" ? "winners" : "fame";
  // Keep the client (and anything else) when switching tabs
  const keep = (t: string) => {
    const q = new URLSearchParams();
    q.set("tab", t);
    if (typeof sp.client === "string") q.set("client", sp.client);
    return `/ideas?${q.toString()}`;
  };
  return (
    <div className="grid gap-6">
      <nav className="mx-auto flex w-full max-w-6xl gap-1 rounded-full border border-line bg-surface p-1 sm:w-fit" aria-label="Ideas">
        {TABS.map(([k, label, hint]) => (
          <Link
            key={k}
            href={keep(k)}
            title={hint}
            aria-current={tab === k ? "page" : undefined}
            className={`flex-1 rounded-full px-4 py-2 text-center text-sm transition-colors sm:flex-none ${tab === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === "market" ? <Market {...({ searchParams, params: Promise.resolve({}) } as unknown as PageProps<"/market">)} /> : tab === "verticals" ? <Verticals /> : tab === "winners" ? <Winners /> : <Fame />}
    </div>
  );
}

async function Verticals() {
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const [verticals, { data: clients }, { data: brands }] = await Promise.all([
    loadVerticals(db),
    db.from("clients").select("id, name, slug, vertical_id, vertical_why").is("archived_at", null).in("status", LIVE).order("name"),
    db.from("market_brands").select("vertical_id").eq("rejected", false).not("vertical_id", "is", null),
  ]);
  const counts = new Map<string, number>();
  for (const b of brands ?? []) counts.set(b.vertical_id as string, (counts.get(b.vertical_id as string) ?? 0) + 1);
  return (
    <VerticalsView
      verticals={verticals}
      clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, verticalId: c.vertical_id, why: c.vertical_why }))}
      brands={counts}
    />
  );
}

async function Fame() {
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const [ads, verticals, { data: usage }, { data: rows }] = await Promise.all([
    loadHallOfFame(db),
    loadVerticals(db),
    db.from("client_allotment_usage").select("*"),
    db.from("clients").select("id, name, industry, industry_detail").is("archived_at", null).in("status", LIVE).order("name"),
  ]);
  const clients: PickClient[] = ((usage ?? []) as UsageRow[])
    .map((u) => {
      const c = (rows ?? []).find((r) => r.id === u.client_id);
      return c ? { id: c.id, name: c.name, industry: c.industry, detail: c.industry_detail, allotment: toAllotment(u) } : null;
    })
    .filter((c): c is PickClient => Boolean(c))
    .sort((a, b) => a.name.localeCompare(b.name));
  return <FameLibrary ads={ads} verticals={verticals.flatMap((v) => v.subs.map((x) => ({ id: x.id, name: x.name, parent: v.name })))} clients={clients} />;
}
