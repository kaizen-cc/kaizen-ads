import Link from "next/link";
import { ACTIVITIES, activityOf, addUsage, cacheSaved, costOf, emptyUsage, type Activity, type Usage } from "@/lib/ai-costs";

// Settings → AI agents → Expenses: what the AI costs Kaizen, by agent, by activity and by person, over any period,
// with where the month is heading. Built from the rollup of every AI call (ai_cost_rollup), priced at Anthropic's list
// prices (src/lib/ai-costs.ts).

export type CostRow = { day: string; agent: string | null; model: string | null; kind: string; person: string | null; actor: "person" | "auto" | null; runs: number; failed: number; input: number; output: number; cache_w: number; cache_r: number; searches: number };
export type Person = { id: string; name: string; role: string };
type Range = { key: string; label: string; from: string; to: string };

const usageOf = (r: CostRow): Usage => ({ runs: r.runs, failed: r.failed, input: r.input, output: r.output, cacheW: r.cache_w, cacheR: r.cache_r, searches: r.searches });
const $ = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(n >= 10 ? 1 : 2)}`);
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;
const daysInMonth = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0).getDate();

/** The periods, as New York dates (inclusive) */
export function ranges(): Range[] {
  const t = nyToday();
  const y = t.slice(0, 4);
  const m = Number(t.slice(5, 7));
  const monthStart = `${t.slice(0, 7)}-01`;
  const lastStart = m === 1 ? `${Number(y) - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: "7d", label: "Last 7 days", from: addDays(t, -6), to: t },
    { key: "30d", label: "Last 30 days", from: addDays(t, -29), to: t },
    { key: "mtd", label: "Month to date", from: monthStart, to: t },
    { key: "last", label: "Last month", from: lastStart, to: addDays(monthStart, -1) },
    { key: "qtd", label: "Quarter to date", from: `${y}-${String(q).padStart(2, "0")}-01`, to: t },
    { key: "ytd", label: "Year to date", from: `${y}-01-01`, to: t },
  ];
}
/** The earliest day any period needs */
export const rollupFrom = () => ranges().reduce((min, r) => (r.from < min ? r.from : min), nyToday());

