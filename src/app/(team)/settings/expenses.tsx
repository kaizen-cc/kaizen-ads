import Link from "next/link";
import { PersonAvatar } from "@/components/person-avatar";
import { tintOf } from "@/lib/agent-look";
import { ACTIVITIES, activityOf, addUsage, cacheSaved, costOf, emptyUsage, type Activity, type Usage } from "@/lib/ai-costs";

// Settings → AI agents → Expenses: what the AI costs Kaizen, by agent, by activity and by person, over any period,
// with where the month is heading. Built from the rollup of every AI call (ai_cost_rollup), priced at Anthropic's list
// prices (src/lib/ai-costs.ts).

export type CostRow = { day: string; agent: string | null; model: string | null; kind: string; person: string | null; actor: "person" | "auto" | null; runs: number; failed: number; input: number; output: number; cache_w: number; cache_r: number; searches: number };
export type Person = { id: string; name: string; role: string };
type Range = { key: string; label: string; short: string; from: string; to: string };

const usageOf = (r: CostRow): Usage => ({ runs: r.runs, failed: r.failed, input: r.input, output: r.output, cacheW: r.cache_w, cacheR: r.cache_r, searches: r.searches });
const $ = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(n >= 10 ? 1 : 2)}`);
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;
const daysInMonth = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0).getDate();
const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The periods, as New York dates (inclusive) */
export function ranges(): Range[] {
  const t = nyToday();
  const y = t.slice(0, 4);
  const m = Number(t.slice(5, 7));
  const monthStart = `${t.slice(0, 7)}-01`;
  const lastStart = m === 1 ? `${Number(y) - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return [
    { key: "7d", label: "Last 7 days", short: "7D", from: addDays(t, -6), to: t },
    { key: "30d", label: "Last 30 days", short: "30D", from: addDays(t, -29), to: t },
    { key: "mtd", label: "Month to date", short: "MTD", from: monthStart, to: t },
    { key: "last", label: "Last month", short: "Last mo", from: lastStart, to: addDays(monthStart, -1) },
    { key: "qtd", label: "Quarter to date", short: "QTD", from: `${y}-${String(q).padStart(2, "0")}-01`, to: t },
    { key: "ytd", label: "Year to date", short: "YTD", from: `${y}-01-01`, to: t },
  ];
}
/** The earliest day any period needs */
export const rollupFrom = () => ranges().reduce((min, r) => (r.from < min ? r.from : min), nyToday());

// Colors for activities and people (agents use their own)
const PALETTE = ["#e0505c", "#5b8def", "#3fb27f", "#e0a63a", "#8a63d2", "#3fa7b5", "#e07a3f", "#d1495b", "#6c7ee1", "#9b6bd6", "#888888"];

/** A smooth curve through the points (cubic segments with tangents from the neighbours) */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[Math.max(0, i - 1)];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[Math.min(pts.length - 1, i + 2)];
    d += ` C${x1 + (x2 - x0) / 6},${y1 + (y2 - y0) / 6} ${x2 - (x3 - x1) / 6},${y2 - (y3 - y1) / 6} ${x2},${y2}`;
  }
  return d;
}

