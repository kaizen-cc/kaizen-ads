import Link from "next/link";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { integrationHealth } from "@/lib/integration-health/load";
import { isProblem, type Health } from "@/lib/integration-health/core";

// Connection health: on Sync health, every client with a connection that's disconnected, erroring or stale (Meta,
// Google, TikTok, Klaviyo and the other email platforms, Shopify, CRMs like GoHighLevel, Motion); on a client's page,
// each of its connections. The same reading the afternoon-before-a-call check uses (src/lib/integration-health).

const TONE: Record<Health["state"], string> = { ok: "bg-ok-soft text-ok", stale: "bg-warn-soft text-warn", error: "bg-bad-soft text-bad", disconnected: "bg-bad-soft text-bad" };
const WORD: Record<Health["state"], string> = { ok: "OK", stale: "Stale", error: "Error", disconnected: "Disconnected" };

function Row({ h }: { h: Health }) {
  return (
    <li className="flex min-w-0 items-start justify-between gap-3 py-2 text-[13px]">
      <span className="min-w-0 break-words">{h.detail}</span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${TONE[h.state]}`}>{WORD[h.state]}</span>
    </li>
  );
}

/** Sync health: every client with a connection problem, worst first */
export async function ClientConnectionsHealth() {
  if (!adminConfigured()) return null;
  const all = await integrationHealth(createAdminClient()).catch(() => []);
  const bad = all.map((c) => ({ ...c, items: c.items.filter(isProblem) })).filter((c) => c.items.length);
  const rank = (c: (typeof bad)[number]) => (c.items.some((i) => i.state === "disconnected" || i.state === "error") ? 0 : 1);
  bad.sort((a, b) => rank(a) - rank(b) || a.client.localeCompare(b.client));
  return (
    <section className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="grid gap-1">
        <h2 className="font-heading text-lg">Client connections</h2>
        <p className="text-[13px] text-muted">{bad.length ? `${bad.length} client${bad.length === 1 ? " has" : "s have"} a connection that's disconnected, erroring or stale. The afternoon before a client call, the people on it get these too.` : "Every client's connections are connected and fresh."}</p>
      </div>
      {bad.length > 0 && (
        <ul className="grid gap-2">
          {bad.map((c) => (
            <li key={c.clientId} className="rounded-[14px] border border-line px-3.5 py-2">
              <Link href={`/clients/${c.slug}?tab=team#connections`} className="text-[14px] font-medium hover:underline">
                {c.client}
              </Link>
              <ul className="divide-y divide-line">
                {c.items.map((h, i) => (
                  <Row key={i} h={h} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A client's page: each of its connections */
export async function ClientConnectionHealth({ clientId }: { clientId: string }) {
  if (!adminConfigured()) return null;
  const [c] = await integrationHealth(createAdminClient(), { clientIds: [clientId] }).catch(() => []);
  if (!c?.items.length) return null;
  const bad = c.items.filter(isProblem).length;
  return (
    <div id="connections" className="grid min-w-0 scroll-mt-24 gap-1">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Connection health{bad ? ` · ${bad} to fix` : ""}</p>
      <ul className="divide-y divide-line">
        {c.items.map((h, i) => (
          <Row key={i} h={h} />
        ))}
      </ul>
    </div>
  );
}