export function Expenses({ rows, people, roles, skills, range: asked, by }: { rows: CostRow[]; people: Person[]; roles: { key: string; label: string }[]; skills: { key: string; label: string; roleKey: string | null }[]; range: string; by: string }) {
  const all = ranges();
  const range = all.find((r) => r.key === asked) ?? all[2];
  const view = ["agents", "activity", "people"].includes(by) ? by : "agents";
  const inRange = rows.filter((r) => r.day >= range.from && r.day <= range.to);
  const cost = (list: CostRow[]) => list.reduce((t, r) => t + costOf(r.model, usageOf(r)), 0);
  const total = cost(inRange);
  const runs = inRange.reduce((t, r) => t + r.runs, 0);
  const failed = inRange.reduce((t, r) => t + r.failed, 0);
  const saved = inRange.reduce((t, r) => t + cacheSaved(r.model, usageOf(r)), 0);
  const days = daysBetween(range.from, range.to);

  // Where the month is heading: this month's pace, last month, and the last 30 days' pace for next month
  const [, , mtd, last, , ] = all;
  const t = nyToday();
  const mtdCost = cost(rows.filter((r) => r.day >= mtd.from));
  const elapsed = daysBetween(mtd.from, t);
  const pace = (mtdCost / elapsed) * daysInMonth(t);
  const lastCost = cost(rows.filter((r) => r.day >= last.from && r.day <= last.to));
  const thirty = cost(rows.filter((r) => r.day >= all[1].from));
  const nextMonthDays = daysInMonth(addDays(`${t.slice(0, 7)}-01`, 40));
  const nextMonth = (thirty / 30) * nextMonthDays;

  // The bars: days, or weeks for long periods
  const weekly = days > 62;
  const buckets = new Map<string, number>();
  for (let d = range.from; d <= range.to; d = addDays(d, weekly ? 7 : 1)) buckets.set(d, 0);
  const keys = [...buckets.keys()];
  for (const r of inRange) {
    const k = weekly ? keys.filter((b) => b <= r.day).at(-1)! : r.day;
    buckets.set(k, (buckets.get(k) ?? 0) + costOf(r.model, usageOf(r)));
  }
  const peak = Math.max(...buckets.values(), 0.01);

  // The breakdowns
  const roleOf = new Map(skills.map((s) => [s.key, s.roleKey]));
  const skillName = new Map(skills.map((s) => [s.key, s.label]));
  const roleName = new Map(roles.map((r) => [r.key, r.label]));
  type Line = { key: string; label: string; sub?: string; usage: Usage; cost: number; children?: Line[]; last?: string };
  const group = (keyOf: (r: CostRow) => string, labelOf: (k: string) => string, subOf?: (k: string) => string) => {
    const m = new Map<string, Line>();
    for (const r of inRange) {
      const k = keyOf(r);
      const l = m.get(k) ?? { key: k, label: labelOf(k), sub: subOf?.(k), usage: emptyUsage(), cost: 0 };
      l.usage = addUsage(l.usage, usageOf(r));
      l.cost += costOf(r.model, usageOf(r));
      if (!l.last || r.day > l.last) l.last = r.day;
      m.set(k, l);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const lines: Line[] =
    view === "agents"
      ? group(
          (r) => roleOf.get(r.agent ?? "") ?? "none",
          (k) => roleName.get(k) ?? "Training chats & other",
        ).map((l) => ({ ...l, children: group((r) => r.agent ?? "?", (k) => skillName.get(k) ?? (k === "coach" ? "Skill training chats" : k)).filter((c) => (roleOf.get(c.key) ?? "none") === l.key) }))
      : view === "activity"
        ? group(
            (r) => activityOf(r.agent, r.kind),
            (k) => ACTIVITIES.find((a) => a.key === (k as Activity))?.label ?? k,
            (k) => ACTIVITIES.find((a) => a.key === (k as Activity))?.about ?? "",
          )
        : group(
            (r) => r.person ?? (r.actor === "auto" ? "auto" : "before"),
            (k) => (k === "auto" ? "Kaizen Ads on its own" : k === "before" ? "Before people were tracked" : (people.find((p) => p.id === k)?.name ?? "Former team member")),
            (k) => (k === "auto" ? "Scheduled jobs: syncs, audits, Brand Bibles, briefings" : k === "before" ? "Calls made before Oct 28, 2026, when tracking by person began" : (people.find((p) => p.id === k)?.role ?? "")),
          );
  const quiet = view === "people" ? people.filter((p) => !lines.some((l) => l.key === p.id)) : [];
  const top = Math.max(...lines.map((l) => l.cost), 0.01);
  const href = (patch: Record<string, string>) => `/settings?${new URLSearchParams({ tab: "agents", section: "expenses", range: range.key, by: view, ...patch })}`;

  return (
    <div className="grid gap-6">
      <nav className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" aria-label="Period">
        {all.map((r) => (
          <Link key={r.key} href={href({ range: r.key })} aria-current={r.key === range.key ? "page" : undefined} className={`inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm transition-colors md:h-9 ${r.key === range.key ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
            {r.label}
          </Link>
        ))}
      </nav>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: range.label, value: $(total), note: `${$(total / days)} a day on average · ${runs.toLocaleString()} AI calls${failed ? `, ${failed} failed` : ""}` },
          { label: "This month, at this pace", value: $(pace), note: `${$(mtdCost)} so far, ${elapsed} of ${daysInMonth(t)} days${lastCost ? ` · ${pace > lastCost ? "+" : ""}${Math.round(((pace - lastCost) / lastCost) * 100)}% on last month` : ""}` },
          { label: "Last month", value: $(lastCost), note: `${$(lastCost / daysBetween(last.from, last.to))} a day` },
          { label: "Next month, estimated", value: $(nextMonth), note: `From the last 30 days' pace (${$(thirty / 30)} a day)` },
        ].map((k, i) => (
          <div key={k.label} className={`relative isolate grid content-start gap-1 overflow-hidden rounded-[18px] border border-line bg-surface p-4 md:p-5 ${i === 0 ? "sm:col-span-2 xl:col-span-1" : ""}`}>
            {i === 0 && <span aria-hidden className="pointer-events-none absolute -right-10 -top-14 -z-10 h-40 w-40 rounded-full bg-brand/20 blur-3xl" />}
            <span className="text-xs text-muted">{k.label}</span>
            <span className="tabular font-display text-[32px] leading-none tracking-tight">{k.value}</span>
            <span className="text-[11px] leading-relaxed text-faint">{k.note}</span>
          </div>
        ))}
      </section>

      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{weekly ? "By week" : "By day"}</p>
          {saved > 0.005 && <p className="text-xs text-ok">Prompt caching saved {$(saved)} in this period</p>}
        </div>
        <div className="flex h-36 items-end gap-[3px]" role="img" aria-label={`AI spend ${weekly ? "by week" : "by day"}, ${range.label.toLowerCase()}`}>
          {[...buckets].map(([d, v]) => (
            <span key={d} title={`${weekly ? "Week of " : ""}${d}: ${$(v)}`} className="min-w-[3px] flex-1 rounded-t-[3px] bg-brand/70 transition-colors hover:bg-brand" style={{ height: `${Math.max(2, (v / peak) * 100)}%` }} />
          ))}
        </div>
        <div className="flex justify-between text-[10.5px] text-faint">
          <span>{range.from}</span>
          <span>{range.to}</span>
        </div>
      </section>

      <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-[18px]">What&apos;s driving it</h2>
          <div className="flex gap-1 rounded-full border border-line bg-bg p-1">
            {[
              ["agents", "By agent"],
              ["activity", "By activity"],
              ["people", "By person"],
            ].map(([k, l]) => (
              <Link key={k} href={href({ by: k })} aria-current={view === k ? "page" : undefined} className={`inline-flex h-9 items-center rounded-full px-3.5 text-sm transition-colors md:h-8 ${view === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {l}
              </Link>
            ))}
          </div>
        </div>
        {lines.length ? (
          <ul className="grid gap-2">
            {lines.map((l) => (
              <li key={l.key}>
                <details className="group rounded-[14px] border border-line bg-bg/40 open:bg-bg">
                  <summary className={`grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 ${l.children?.length ? "" : "pointer-events-none"}`}>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex items-center gap-2 truncate text-sm font-medium">
                        {l.children?.length ? <span className="text-faint transition-transform group-open:rotate-90">›</span> : null}
                        {l.label}
                      </span>
                      {l.sub && <span className="truncate text-[11px] text-faint">{l.sub}</span>}
                    </span>
                    <span className="grid justify-items-end gap-0.5">
                      <span className="tabular text-sm">{$(l.cost)}</span>
                      <span className="tabular text-[11px] text-faint">{total ? Math.round((l.cost / total) * 100) : 0}%</span>
                    </span>
                    <span className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                      <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${(l.cost / top) * 100}%` }} />
                      </span>
                      <span className="tabular text-[11px] text-faint">
                        {l.usage.runs.toLocaleString()} {view === "people" ? "actions" : "calls"} · {$(l.cost / Math.max(1, l.usage.runs))} each · {$(l.cost / days)}/day
                        {view === "people" && l.last ? ` · last ${l.last}` : ""}
                      </span>
                    </span>
                  </summary>
                  {l.children && l.children.length > 0 && (
                    <ul className="grid gap-1 border-t border-line px-4 py-3">
                      {l.children.map((c) => (
                        <li key={c.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-[13px]">
                          <span className="truncate text-muted">{c.label}</span>
                          <span className="tabular text-faint">
                            {$(c.cost)} · {c.usage.runs.toLocaleString()} calls · {$(c.cost / Math.max(1, c.usage.runs))} each
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-[14px] border border-dashed border-line px-5 py-10 text-center text-sm text-faint">No AI calls in this period.</p>
        )}
        {quiet.length > 0 && (
          <div className="grid gap-2 border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Not using the AI in this period</p>
            <div className="flex flex-wrap gap-1.5">
              {quiet.map((p) => (
                <span key={p.id} className="rounded-full border border-line px-3 py-1 text-xs text-muted">
                  {p.name}
                  <span className="text-faint"> · {p.role}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-faint">
        Priced at Anthropic&apos;s list prices (Opus $4 in / $20 out, Sonnet $2 / $10, Haiku $0.10 / $0.50 per million tokens; cache reads at a twentieth of input on Opus and Sonnet, a tenth on Haiku; web search $10 per 1,000). Cache tokens and web
        searches are counted from Oct 28, 2026, and so is who set each call off. The Claude Console bill also includes anything else using Kaizen&apos;s API key.
      </p>
    </div>
  );
}
