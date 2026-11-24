import Link from "next/link";
import type { Staff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { loadWidget, myWidgets, type WidgetData } from "@/lib/widgets";
import { gallery, WIDGETS } from "@/lib/widgets-core";
import { WidgetGallery } from "./widget-gallery";

// The person's own widgets under their blocks (owner, Nov 24 2026), in their order, with "Add widget". Each widget
// reads its own numbers (src/lib/widgets.ts); one that fails says so and the rest still show.

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export async function OverviewWidgets({ me }: { me: Staff }) {
  if (!adminConfigured() || me.viewAs) return null;
  const admin = createAdminClient();
  const ids = await myWidgets(admin, me);
  const data = await Promise.all(ids.map((id) => loadWidget(admin, me, id).catch(() => null)));
  return (
    <section className="grid gap-3" aria-label="Your widgets">
      {ids.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ids.map((id, i) => (
            <article key={id} className="grid min-w-0 content-start gap-3 rounded-[22px] border border-line bg-surface p-4 md:p-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{WIDGETS.find((w) => w.id === id)?.title}</h3>
              {data[i] ? <Body d={data[i]!} /> : <p className="text-[13px] text-muted">Couldn&apos;t read this one right now.</p>}
            </article>
          ))}
        </div>
      )}
      <WidgetGallery groups={gallery(me)} chosen={ids} />
    </section>
  );
}

const Big = ({ n, label }: { n: string; label: string }) => (
  <p className="flex flex-wrap items-baseline gap-x-2">
    <span className="tabular font-display text-4xl leading-none tracking-tight text-fg">{n}</span>
    <span className="text-[13px] text-muted">{label}</span>
  </p>
);

const Rows = ({ rows }: { rows: { left: React.ReactNode; right: string; tone?: string }[] }) => (
  <ul className="grid gap-1">
    {rows.map((r, i) => (
      <li key={i} className="flex min-w-0 items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 truncate text-fg">{r.left}</span>
        <span className={`tabular shrink-0 ${r.tone ?? "text-muted"}`}>{r.right}</span>
      </li>
    ))}
  </ul>
);

const Empty = ({ text }: { text: string }) => <p className="text-[13px] text-muted">{text}</p>;

function Body({ d }: { d: WidgetData }) {
  switch (d.id) {
    case "mrr":
      return d.total ? (
        <>
          <Big n={usd(d.total)} label={`a month across ${d.clients} clients`} />
          <Rows rows={d.lines.map(([l, n]) => ({ left: l, right: usd(n) }))} />
        </>
      ) : (
        <Empty text="No billed services synced yet." />
      );
    case "projection":
      return (
        <>
          <Big n={usd(d.month)} label="still to bill this month" />
          <Rows rows={[{ left: "To quarter end", right: usd(d.quarter) }, { left: "Monthly revenue", right: usd(d.mrr) }, { left: "At risk (clients who may leave)", right: d.atRisk ? `−${usd(d.atRisk)}` : "$0", tone: d.atRisk ? "text-bad" : undefined }]} />
        </>
      );
    case "pipeline":
      return d.total ? (
        <>
          <Big n={String(d.total)} label={`prospects · ${d.wonThisMonth} won this month`} />
          <Rows rows={d.stages.map(([s, n]) => ({ left: s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), right: String(n) }))} />
        </>
      ) : (
        <Empty text="No prospects yet. Add them in Sales." />
      );
    case "clients-risk":
      return (
        <>
          <Big n={String(d.live)} label={`live clients · ${d.atRisk.length} at risk`} />
          {d.atRisk.length ? <Rows rows={d.atRisk.slice(0, 6).map((c) => ({ left: <Link href={`/clients/${c.slug}`} className="hover:underline">{c.name}</Link>, right: "at risk", tone: "text-bad" }))} /> : <Empty text="Nobody flagged as likely to leave." />}
        </>
      );
    case "spend":
      return d.total ? (
        <>
          <Big n={usd(d.total)} label={`last 30 days · ${d.accounts} accounts`} />
          <Rows rows={d.top.map((c) => ({ left: <Link href={`/clients/${c.slug}`} className="hover:underline">{c.name}</Link>, right: usd(c.spend) }))} />
        </>
      ) : (
        <Empty text="No spend read in the last 30 days." />
      );
    case "team-load":
      return d.people.length ? <Rows rows={d.people.map((p) => ({ left: p.name, right: `${p.asks} asked${p.stuck ? ` · ${p.stuck} stuck` : ""}`, tone: p.stuck ? "text-bad" : undefined }))} /> : <Empty text="Nothing open on the team." />;
    case "my-targets":
      return d.rows.length ? <Rows rows={d.rows.map((r) => ({ left: <Link href={`/clients/${r.slug}`} className="hover:underline">{`${r.name}${r.label ? ` · ${r.label}` : ""}`}</Link>, right: r.status === "off" ? "off target" : r.status === "close" ? "close" : r.status === "on" ? "on target" : r.status, tone: r.status === "off" ? "text-bad" : r.status === "on" ? "text-ok" : undefined }))} /> : <Empty text="No targets set for your clients yet." />;
    case "my-load":
      return (
        <>
          <Big n={String(d.open)} label={`open · ${d.overdue} overdue`} />
          {d.from.length ? <Rows rows={d.from.map(([w, n]) => ({ left: w === "You" ? "Saved by you" : `From ${w}`, right: String(n) }))} /> : <Empty text="Nothing asked of you." />}
        </>
      );
  }
}
