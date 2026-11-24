"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { storeStrip, type StoreStrip as Strip } from "./store-strip-actions";

// Their real store under an ad account's numbers: Shopify revenue, orders and MER, last 30 days against the 30 before.
// Nothing shows for a client without a connected store.

const money = (n: number, cur: string | null) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n);

export function StoreStrip({ clientId }: { clientId: string }) {
  const [s, setS] = useState<Strip | undefined>(undefined);
  useEffect(() => {
    let live = true;
    storeStrip(clientId)
      .then((r) => live && setS(r))
      .catch(() => live && setS(null));
    return () => {
      live = false;
    };
  }, [clientId]);
  if (!s) return null;
  const d = s.prior ? Math.round(((s.revenue - s.prior) / s.prior) * 100) : null;
  return (
    <Link href={`/clients/${s.slug}#store`} className="grid gap-2 rounded-[14px] border border-line bg-surface px-3.5 py-3 hover:border-brand/50 sm:grid-cols-[auto_1fr_1fr_1fr] sm:items-center sm:gap-5 md:px-4">
      <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Their store, 30 days</span>
      <span className="grid gap-0.5">
        <span className="tabular font-heading text-[17px]">{money(s.revenue, s.currency)}</span>
        <span className={`text-[11.5px] ${d == null ? "text-faint" : d >= 0 ? "text-ok" : "text-bad"}`}>{d == null ? "Shopify revenue" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}% vs the 30 before`}</span>
      </span>
      <span className="grid gap-0.5">
        <span className="tabular font-heading text-[17px]">{s.orders.toLocaleString("en-US")}</span>
        <span className="text-[11.5px] text-faint">store orders</span>
      </span>
      <span className="grid gap-0.5">
        <span className="tabular font-heading text-[17px]">{s.mer != null ? `${s.mer}x` : "–"}</span>
        <span className="text-[11.5px] text-faint">MER{s.priorMer != null ? ` (${s.priorMer}x before)` : ""} · {money(s.adSpend, s.currency)} all ad spend</span>
      </span>
    </Link>
  );
}
