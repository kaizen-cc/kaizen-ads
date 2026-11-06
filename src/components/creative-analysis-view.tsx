import { AdImg } from "@/components/ad-img";
import type { CreativeAdStats, CreativeAnalysis } from "@/lib/creative-analysis-core";

// The "Creative analysis" section of an account audit and the business audit: the KPI's best and worst creatives with
// their pictures and numbers, what the winners share, what's tiring and what's missing. What to make next is the
// audit's own creative ideas (each with Brief it), right after.

const money = (x: number | null, roas: boolean) => (x == null ? "none" : roas ? `${x}x` : `$${x < 100 ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")}`);
const DIM: Record<string, string> = { angle: "Angle", avatar: "Avatar", format: "Format", hook: "Hook", offer: "Offer", length: "Length" };

function AdCard({ a, roas, side, ref0 }: { a: CreativeAdStats; roas: boolean; side: "top" | "bottom"; ref0: number | null }) {
  const kpi = roas ? a.roas : a.cpa;
  const better = kpi != null && ref0 != null ? (roas ? kpi >= ref0 : kpi <= ref0) : null;
  const stats: [string, string | null][] = [
    ["Hook", a.hookRate != null ? `${a.hookRate}%` : null],
    ["Hold", a.holdRate != null ? `${a.holdRate}%` : null],
    ["Watched", a.watchPct != null ? `${a.watchPct}%` : null],
    ["CTR", a.ctr != null ? `${a.ctr}%` : null],
    ["Spend", `${a.share}%`],
  ];
  return (
    <article className={`grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-3 rounded-[16px] border bg-surface p-3 md:grid-cols-[84px_minmax(0,1fr)] ${side === "top" ? "border-ok/30" : "border-bad/30"}`}>
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-[10px] bg-surface-2">
        <AdImg src={a.thumb} adId={a.id} alt="" className="h-full w-full object-cover" />
        {a.fatigue && <span className="absolute inset-x-1 bottom-1 rounded-full bg-warn px-1.5 py-0.5 text-center text-[9px] font-medium text-bg">{a.fatigue}</span>}
      </div>
      <div className="grid min-w-0 content-start gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className={`font-display text-xl tabular tracking-tight ${better == null ? "" : better ? "text-ok" : "text-bad"}`}>{kpi == null ? (roas ? "0x" : "No results") : money(kpi, roas)}</p>
          <p className="shrink-0 text-[11px] tabular text-faint">${Math.round(a.spend).toLocaleString("en-US")}</p>
        </div>
        <p className="truncate text-[13px] leading-snug" title={a.name}>
          {a.headline || a.name}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {stats
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <span key={k} className="tabular">
                <span className="text-faint">{k}</span> {v}
              </span>
            ))}
        </div>
        {(a.angle || a.format) && (
          <div className="flex flex-wrap gap-1 text-[10.5px]">
            {[a.format && (a.videoSeconds ? `${a.format} · ${Math.round(a.videoSeconds)}s` : a.format), a.angle, a.avatar]
              .filter(Boolean)
              .map((x) => (
                <span key={x as string} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-muted">
                  {x}
                </span>
              ))}
          </div>
        )}
      </div>
    </article>
  );
}

function Lines({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  if (!items.length) return null;
  return (
    <div className={`grid min-w-0 content-start gap-2 rounded-[16px] border p-4 ${tone === "warn" ? "border-warn/30 bg-warn-soft" : "border-line bg-surface"}`}>
      <p className="text-[10px] uppercase tracking-[0.16em] text-faint">{title}</p>
      <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
        {items.map((x, i) => (
          <li key={i} className="grid grid-cols-[10px_minmax(0,1fr)] gap-2">
            <span className="mt-2 h-1 w-1 rounded-full bg-faint" />
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CreativeAnalysisView({ a, nextHint }: { a: CreativeAnalysis; nextHint?: string }) {
  const ref0 = a.target ?? a.average;
  const common = a.read?.common?.length ? a.read.common : a.traits.filter((t) => t.winners >= 2).map((t) => `${DIM[t.dimension]}: ${t.value} (${t.winners} of the top ${a.top.length}${t.losers ? `, ${t.losers} of the bottom` : ""})`);
  const tiring = a.read?.fatiguing?.length ? a.read.fatiguing : a.fatiguing.map((f) => `${f.name}: ${f.severity}${f.note ? `, ${f.note}` : ""}`);
  const gaps = a.read?.gaps?.length ? a.read.gaps : a.gaps;
  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[16px] border border-line bg-line">
        {[
          [String(a.ads), `ads, last ${a.days} days`],
          [`$${Math.round(a.spend).toLocaleString("en-US")}`, "spent in the KPI's campaigns"],
          [money(a.average, a.roas), a.target != null ? `average · target ${money(a.target, a.roas)}` : `average ${a.roas ? "ROAS" : `per ${a.label.replace(/s$/, "")}`}`],
        ].map(([v, l]) => (
          <div key={l} className="grid min-w-0 gap-0.5 bg-surface px-3 py-3 md:px-4">
            <dd className="font-display text-lg tabular tracking-tight md:text-2xl">{v}</dd>
            <dt className="text-[11px] leading-snug text-muted">{l}</dt>
          </div>
        ))}
      </dl>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="grid content-start gap-2.5">
          <p className="flex items-center gap-2 font-heading">
            <span className="h-2 w-2 rounded-full bg-ok" />
            Top creatives
          </p>
          {a.top.length ? a.top.map((x) => <AdCard key={x.id} a={x} roas={a.roas} side="top" ref0={ref0} />) : <p className="text-sm text-faint">No ad has a fair share of spend and results yet.</p>}
        </div>
        <div className="grid content-start gap-2.5">
          <p className="flex items-center gap-2 font-heading">
            <span className="h-2 w-2 rounded-full bg-bad" />
            Bottom creatives
          </p>
          {a.bottom.length ? a.bottom.map((x) => <AdCard key={x.id} a={x} roas={a.roas} side="bottom" ref0={ref0} />) : <p className="text-sm text-faint">Nothing clearly worse than the account.</p>}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Lines title="What the winners have in common" items={common} />
        <Lines title="What's tiring" items={tiring} tone="warn" />
        <Lines title="What's missing" items={gaps} />
      </div>
      {nextHint && <p className="text-[13px] text-muted">{nextHint}</p>}
    </div>
  );
}
