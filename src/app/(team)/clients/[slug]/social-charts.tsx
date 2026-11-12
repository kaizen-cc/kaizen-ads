"use client";

import { ScrubChart } from "@/components/scrub-chart";
import { ENGAGEMENT_BENCH } from "@/lib/social/insights";
import type { ClientSocial } from "@/lib/social/store";

// The Social Overview's charts: followers, reach and engagement rate over 90 days. Each reads with the same hover and
// touch scrub as the KPI chart and the Email tab (ScrubChart): a guide line, a dot and a reading for the day.

const IG = "#e0508c";
const FB = "#6c7ee1";
const LINE = "#5be3a5";
export const PLATFORM_COLOR = { instagram: IG, facebook: FB } as const;
const NAME = { instagram: "Instagram", facebook: "Facebook" } as const;

const count = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number | null, dp = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const short = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(x >= 100_000 ? 0 : 1)}k` : count(x));

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

function Empty({ title, why }: { title: string; why: string }) {
  return (
    <section className="grid gap-1.5 rounded-[18px] border border-dashed border-line bg-surface p-4 md:p-5">
      <h3 className="font-heading text-[16px]">{title}</h3>
      <p className="text-sm text-faint">{why}</p>
    </section>
  );
}

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

type Pt = { x: number; y: number } | null;
/** A line that breaks where there's no value */
const brokenPath = (pts: Pt[]) => pts.map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}` : "")).join(" ");
/** The area under each unbroken run of a line, down to the base */
function areaPath(pts: Pt[], base: number) {
  const runs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length > 1).map((r) => `${r.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} L${r[r.length - 1].x.toFixed(1)},${base} L${r[0].x.toFixed(1)},${base} Z`).join(" ");
}

// ─── Followers ────────────────────────────────────────────────────────────

export function FollowersChart({ s }: { s: ClientSocial }) {
  const pts = s.followers;
  const n = pts.length;
  const known = pts.filter((p) => p.followers != null).map((p) => p.followers!);
  if (!n || known.length < 2) return <Empty title="Followers" why="The follower count builds up day by day: the chart appears once a second day is read." />;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const pad = Math.max(1, (hi - lo) * 0.12);
  const min = Math.max(0, lo - pad);
  const max = hi + pad;
  const y = (v: number) => PAD_T + INNER - ((v - min) / (max - min || 1)) * INNER;
  const line: Pt[] = pts.map((p, i) => (p.followers == null ? null : { x: xAt(i, n), y: y(p.followers) }));
  const estimated = pts.some((p) => p.estimated);
  const latest = known[known.length - 1];
  const first = known[0];
  const base = PAD_T + INNER;
  return (
    <Card
      title="Followers"
      sub={`${count(latest)} now · ${latest - first >= 0 ? "+" : ""}${count(latest - first)} over ${n} days${estimated ? " · earlier days rebuilt from daily changes" : ""}`}
      legend={
        s.platforms.length > 1 && (
          <>
            {s.platforms.map((p) => (
              <span key={p.platform} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: PLATFORM_COLOR[p.platform] }} />
                {NAME[p.platform]}
              </span>
            ))}
          </>
        )
      }
    >
      <ScrubChart
        n={n}
        tooltip={(i) => (
          <>
            <span className="text-faint">{label(pts[i].date)}</span>
            <span className="tabular font-medium">{pts[i].followers == null ? "Not read" : `${count(pts[i].followers!)} followers`}</span>
            {s.platforms.length > 1 &&
              s.platforms.map((p) => (
                <span key={p.platform} className="tabular text-faint">
                  {NAME[p.platform]} {p.series[i]?.followers == null ? "n/a" : count(p.series[i].followers!)}
                </span>
              ))}
          </>
        )}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Followers over ${n} days, ${count(latest)} now`}>
            <path d={areaPath(line, base)} fill={LINE} opacity="0.16" />
            <path d={brokenPath(line)} fill="none" stroke={LINE} strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
            <text x="2" y={PAD_T - 3} fontSize="10.5" fill="var(--fg-faint)">
              {short(hi)}
            </text>
            {hover != null && line[hover] && (
              <g>
                <Guide x={xAt(hover, n)} />
                <Dot x={line[hover]!.x} y={line[hover]!.y} color={LINE} />
              </g>
            )}
            <Ticks dates={pts.map((p) => p.date)} step={14} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}

// ─── Reach ────────────────────────────────────────────────────────────────

export function ReachChart({ s }: { s: ClientSocial }) {
  const days = s.reach;
  const n = days.length;
  const known = days.filter((d) => d.value != null).map((d) => d.value!);
  if (!n || !known.length) return <Empty title="Reach" why="Reach by day reads on the next sync, or Meta isn't giving it for this account yet." />;
  const top = Math.max(...known) * 1.1 || 1;
  const y = (v: number) => PAD_T + INNER - (v / top) * INNER;
  const line: Pt[] = days.map((d, i) => (d.value == null ? null : { x: xAt(i, n), y: y(d.value) }));
  const total = known.reduce((a, b) => a + b, 0);
  const base = PAD_T + INNER;
  return (
    <Card title="Reach" sub={`Accounts reached per day, ${s.platforms.map((p) => NAME[p.platform]).join(" and ")} added up · ${short(total)} over ${n} days`}>
      <ScrubChart
        n={n}
        tooltip={(i) => (
          <>
            <span className="text-faint">{label(days[i].date)}</span>
            <span className="tabular font-medium">{days[i].value == null ? "Not read" : `${count(days[i].value!)} reached`}</span>
          </>
        )}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Reach per day over ${n} days`}>
            <path d={areaPath(line, base)} fill={FB} opacity="0.2" />
            <path d={brokenPath(line)} fill="none" stroke={FB} strokeWidth="2" strokeLinejoin="round" />
            <text x="2" y={PAD_T - 3} fontSize="10.5" fill="var(--fg-faint)">
              {short(top / 1.1)}
            </text>
            {hover != null && line[hover] && (
              <g>
                <Guide x={xAt(hover, n)} />
                <Dot x={line[hover]!.x} y={line[hover]!.y} color={FB} />
              </g>
            )}
            <Ticks dates={days.map((d) => d.date)} step={14} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}

