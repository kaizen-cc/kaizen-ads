import Link from "next/link";
import { HideForMe } from "./hide-for-me";

// Building blocks shared by every role's home.

export type Tone = "ok" | "warn" | "bad" | "muted" | "brand";
export const DOT: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", muted: "bg-faint", brand: "bg-brand" };
export const TXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", muted: "text-faint", brand: "text-brand-text" };
export const SOFT: Record<Tone, string> = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", muted: "bg-surface-2 text-muted", brand: "bg-brand-soft text-brand-text" };

// Five phases instead of ten columns. Each groups the detailed stages the app tracks.
export const PHASES = [
  { key: "brief", name: "Brief", owner: "Requester → creative" },
  { key: "make", name: "Make", owner: "Designers & editors" },
  { key: "review", name: "Review", owner: "Head of Creative · Copywriter" },
  { key: "client", name: "Client", owner: "Customer success · clients" },
  { key: "launch", name: "Launch", owner: "Media buyers" },
] as const;
export type PhaseKey = (typeof PHASES)[number]["key"];
export type PhaseStat = { count: number; avgDays?: number; slaDays?: number };

export function PageHeader({
  today,
  title,
  subtitle,
  action,
}: {
  today: string;
  title: string;
  subtitle: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{today}</p>
        <h1 className="mt-2 font-heading text-3xl md:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

export function PrimaryAction({ label, disabled, href }: { label: string; disabled?: boolean; href?: string }) {
  const cls =
    "flex h-11 w-full items-center justify-center gap-2 rounded-brand bg-brand px-5 text-sm font-medium text-white md:w-auto md:justify-start shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition hover:bg-brand-hover";
  if (disabled || !href) {
    return (
      <button disabled className={`${cls} opacity-60 shadow-none`} title="Opens in the next build phase">
        <span className="text-lg leading-none">+</span> {label}
        <span className="rounded-full bg-ink/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>
      </button>
    );
  }
  return (
    <Link href={href} className={cls}>
      <span className="text-lg leading-none">+</span> {label}
    </Link>
  );
}

export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-heading text-xl">{children}</h2>
      {aside && <span className="text-xs text-faint">{aside}</span>}
    </div>
  );
}

