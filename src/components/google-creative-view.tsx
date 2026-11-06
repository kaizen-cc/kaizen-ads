import type { GoogleCopyStat, GoogleCreativeAnalysis } from "@/lib/google-creative-core";

// The "Creative analysis" of a Google Ads audit: on Google the creative is the copy. The best and worst headlines and
// descriptions with Google's rating and their numbers, the Performance Max asset groups, and the themes in the
// searches that convert (flagged when no headline says them). What to write next is the audit's own creative ideas.

const LABEL: Record<string, string> = { BEST: "bg-ok-soft text-ok", GOOD: "bg-brand/15 text-brand-text", LOW: "bg-bad-soft text-bad" };

function Row({ s, roas, side }: { s: GoogleCopyStat; roas: boolean; side: "top" | "bottom" }) {
  const kpi = roas ? (s.roas != null ? `${s.roas}x` : null) : s.cpa != null ? `$${s.cpa}` : null;
  return (
    <li className={`grid min-w-0 gap-1.5 rounded-[14px] border bg-surface p-3 ${side === "top" ? "border-ok/30" : "border-bad/30"}`}>
      <p className="font-heading text-[15px] leading-snug [overflow-wrap:anywhere]">{s.text}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        {s.label && <span className={`rounded-full px-2 py-0.5 ${LABEL[s.label] ?? "bg-surface-2 text-muted"}`}>{s.label.charAt(0) + s.label.slice(1).toLowerCase()}</span>}
        {s.pinned && <span className="rounded-full bg-surface-2 px-2 py-0.5">Pinned {s.pinned.toLowerCase().replace("_", " ")}</span>}
        <span className="tabular">
          <span className="text-faint">CTR</span> {s.ctr ?? "?"}%
        </span>
        <span className="tabular">
          <span className="text-faint">Conv</span> {s.conversions}
        </span>
        {kpi && (
          <span className="tabular">
            <span className="text-faint">{roas ? "ROAS" : "CPA"}</span> {kpi}
          </span>
        )}
        <span className="tabular text-faint">{s.impressions.toLocaleString("en-US")} impr.</span>
      </div>
    </li>
  );
}

function Pair({ title, top, bottom, roas }: { title: string; top: GoogleCopyStat[]; bottom: GoogleCopyStat[]; roas: boolean }) {
  if (!top.length && !bottom.length) return null;
  return (
    <div className="grid gap-3">
      <p className="font-heading">{title}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <ul className="grid content-start gap-2">
          <li className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
            <span className="h-2 w-2 rounded-full bg-ok" /> Best
          </li>
          {top.length ? top.map((s) => <Row key={s.text} s={s} roas={roas} side="top" />) : <li className="text-sm text-faint">Nothing converting yet.</li>}
        </ul>
        <ul className="grid content-start gap-2">
          <li className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
            <span className="h-2 w-2 rounded-full bg-bad" /> Worst
          </li>
          {bottom.length ? bottom.map((s) => <Row key={s.text} s={s} roas={roas} side="bottom" />) : <li className="text-sm text-faint">Nothing clearly weak.</li>}
        </ul>
      </div>
    </div>
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

export function GoogleCreativeView({ a, nextHint }: { a: GoogleCreativeAnalysis; nextHint?: string }) {
  const gaps = a.read?.gaps?.length ? a.read.gaps : a.themes.filter((t) => !t.covered).map((t) => `"${t.theme}" converts (${t.conversions} conv) but no headline says it.`);
  return (
    <div className="grid gap-6">
      <Pair title="Headlines" top={a.headlines.top} bottom={a.headlines.bottom} roas={a.roas} />
      <Pair title="Descriptions" top={a.descriptions.top} bottom={a.descriptions.bottom} roas={a.roas} />
      {a.groups.length > 0 && (
        <div className="grid gap-2">
          <p className="font-heading">Performance Max asset groups</p>
          <ul className="grid gap-2 md:grid-cols-2">
            {a.groups.map((g) => (
              <li key={`${g.campaign}|${g.name}`} className="grid min-w-0 gap-1 rounded-[14px] border border-line bg-surface p-3">
                <p className="truncate text-[14px]" title={`${g.campaign} › ${g.name}`}>
                  {g.name}
                </p>
                <p className="flex flex-wrap gap-x-3 text-[11px] tabular text-muted">
                  <span>${Math.round(g.spend).toLocaleString("en-US")}</span>
                  <span>{g.conversions} conv</span>
                  <span>{a.roas ? `${g.roas ?? 0}x` : g.cpa != null ? `$${g.cpa}/conv` : "no conv"}</span>
                  {g.strength && <span>Strength {g.strength.toLowerCase()}</span>}
                  {g.pmaxLow > 0 && <span className="text-bad">{g.pmaxLow} rated Low</span>}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.themes.length > 0 && (
        <div className="grid gap-2">
          <p className="font-heading">What the converting searches are about</p>
          <div className="flex flex-wrap gap-2">
            {a.themes.map((t) => (
              <span key={t.theme} title={t.terms.join(", ")} className={`rounded-full px-3 py-1.5 text-[12.5px] ${t.covered ? "bg-surface-2 text-muted" : "bg-warn-soft text-warn"}`}>
                {t.theme} · {t.conversions} conv{t.covered ? "" : " · no headline says it"}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Lines title="What the winners have in common" items={a.read?.common ?? []} />
        <Lines title="What's dragging" items={a.read?.fatiguing ?? []} tone="warn" />
        <Lines title="What's missing" items={gaps} />
      </div>
      {nextHint && <p className="text-[13px] text-muted">{nextHint}</p>}
    </div>
  );
}
