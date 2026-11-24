"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { StoreOverview } from "@/lib/shopify/store";
import { connectStore } from "./integrations-actions";
import { readStoreNow, setKaizenStart } from "./store-actions";

// The client's real store on their page: Shopify's revenue over the last 30 days against the 30 before, orders, AOV,
// new customers and MER (store revenue over every ad dollar on Meta, Google and TikTok), the last 90 days by day, 13
// months, and before and after they started with Kaizen. Not connected: why we think they're on Shopify, and the
// connect (the Kaizen OS app, or a custom app token where the app can't be installed).

export type StoreSplit = { pivot: string; source: string | null; beforePerMonth: number; afterPerMonth: number; growthPct: number | null; beforeMer: number | null; afterMer: number | null; beforeDays: number; afterDays: number; note: string | null } | null;

const money = (n: number | null | undefined, cur = "USD") => (n == null ? "–" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 }).format(n));
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function Delta({ now, before, invert = false }: { now: number; before: number; invert?: boolean }) {
  const d = pct(now, before);
  if (d == null) return null;
  const good = invert ? d <= 0 : d >= 0;
  return <p className={`mt-0.5 text-[11.5px] ${good ? "text-ok" : "text-bad"}`}>{d >= 0 ? "▲" : "▼"} {Math.abs(d)}% vs the 30 days before</p>;
}

/** 90 days of store revenue as bars, ad spend as a line over them */
function Trend({ days, cur }: { days: StoreOverview["days"]; cur: string }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.revenue, d.spend)));
  const w = 100 / Math.max(1, days.length);
  const line = days.map((d, i) => `${(i + 0.5) * w},${100 - (d.spend / max) * 96}`).join(" ");
  const total = days.reduce((t, d) => t + d.revenue, 0);
  return (
    <figure className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-brand" /> Store revenue by day
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-warn" /> Ad spend
        </span>
        <span className="ml-auto tabular">{money(total, cur)} in 90 days</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-28 w-full md:h-36" role="img" aria-label="Store revenue and ad spend over the last 90 days">
        {days.map((d, i) => (
          <rect key={d.date} x={i * w + w * 0.12} width={w * 0.76} y={100 - (d.revenue / max) * 96} height={(d.revenue / max) * 96} className="fill-brand/70">
            <title>{`${dayName(d.date)}: ${money(d.revenue, cur)} revenue, ${money(d.spend, cur)} ad spend`}</title>
          </rect>
        ))}
        {days.some((d) => d.spend > 0) && <polyline points={line} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={1.5} className="stroke-warn" />}
      </svg>
      <div className="flex justify-between text-[10.5px] text-faint">
        <span>{days[0] ? dayName(days[0].date) : ""}</span>
        <span>{days.at(-1) ? dayName(days.at(-1)!.date) : ""}</span>
      </div>
    </figure>
  );
}

