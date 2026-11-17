"use client";

import { ScrubChart } from "@/components/scrub-chart";
import type { TrendMetric, TrendPoint } from "@/lib/email-ops/windows";

// The email account's last 30 days, the way the ads sheet shows its own: a bar for each day, coloured against what it
// is judged by (green at or over, amber close, red under), the 7-day average as the line, and the target as a dashed
// line. Point at a day for its numbers. Theme tokens only, so it reads in light and dark.

const TONE = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", none: "var(--fg-faint)" } as const;
const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function toneOf(v: number | null, target: number | null): keyof typeof TONE {
  if (v == null || target == null || !(target > 0)) return "none";
  const gap = v / target - 1;
  return gap >= 0 ? "ok" : gap >= -0.15 ? "warn" : "bad";
}

export function EmailTrendChart({ points, metric, target, format, height = 200, id }: { points: TrendPoint[]; metric: TrendMetric; /** What a day is judged against (the month's target per day, or a bar); null for none */ target: number | null; format: (v: number | null) => string; height?: number; id: string }) {
  if (!points.length) return <p className="text-sm text-faint">No daily numbers yet.</p>;
  const width = 640;
  const padT = 16;
  const padB = 22;
  const inner = height - padT - padB;
  const vals = points.map((p) => p.value ?? 0);
  const top = Math.max(...vals, ...points.map((p) => p.avg ?? 0), target ? target * 1.35 : 0, metric === "rpr" ? 0.05 : 1);
  const y = (v: number) => padT + inner - (Math.min(v, top) / top) * inner;
  const slot = width / points.length;
  const x = (i: number) => slot * i + slot / 2;
  const line = points.map((p, i) => (p.avg == null ? null : `${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`)).filter(Boolean);
  const ty = target ? y(target) : null;
  const gid = `et-${id}`;
  return (
    <ScrubChart
      n={points.length}
      tooltip={(i) => {
        const p = points[i];
        const t = toneOf(p.value, target);
        return (
          <>
            <span className="text-faint">{dateLabel(p.d)}</span>
            <span className="tabular font-medium" style={{ color: t === "none" ? undefined : TONE[t] }}>
              {p.value == null ? "Nothing went out" : format(p.value)}
            </span>
            <span className="tabular text-faint">7-day average {format(p.avg)}</span>
            {metric !== "recipients" && <span className="tabular text-faint">{p.recipients.toLocaleString("en-US")} recipients</span>}
          </>
        );
      }}
    >
      {(hover) => (
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full overflow-visible" preserveAspectRatio="none" role="img" aria-label="The last 30 days, day by day">
          <defs>
            <linearGradient id={`${gid}-fade`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--fg)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--fg)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ty != null && (
            <>
              <rect x="0" y={padT} width={width} height={Math.max(0, ty - padT)} fill="var(--ok)" opacity="0.045" />
              <rect x="0" y={ty} width={width} height={Math.max(0, padT + inner - ty)} fill="var(--bad)" opacity="0.035" />
            </>
          )}
          {points.map((p, i) => {
            const v = p.value ?? 0;
            const h = Math.max(v > 0 ? 2 : 0, padT + inner - y(v));
            const bw = Math.max(3, slot - 6);
            const t = toneOf(p.value, target);
            return <rect key={p.d} x={x(i) - bw / 2} y={padT + inner - h} width={bw} height={h} rx="2.5" fill={t === "none" ? "var(--fg-muted)" : TONE[t]} opacity={hover == null || hover === i ? (t === "none" ? 0.35 : 0.7) : 0.3} />;
          })}
          {line.length > 1 && (
            <>
              <path d={`M${line.join(" L")} L${x(points.length - 1)},${padT + inner} L${x(0)},${padT + inner} Z`} fill={`url(#${gid}-fade)`} />
              <path d={`M${line.join(" L")}`} fill="none" stroke="var(--fg)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
            </>
          )}
          {ty != null && (
            <>
              <line x1="0" x2={width} y1={ty} y2={ty} stroke="var(--fg-faint)" strokeDasharray="4 4" strokeWidth="1" />
              <text x={width - 4} y={ty - 6} textAnchor="end" fontSize="10.5" fill="var(--fg-muted)">
                {metric === "rpr" ? `Bar ${format(target)}` : `Target ${format(target)} a day`}
              </text>
            </>
          )}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + inner} stroke="var(--fg-faint)" strokeWidth="1" opacity="0.7" />}
          {points.map((p, i) =>
            (i % 6 === 0 && points.length - 1 - i >= 3) || i === points.length - 1 ? (
              <text key={`l-${p.d}`} x={x(i)} y={height - 5} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize="10.5" fill="var(--fg-faint)">
                {dateLabel(p.d)}
              </text>
            ) : null,
          )}
        </svg>
      )}
    </ScrubChart>
  );
}
