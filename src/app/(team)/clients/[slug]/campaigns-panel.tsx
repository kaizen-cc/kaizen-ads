import { Section } from "@/components/ui";
import type { PlatformSummary } from "@/lib/client-campaigns";

// One platform's campaigns over the last 30 days: what each spent, what it brought in (counted like the KPI) and at
// what cost, against the 30 days before. Google adds how much of the auction it's getting and what it loses.

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const TYPE: Record<string, string> = { SEARCH: "Search", PERFORMANCE_MAX: "PMax", DISPLAY: "Display", VIDEO: "YouTube", SHOPPING: "Shopping", DEMAND_GEN: "Demand Gen", LOCAL: "Local", SMART: "Smart" };

/** Cost per result (or ROAS), and whether it got better than the 30 days before */
function efficiency(spend: number, results: number, value: number, prevSpend: number, prevResults: number, roas: boolean) {
  if (roas) return { now: spend ? `${(value / spend).toFixed(2)}x` : "—", better: null };
  const now = results ? spend / results : null;
  const before = prevResults ? prevSpend / prevResults : null;
  return { now: now == null ? "—" : money(now), better: now != null && before != null ? now < before : null };
}

export function CampaignsPanel({ p }: { p: PlatformSummary }) {
  const name = p.platform === "google" ? "Google" : "Meta";
  const live = p.campaigns.filter((c) => c.spend > 0);
  const total = efficiency(p.spend, p.results, p.value, p.prevSpend, p.prevResults, p.roas);
  return (
    <Section title={`${name} campaigns`} description={`Last 30 days, against the 30 before. Results counted as the KPI counts them (${p.resultLabel}).`}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          { k: "Spend", v: money(p.spend), sub: p.prevSpend ? `${p.spend >= p.prevSpend ? "+" : ""}${Math.round(((p.spend - p.prevSpend) / p.prevSpend) * 100)}% vs before` : null },
          { k: p.roas ? "Revenue" : p.resultLabel, v: p.roas ? money(p.value) : p.results.toLocaleString("en-US", { maximumFractionDigits: 1 }), sub: p.prevResults && !p.roas ? `${p.prevResults.toLocaleString("en-US", { maximumFractionDigits: 1 })} before` : null },
          { k: p.roas ? "ROAS" : "Cost per result", v: total.now, sub: total.better == null ? null : total.better ? "Better than before" : "Worse than before", tone: total.better == null ? "" : total.better ? "text-ok" : "text-bad" },
          { k: "Campaigns spending", v: String(live.length), sub: `${p.accounts.length} account${p.accounts.length === 1 ? "" : "s"}` },
        ].map((s) => (
          <div key={s.k} className="grid gap-0.5 rounded-[12px] bg-surface-2/70 px-3.5 py-3">
            <span className="text-[11px] text-faint">{s.k}</span>
            <span className="tabular font-display text-xl leading-tight">{s.v}</span>
            {s.sub && <span className={`text-[11px] ${"tone" in s && s.tone ? s.tone : "text-faint"}`}>{s.sub}</span>}
          </div>
        ))}
      </div>
      {p.campaigns.length ? (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-faint">
                <th className="px-1 py-2 font-medium">Campaign</th>
                <th className="px-1 py-2 text-right font-medium">Spend</th>
                <th className="px-1 py-2 text-right font-medium">{p.roas ? "Revenue" : "Results"}</th>
                <th className="px-1 py-2 text-right font-medium">{p.roas ? "ROAS" : "Per result"}</th>
                <th className="px-1 py-2 text-right font-medium">CTR</th>
                {p.platform === "google" && <th className="px-1 py-2 text-right font-medium" title="Share of the impressions it could have had · lost to budget · lost to rank">Impr. share</th>}
              </tr>
            </thead>
            <tbody>
              {p.campaigns.slice(0, 25).map((c) => {
                const e = efficiency(c.spend, c.results, c.value, c.prevSpend, c.prevResults, p.roas);
                return (
                  <tr key={c.id} className={`border-t border-line ${c.spend ? "" : "opacity-50"}`}>
                    <td className="max-w-[280px] px-1 py-2.5">
                      <span className="block truncate" title={c.name}>
                        {c.name}
                      </span>
                      {c.type && <span className="text-[11px] text-faint">{TYPE[c.type] ?? c.type.toLowerCase()}</span>}
                      {!c.spend && <span className="text-[11px] text-faint">Not spending (spent {money(c.prevSpend)} before)</span>}
                    </td>
                    <td className="tabular px-1 py-2.5 text-right">{money(c.spend)}</td>
                    <td className="tabular px-1 py-2.5 text-right">{p.roas ? money(c.value) : c.results.toLocaleString("en-US", { maximumFractionDigits: 1 })}</td>
                    <td className={`tabular px-1 py-2.5 text-right ${e.better == null ? "" : e.better ? "text-ok" : "text-bad"}`}>{e.now}</td>
                    <td className="tabular px-1 py-2.5 text-right text-muted">{c.impressions ? pct(c.clicks / c.impressions) : "—"}</td>
                    {p.platform === "google" && (
                      <td className="tabular px-1 py-2.5 text-right text-muted">
                        {pct(c.share?.is)}
                        {c.share?.is != null && (c.share.lostBudget ?? 0) + (c.share.lostRank ?? 0) > 0.05 && (
                          <span className="block text-[11px] text-faint">
                            −{pct(c.share.lostBudget)} budget · −{pct(c.share.lostRank)} rank
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-faint">No campaign data in the last 60 days.</p>
      )}
    </Section>
  );
}
