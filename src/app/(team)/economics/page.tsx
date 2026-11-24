import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { loadEconomics, type EconRow } from "@/lib/oversight/load";

export const metadata: Metadata = { title: "Account economics" };

// Account economics, executives only: each client's fee (Stripe, through Kaizen Track), what it costs us in team hours
// (Track's time entries at each person's cost rate), paid, unpaid or overdue, failed or never-collected invoices, and
// the flags: losing money, underpriced, billed with no work done, unpaid. Never in Slack, never in anything a client
// sees. Stripe's own failed charges and uncollectible invoices light up when STRIPE_SECRET_KEY is set.

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const PAY: Record<EconRow["pay"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-ok-soft text-ok" },
  unpaid: { label: "Invoice open", cls: "bg-warn-soft text-warn" },
  overdue: { label: "Overdue", cls: "bg-bad-soft text-bad" },
  none: { label: "No fee on file", cls: "bg-bg text-muted" },
};
const FLAG: Record<string, string> = { losing: "Losing money", underpriced: "Underpriced", no_work: "Billed, no work", unpaid: "Unpaid" };

export default async function EconomicsPage() {
  const me = await requireStaff();
  if (!me.isExec) redirect("/pipeline");
  if (!adminConfigured()) return <p className="text-sm text-muted">Economics can&apos;t be read here.</p>;
  const e = await loadEconomics(createAdminClient());
  if (!e.ok)
    return (
      <div className="mx-auto grid max-w-3xl gap-4">
        <h1 className="font-heading text-[30px]">Account economics</h1>
        <p className="rounded-[18px] border border-dashed border-line p-6 text-sm text-muted">{e.setup}</p>
      </div>
    );
  const flagged = e.rows.filter((r) => r.flags.length);
  const fees = e.rows.reduce((n, r) => n + r.fee, 0);
  const cost = e.rows.reduce((n, r) => n + r.cost, 0);
  const owed = e.rows.filter((r) => r.pay === "overdue").reduce((n, r) => n + r.owed, 0);
  return (
    <div className="mx-auto grid max-w-5xl gap-6 md:gap-8">
      <header className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Account economics · executives only</p>
        <h1 className="mt-1 font-heading text-[30px] leading-tight md:text-[34px]">{flagged.length ? `${flagged.length} account${flagged.length === 1 ? "" : "s"} need a money decision` : "Every account pays its way"}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Fees from Stripe through Kaizen Track{e.trackSyncedAt ? ` (synced ${new Date(e.trackSyncedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""}, cost from the team&apos;s logged hours in the last 30 days. Never shared in Slack or with a client.
        </p>
      </header>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Monthly fees", value: usd(fees) },
          { label: "Team cost, 30 days", value: usd(cost) },
          { label: "Margin", value: usd(fees - cost) },
          { label: "Overdue", value: usd(owed) },
        ].map((s) => (
          <div key={s.label} className="grid gap-1 rounded-[18px] border border-line bg-surface p-4">
            <span className="text-[11px] text-muted">{s.label}</span>
            <span className="tabular font-heading text-[22px] leading-none">{s.value}</span>
          </div>
        ))}
      </section>
      {!e.stripeDirect && (
        <p className="rounded-[14px] border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {e.stripeError ? `Stripe answered with an error: ${e.stripeError}.` : "Failed charges and never-collected invoices appear once a restricted, read-only Stripe key is added in Vercel as STRIPE_SECRET_KEY. Until then, unpaid and overdue come from Track's Stripe mirror."}
        </p>
      )}
      {e.unmatched > 0 && <p className="text-[12.5px] text-muted">{e.unmatched} Stripe subscription{e.unmatched === 1 ? " isn't" : "s aren't"} matched to a live client in Track, so not counted here.</p>}
      <ul className="grid gap-3">
        {e.rows.map((r) => (
          <li key={r.clientId} className="relative grid gap-3 overflow-hidden rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)] md:items-center md:p-5">
            <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${r.flags.some((f) => f.kind === "losing" || f.kind === "unpaid") ? "bg-bad" : r.flags.length ? "bg-warn" : "bg-ok"}`} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/clients/${r.slug}`} className="truncate font-heading text-[18px] leading-tight hover:underline">
                  {r.client}
                </Link>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${PAY[r.pay].cls}`}>{PAY[r.pay].label}</span>
              </div>
              {r.flags.length > 0 && (
                <ul className="mt-1.5 grid gap-1">
                  {r.flags.map((f, i) => (
                    <li key={i} className="text-[13px]">
                      <span className="font-medium">{FLAG[f.kind]}:</span> <span className="text-muted">{f.text}</span> <span className="text-[11px] text-faint">({f.confidence})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-4 text-[13px] sm:grid-cols-4">
              {[
                { l: "Fee / mo", v: usd(r.fee) },
                { l: "Hours 30d", v: Math.round(r.hours).toString() },
                { l: "Cost 30d", v: usd(r.cost) },
                { l: "Margin", v: usd(r.margin), bad: r.margin < 0 },
              ].map((x) => (
                <div key={x.l} className="grid gap-0.5">
                  <span className={`tabular font-heading text-[17px] leading-none ${x.bad ? "text-bad" : ""}`}>{x.v}</span>
                  <span className="text-[11px] text-muted">{x.l}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
