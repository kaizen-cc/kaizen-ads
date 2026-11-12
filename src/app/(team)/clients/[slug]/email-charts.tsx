"use client";

import { useMemo, useState } from "react";
import { ScrubChart } from "@/components/scrub-chart";
import { BENCHMARKS, deliverabilityByWeek } from "@/lib/klaviyo/insights";
import { SCORE_ACT, SCORE_HEALTHY, rprSeries, scoreWeeks } from "@/lib/klaviyo/charts";
import type { ClientKlaviyo } from "@/lib/klaviyo/store";

// The Email Overview's three charts. Each reads with the same hover and touch scrub as the KPI chart (ScrubChart): a
// guide line, a dot and a reading for the day or week under the pointer.

const FLOW = "#6c7ee1";
const CAMPAIGN = "#5be3a5";
const LINE = "#5be3a5";

type Money = (x: number, cents?: boolean) => string;
const pct = (x: number | null, dp = 2) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
const count = (x: number) => Math.round(x).toLocaleString("en-US");
const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

const W = 640;
const H = 170;
const PAD_T = 14;
const PAD_B = 22;
const INNER = H - PAD_T - PAD_B;
const xAt = (i: number, n: number) => (n === 1 ? W / 2 : (i * W) / (n - 1));

function Card({ title, sub, legend, children }: { title: string; sub?: string; legend?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="font-heading text-[16px]">{title}</h3>
          {sub && <span className="text-[12px] text-faint">{sub}</span>}
        </div>
        {legend && <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">{legend}</div>}
      </div>
      {children}
    </section>
  );
}

export function ChartEmpty({ title, why }: { title: string; why: string }) {
  return (
    <section className="grid gap-1.5 rounded-[18px] border border-dashed border-line bg-surface p-4 md:p-5">
      <h3 className="font-heading text-[16px]">{title}</h3>
      <p className="text-sm text-faint">{why}</p>
    </section>
  );
}

const Swatch = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span className="flex items-center gap-1.5">
    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
    {children}
  </span>
);

/** Date ticks along the bottom, like the KPI chart's */
function Ticks({ dates, step }: { dates: string[]; step: number }) {
  const n = dates.length;
  return (
    <>
      {dates.map((d, i) =>
        (i % step === 0 && n - 1 - i >= Math.ceil(step / 2)) || i === n - 1 ? (
          <text key={d} x={xAt(i, n)} y={H - 5} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10.5" fill="var(--fg-faint)">
            {label(d)}
          </text>
        ) : null,
      )}
    </>
  );
}

const Guide = ({ x }: { x: number }) => <line x1={x} x2={x} y1={PAD_T} y2={PAD_T + INNER} stroke="var(--fg-faint)" strokeWidth="1" opacity="0.7" />;
const Dot = ({ x, y, color }: { x: number; y: number; color: string }) => <circle cx={x} cy={y} r={5} fill={color} stroke="var(--surface)" strokeWidth="1.5" />;

const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

// ─── Revenue by day ───────────────────────────────────────────────────────

