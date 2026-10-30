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
import { PLAYBOOK_VERSION } from "@/lib/playbooks";
import { FameLibrary } from "./fame-library";
import { loadHallOfFame } from "@/lib/hall-of-fame";
import { toAllotment, type UsageRow } from "@/lib/allotment";
import type { PickClient } from "../winners/winners-library";
import { GoogleIdeasView } from "./google-ideas-view";
import { loadGoogleIdeas } from "@/lib/google-ideas";
import { GoogleAdsMark, MetaMark } from "@/components/source-logo";

export const metadata: Metadata = { title: "Ideas" };

// The strategist writes a full brief from a winner or a market ad while the person waits
export const maxDuration = 300;

const GOOGLE_TABS = [
  ["fame", "Hall of Fame", "Our search ads, keywords and search terms that beat their target over six months"],
  ["winners", "Live winners", "What's converting cheapest in our Google accounts right now"],
  ["market", "In the market", "Competitors' live Google ads, from the Ads Transparency Center"],
  ["verticals", "Verticals", "A Google playbook for each market we serve"],
] as const;

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
  // Two sides, the same four kinds of ideas: Meta (briefs for the creative team) and Google (search ads, keywords and
  // search terms). Everyone can look at both
  const line = sp.line === "google" ? "google" : "meta";
  // Keep the client (and anything else) when switching tabs
  const keep = (t: string, l: string = line) => {
    const q = new URLSearchParams();
    if (l === "google") q.set("line", "google");
    q.set("tab", t);
    if (typeof sp.client === "string") q.set("client", sp.client);
    return `/ideas?${q.toString()}`;
  };
  const tabs = line === "google" ? GOOGLE_TABS : TABS;
  return (
    <div className="grid gap-6">
      <div className="mx-auto grid w-full max-w-6xl gap-3">
        {/* The side: Meta or Google */}
        <nav className="grid w-full grid-cols-2 gap-1 rounded-[20px] border border-line bg-surface p-1 sm:mx-auto sm:w-fit" aria-label="Platform">
          {(
            [
              ["meta", "Meta", <MetaMark key="m" size={18} />],
              ["google", "Google Ads", <GoogleAdsMark key="g" size={15} />],
            ] as const
          ).map(([k, label, mark]) => (
            <Link
              key={k}
              href={keep(tab, k)}
              aria-current={line === k ? "page" : undefined}
              className={`flex items-center justify-center gap-2.5 rounded-[16px] px-6 py-3 text-[15px] font-medium transition-colors sm:min-w-[170px] ${line === k ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
            >
              {mark}
              {label}
            </Link>
          ))}
        </nav>
        {/* Phones: the four tabs as a two-by-two segmented control, every label whole */}
        <nav className="grid w-full grid-cols-2 gap-1 rounded-[18px] border border-line bg-surface p-1 sm:mx-auto sm:flex sm:w-fit sm:rounded-full" aria-label="Ideas">
          {tabs.map(([k, label, hint]) => (
            <Link
              key={k}
              href={keep(k)}
              title={hint}
              aria-current={tab === k ? "page" : undefined}
              className={`flex-1 whitespace-nowrap rounded-[14px] px-3 py-2.5 text-center text-sm transition-colors sm:flex-none sm:rounded-full sm:px-4 sm:py-2 ${tab === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {line === "google" ? (
        tab === "market" ? (
          <GoogleSoon title="Google ads in the market" body="Competitors' live search ads for every industry we serve, read from Google's Ads Transparency Center, the way Motion fills the Meta side. It needs one connection to switch on." />
        ) : tab === "verticals" ? (
          <GoogleSoon title="Google playbooks by vertical" body="For each industry we serve: the search ads, keywords and search terms that won for our clients, the intents that convert, and the campaign structure behind them. It's written from the Hall of Fame below as it fills." />
        ) : (
          <GoogleIdeas mode={tab === "winners" ? "live" : "fame"} />
        )
      ) : tab === "market" ? (
        <Market {...({ searchParams, params: Promise.resolve({}) } as unknown as PageProps<"/market">)} />
      ) : tab === "verticals" ? (
        <Verticals />
      ) : tab === "winners" ? (
        <Winners />
      ) : (
        <Fame />
      )}
    </div>
  );
}

async function GoogleIdeas({ mode }: { mode: "fame" | "live" }) {
  await requireStaff();
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const items = await loadGoogleIdeas(db, mode);
  const verticals = [...new Set(items.map((i) => i.vertical).filter((v): v is string => Boolean(v)))].sort();
  return <GoogleIdeasView items={items} mode={mode} verticals={verticals} />;
}

function GoogleSoon({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto grid w-full max-w-3xl place-items-center gap-3 rounded-[22px] border border-dashed border-line px-6 py-16 text-center">
      <GoogleAdsMark size={28} />
      <p className="font-heading text-2xl">{title}</p>
      <p className="max-w-lg text-sm text-muted">{body}</p>
      <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-faint">Coming next</span>
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
    db.from("vertical_playbooks").select("vertical_id, summary, avatars, sources, fingerprint").like("fingerprint", `${PLAYBOOK_VERSION}:%`),
    db.from("hall_of_fame").select("vertical_id, creative").gt("expires_at", new Date().toISOString()).not("vertical_id", "is", null).order("beat_by", { ascending: false }).limit(600),
    db
      .from("market_ads")
      .select("id, market_brands!inner(vertical_id)")
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
    // Market ads are counted, not pictured: the card shows our own ads
    card((m.market_brands as unknown as { vertical_id: string }).vertical_id).market++;
  }
  for (const b of books ?? []) {
    const avatars = (b.avatars ?? []) as { name: string; angles?: unknown[] }[];
    if (avatars.length && Number((b.sources as { fame?: number } | null)?.fame)) card(b.vertical_id as string).playbook = { summary: b.summary as string, avatars: avatars.map((a) => a.name), angles: avatars.reduce((n, a) => n + (a.angles?.length ?? 0), 0) };
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
