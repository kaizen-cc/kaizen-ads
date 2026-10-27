import type { ClientKpi } from "@/lib/kpi/client";
import type { PlatformSummary } from "@/lib/client-campaigns";
import { STATUS, kpiValue } from "@/lib/kpi/format";
import type { AuditSummary } from "../../kpis/audit-panel";
import type { SprintSummary } from "@/lib/sprints";
import { OpenService } from "./client-sections";

// The whole business at a glance: every service the client buys side by side (paid ads on each platform, creative,
// and what's run outside Kaizen Ads), what all their advertising spent together, and a way into each service.

export type ServiceCard =
  | { id: "meta" | "google"; kind: "ads"; label: string; kpis: ClientKpi[]; summary: PlatformSummary | null; extra: string[] }
  | { id: "creative"; kind: "creative"; label: string; package: string | null; used: number; allotted: number; moving: number; waiting: number; live: number }
  | { id: string; kind: "other"; label: string; tier: string | null };

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const RANK = { off: 0, close: 1, setup: 2, idle: 3, good: 4, excellent: 5 } as const;
const COLOR: Record<string, string> = { meta: "#6c7ee1", google: "#5be3a5" };

export function BusinessOverview({ cards, audits, sprints }: { cards: ServiceCard[]; audits: Record<string, AuditSummary>; sprints: Record<string, SprintSummary> }) {
  const ads = cards.filter((c): c is Extract<ServiceCard, { kind: "ads" }> => c.kind === "ads");
  const spend = ads.reduce((n, c) => n + (c.summary?.spend ?? 0), 0);
  const prev = ads.reduce((n, c) => n + (c.summary?.prevSpend ?? 0), 0);
  return (
    <div className="grid gap-5">
      {ads.length > 0 && spend > 0 && (
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface/60 p-4 md:p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">All advertising · last 30 days</span>
              <span className="tabular font-display text-3xl leading-none">{money(spend)}</span>
            </div>
            {prev > 0 && (
              <span className="text-xs text-muted">
                {spend >= prev ? "+" : ""}
                {Math.round(((spend - prev) / prev) * 100)}% vs the 30 days before ({money(prev)})
              </span>
            )}
          </div>
          {/* Where the money went, platform by platform */}
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2">
            {ads.map((c) => (c.summary?.spend ? <span key={c.id} style={{ width: `${(c.summary.spend / spend) * 100}%`, background: COLOR[c.id] }} /> : null))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
            {ads.map((c) => (
              <span key={c.id} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: COLOR[c.id] }} />
                {c.label} {money(c.summary?.spend ?? 0)}
                <span className="text-faint">· {spend ? Math.round(((c.summary?.spend ?? 0) / spend) * 100) : 0}%</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {cards.map((c) => {
          if (c.kind === "ads") {
            const worst = [...c.kpis].sort((a, b) => RANK[a.status] - RANK[b.status])[0];
            const s = worst ? STATUS[worst.status] : null;
            const audit = worst ? audits[worst.id] : null;
            const sprint = c.kpis.map((k) => sprints[k.id]).find(Boolean);
            const p = c.summary;
            const cpr = p && !p.roas && p.results ? p.spend / p.results : null;
            return (
              <OpenService key={c.id} id={c.id} className="group grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR[c.id] }} />
                    {c.label}
                  </span>
                  {s && <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${s.tone}`}>{s.label}</span>}
                </span>
                {worst ? (
                  <span className="flex flex-wrap items-end gap-x-3 gap-y-1">
                    <span className={`tabular font-display text-3xl leading-none ${s?.text ?? ""}`}>{kpiValue(worst.windows.d14?.value, worst.roas)}</span>
                    <span className="pb-0.5 text-xs text-faint">
                      {worst.conversionLabel} · 14 days · target {kpiValue(worst.target, worst.roas)}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-faint">No KPI target set</span>
                )}
                {p && (
                  <span className="grid grid-cols-3 gap-2 text-xs">
                    <Stat k="Spend · 30d" v={money(p.spend)} />
                    <Stat k={p.roas ? "Revenue" : p.resultLabel} v={p.roas ? money(p.value) : p.results.toLocaleString("en-US", { maximumFractionDigits: 0 })} />
                    <Stat k={p.roas ? "ROAS" : "Per result"} v={p.roas ? (p.spend ? `${(p.value / p.spend).toFixed(2)}x` : "—") : cpr ? `$${cpr.toFixed(cpr < 100 ? 2 : 0)}` : "—"} />
                  </span>
                )}
                {(audit?.verdict || sprint || c.extra.length > 0) && (
                  <span className="grid gap-1 border-t border-line pt-3 text-xs text-muted">
                    {audit?.status === "ready" && audit.verdict && <span className="line-clamp-2">Audit: {audit.verdict.headline}</span>}
                    {sprint && (
                      <span>
                        Sprint {sprint.done}/{sprint.total} moves done
                      </span>
                    )}
                    {c.extra.map((x) => (
                      <span key={x}>{x}</span>
                    ))}
                  </span>
                )}
                <span className="text-xs text-faint group-hover:text-fg">Open {c.label} →</span>
              </OpenService>
            );
          }
          if (c.kind === "creative") {
            const pct = c.allotted ? Math.min(100, Math.round((c.used / c.allotted) * 100)) : 0;
            return (
              <OpenService key={c.id} id={c.id} className="group grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#f2b14c]" />
                    {c.label}
                  </span>
                  {c.package && <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand-text">{c.package}</span>}
                </span>
                {c.allotted > 0 ? (
                  <span className="grid gap-1.5">
                    <span className="flex items-end gap-2">
                      <span className="tabular font-display text-3xl leading-none">
                        {c.used}
                        <span className="text-lg text-faint">/{c.allotted}</span>
                      </span>
                      <span className="pb-0.5 text-xs text-faint">made this month</span>
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full bg-[#f2b14c]" style={{ width: `${pct}%` }} />
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-faint">No monthly allotment set</span>
                )}
                <span className="grid grid-cols-3 gap-2 text-xs">
                  <Stat k="In production" v={String(c.moving)} />
                  <Stat k="With the client" v={String(c.waiting)} />
                  <Stat k="Ads live" v={String(c.live)} />
                </span>
                <span className="text-xs text-faint group-hover:text-fg">Open Creative →</span>
              </OpenService>
            );
          }
          return (
            <div key={c.id} className="grid content-start gap-1.5 rounded-[18px] border border-dashed border-line p-4 md:p-5">
              <span className="flex items-center justify-between gap-2 font-medium">
                {c.label}
                {c.tier && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">{c.tier}</span>}
              </span>
              <span className="text-xs text-faint">Run outside Kaizen Ads. Its tier and team are in Team &amp; setup.</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <span className="grid gap-0.5 rounded-[10px] bg-surface-2/70 px-2.5 py-2">
      <span className="truncate text-[10.5px] text-faint">{k}</span>
      <span className="tabular text-sm text-fg">{v}</span>
    </span>
  );
}
