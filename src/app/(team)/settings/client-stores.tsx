import Link from "next/link";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Settings › Connections › Client stores: every client's Shopify, how far back its history is read, and the clients that
// sell on Shopify but aren't connected yet (their site, their Klaviyo's orders, their onboarding answers). Connecting
// happens on each client's page (Store revenue).

const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "–");

export async function ClientStores() {
  if (!adminConfigured()) return <p className="text-sm text-muted">Server key missing.</p>;
  const db = await createClient();
  const [{ data: conns }, { shopifyToConnect }] = await Promise.all([
    db.from("client_integrations").select("id, account, label, status, settings, last_synced_at, last_error, clients(name, slug)").eq("kind", "shopify").neq("status", "disconnected").order("created_at"),
    import("@/lib/shopify/store"),
  ]);
  const [todo, waiting] = await Promise.all([shopifyToConnect(db), import("@/lib/shopify/store").then((m) => m.pendingInstalls(createAdminClient()))]);
  const ready = Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div>
          <h2 className="font-heading text-[18px]">Connected stores</h2>
          <p className="mt-1 text-sm text-muted">Real store revenue for MER, reports, KPIs, the agents and case studies. Each store&apos;s whole history is read once (back to its first order), then refreshed every hour.</p>
          {!ready && <p className="mt-2 rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] text-warn">The Kaizen OS Shopify app isn&apos;t set up yet (SHOPIFY_API_KEY and SHOPIFY_API_SECRET in Vercel). Until then a store connects with a custom app token on the client&apos;s page.</p>}
        </div>
        {(conns ?? []).length ? (
          <ul className="grid gap-2">
            {(conns ?? []).map((c) => {
              const s = (c.settings ?? {}) as { backfill?: { done?: boolean; before?: string | null }; earliest?: string | null; auth?: string };
              const cl = c.clients as unknown as { name: string; slug: string } | null;
              return (
                <li key={c.id as string}>
                  <Link href={cl ? `/clients/${cl.slug}#store` : "#"} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] border border-line bg-surface px-3.5 py-2.5 text-sm hover:border-brand/50">
                    <span className={`h-2 w-2 rounded-full ${c.status === "connected" ? "bg-ok" : "bg-bad"}`} />
                    <span className="font-medium">{cl?.name ?? "?"}</span>
                    <span className="min-w-0 truncate text-[12px] text-faint">{(c.label as string | null) ?? (c.account as string)}</span>
                    <span className="ml-auto text-[12px] text-faint">{c.status === "error" ? <span className="text-bad">{String(c.last_error ?? "Failing").slice(0, 80)}</span> : s.backfill?.done ? `History from ${day(s.earliest)}` : `Reading history, back to ${day(s.backfill?.before) === "–" ? "today" : day(s.backfill?.before)}`}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-faint">No store connected yet.</p>
        )}
      </section>
      {waiting.length > 0 && (
        <section className="grid gap-3">
          <div>
            <h2 className="font-heading text-[18px]">Installed, waiting to be linked</h2>
            <p className="mt-1 text-sm text-muted">These stores installed the Kaizen OS app from Shopify&apos;s side. Link each on its client&apos;s page (Store revenue › Link to this client).</p>
          </div>
          <ul className="grid gap-2">
            {waiting.map((w) => (
              <li key={w.shop} className="flex min-h-11 flex-wrap items-center gap-x-3 rounded-[12px] border border-line bg-surface px-3.5 py-2.5 text-sm">
                <span className="font-medium">{w.name ?? w.shop}</span>
                <span className="text-[12px] text-faint">{w.shop}</span>
                <span className="ml-auto text-[12px] text-faint">{day(w.at.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="grid gap-3">
        <div>
          <h2 className="font-heading text-[18px]">On Shopify, not connected</h2>
          <p className="mt-1 text-sm text-muted">Clients whose website, Klaviyo or onboarding answers say Shopify. Each is checked weekly.</p>
        </div>
        {todo.length ? (
          <ul className="grid gap-2">
            {todo.map((t) => (
              <li key={t.clientId}>
                <Link href={`/clients/${t.slug}#store`} className="grid min-h-11 gap-0.5 rounded-[12px] border border-warn/40 bg-surface px-3.5 py-2.5 text-sm hover:border-warn">
                  <span className="flex flex-wrap items-center gap-x-3">
                    <span className="font-medium">{t.name}</span>
                    {t.shop && <span className="text-[12px] text-faint">{t.shop}</span>}
                    <span className="ml-auto text-[12px] text-brand-text">Connect →</span>
                  </span>
                  <span className="text-[12px] text-muted">{t.evidence.join(" · ")}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">None found so far (clients are checked a few at a time).</p>
        )}
      </section>
    </div>
  );
}