export function RevenueByDayChart({ k, money }: { k: ClientKlaviyo; money: Money }) {
  const days = k.daily;
  const n = days.length;
  const has = days.some((d) => d.revenue > 0);
  const hasStore = days.some((d) => d.storeRevenue != null && d.storeRevenue > 0);
  const emailPeak = Math.max(1, ...days.map((d) => d.revenue));
  const storePeak = Math.max(1, ...days.map((d) => d.storeRevenue ?? 0));
  const [showStore, setShowStore] = useState<boolean | null>(null);
  // The store's total is usually several times email's: start with it off then, so email's own days stay readable
  const store = hasStore && (showStore ?? storePeak <= emailPeak * 5);
  if (!n || !has) return <ChartEmpty title="Revenue by day" why="Revenue by day reads on the next full sync." />;
  const top = Math.max(emailPeak, store ? storePeak : 0) * 1.08;
  const y = (v: number) => PAD_T + INNER - (v / top) * INNER;
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const camp = days.map((d, i) => ({ x: xAt(i, n), y: y(d.campaignRevenue) }));
  const both = days.map((d, i) => ({ x: xAt(i, n), y: y(d.campaignRevenue + d.flowRevenue) }));
  const base = PAD_T + INNER;
  const areaOf = (upper: { x: number; y: number }[], lower: { x: number; y: number }[] | null) => `${path(upper)} ${lower ? [...lower].reverse().map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") : `L${upper[upper.length - 1].x},${base} L${upper[0].x},${base}`} Z`;
  return (
    <Card
      title="Revenue by day"
      sub={`${n} days · ${money(total)} from email and SMS`}
      legend={
        <>
          <Swatch color={CAMPAIGN}>Campaigns</Swatch>
          <Swatch color={FLOW}>Flows</Swatch>
          {hasStore && (
            <button type="button" onClick={() => setShowStore(!store)} aria-pressed={store} className={`flex min-h-11 items-center gap-1.5 rounded-full px-2 md:min-h-0 ${store ? "text-fg" : "text-faint line-through"}`}>
              <span className="h-0.5 w-4 rounded-full bg-fg/70" />
              Store total
            </button>
          )}
        </>
      }
    >
      <ScrubChart
        n={n}
        tooltip={(i) => {
          const d = days[i];
          return (
            <>
              <span className="text-faint">{label(d.date)}</span>
              <span className="tabular font-medium">{money(d.revenue)}</span>
              <span className="tabular text-faint">
                Campaigns {money(d.campaignRevenue)} · Flows {money(d.flowRevenue)}
              </span>
              {d.smsRevenue > 0 && <span className="tabular text-faint">of which SMS {money(d.smsRevenue)}</span>}
              {d.storeRevenue != null && (
                <span className="tabular text-faint">
                  Store {money(d.storeRevenue)}
                  {d.storeRevenue > 0 ? ` · ${Math.round((d.revenue / d.storeRevenue) * 100)}% email` : ""}
                </span>
              )}
            </>
          );
        }}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Email revenue per day over ${n} days, ${money(total)} in total`}>
            <path d={areaOf(camp, null)} fill={CAMPAIGN} opacity="0.55" />
            <path d={areaOf(both, camp)} fill={FLOW} opacity="0.55" />
            <path d={path(both)} fill="none" stroke={FLOW} strokeWidth="2" strokeLinejoin="round" />
            {store && <path d={path(days.map((d, i) => ({ x: xAt(i, n), y: y(d.storeRevenue ?? 0) })))} fill="none" stroke="var(--fg-muted)" strokeWidth="1.5" strokeDasharray="4 3" strokeLinejoin="round" />}
            <text x="2" y={PAD_T - 3} fontSize="10.5" fill="var(--fg-faint)">
              {money(top / 1.08)}
            </text>
            {hover != null && (
              <g>
                <Guide x={xAt(hover, n)} />
                <Dot x={xAt(hover, n)} y={y(days[hover].revenue)} color={FLOW} />
              </g>
            )}
            <Ticks dates={days.map((d) => d.date)} step={14} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}

// ─── Revenue per recipient ────────────────────────────────────────────────

export function RprChart({ k, money }: { k: ClientKlaviyo; money: Money }) {
  const series = useMemo(() => rprSeries(k.daily), [k.daily]);
  const n = series.length;
  const known = series.filter((p) => p.rpr != null);
  if (!n || !known.length) return <ChartEmpty title="Revenue per recipient" why="Recipients by day read on the next full sync." />;
  const top = Math.max(...known.map((p) => p.rpr!)) * 1.15 || 1;
  const y = (v: number) => PAD_T + INNER - (v / top) * INNER;
  const pts = series.map((p, i) => (p.rpr == null ? null : { x: xAt(i, n), y: y(p.rpr) }));
  // Break the line where the window had no recipients
  const d = pts.map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}` : "")).join(" ");
  const last = [...pts].reverse().find(Boolean);
  const latest = known[known.length - 1].rpr!;
  return (
    <Card title="Revenue per recipient" sub={`7-day, campaigns and flows · latest ${money(latest, true)}`}>
      <ScrubChart
        n={n}
        tooltip={(i) => {
          const p = series[i];
          return (
            <>
              <span className="text-faint">{label(p.date)} · 7 days to it</span>
              <span className="tabular font-medium">{p.rpr == null ? "Nothing sent" : `${money(p.rpr, true)} per recipient`}</span>
              <span className="tabular text-faint">
                {money(p.revenue)} · {count(p.recipients)} recipients
              </span>
            </>
          );
        }}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Revenue per recipient over ${n} days, latest ${money(latest, true)}`}>
            <path d={d} fill="none" stroke={LINE} strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
            <text x="2" y={PAD_T - 3} fontSize="10.5" fill="var(--fg-faint)">
              {money(top / 1.15, true)}
            </text>
            {last && <circle cx={last.x} cy={last.y} r={4} fill={LINE} stroke="var(--surface)" strokeWidth="1.5" />}
            {hover != null && (
              <g>
                <Guide x={xAt(hover, n)} />
                {pts[hover] && <Dot x={pts[hover]!.x} y={pts[hover]!.y} color={LINE} />}
              </g>
            )}
            <Ticks dates={series.map((p) => p.date)} step={14} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}

// ─── Deliverability score ─────────────────────────────────────────────────

const scoreTone = (s: number) => (s >= SCORE_HEALTHY ? "#3fb27f" : s >= SCORE_ACT ? "#e0a63a" : "#e0505c");
const scoreWord = (s: number) => (s >= SCORE_HEALTHY ? "Healthy" : s >= SCORE_ACT ? "Watch" : "Act");

export function DeliverabilityScoreChart({ k }: { k: ClientKlaviyo }) {
  const weeks = useMemo(() => scoreWeeks(deliverabilityByWeek(k.campaigns)), [k.campaigns]);
  const n = weeks.length;
  if (!n) return <ChartEmpty title="Deliverability score" why="Scores come from email campaigns sent; none in the last 120 days yet, or they read on the next full sync." />;
  const y = (v: number) => PAD_T + INNER - (v / 100) * INNER;
  const pts = weeks.map((w, i) => ({ x: xAt(i, n), y: y(w.score) }));
  const latest = weeks[n - 1].score;
  return (
    <Card title="Deliverability score" sub={`Weekly, 0 to 100 from bounces, spam complaints and unsubscribes · latest ${latest} (${scoreWord(latest).toLowerCase()})`}>
      <ScrubChart
        n={n}
        tooltip={(i) => {
          const w = weeks[i];
          return (
            <>
              <span className="text-faint">Week of {label(w.week)}</span>
              <span className="tabular font-medium" style={{ color: scoreTone(w.score) }}>
                Score {w.score} · {scoreWord(w.score)}
              </span>
              <span className="tabular text-faint">
                Bounce {pct(w.bounceRate)} (line {pct(BENCHMARKS.bounce.warn, 1)})
              </span>
              <span className="tabular text-faint">
                Spam {pct(w.spamRate)} (line {pct(BENCHMARKS.spam.warn)})
              </span>
              <span className="tabular text-faint">
                Unsubscribe {pct(w.unsubscribeRate)} (line {pct(BENCHMARKS.unsubscribe.warn, 1)})
              </span>
            </>
          );
        }}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Weekly deliverability score over ${n} weeks, latest ${latest} out of 100; healthy is ${SCORE_HEALTHY} and up`}>
            <rect x="0" y={y(100)} width={W} height={y(SCORE_HEALTHY) - y(100)} fill="#3fb27f" opacity="0.12" />
            <line x1="0" x2={W} y1={y(SCORE_HEALTHY)} y2={y(SCORE_HEALTHY)} stroke="#3fb27f" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
            <text x={W - 4} y={y(SCORE_HEALTHY) + 12} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
              Healthy {SCORE_HEALTHY} and up
            </text>
            {n > 1 && <path d={path(pts)} fill="none" stroke="var(--fg-muted)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
            {weeks.map((w, i) => (
              <circle key={w.week} cx={pts[i].x} cy={pts[i].y} r={3.5} fill={scoreTone(w.score)} stroke="var(--surface)" strokeWidth="1.5" />
            ))}
            {hover != null && (
              <g>
                <Guide x={pts[hover].x} />
                <circle cx={pts[hover].x} cy={pts[hover].y} r={6} fill={scoreTone(weeks[hover].score)} stroke="var(--surface)" strokeWidth="1.5" />
              </g>
            )}
            <Ticks dates={weeks.map((w) => w.week)} step={Math.max(1, Math.ceil(n / 5))} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}
