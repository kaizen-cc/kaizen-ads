import type { Metadata } from "next";
import Link from "next/link";
import Market from "../market/page";
import Winners from "../winners/page";
import { LIVE } from "@/lib/live";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadVerticals } from "@/lib/verticals";
import { VerticalsView, type SubCard } from "./verticals-view";
import { requireStaff } from "@/lib/auth";
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
  ["verticals", "Verticals", "The markets we serve: benchmarks and a playbook for each"],
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
  const me = await requireStaff();
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const [verticals, { data: clients }, { data: brands }, { data: books }, { data: fame }, { data: market }] = await Promise.all([
    loadVerticals(db),
    db.from("clients").select("id, name, slug, vertical_id, vertical_why").is("archived_at", null).in("status", LIVE).eq("paid_ads", true).order("name"),
    db.from("market_brands").select("vertical_id").eq("rejected", false).not("vertical_id", "is", null),
    db.from("vertical_playbooks").select("vertical_id, summary, avatars"),
    db.from("hall_of_fame").select("vertical_id, creative").gt("expires_at", new Date().toISOString()).not("vertical_id", "is", null).order("beat_by", { ascending: false }).limit(600),
    db
      .from("market_ads")
      .select("media, market_brands!inner(vertical_id)")
      .gte("days_active", 30)
      .neq("active", false)
      .not("market_brands.vertical_id", "is", null)
      .order("days_active", { ascending: false })
      .limit(800),
  ]);
  const cards = new Map<string, SubCard>();
  const card = (id: string) => {
    if (!cards.has(id)) cards.set(id, { clients: [], brands: 0, fame: 0, market: 0, thumbs: [], playbook: null });
    return cards.get(id)!;
  };
  for (const v of verticals) for (const s of v.subs) card(s.id);
  for (const c of clients ?? []) if (c.vertical_id) card(c.vertical_id).clients.push({ id: c.id, name: c.name, slug: c.slug, why: c.vertical_why });
  for (const b of brands ?? []) card(b.vertical_id as string).brands++;
  for (const f of fame ?? []) {
    const k = card(f.vertical_id as string);
    k.fame++;
    const img = (f.creative as { image?: string } | null)?.image;
    if (img && k.thumbs.length < 3) k.thumbs.push(img);
  }
  for (const m of market ?? []) {
    const k = card((m.market_brands as unknown as { vertical_id: string }).vertical_id);
    k.market++;
    const media = (m.media ?? []) as { type: string; url: string; thumb: string | null }[];
    const img = media.find((x) => x.type === "image")?.url ?? media[0]?.thumb;
    if (img && k.thumbs.length < 3) k.thumbs.push(img);
  }
  for (const b of books ?? []) {
    const avatars = (b.avatars ?? []) as { name: string; angles?: unknown[] }[];
    if (avatars.length) card(b.vertical_id as string).playbook = { summary: b.summary as string, avatars: avatars.map((a) => a.name), angles: avatars.reduce((n, a) => n + (a.angles?.length ?? 0), 0) };
  }
  const all = [...cards.values()];
  return (
    <VerticalsView
      verticals={verticals}
      cards={cards}
      unplaced={(clients ?? []).filter((c) => !c.vertical_id).map((c) => ({ id: c.id, name: c.name }))}
      totals={{ clients: (clients ?? []).length, fame: all.reduce((n, c) => n + c.fame, 0), market: all.reduce((n, c) => n + c.market, 0), playbooks: all.filter((c) => c.playbook).length }}
      canRebuild={me.isExec}
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