/** 13 months of revenue, with MER under each month that had ad spend */
function Months({ months, cur, pivot }: { months: StoreOverview["months"]; cur: string; pivot: string | null }) {
  const max = Math.max(1, ...months.map((m) => m.revenue));
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Month by month</p>
      <div className="grid grid-flow-col auto-cols-fr items-end gap-1" style={{ height: 112 }}>
        {months.map((m) => (
          <div key={m.month} className="flex h-full flex-col justify-end" title={`${monthName(m.month)} ${m.month.slice(0, 4)}: ${money(m.revenue, cur)}${m.mer != null ? `, MER ${m.mer}x` : ""}`}>
            <div className={`w-full rounded-t-[3px] ${pivot && m.month >= pivot.slice(0, 7) ? "bg-brand" : "bg-muted/40"}`} style={{ height: `${Math.max(2, (m.revenue / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="grid grid-flow-col auto-cols-fr gap-1 text-center text-[10px] text-faint">
        {months.map((m) => (
          <span key={m.month} className="min-w-0 truncate">
            {monthName(m.month)}
            {m.mer != null && <span className="block tabular text-muted max-sm:hidden">{m.mer}x</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

export function StorePanel({ clientId, overview, split, hint, canEdit, suggest, appReady }: { clientId: string; overview: StoreOverview | null; split: StoreSplit; hint: { shop: string | null; evidence: string[] } | null; canEdit: boolean; /** Shown even with no hint: an ecommerce client */ suggest: boolean; /** The Kaizen OS Shopify app's keys are set */ appReady: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const flash = sp.get("shopify");
  const [shop, setShop] = useState(hint?.shop ?? "");
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [useToken, setUseToken] = useState(false);
  const [error, setError] = useState<string | null>(flash === "error" ? `Shopify didn't connect${sp.get("reason") ? `: ${sp.get("reason")}` : ""}.` : null);
  const [pending, start] = useTransition();
  const [startDate, setStartDate] = useState(overview?.start.source === "set" ? (overview.start.date ?? "") : "");
  if (!overview && !hint && !suggest) return null;
  const cur = overview?.currency ?? "USD";
  const l = overview?.last30;
  const p = overview?.prior30;

  const tokenForm = (
    <div className="grid gap-2">
      <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={useToken ? "The app's client ID" : "Admin API access token (shpat_…)"} className="h-11 rounded-[10px] border border-line bg-surface px-3 text-base outline-none focus:border-brand-text/60 md:text-sm" />
      {useToken && <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="The app's client secret" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-base outline-none focus:border-brand-text/60 md:text-sm" />}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await connectStore(clientId, { kind: "shopify", account: shop, secret: token, secret2: useToken ? secret : "" });
            if (!r.ok) return setError(r.error);
            setError(null);
            setToken("");
            setSecret("");
            router.refresh();
          })
        }
        className="h-11 justify-self-start rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50 md:h-9"
      >
        {pending ? "Checking…" : "Check and connect"}
      </button>
    </div>
  );

  const connect = (
    <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-4">
      <label className="grid gap-1.5 text-[13px] text-muted">
        Store address
        <input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="theirstore.myshopify.com" autoCapitalize="none" autoComplete="off" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-base text-fg outline-none focus:border-brand-text/60 md:text-sm" />
      </label>
      {!useToken ? (
        <>
          <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Through our collaborator access (best)</p>
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            <li>
              Open the store from Shopify Partners › Stores. Our collaborator access needs the permissions <b className="text-fg">Manage and install apps and channels</b> and <b className="text-fg">Enable development</b>; if they&apos;re missing, ask the client to add them (Settings › Users › our collaborator account).
            </li>
            <li>Settings › Apps and sales channels › Develop apps › Create an app named &quot;Kaizen OS&quot;.</li>
            <li>
              Configure Admin API scopes: tick <b className="text-fg">read_orders</b>, <b className="text-fg">read_all_orders</b>, <b className="text-fg">read_products</b> and <b className="text-fg">read_customers</b>. Save, Install app, then reveal the Admin API access token (shown once) and paste it here.
            </li>
          </ol>
          {tokenForm}
          <div className="grid gap-1 border-t border-line pt-3 text-[12.5px] text-muted">
            <span>Shopify won&apos;t let us make an app in that store?</span>
            <div className="flex flex-wrap gap-x-4">
              <button type="button" onClick={() => setUseToken(true)} className="min-h-11 text-left text-brand-text hover:underline md:min-h-0">
                The store owner makes it (client ID and secret)
              </button>
              {appReady && (
                <a
                  href={shop.trim() ? `/api/shopify/install?client=${clientId}&shop=${encodeURIComponent(shop.trim())}` : undefined}
                  onClick={(e) => {
                    if (!shop.trim()) {
                      e.preventDefault();
                      setError("Add the store address first.");
                    }
                  }}
                  className="inline-flex min-h-11 items-center text-brand-text hover:underline md:min-h-0"
                >
                  Install the Kaizen OS app
                </a>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            <li>The store owner opens dev.shopify.com › Apps › Create app, named &quot;Kaizen OS&quot;, with the scopes read_orders, read_all_orders, read_products and read_customers, and installs it on their store.</li>
            <li>They send us its client ID and client secret (the app&apos;s Settings). Kaizen OS gets fresh read-only tokens from them as needed.</li>
          </ol>
          {tokenForm}
          <button type="button" onClick={() => setUseToken(false)} className="h-11 justify-self-start px-1 text-[13px] text-muted hover:text-fg md:h-auto">
            ← Back to the collaborator way
          </button>
        </>
      )}
      <p className="text-[11.5px] text-faint">Read only. Keys are checked, encrypted and never shown again; never ask a client to paste one in a chat.</p>
    </div>
  );

  return (
    <section id="store" className="grid scroll-mt-24 gap-5 rounded-[12px] border border-line bg-surface p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[17px]">Store revenue</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">What their Shopify store actually sold, not what the ad platforms claim. MER is store revenue over every ad dollar (Meta, Google, TikTok).</p>
        </div>
      </div>
      {flash === "connected" && <p className="rounded-[10px] bg-ok-soft px-3 py-2 text-[13px] text-ok">Shopify connected. Its full history is being read now; the numbers fill in over the next few minutes.</p>}
      {error && <p className="rounded-[10px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}

      {!overview && (
        <>
          {hint?.evidence.length ? (
            <div className="rounded-[12px] border border-warn/40 bg-warn-soft p-3.5 text-[13px]">
              <p className="font-medium text-warn">On Shopify, not connected</p>
              <ul className="mt-1 grid gap-0.5 text-muted">
                {hint.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-faint">No store connected yet.</p>
          )}
          {canEdit ? connect : <p className="text-[12.5px] text-faint">An exec or team lead connects it (or the client, from their onboarding guide).</p>}
        </>
      )}

      {overview && l && p && (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            {[
              ["Revenue, 30 days", money(l.revenue, cur), <Delta key="d" now={l.revenue} before={p.revenue} />],
              ["Orders", l.orders.toLocaleString("en-US"), <Delta key="d" now={l.orders} before={p.orders} />],
              ["AOV", money(l.aov, cur), l.aov != null && p.aov != null ? <Delta key="d" now={l.aov} before={p.aov} /> : null],
              ["New customers", l.newCustomers.toLocaleString("en-US"), <Delta key="d" now={l.newCustomers} before={p.newCustomers} />],
              ["MER", l.mer != null ? `${l.mer}x` : "–", <p key="d" className="mt-0.5 text-[11.5px] text-faint">{l.adSpend ? `${money(l.adSpend, cur)} ad spend` : "No ad spend read"}</p>],
            ].map(([k, v, d], i) => (
              <div key={k as string} className={`rounded-[12px] border border-line bg-bg p-3.5 ${i === 4 ? "col-span-2 md:col-span-1" : ""}`}>
                <p className="text-[11px] uppercase tracking-[0.1em] text-faint">{k}</p>
                <p className="tabular mt-1 font-heading text-[20px] leading-tight">{v}</p>
                {d}
              </div>
            ))}
          </div>

          <Trend days={overview.days} cur={cur} />
          {overview.months.length > 1 && <Months months={overview.months} cur={cur} pivot={overview.start.date} />}

          <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Before and after Kaizen</p>
              {canEdit ? (
                <label className="ml-auto flex items-center gap-2 text-[12.5px] text-muted">
                  Started with Kaizen
                  <input
                    type="date"
                    value={startDate || overview.start.date || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setStartDate(v);
                      start(async () => {
                        const r = await setKaizenStart(clientId, v || null);
                        if (!r.ok) setError(r.error);
                        else router.refresh();
                      });
                    }}
                    className="h-11 rounded-[10px] border border-line bg-surface px-2 text-base text-fg md:h-9 md:text-sm"
                  />
                </label>
              ) : (
                overview.start.date && <span className="ml-auto text-[12.5px] text-muted">Started {dayName(overview.start.date)}</span>
              )}
            </div>
            {split ? (
              <div className="grid gap-1.5">
                <p className="text-[14.5px] leading-relaxed">
                  <span className="tabular font-heading text-[20px]">{money(split.beforePerMonth, cur)}</span>
                  <span className="text-muted"> a month before → </span>
                  <span className="tabular font-heading text-[20px]">{money(split.afterPerMonth, cur)}</span>
                  <span className="text-muted"> a month since</span>
                  {split.growthPct != null && <span className={`ml-2 text-[13px] ${split.growthPct >= 0 ? "text-ok" : "text-bad"}`}>{split.growthPct >= 0 ? "+" : ""}{split.growthPct}%</span>}
                </p>
                <p className="text-[12px] text-faint">
                  {split.beforeDays} days each side around {dayName(split.pivot)}
                  {split.source === "first spend" ? " (their first ad spend we have; set the real start above)" : ""}. MER {split.beforeMer != null ? `${split.beforeMer}x` : "–"} before, {split.afterMer != null ? `${split.afterMer}x` : "–"} after.
                  {split.note ? ` ${split.note}` : ""}
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-faint">Set when they started with Kaizen to see before against after.</p>
            )}
          </div>

          <ul className="grid gap-2">
            {overview.connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-line px-3.5 py-2.5 text-sm">
                <span className={`h-2 w-2 rounded-full ${c.status === "connected" ? "bg-ok" : "bg-bad"}`} />
                <span className="font-medium">{c.name ?? c.shop}</span>
                <span className="min-w-0 truncate text-[12px] text-faint">{c.shop}{c.auth === "token" ? " · custom app token" : ""}</span>
                <span className="ml-auto text-[12px] text-faint">
                  {c.status === "error" ? <span className="text-bad">{c.lastError?.slice(0, 90) ?? "Failing"}</span> : !c.historyDone ? `Reading history… back to ${c.historyFrom ? dayName(c.historyFrom) : "today"}` : `History from ${c.historyFrom ? dayName(c.historyFrom) : "–"}${c.lastSyncedAt ? ` · read ${ago(c.lastSyncedAt)}` : ""}`}
                  {!c.allOrders && " · 60 days only (no read_all_orders)"}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await readStoreNow(clientId, c.id);
                      setError(r.ok ? null : r.error);
                      router.refresh();
                    })
                  }
                  className="h-11 text-[12px] text-brand-text hover:underline disabled:opacity-50 md:h-auto"
                >
                  {pending ? "Reading…" : "Read now"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