export function Expenses({ rows, people, roles, skills, range: asked, by }: { rows: CostRow[]; people: Person[]; roles: { key: string; label: string; icon: string }[]; skills: { key: string; label: string; roleKey: string | null }[]; range: string; by: string }) {
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
  const mtd = all[2];
  const last = all[3];
  const t = nyToday();
  const mtdCost = cost(rows.filter((r) => r.day >= mtd.from));
  const elapsed = daysBetween(mtd.from, t);
  const pace = (mtdCost / elapsed) * daysInMonth(t);
  const lastCost = cost(rows.filter((r) => r.day >= last.from && r.day <= last.to));
  const thirty = cost(rows.filter((r) => r.day >= all[1].from));
  const nextMonth = (thirty / 30) * daysInMonth(addDays(`${t.slice(0, 7)}-01`, 40));
  const vsLast = lastCost ? (pace - lastCost) / lastCost : null;

  // The curve: days, or weeks for long periods
  const weekly = days > 62;
  const buckets = new Map<string, number>();
  for (let d = range.from; d <= range.to; d = addDays(d, weekly ? 7 : 1)) buckets.set(d, 0);
  const keys = [...buckets.keys()];
  for (const r of inRange) {
    const k = weekly ? keys.filter((b) => b <= r.day).at(-1)! : r.day;
    buckets.set(k, (buckets.get(k) ?? 0) + costOf(r.model, usageOf(r)));
  }
  const series = [...buckets];
  const peak = Math.max(...series.map(([, v]) => v), 0.01);
  const peakAt = series.find(([, v]) => v === peak)?.[0];
  const W = 1000;
  const H = 220;
  const x = (i: number) => (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const y = (v: number) => H - 14 - (v / peak) * (H - 40);
  const pts = series.map(([, v], i) => [x(i), y(v)] as [number, number]);
  const line = smooth(pts);
  const area = line ? `${line} L${W},${H} L0,${H} Z` : "";
  const end = pts.at(-1);

  // The breakdowns
  const roleOf = new Map(skills.map((s) => [s.key, s.roleKey]));
  const skillName = new Map(skills.map((s) => [s.key, s.label]));
  type Line = { key: string; label: string; sub?: string; color: string; usage: Usage; cost: number; children?: Line[]; last?: string; person?: string };
  const group = (keyOf: (r: CostRow) => string, describe: (k: string, i: number) => Pick<Line, "label" | "sub" | "color" | "person">, list = inRange) => {
    const m = new Map<string, Omit<Line, "label" | "color">>();
    for (const r of list) {
      const k = keyOf(r);
      const l = m.get(k) ?? { key: k, usage: emptyUsage(), cost: 0 };
      l.usage = addUsage(l.usage, usageOf(r));
      l.cost += costOf(r.model, usageOf(r));
      if (!l.last || r.day > l.last) l.last = r.day;
      m.set(k, l);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost).map((l, i) => ({ ...l, ...describe(l.key, i) }) as Line);
  };
  const lines: Line[] =
    view === "agents"
      ? group(
          (r) => roleOf.get(r.agent ?? "") ?? "none",
          (k) => {
            const role = roles.find((r) => r.key === k);
            return { label: role?.label ?? "Training chats & other", color: role ? tintOf(role.icon) : "#888888" };
          },
        ).map((l) => ({
          ...l,
          children: group(
            (r) => r.agent ?? "?",
            (k) => ({ label: skillName.get(k) ?? (k === "coach" ? "Skill training chats" : k), color: l.color }),
            inRange.filter((r) => (roleOf.get(r.agent ?? "") ?? "none") === l.key),
          ),
        }))
      : view === "activity"
        ? group(
            (r) => activityOf(r.agent, r.kind),
            (k) => {
              const a = ACTIVITIES.find((x) => x.key === (k as Activity));
              return { label: a?.label ?? k, sub: a?.about, color: PALETTE[ACTIVITIES.findIndex((x) => x.key === k) % PALETTE.length] };
            },
          )
        : group(
            (r) => r.person ?? (r.actor === "auto" ? "auto" : "before"),
            (k, i) => {
              const p = people.find((x) => x.id === k);
              return k === "auto"
                ? { label: "Kaizen Ads on its own", sub: "Scheduled: syncs, audits, Brand Bibles, briefings", color: "#e0505c" }
                : k === "before"
                  ? { label: "Before people were tracked", sub: "Calls before Oct 28, 2026", color: "#6a6a72" }
                  : { label: p?.name ?? "Former team member", sub: p?.role, color: PALETTE[(i + 1) % PALETTE.length], person: p?.name ?? "?" };
            },
          );
  const quiet = view === "people" ? people.filter((p) => !lines.some((l) => l.key === p.id)) : [];

  // The donut: each line's share of the period, drawn as arcs around a circle
  const R = 70;
  const C = 2 * Math.PI * R;
  const lens = lines.map((l) => (total ? (l.cost / total) * C : 0));
  const arcs = lines.map((l, i) => ({ color: l.color, len: lens[i], offset: lens.slice(0, i).reduce((t, n) => t + n, 0) }));

  const href = (patch: Record<string, string>) => `/settings?${new URLSearchParams({ tab: "agents", section: "expenses", range: range.key, by: view, ...patch })}`;

  return (
    <div className="grid gap-6">
      {/* The headline: what the period cost, the curve of it, and where the month is heading */}
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep">
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/25 blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-40 right-0 -z-10 h-80 w-[36rem] rounded-full bg-[#5b8def]/10 blur-[120px]" />
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 md:px-8 md:pt-7">
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">AI spend · {range.label}</p>
            <p className="tabular font-display text-[56px] leading-[0.9] tracking-tight md:text-[72px]">{$(total)}</p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>
                <span className="tabular text-fg">{$(total / days)}</span> a day
              </span>
              <span className="h-1 w-1 rounded-full bg-faint/60" />
              <span>
                <span className="tabular text-fg">{runs.toLocaleString()}</span> AI calls
              </span>
              {failed > 0 && (
                <>
                  <span className="h-1 w-1 rounded-full bg-faint/60" />
                  <span className="text-bad">{failed.toLocaleString()} failed</span>
                </>
              )}
            </p>
          </div>
          <nav className="no-scrollbar -mx-5 flex max-w-[calc(100%+2.5rem)] gap-1 overflow-x-auto px-5 md:mx-0 md:max-w-none md:rounded-full md:border md:border-line md:bg-bg/60 md:p-1 md:px-1 md:backdrop-blur" aria-label="Period">
            {all.map((r) => (
              <Link
                key={r.key}
                href={href({ range: r.key })}
                title={r.label}
                aria-current={r.key === range.key ? "page" : undefined}
                className={`inline-flex h-10 shrink-0 items-center rounded-full px-3.5 text-[13px] transition-colors md:h-8 ${r.key === range.key ? "bg-fg text-bg" : "text-muted hover:text-fg max-md:border max-md:border-line"}`}
              >
                {r.short}
              </Link>
            ))}
          </nav>
        </div>

        <div className="relative mt-4 px-1 md:px-3">
          {total > 0 ? (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-44 w-full overflow-visible md:h-56" role="img" aria-label={`AI spend ${weekly ? "by week" : "by day"}`}>
              <defs>
                <linearGradient id="spend-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#e0505c" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#e0505c" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="spend-line" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0%" stopColor="#b21e2c" />
                  <stop offset="100%" stopColor="#ff6b78" />
                </linearGradient>
              </defs>
              {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1="0" x2={W} y1={y(peak * f)} y2={y(peak * f)} stroke="var(--border)" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />
              ))}
              <path d={area} fill="url(#spend-fill)" />
              <path d={line} fill="none" stroke="url(#spend-line)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {end && (
                <>
                  <circle cx={end[0]} cy={end[1]} r="10" fill="#e0505c" opacity="0.18" />
                  <circle cx={end[0]} cy={end[1]} r="4" fill="#ff6b78" />
                </>
              )}
              {series.map(([d, v], i) => (
                <rect key={d} x={x(i) - W / series.length / 2} y="0" width={W / series.length} height={H} fill="transparent">
                  <title>{`${weekly ? "Week of " : ""}${label(d)}: ${$(v)}`}</title>
                </rect>
              ))}
            </svg>
          ) : (
            <p className="px-5 py-16 text-center text-sm text-faint md:px-8">No AI calls in this period.</p>
          )}
          <div className="flex justify-between px-4 pb-1 text-[10.5px] text-faint md:px-5">
            <span>{label(range.from)}</span>
            {peakAt && total > 0 && (
              <span>
                Peak {label(peakAt)} · {$(peak)}
              </span>
            )}
            <span>{label(range.to)}</span>
          </div>
        </div>

        <dl className="grid grid-cols-2 border-t border-line/70 md:grid-cols-4">
          {[
            {
              k: "This month at this pace",
              v: $(pace),
              n: (
                <>
                  {$(mtdCost)} so far · day {elapsed} of {daysInMonth(t)}
                  {vsLast != null && <span className={`ml-1.5 rounded-full px-1.5 py-px text-[10px] ${vsLast > 0 ? "bg-bad-soft text-bad" : "bg-ok-soft text-ok"}`}>{`${vsLast > 0 ? "+" : ""}${Math.round(vsLast * 100)}% vs last month`}</span>}
                </>
              ),
            },
            { k: "Last month", v: lastCost ? $(lastCost) : "—", n: lastCost ? `${$(lastCost / daysBetween(last.from, last.to))} a day` : "No history yet: tracking started this month" },
            { k: "Next month, estimated", v: $(nextMonth), n: `At the last 30 days' pace, ${$(thirty / 30)} a day` },
            { k: "Saved by prompt caching", v: saved >= 0.01 ? $(saved) : "—", n: saved >= 0.01 ? "In this period, against full input price" : "Shows once cached calls run" },
          ].map((s, i) => (
            <div key={s.k} className={`grid content-start gap-1 px-5 py-4 md:px-8 md:py-5 ${i % 2 ? "border-l border-line/70" : ""} ${i > 1 ? "border-t border-line/70 md:border-t-0" : ""} ${i === 2 ? "md:border-l" : ""}`}>
              <dt className="text-[11px] text-faint">{s.k}</dt>
              <dd className="tabular font-heading text-[22px] leading-tight">{s.v}</dd>
              <dd className="text-[11px] leading-relaxed text-faint">{s.n}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Where it goes: the share as a donut, the ranking beside it */}
      <section className="grid gap-5 rounded-[28px] border border-line bg-surface p-5 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-[22px] leading-tight">Where it goes</h2>
            <p className="mt-1 text-sm text-muted">{view === "agents" ? "By the agent doing the work; open one for its skills." : view === "activity" ? "By the kind of work, whichever agent does it." : "By who set it off, and who isn't using it."}</p>
          </div>
          <div className="flex w-full gap-1 rounded-full border border-line bg-bg p-1 md:w-auto">
            {[
              ["agents", "Agents"],
              ["activity", "Activity"],
              ["people", "People"],
            ].map(([k, l]) => (
              <Link key={k} href={href({ by: k })} aria-current={view === k ? "page" : undefined} className={`inline-flex h-10 flex-1 items-center justify-center rounded-full px-4 text-sm transition-colors md:h-8 md:flex-none ${view === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {l}
              </Link>
            ))}
          </div>
        </div>

        {lines.length ? (
          <div className="grid items-start gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="relative mx-auto grid h-[200px] w-[200px] place-items-center lg:sticky lg:top-6">
              <svg viewBox="0 0 180 180" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
                <circle cx="90" cy="90" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="18" />
                {arcs.map((a, i) => (
                  <circle key={i} cx="90" cy="90" r={R} fill="none" stroke={a.color} strokeWidth="18" strokeDasharray={`${Math.max(0, a.len - 2)} ${C}`} strokeDashoffset={-a.offset} strokeLinecap="butt" />
                ))}
              </svg>
              <div className="grid justify-items-center gap-0.5 text-center">
                <span className="tabular font-display text-[30px] leading-none">{$(total)}</span>
                <span className="text-[11px] text-faint">{range.label.toLowerCase()}</span>
              </div>
            </div>

            <ul className="grid gap-1">
              {lines.map((l) => {
                const share = total ? l.cost / total : 0;
                const row = (
                  <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
                    {l.person ? <PersonAvatar name={l.person} size={32} /> : <span className="grid h-8 w-8 place-items-center rounded-[10px]" style={{ background: `${l.color}22` }}><span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color, boxShadow: `0 0 10px ${l.color}` }} /></span>}
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {l.label}
                        {l.children && l.children.length > 1 && <span className="text-faint transition-transform group-open:rotate-90">›</span>}
                      </span>
                      <span className="truncate text-[11px] text-faint">
                        {l.usage.runs.toLocaleString()} {view === "people" ? "actions" : "calls"} · {$(l.cost / Math.max(1, l.usage.runs))} each
                        {view === "people" && l.last ? ` · last ${label(l.last)}` : l.sub ? ` · ${l.sub}` : ""}
                      </span>
                    </span>
                    <span className="grid justify-items-end">
                      <span className="tabular text-[15px] font-medium">{$(l.cost)}</span>
                      <span className="tabular text-[11px] text-faint">{Math.round(share * 100)}%</span>
                    </span>
                    <span className="col-span-3 h-1 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(1, share * 100)}%`, background: l.color }} />
                    </span>
                  </span>
                );
                return (
                  <li key={l.key}>
                    {l.children && l.children.length > 1 ? (
                      <details className="group rounded-[16px] transition-colors open:bg-bg/60 hover:bg-bg/40">
                        <summary className="cursor-pointer list-none rounded-[16px] px-3 py-3">{row}</summary>
                        <ul className="grid gap-2 px-3 pb-3 pl-14">
                          {l.children.map((c) => (
                            <li key={c.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-[13px]">
                              <span className="truncate text-muted">{c.label}</span>
                              <span className="tabular text-faint">
                                <span className="text-fg">{$(c.cost)}</span> · {c.usage.runs.toLocaleString()} calls
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <div className="rounded-[16px] px-3 py-3 transition-colors hover:bg-bg/40">{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="rounded-[18px] border border-dashed border-line px-5 py-12 text-center text-sm text-faint">No AI calls in this period.</p>
        )}

        {quiet.length > 0 && (
          <div className="grid gap-3 border-t border-line pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Not using the AI in this period</p>
            <div className="flex flex-wrap gap-2">
              {quiet.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-xs text-muted">
                  <PersonAvatar name={p.name} size={22} muted />
                  {p.name}
                  <span className="text-faint">{p.role}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <p className="px-1 text-[11px] leading-relaxed text-faint">
        Priced at Anthropic&apos;s list prices (Opus $4 in / $20 out, Sonnet $2 / $10, Haiku $0.10 / $0.50 per million tokens; cache reads at a twentieth of input on Opus and Sonnet, a tenth on Haiku; web search $10 per
        1,000). Cache tokens, web searches and who set each call off are counted from Oct 28, 2026. The Claude Console bill also includes anything else using Kaizen&apos;s API key.
      </p>
    </div>
  );
}
