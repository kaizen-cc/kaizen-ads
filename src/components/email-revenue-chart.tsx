"use client";

import { ScrubChart } from "@/components/scrub-chart";
import { moneyShort } from "@/lib/channel-kpis/calc";
import type { MonthRevenue, PaceHealth } from "@/lib/email-metrics";

// The Email card's chart, built like the Meta cards' health chart (src/app/(team)/kpis/kpi-charts.tsx): the month's
// attributed revenue (the primary metric) as a running total whose line takes each day's colour against the even pace
// to the target, the target's pace as a dashed line, where the month lands at this pace dotted on, and last month's
// running total as a faint ghost to beat. Pointing (or a finger sliding) across it reads any day; the days still to come
// read the target's pace and the projection. Theme colours only.

const TONE: Record<PaceHealth, string> = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", none: "var(--fg-muted)" };
const TEXT: Record<PaceHealth, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-fg" };

const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function RevenueSvg({ id, m, currency, compact, height, hover }: { id: string; m: MonthRevenue; currency: string | null; compact: boolean; height: number; hover: number | null }) {
  const width = compact ? 180 : 640;
  const padT = compact ? 4 : 18;
  const padB = compact ? 4 : 22;
  const inner = height - padT - padB;
  const pts = m.points;
  const n = pts.length;
  const top = Math.max(1, m.target ?? 0, m.projected ?? 0, ...pts.map((p) => Math.max(p.cum ?? 0, p.prevCum ?? 0))) * 1.06;
  const x = (i: number) => (n <= 1 ? width / 2 : (i * width) / (n - 1));
  const y = (v: number) => padT + inner - (Math.min(v, top) / top) * inner;
  const base = padT + inner;
  const past = pts.slice(0, m.today + 1);
  const line = past.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cum ?? 0).toFixed(1)}`).join(" ");
  const area = past.length > 1 ? `${line} L${x(past.length - 1)},${base} L0,${base} Z` : "";
  const ghost = pts.filter((p) => p.prevCum != null).map((p, i) => `${i ? "L" : "M"}${x(p.day - 1).toFixed(1)},${y(p.prevCum!).toFixed(1)}`).join(" ");
  const last = past[past.length - 1];
  const color = TONE[m.health];
  const gid = `er-${id}-${compact ? "s" : "l"}`;
  const stroke = compact ? 2 : 2.75;
  const hp = hover != null ? pts[hover] : null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" aria-label="Attributed revenue this month against the target's pace">
      <defs>
        {/* The line takes each day's colour, the area the month's */}
        <linearGradient id={`${gid}-line`} x1="0" x2={width} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          {past.map((p, i) => (
            <stop key={p.date} offset={`${(x(i) / width) * 100}%`} style={{ stopColor: TONE[p.health === "none" ? m.health : p.health] }} />
          ))}
        </linearGradient>
        <linearGradient id={`${gid}-area`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: compact ? 0.32 : 0.28 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {ghost && <path d={ghost} fill="none" stroke="var(--fg-faint)" strokeWidth={compact ? 1 : 1.25} opacity="0.45" strokeLinejoin="round" />}
      {m.target != null && (
        <>
          <line x1="0" y1={base} x2={width} y2={y(m.target)} stroke="var(--fg-faint)" strokeDasharray="4 4" strokeWidth={compact ? 0.8 : 1} opacity="0.85" />
          {!compact && (
            <text x={width - 4} y={y(m.target) - 7} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
              Target {moneyShort(m.target, currency)}
            </text>
          )}
        </>
      )}
      {area && <path d={area} fill={`url(#${gid}-area)`} />}
      {/* Where the month lands at this pace */}
      {last && m.projected != null && m.today < n - 1 && <line x1={x(m.today)} y1={y(last.cum ?? 0)} x2={x(n - 1)} y2={y(m.projected)} stroke={color} strokeDasharray="1.5 4" strokeLinecap="round" strokeWidth={compact ? 1.4 : 2} opacity="0.7" />}
      {line && past.length > 1 && <path d={line} fill="none" stroke={`url(#${gid}-line)`} strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round" />}
      {last && (
        <g>
          <circle cx={x(m.today)} cy={y(last.cum ?? 0)} r={compact ? 5.5 : 8} fill={TONE[last.health === "none" ? m.health : last.health]} opacity="0.25" />
          <circle cx={x(m.today)} cy={y(last.cum ?? 0)} r={compact ? 2.8 : 4} fill={TONE[last.health === "none" ? m.health : last.health]} stroke="var(--surface)" strokeWidth="1.5" />
        </g>
      )}
      {hp && (
        <g>
          <line x1={x(hover!)} x2={x(hover!)} y1={padT} y2={base} stroke="var(--fg-faint)" strokeWidth={compact ? 0.8 : 1} opacity="0.7" />
          <circle cx={x(hover!)} cy={y(hp.cum ?? hp.projected ?? hp.pace ?? 0)} r={compact ? 3.2 : 5} fill={hp.cum != null ? TONE[hp.health === "none" ? m.health : hp.health] : "var(--fg-faint)"} stroke="var(--surface)" strokeWidth="1.5" />
        </g>
      )}
      {!compact &&
        pts.map((p, i) =>
          (i % 7 === 0 && n - 1 - i >= 3) || i === n - 1 ? (
            <text key={p.date} x={x(i)} y={height - 5} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10.5" fill="var(--fg-faint)">
              {dateLabel(p.date)}
            </text>
          ) : null,
        )}
    </svg>
  );
}

