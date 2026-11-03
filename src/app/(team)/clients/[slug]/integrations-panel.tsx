"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BusinessSummary, IntegrationKind } from "@/lib/integrations";
import { connectStore, disconnectStore, syncStoreNow } from "./integrations-actions";

// Their store and CRM on the client page: what it says (real new customers, subscriptions, leads booked, won and lost,
// and how many came from Meta or Google), and the team connecting it with a key made for us. Keys are never shown again.

export type Connection = { id: string; kind: IntegrationKind; account: string; label: string | null; status: string; lastSyncedAt: string | null; lastError: string | null };

const NAMES: Record<IntegrationKind, string> = { shopify: "Shopify", woocommerce: "WooCommerce", gohighlevel: "GoHighLevel", hubspot: "HubSpot", other: "Other CRM" };

const HOW: Record<IntegrationKind, { account: string; secret: string; secret2?: string; steps: string[] }> = {
  shopify: {
    account: "Store address (the .myshopify.com one)",
    secret: "Admin API access token",
    steps: [
      "Once our collaborator access is accepted, open the store's admin: Settings › Apps and sales channels › Develop apps.",
      "Create an app named \"Kaizen Ads\", then Configure Admin API scopes: read_orders and read_customers (read_all_orders too, to read further back than 60 days).",
      "Install the app and reveal the Admin API access token (Shopify shows it once). Paste it here.",
    ],
  },
  woocommerce: {
    account: "Site address",
    secret: "Consumer key",
    secret2: "Consumer secret",
    steps: ["In WordPress: WooCommerce › Settings › Advanced › REST API › Add key.", "Description \"Kaizen Ads\", user: our tech account, permissions Read. Generate, then paste the consumer key and secret here."],
  },
  gohighlevel: {
    account: "Location ID (the sub-account)",
    secret: "Private integration token",
    steps: [
      "Every GoHighLevel account we manage needs its own token: one per sub-account (location).",
      "In the client's sub-account: Settings › Private Integrations › Create new integration, named \"Kaizen Ads\", with read access to contacts, opportunities and locations.",
      "Copy the token (shown once). The location ID is in Settings › Business Profile, or in the address bar after /location/.",
    ],
  },
  hubspot: {
    account: "Account name (optional)",
    secret: "Private app access token",
    steps: ["In HubSpot: Settings › Integrations › Private Apps › Create a private app named \"Kaizen Ads\".", "Scopes: crm.objects.contacts.read and crm.objects.deals.read. Create it and paste the access token."],
  },
  other: { account: "Which CRM (name)", secret: "", steps: ["We can't read this one yet: it's kept on the page so the team and the agents know where their leads live, and it's covered on a call."] },
};

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const money = (x: number) => `$${n(x)}`;
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function IntegrationsPanel({ clientId, connections, summary, suggest }: { clientId: string; connections: Connection[]; summary: BusinessSummary | null; /** What fits this business first: a store platform or a CRM */ suggest: IntegrationKind }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<IntegrationKind>(suggest);
  const [account, setAccount] = useState("");
  const [secret, setSecret] = useState("");
  const [secret2, setSecret2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const live = connections.filter((c) => c.status !== "disconnected");
  const how = HOW[kind];
  const m = summary?.month;
  const l30 = summary?.last30;
  const p30 = summary?.prior30;
  const delta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);

  return (
    <section className="grid gap-5 rounded-[12px] border border-line bg-surface p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[17px]">Their store and CRM</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">The real customers and leads, from their own systems, not the ad platforms. Audits, reports and the Brand Bible judge what works by this.</p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="h-11 shrink-0 rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
            + Connect
          </button>
        )}
      </div>

      {summary && m && l30 && p30 && (
        <div className="grid gap-3">
          {summary.store && (
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              {[
                ["New customers this month", n(m.newCustomers), delta(l30.newCustomers, p30.newCustomers)],
                ["Subscriptions started", n(m.subscriptions), delta(l30.subscriptions, p30.subscriptions)],
                ["Revenue this month", money(m.revenue), delta(l30.revenue, p30.revenue)],
                ["From paid ads (30 days)", `${n(l30.fromMeta)} Meta · ${n(l30.fromGoogle)} Google`, null],
              ].map(([k, v, d]) => (
                <div key={k as string} className="rounded-[12px] border border-line bg-bg p-3.5">
                  <p className="text-[11px] uppercase tracking-[0.1em] text-faint">{k}</p>
                  <p className="tabular mt-1 font-heading text-[20px] leading-tight">{v}</p>
                  {typeof d === "number" && <p className={`mt-0.5 text-[11.5px] ${d >= 0 ? "text-ok" : "text-bad"}`}>{d >= 0 ? "▲" : "▼"} {Math.abs(d)}% vs the 30 days before</p>}
                </div>
              ))}
            </div>
          )}
          {summary.crm && (
            <div className="rounded-[12px] border border-line bg-bg p-4">
              <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Lead funnel, last 30 days</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Leads", l30.leads, `${n(l30.fromMeta)} Meta · ${n(l30.fromGoogle)} Google`],
                  ["Booked", l30.booked, l30.leads ? `${Math.round((l30.booked / l30.leads) * 100)}% of leads` : ""],
                  ["Won", l30.won, l30.wonValue ? money(l30.wonValue) : ""],
                  ["Lost", l30.lost, ""],
                ].map(([k, v, sub]) => (
                  <div key={k as string} className="grid gap-0.5">
                    <span className="tabular font-heading text-[22px] leading-none">{n(v as number)}</span>
                    <span className="text-[12px] text-muted">{k}</span>
                    {sub && <span className="text-[11px] text-faint">{sub}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {live.length > 0 && (
        <ul className="grid gap-2">
          {live.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-line px-3.5 py-2.5 text-sm">
              <span className={`h-2 w-2 rounded-full ${c.status === "connected" ? "bg-ok" : c.status === "error" ? "bg-bad" : "bg-warn"}`} />
              <span className="font-medium">{NAMES[c.kind]}</span>
              <span className="min-w-0 truncate text-muted">{c.label ?? c.account}</span>
              <span className="ml-auto text-[12px] text-faint">{c.status === "error" ? <span className="text-bad">{c.lastError?.slice(0, 80) ?? "Failing"}</span> : c.status === "pending" ? "Noted, not read" : c.lastSyncedAt ? `Read ${ago(c.lastSyncedAt)}` : "Reading…"}</span>
              {c.kind !== "other" && (
                <button type="button" disabled={pending} onClick={() => start(async () => { const r = await syncStoreNow(clientId, c.id); setError(r.ok ? null : r.error); router.refresh(); })} className="text-[12px] text-brand-text hover:underline disabled:opacity-50">
                  Read now
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!confirm(`Disconnect ${NAMES[c.kind]}? Its key is deleted; what was read stays.`)) return;
                  start(async () => {
                    await disconnectStore(clientId, c.id);
                    router.refresh();
                  });
                }}
                className="text-[12px] text-faint hover:text-bad"
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}

      {!live.length && !adding && <p className="text-sm text-faint">Nothing connected yet. Stores connect Shopify or WooCommerce; lead businesses connect their CRM (GoHighLevel, HubSpot).</p>}

      {adding && (
        <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-4">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(NAMES) as IntegrationKind[]).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={`h-9 rounded-full border px-3.5 text-[13px] ${kind === k ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:text-fg"}`}>
                {NAMES[k]}
              </button>
            ))}
          </div>
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            {how.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={how.account} className="h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60" />
          {how.secret && <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={how.secret} className="h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60" />}
          {how.secret2 && <input type="password" autoComplete="off" value={secret2} onChange={(e) => setSecret2(e.target.value)} placeholder={how.secret2} className="h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60" />}
          <p className="text-[11.5px] text-faint">The key is checked, encrypted and never shown again. Only the team enters keys; never ask a client to paste one in a chat.</p>
          {error && <p className="text-[12.5px] text-bad">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await connectStore(clientId, { kind, account, secret, secret2 });
                  if (!r.ok) return setError(r.error);
                  setError(null);
                  setAdding(false);
                  setAccount("");
                  setSecret("");
                  setSecret2("");
                  router.refresh();
                })
              }
              className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50 md:h-9"
            >
              {pending ? "Checking…" : kind === "other" ? "Save" : "Check and connect"}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="h-11 rounded-full px-4 text-sm text-muted hover:text-fg md:h-9">
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
