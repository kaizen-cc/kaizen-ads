"use client";

import Link from "next/link";
import { LINE_LABEL, type KpiLine, type Scorecard } from "@/lib/clients-kpi/core";

// The executive summary at the top of the Clients list (execs and leads): the success ratio (KPI'd lines on or better
// than target, and clients with every line there), how many accounts are in the red and critical, each line's on /
// close / off with where it's heading, and the high-priority accounts with their top reason. Counted over the tab
// that's open, from the same numbers as the cards; pressing a count narrows the list to it.

const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);

function Ring({ value, size = 92 }: { value: number | null; size?: number }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value ?? 0));
  const tone = value == null ? "text-faint" : v >= 0.7 ? "text-ok" : v >= 0.5 ? "text-warn" : "text-bad";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="7" className="text-surface-2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} className={`${tone} transition-[stroke-dasharray] duration-700`} />
    </svg>
  );
}

function LineBar({ s }: { s: Scorecard["lines"][number] }) {
  const total = Math.max(1, s.on + s.close + s.off);
  const seg = (n: number, cls: string) => (n ? <span className={`${cls} h-full`} style={{ width: `${(n / total) * 100}%` }} /> : null);
  return (
    <div className="grid min-w-0 gap-1.5 rounded-xl bg-surface-2/60 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{LINE_LABEL[s.line]}</span>
        <span className="tabular text-[11px] text-faint">{s.judged ? `${s.on}/${s.judged} on` : "not judged"}</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface" aria-label={`${s.on} on target, ${s.close} close, ${s.off} off`}>
        {seg(s.on, "bg-ok")}
        {seg(s.close, "bg-warn")}
        {seg(s.off, "bg-bad")}
      </div>
      <div className="tabular flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted">
        <span>
          <span className="text-ok">{s.on}</span> · <span className="text-warn">{s.close}</span> · <span className="text-bad">{s.off}</span>
        </span>
        {s.improving > 0 && <span className="text-ok">↑ {s.improving}</span>}
        {s.slipping > 0 && <span className="text-bad">↓ {s.slipping}</span>}
        {s.pace != null && <span title={s.line === "email" ? "Revenue against the month's target" : s.line === "creative" ? "Creative delivered against what's due by today" : "Spend against the month's budget"}>pace {pct(s.pace)}</span>}
      </div>
    </div>
  );
}

export function ExecSummary({
  card,
  critical,
  slugs,
  line,
  active,
  onPick,
}: {
  card: Scorecard;
  /** Clients at or over the critical line (the summary's count) */
  critical: number;
  /** Client id to page address, for the high-priority list */
  slugs: Record<string, string>;
  /** The line a service tab narrows to */
  line: KpiLine | null;
  active: "off" | "critical" | null;
  onPick: (k: "off" | "critical") => void;
}) {
  if (!card.linesJudged) return null;

  return (
    <section aria-label="Executive summary" className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1.3fr)] md:gap-6 md:p-5">
      <div className="flex items-center gap-4">
        <div className="relative grid place-items-center">
          <Ring value={card.lineRatio} />
          <span className="tabular absolute font-heading text-2xl">{pct(card.lineRatio)}</span>
        </div>
        <div className="grid min-w-0 gap-1">
          <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Success ratio{line ? ` · ${LINE_LABEL[line]}` : ""}</p>
          <p className="text-sm leading-snug">
            <span className="tabular font-medium">{card.linesOn}</span> of {card.linesJudged} KPI&apos;d lines on or better than target
          </p>
          <p className="text-xs text-muted">
            <span className="tabular">{pct(card.clientRatio)}</span> of clients ({card.clientsOn}/{card.clientsJudged}) on every line
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onPick("off")} aria-pressed={active === "off"} className={`inline-flex h-11 items-center rounded-full px-3 text-xs font-medium transition-colors md:h-7 ${active === "off" ? "bg-fg text-bg" : "bg-bad-soft text-bad hover:brightness-110"}`}>
              {card.inRed} in the red
            </button>
            {critical > 0 && (
              <button type="button" onClick={() => onPick("critical")} aria-pressed={active === "critical"} className={`inline-flex h-11 items-center rounded-full px-3 text-xs font-medium transition-colors md:h-7 ${active === "critical" ? "bg-fg text-bg" : "bg-bad-soft text-bad hover:brightness-110"}`}>
                {critical} critical
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid content-start gap-2">
        <p className="text-[11px] uppercase tracking-[0.12em] text-faint">By line</p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {card.lines.map((s) => (
            <LineBar key={s.line} s={s} />
          ))}
        </div>
      </div>

      <div className="grid content-start gap-2">
        <p className="text-[11px] uppercase tracking-[0.12em] text-faint">High priority</p>
        {card.highPriority.length ? (
          <ol className="grid gap-1">
            {card.highPriority.map((c, i) => (
              <li key={c.id}>
                <Link href={slugs[c.id] ? `/clients/${slugs[c.id]}` : "/clients"} className="group flex min-h-11 items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2 md:min-h-0">
                  <span className="tabular mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-bad-soft text-[11px] font-semibold text-bad">{i + 1}</span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-sm font-medium group-hover:text-brand-text">{c.name}</span>
                    {c.reasons[0] && <span className="line-clamp-1 text-[11.5px] text-muted">{c.reasons[0]}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg bg-ok-soft px-3 py-2.5 text-sm text-ok">Nothing critical right now.</p>
        )}
      </div>
    </section>
  );
}
