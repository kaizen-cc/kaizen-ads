import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { INDUSTRY_OPTIONS } from "@/lib/industries";
import { loadMarket } from "@/lib/market";
import { motionConnected } from "@/lib/motion";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toAllotment, type UsageRow } from "@/lib/allotment";
import type { PickClient } from "../winners/winners-library";
import { MarketLibrary } from "./market-library";
import { LIVE } from "@/lib/live";

export const metadata: Metadata = { title: "Market" };

// The strategist writes a full brief from a market ad while the person waits
export const maxDuration = 300;

export default async function Market({ searchParams }: PageProps<"/market">) {
  const me = await requireStaff();
  const sp = await searchParams;
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const [ads, connection, { data: usage }, { data: rows }, { count: brands }] = await Promise.all([
    loadMarket(db),
    adminConfigured() ? motionConnected(createAdminClient()) : Promise.resolve(null),
    db.from("client_allotment_usage").select("*"),
    db.from("clients").select("id, name, slug, industry, industry_detail").is("archived_at", null).in("status", LIVE).order("name"),
    db.from("market_brands").select("id", { count: "exact", head: true }),
  ]);
  const clients: PickClient[] = ((usage ?? []) as UsageRow[])
    .map((u) => {
      const c = (rows ?? []).find((r) => r.id === u.client_id);
      return c ? { id: c.id, name: c.name, industry: c.industry, detail: c.industry_detail, allotment: toAllotment(u) } : null;
    })
    .filter((c): c is PickClient => Boolean(c))
    .sort((a, b) => a.name.localeCompare(b.name));
  const clientsBySlug = new Map((rows ?? []).map((r) => [(r as { slug?: string }).slug ?? "", clients.find((c) => c.id === r.id)]).filter(([, c]) => c) as [string, PickClient][]);
  return (
    <div className="mx-auto max-w-6xl">
      <MarketLibrary
        ads={ads}
        industries={INDUSTRY_OPTIONS}
        clients={clients}
        brands={brands ?? 0}
        connected={Boolean(connection)}
        lastSync={connection?.lastSyncAt ?? null}
        canConnect={me.isExec}
        openId={typeof sp.ad === "string" ? sp.ad : null}
        startIndustry={typeof sp.industry === "string" ? sp.industry : null}
        startClient={typeof sp.client === "string" ? (clients.find((c) => c.id === sp.client) ?? clientsBySlug.get(sp.client))?.id ?? null : null}
      />
    </div>
  );
}
