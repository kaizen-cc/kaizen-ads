"use client";

import Link from "next/link";
import { useState } from "react";
import type { MarketAd } from "@/lib/market";
import { AdCard, MarketSheet } from "../../market/market-library";

/**
 * What's live in this client's market right now (Motion): the competitors they named first, then what's proven or
 * being tested in their industry. Open one to brief this client on it, with the Motion link in the references.
 */
export function MarketPanel({ clientId, industry, label, ads }: { clientId: string; industry: string | null; label: string; ads: MarketAd[] }) {
  const [open, setOpen] = useState<MarketAd | null>(null);
  if (!ads.length) return null;
  const competitors = ads.filter((a) => a.competitorOf.includes(clientId)).length;
  return (
    <section className="grid gap-4 rounded-[12px] border border-line bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-heading text-[17px]">In the market</h2>
          <p className="mt-1 text-sm text-muted">
            Live on Meta right now{competitors ? `: ${competitors} from competitors this client named, then` : ":"} what&apos;s proven or being tested in {label.toLowerCase()}. From Motion.
          </p>
        </div>
        <Link href={`/market?client=${clientId}${industry ? `&industry=${industry}` : ""}`} className="text-xs text-muted hover:text-fg">
          See the whole market →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ads.slice(0, 8).map((a) => (
          <AdCard key={a.id} a={a} sub={a.competitorOf.includes(clientId) ? "Competitor" : (a.matchWhy ?? a.detail ?? label)} onOpen={() => setOpen(a)} />
        ))}
      </div>
      {open && <MarketSheet key={open.id} a={open} industryLabel={label} clients={[]} forClient={clientId} onClose={() => setOpen(null)} />}
    </section>
  );
}
