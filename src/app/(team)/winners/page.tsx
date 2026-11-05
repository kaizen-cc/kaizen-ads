import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { INDUSTRY_OPTIONS } from "@/lib/industries";
import { allWinners, loadPeerContext, type WinnerScope } from "@/lib/industry";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toAllotment, type UsageRow } from "@/lib/allotment";
import { WinnersLibrary, type PickClient } from "./winners-library";
import { LIVE } from "@/lib/live";
import { filterByFormat, formatsFor } from "@/lib/creative-formats";

export const metadata: Metadata = { title: "Winners" };

// A brief someone chooses from its quick preview is written right after the answer (in the background), on this route
export const maxDuration = 300;

export default async function Winners() {
  const me = await requireStaff();
  // Every account's numbers, whoever is looking: the point is learning from clients you don't work on
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const scope: WinnerScope = { accounts: 0, ads: 0, eligible: 0, withoutData: 0 };
  const [winners, { data: usage }, { data: rows }, match] = await Promise.all([
    allWinners(db, scope),
    db.from("client_allotment_usage").select("*"),
    db.from("clients").select("id, name, industry, industry_detail").is("archived_at", null).in("status", LIVE).order("name"),
    loadPeerContext(db),
  ]);
  // Who a request can be made for: clients with a creative package, and what's left of their month
  const clients: PickClient[] = ((usage ?? []) as UsageRow[])
    .map((u) => {
      const c = (rows ?? []).find((r) => r.id === u.client_id);
      return c ? { id: c.id, name: c.name, industry: c.industry, detail: c.industry_detail, allotment: toAllotment(u) } : null;
    })
    .filter((c): c is PickClient => Boolean(c))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="mx-auto max-w-6xl">
      <WinnersLibrary winners={filterByFormat(winners, formatsFor(me), (w) => w.format)} industries={INDUSTRY_OPTIONS} clients={clients} scope={scope} match={match} />
    </div>
  );
}