// ─── Engagement ───────────────────────────────────────────────────────────

export function EngagementChart({ s }: { s: ClientSocial }) {
  const series = s.rate;
  const n = series.length;
  const known = series.filter((p) => p.rate != null);
  if (!n || !known.length) return <Empty title="Engagement rate" why="The rate is interactions over reach: it appears once both are read for some days." />;
  const peak = Math.max(ENGAGEMENT_BENCH.high * 1.3, ...known.map((p) => p.rate!)) * 1.05;
  const y = (v: number) => PAD_T + INNER - (v / peak) * INNER;
  const line: Pt[] = series.map((p, i) => (p.rate == null ? null : { x: xAt(i, n), y: y(p.rate) }));
  const latest = known[known.length - 1].rate!;
  return (
    <Card title="Engagement rate" sub={`7-day, interactions over reach · latest ${pct(latest)}`}>
      <ScrubChart
        n={n}
        tooltip={(i) => {
          const p = series[i];
          return (
            <>
              <span className="text-faint">{label(p.date)} · 7 days to it</span>
              <span className="tabular font-medium">{p.rate == null ? "No reach" : pct(p.rate)}</span>
              <span className="tabular text-faint">
                {count(p.interactions)} interactions · {count(p.reach)} reached
              </span>
            </>
          );
        }}
      >
        {(hover) => (
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label={`Engagement rate over ${n} days, latest ${pct(latest)}; strong is ${pct(ENGAGEMENT_BENCH.high, 0)} and up`}>
            <rect x="0" y={y(peak)} width={W} height={y(ENGAGEMENT_BENCH.high) - y(peak)} fill="#3fb27f" opacity="0.1" />
            <line x1="0" x2={W} y1={y(ENGAGEMENT_BENCH.high)} y2={y(ENGAGEMENT_BENCH.high)} stroke="#3fb27f" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
            <line x1="0" x2={W} y1={y(ENGAGEMENT_BENCH.low)} y2={y(ENGAGEMENT_BENCH.low)} stroke="#e0a63a" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
            <text x={W - 4} y={y(ENGAGEMENT_BENCH.high) - 4} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
              Strong {pct(ENGAGEMENT_BENCH.high, 0)} and up
            </text>
            <text x={W - 4} y={y(ENGAGEMENT_BENCH.low) + 12} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
              Low under {pct(ENGAGEMENT_BENCH.low)}
            </text>
            <path d={brokenPath(line)} fill="none" stroke={LINE} strokeWidth="2.75" strokeLinejoin="round" strokeLinecap="round" />
            {hover != null && line[hover] && (
              <g>
                <Guide x={xAt(hover, n)} />
                <Dot x={line[hover]!.x} y={line[hover]!.y} color={LINE} />
              </g>
            )}
            <Ticks dates={series.map((p) => p.date)} step={14} />
          </svg>
        )}
      </ScrubChart>
    </Card>
  );
}
