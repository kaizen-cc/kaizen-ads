import type { Metadata } from "next";
import Link from "next/link";
import Market from "../market/page";
import Winners from "../winners/page";
import { LIVE } from "@/lib/live";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadVerticals } from "@/lib/verticals";
import { VerticalsView } from "./verticals-view";

export const metadata: Metadata = { title: "Ideas" };

// The strategist writes a full brief from a winner or a market ad while the person waits
export const maxDuration = 300;

const TABS = [
  ["winners", "Our winners", "What's beating its own account across our clients"],
  ["market", "In the market", "Live Meta ads from comparable brands, from Motion"],
  ["verticals", "Verticals", "The markets we serve, with their benchmarks"],
] as const;

/** Where ideas come from: what's working in our accounts, and what's working out in the market. */
export default async function Ideas({ searchParams }: PageProps<"/ideas">) {
  const sp = await searchParams;
  const tab = sp.tab === "market" ? "market" : sp.tab === "verticals" ? "verticals" : "winners";
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
      {tab === "market" ? <Market {...({ searchParams, params: Promise.resolve({}) } as unknown as PageProps<"/market">)} /> : tab === "verticals" ? <Verticals /> : <Winners />}
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