/** A row of big numbers. */
export function Stats({ items }: { items: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone }[] }) {
  return (
    <section className={`grid grid-cols-2 gap-px overflow-hidden rounded-brand border border-line bg-line ${items.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
      {items.map((s) => (
        <div key={s.label} className="grid min-w-0 content-start gap-1 bg-surface p-4 md:p-5">
          <div className="flex items-center gap-2">
            {s.tone && <span className={`h-1.5 w-1.5 rounded-full ${DOT[s.tone]}`} />}
            <p className="text-xs text-muted">{s.label}</p>
          </div>
          <p className="tabular font-heading text-3xl md:text-4xl">{s.value}</p>
          {s.hint && <p className="text-[11px] text-faint">{s.hint}</p>}
        </div>
      ))}
    </section>
  );
}

/** The five phases as one journey. Phases running slower than their turnaround glow amber. */
export function FlowStrip({ phases, showTiming = false }: { phases: Record<PhaseKey, PhaseStat>; showTiming?: boolean }) {
  return (
    <ol className="relative grid grid-cols-5 gap-2">
      <span aria-hidden className="absolute left-[10%] right-[10%] top-[22px] h-px bg-gradient-to-r from-line via-brand/40 to-line" />
      {PHASES.map((p, i) => {
        const s = phases[p.key];
        const slow = showTiming && s.avgDays != null && s.slaDays != null && s.avgDays > s.slaDays;
        return (
          <li key={p.key} className="relative grid justify-items-center gap-1.5 text-center">
            <span
              className={`tabular relative grid h-11 w-11 place-items-center rounded-full border text-base font-semibold ${
                slow
                  ? "border-warn/70 bg-warn-soft text-fg shadow-[0_0_24px_-6px_rgba(224,166,58,0.8)]"
                  : s.count
                    ? "border-brand/60 bg-brand-soft text-fg shadow-[0_0_24px_-6px_rgba(178,30,44,0.8)]"
                    : "border-line bg-surface text-faint"
              }`}
            >
              {s.count}
            </span>
            <span className="text-sm font-medium">
              <span className="mr-1 text-faint">{i + 1}</span>
              {p.name}
            </span>
            {showTiming && s.avgDays != null ? (
              <span className={`tabular text-[11px] ${slow ? "text-warn" : "text-faint"}`}>
                {s.avgDays.toFixed(1)}d avg{s.slaDays != null && <span className="text-faint"> / {s.slaDays}d</span>}
              </span>
            ) : (
              <span className="hidden text-[11px] leading-tight text-faint sm:block">{p.owner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export type Alert = {
  id: string;
  tone: "bad" | "warn";
  kind: string; // "Stuck", "Revisions", "Allotment", "No response"…
  client: string;
  title: string;
  detail: string;
  owner?: string;
  href?: string;
};

/** What a leader or exec should look at, worst first. */
export function AttentionList({ alerts, empty }: { alerts: Alert[]; empty: string }) {
  if (!alerts.length) {
    return (
      <div className="grid place-items-center gap-2 rounded-brand border border-dashed border-line px-6 py-12 text-center">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-ok-soft text-ok">✓</span>
        <p className="text-sm text-muted">{empty}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-brand border border-line bg-surface">
      {alerts.map((a) => (
        <li key={a.id} data-hideable className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2 md:grid-cols-[auto_1fr_auto_auto] md:gap-4">
          <span className={`mt-0.5 w-20 rounded-full px-2 py-0.5 text-center text-[11px] font-medium ${SOFT[a.tone]}`}>{a.kind}</span>
          <div className="min-w-0">
            <p className="text-sm">
              <span className="font-medium">{a.client}</span> <span className="text-muted">· {a.title}</span>
            </p>
            <p className="mt-0.5 text-xs text-faint">{a.detail}</p>
          </div>
          {a.owner ? <span className="col-start-2 whitespace-nowrap text-xs text-muted md:col-start-auto">{a.owner}</span> : <span className="hidden md:block" />}
          <span className="col-start-2 -my-1 md:col-start-auto">
            <HideForMe hideKey={`alert:${a.id}`} label={`${a.kind}: ${a.client} · ${a.title}`} href={a.href} compact />
          </span>
        </li>
      ))}
    </ul>
  );
}

export type Load = { name: string; role: string; active: number; overdue: number; capacity: number };

/** Who is carrying what. The bar fills toward their usual capacity; red marks overdue work. */
export function TeamLoad({ people }: { people: Load[] }) {
  if (!people.length) return <p className="text-xs text-faint">Workload shows here once requests are assigned.</p>;
  return (
    <ul className="grid gap-3">
      {people.map((p) => {
        const pct = Math.min(100, (p.active / Math.max(1, p.capacity)) * 100);
        const over = p.active > p.capacity;
        return (
          <li key={p.name} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">
                {p.name} <span className="text-xs text-faint">{p.role}</span>
              </span>
              <span className="tabular whitespace-nowrap text-xs text-muted">
                {p.active}
                {p.overdue > 0 && <span className="text-bad"> · {p.overdue} late</span>}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className={`h-full rounded-full ${over ? "bg-warn" : "bg-fg/70"}`} style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export type QueueItem = {
  id: string;
  href?: string; // opens the ticket
  client: string;
  title: string;
  format: "Image" | "Video" | "Carousel";
  stage: string;
  due: string;
  tone: "ok" | "warn" | "bad";
  priority?: "High" | "Urgent";
  note?: string;
};

export function Queue({ items, empty }: { items: QueueItem[]; empty: { title: string; body: string } }) {
  if (!items.length) {
    return (
      <div className="grid place-items-center gap-2 rounded-brand border border-dashed border-line px-6 py-16 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-xl text-faint">✓</span>
        <p className="font-heading text-lg">{empty.title}</p>
        <p className="max-w-sm text-sm text-muted">{empty.body}</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-brand border border-line bg-surface">
      {items.map((q) => (
        <li key={q.id}>
          <Link href={q.href ?? "/board"} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 active:bg-surface-2 md:grid-cols-[auto_1fr_auto] md:gap-4">
          <span className={`h-2 w-2 rounded-full ${DOT[q.tone]}`} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{q.title}</p>
            <p className="truncate text-xs text-muted">
              {q.client} · {q.format} · <span className="text-faint">{q.stage}</span>
            </p>
            {q.note && <p className="mt-1 truncate text-xs text-warn">“{q.note}”</p>}
          </div>
          <div className="flex flex-col items-end gap-1 md:flex-row md:items-center md:gap-3">
            {q.priority && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${q.priority === "Urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                {q.priority}
              </span>
            )}
            <span className={`tabular whitespace-nowrap text-xs ${TXT[q.tone]}`}>{q.due}</span>
          </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export type ClientPulse = {
  name: string;
  slug: string;
  tone: Tone; // overall health
  used: number;
  allotment: number;
  revisionsPerItem: number;
  waiting: number; // items with the client
  note: string;
};

/**
 * Allotment pace: the bar is what's been used this month, the tick is where they "should" be
 * by today. Ahead of the tick by a lot = burning fast; well behind = we're behind on creative.
 */
export function ClientHealth({ clients, monthElapsed }: { clients: ClientPulse[]; monthElapsed: number }) {
  if (!clients.length) return <p className="text-xs text-faint">Client health shows here once requests flow.</p>;
  return (
    <>
    {/* Phones: one card per client instead of the table */}
    <ul className="grid gap-2 md:hidden">
      {clients.map((c) => {
        const pct = c.allotment ? Math.min(100, (c.used / c.allotment) * 100) : 0;
        return (
          <li key={c.slug} className="grid gap-3 rounded-brand border border-line bg-surface p-4">
            <div className="flex items-start gap-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[c.tone]}`} />
              <div className="min-w-0">
                <Link href={`/clients/${c.slug}`} className="block truncate font-medium hover:text-brand-text">
                  {c.name}
                </Link>
                <span className={`block text-xs ${c.tone === "ok" ? "text-faint" : TXT[c.tone]}`}>{c.note}</span>
              </div>
            </div>
            <div className="grid gap-1.5">
              <div className="relative h-1.5 rounded-full bg-surface-2">
                <div className={`h-full rounded-full ${c.tone === "bad" ? "bg-bad" : c.tone === "warn" ? "bg-warn" : "bg-fg/70"}`} style={{ width: `${pct}%` }} />
                <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-fg/60" style={{ left: `${monthElapsed * 100}%` }} />
              </div>
              <div className="tabular flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-faint">
                <span>
                  {c.used} of {c.allotment} this month
                </span>
                <span>
                  <span className={c.revisionsPerItem >= 2 ? "text-bad" : c.revisionsPerItem >= 1.2 ? "text-warn" : "text-muted"}>{c.revisionsPerItem.toFixed(1)}×</span> revisions ·{" "}
                  <span className="text-muted">{c.waiting}</span> with client
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
    <div className="hidden overflow-x-auto rounded-brand border border-line bg-surface md:block">
      <table className="w-full min-w-[620px] text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2.5 font-medium">Client</th>
            <th className="w-56 px-4 py-2.5 font-medium">Creative this month</th>
            <th className="px-4 py-2.5 text-right font-medium">Revisions</th>
            <th className="px-4 py-2.5 text-right font-medium">With client</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const pct = c.allotment ? Math.min(100, (c.used / c.allotment) * 100) : 0;
            return (
              <tr key={c.slug} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[c.tone]}`} />
                    <div className="min-w-0">
                      <Link href={`/clients/${c.slug}`} className="block truncate font-medium hover:text-brand-text">
                        {c.name}
                      </Link>
                      <span className={`block truncate text-xs ${c.tone === "ok" ? "text-faint" : TXT[c.tone]}`}>{c.note}</span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="relative h-1.5 rounded-full bg-surface-2">
                    <div className={`h-full rounded-full ${c.tone === "bad" ? "bg-bad" : c.tone === "warn" ? "bg-warn" : "bg-fg/70"}`} style={{ width: `${pct}%` }} />
                    <span aria-hidden className="absolute -top-1 h-3.5 w-px bg-fg/60" style={{ left: `${monthElapsed * 100}%` }} title="Expected by today" />
                  </div>
                  <p className="tabular mt-1.5 text-[11px] text-faint">
                    {c.used} of {c.allotment}
                  </p>
                </td>
                <td className={`tabular px-4 py-3 text-right ${c.revisionsPerItem >= 2 ? "text-bad" : c.revisionsPerItem >= 1.2 ? "text-warn" : "text-muted"}`}>
                  {c.revisionsPerItem.toFixed(1)}×
                </td>
                <td className="tabular px-4 py-3 text-right text-muted">{c.waiting}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

export type KpiPulseData = import("@/lib/home").KpiPulse;
const money = (n: number) => `$${n.toLocaleString("en-US")}`;

const KPI_BANDS: { key: keyof KpiPulseData["counts"]; label: string; bar: string; text: string }[] = [
  { key: "excellent", label: "Crushing it", bar: "bg-ok", text: "text-ok" },
  { key: "good", label: "On target", bar: "bg-ok/60", text: "text-ok" },
  { key: "close", label: "Close", bar: "bg-warn", text: "text-warn" },
  { key: "off", label: "Off target", bar: "bg-bad", text: "text-bad" },
  { key: "idle", label: "Not spending", bar: "bg-faint/50", text: "text-faint" },
];

/** The ad accounts against their KPI targets: where they stand, who's off, and budget pacing. */
export function KpiPulse({ k, title = "Ad accounts" }: { k: KpiPulseData; title?: string }) {
  const synced = k.syncedMinutes;
  // The bar is the accounts we can read; the ones still being set up are said underneath, by why
  const live = k.accounts - k.counts.setup;
  return (
    <section className="grid gap-4 rounded-brand border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {title ? <h2 className="font-heading text-xl">{title}</h2> : <span />}
        <Link href="/kpis" className="text-xs text-faint hover:text-fg">
          {live} live accounts · {money(k.spend30)} spent in 30 days{synced != null ? ` · synced ${synced < 60 ? `${Math.max(1, synced)}m` : `${Math.round(synced / 60)}h`} ago` : ""} →
        </Link>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2">
        {KPI_BANDS.map((b) => (k.counts[b.key] ? <span key={b.key} className={b.bar} style={{ width: `${(k.counts[b.key] / Math.max(1, live)) * 100}%` }} title={`${b.label}: ${k.counts[b.key]}`} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {KPI_BANDS.filter((b) => k.counts[b.key]).map((b) => (
          <span key={b.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${b.bar}`} />
            <span className={`tabular font-medium ${b.text}`}>{k.counts[b.key]}</span>
            <span className="text-muted">{b.label}</span>
          </span>
        ))}
      </div>
      {(k.setup.cantRead.length > 0 || k.setup.noAccount.length > 0) && (
        <div className="grid gap-1 text-xs text-faint">
          {k.setup.cantRead.length > 0 && (
            <p>
              <span className="text-warn">Can&apos;t read {k.setup.cantRead.length}</span> (access to fix): {k.setup.cantRead.join(", ")}
            </p>
          )}
          {k.setup.noAccount.length > 0 && (
            <p>
              <span className="text-muted">No ad account yet {k.setup.noAccount.length}</span> (new clients): {k.setup.noAccount.join(", ")}
            </p>
          )}
        </div>
      )}
      {(k.off.length > 0 || k.pacing.length > 0 || k.working.length > 0) && (
        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Off or close to target{k.offTotal > k.off.length ? ` · worst ${k.off.length} of ${k.offTotal}` : ""}</p>
            {k.off.length ? (
              k.off.map((o) => (
                <Link key={o.id} href={o.slug ? `/clients/${o.slug}` : `/kpis?target=${o.id}`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm hover:text-fg md:py-0">
                  <span className="min-w-0 truncate">
                    {o.client}
                    {o.label && <span className="text-faint"> · {o.label}</span>}
                  </span>
                  <span className={`tabular shrink-0 text-xs ${o.status === "off" ? "text-bad" : "text-warn"}`}>{o.deviation != null ? `${o.deviation > 0 ? "+" : ""}${Math.round(o.deviation * 100)}% vs target` : "—"}</span>
                </Link>
              ))
            ) : (
              <p className="text-xs text-ok">{k.working.length ? "Nothing else off target needs a look." : "Every account is on or ahead of target."}</p>
            )}
            {/* Off target, but changed in the last few days: given time to turn around before it's raised again */}
            {k.working.length > 0 && (
              <details className="group mt-1 rounded-[10px] border border-line/70 px-3 py-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-faint">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9aa8ff]" />
                  {k.working.length} being worked on · changed in the last 5 days, back here if still off after that
                  <span className="ml-auto transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="grid gap-1 pt-2">
                  {k.working.map((w) => (
                    <Link key={w.id} href={`/clients/${w.slug}`} className="flex items-baseline justify-between gap-3 py-1 text-[13px] text-muted hover:text-fg">
                      <span className="min-w-0 truncate">
                        {w.client}
                        {w.label && <span className="text-faint"> · {w.label}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">
                        changed {new Date(w.changedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                        {w.who ? ` by ${w.who}` : ""}
                      </span>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </div>
          <div className="grid content-start gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Budget pacing</p>
            {k.pacing.length ? (
              k.pacing.map((p) => (
                <Link key={p.id} href={p.slug ? `/clients/${p.slug}` : `/kpis?target=${p.id}`} className="grid gap-0.5 py-1.5 text-sm hover:text-fg md:flex md:items-baseline md:justify-between md:gap-3 md:py-0">
                  <span className="min-w-0 truncate">
                    {p.client}
                    {p.label && <span className="text-faint"> · {p.label}</span>}
                  </span>
                  <span className={`tabular shrink-0 text-xs ${p.status === "over" ? "text-bad" : p.status === "check" ? "text-faint" : "text-warn"}`} title={`${money(p.spent)} spent this month against ${money(p.budget)}`}>
                    {p.status === "check" ? `${money(p.spent)} spent vs ${money(p.budget)} · check the budget` : `${p.status === "over" ? "On pace for" : "On pace for only"} ${Math.round(p.pace * 100)}% of budget`}
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-xs text-ok">Every budget is pacing on track.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