/** The month's revenue with a reading for the day under the pointer: on the Email cards (compact) and the account sheet */
export function EmailRevenueChart({ id, m, currency, compact = false, height }: { id: string; m: MonthRevenue; currency: string | null; compact?: boolean; height?: number }) {
  const h = height ?? (compact ? 44 : 200);
  const money = (v: number | null) => moneyShort(v, currency);
  return (
    <ScrubChart
      n={m.points.length}
      compact={compact}
      tooltip={(i) => {
        const p = m.points[i];
        if (p.cum == null)
          return (
            <>
              <span className="text-faint">{dateLabel(p.date)}</span>
              <span className="tabular font-medium">{p.projected != null ? `${money(p.projected)} at this pace` : "Still to come"}</span>
              {p.pace != null && <span className="tabular text-faint">Target pace {money(p.pace)}</span>}
            </>
          );
        const gap = p.pace ? p.cum / p.pace - 1 : null;
        return (
          <>
            <span className="text-faint">
              {dateLabel(p.date)}
              {i === m.today ? " · today so far" : ""}
            </span>
            <span className={`tabular font-medium ${TEXT[p.health]}`}>
              {money(p.cum)} <span className="font-normal text-faint">this month · {money(p.value)} that day</span>
            </span>
            {p.pace != null && (
              <span className="tabular text-faint">
                Pace {money(p.pace)}
                {gap != null && ` · ${Math.abs(Math.round(gap * 100))}% ${gap >= 0 ? "ahead" : "behind"}`}
              </span>
            )}
            {p.prevCum != null && <span className="tabular text-faint">Last month by now {money(p.prevCum)}</span>}
          </>
        );
      }}
    >
      {(hover) => <RevenueSvg id={id} m={m} currency={currency} compact={compact} height={h} hover={hover} />}
    </ScrubChart>
  );
}

/**
 * Month to date against the revenue target, as the Meta cards' pace bar reads a budget: the fill is what's in, the ghost
 * where the month lands at this pace, the tick where an even month would be today.
 */
export function RevenuePace({ m, currency, compact = false }: { m: MonthRevenue; currency: string | null; compact?: boolean }) {
  if (m.target == null) return <span className="tabular text-[11px] text-faint">{moneyShort(m.mtd, currency)} this month · no target yet</span>;
  const scale = Math.max(m.target, m.projected ?? 0, m.mtd, 1) * 1.04;
  const w = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const even = m.points[m.today]?.pace ?? null;
  const bar = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", none: "bg-fg/40" }[m.health];
  const word = m.health === "ok" ? "On pace" : m.health === "warn" ? "Slightly behind" : m.health === "bad" ? "Behind pace" : "Too early to tell";
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="tabular truncate text-muted">
          {moneyShort(m.mtd, currency)} <span className="text-faint">of {moneyShort(m.target, currency)}</span>
        </span>
        <span className={`shrink-0 font-medium ${TEXT[m.health]}`}>
          {word}
          {m.ratio != null && <span className="tabular font-normal text-faint"> · {Math.round(m.ratio * 100)}%</span>}
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-2">
        {m.projected != null && <span className={`absolute inset-y-0 left-0 rounded-full opacity-25 ${bar}`} style={{ width: w(m.projected) }} />}
        <span className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: w(m.mtd) }} />
        {even != null && <span className="absolute -inset-y-1 w-px bg-fg" style={{ left: w(even) }} title={`Even pace today: ${moneyShort(even, currency)}`} />}
        <span className="absolute -inset-y-0.5 w-0.5 rounded-full bg-faint" style={{ left: w(m.target) }} title={`Target: ${moneyShort(m.target, currency)}`} />
      </div>
      {!compact && m.projected != null && (
        <span className="text-[11px] text-faint">
          Lands at <span className="tabular text-muted">{moneyShort(m.projected, currency)}</span> at this pace
        </span>
      )}
    </div>
  );
}
