import Link from "next/link";
import { Section } from "@/components/ui";
import type { ClientKpi } from "@/lib/kpi/client";
import { STATUS, kpiValue } from "@/lib/kpi/format";
import { DailyChart, PaceBar } from "../../kpis/kpi-charts";
import { AuditPanel, type AuditSummary } from "../../kpis/audit-panel";

// How the client's ad accounts are doing against their targets, from the KPI tracker (refreshed every 2 hours).
// The same picture every agent reads before it writes a brief, copy or a review for this client. Each KPI carries its
// account audit: the same audit as on the KPI board, so one started here shows there and the other way round.

/** "16% above target", the way a buyer says it for a cost or for ROAS. */
function gap(k: ClientKpi) {
  if (k.deviation == null) return k.status === "off" ? "Spending with no results" : null;
  const n = Math.abs(Math.round(k.deviation * 100));
  if (n === 0) return "Right on target";
  const better = k.deviation < 0;
  return k.roas ? `${n}% ${better ? "above" : "below"} target` : `${n}% ${better ? "below" : "above"} target`;
}

const change = (x: number | null) =>
  x == null ? { text: "—", tone: "text-faint" } : Math.abs(x) < 0.01 ? { text: "same", tone: "text-muted" } : { text: `${Math.round(Math.abs(x) * 100)}% ${x > 0 ? "worse" : "better"}`, tone: x > 0.05 ? "text-bad" : x < -0.05 ? "text-ok" : "text-muted" };

const TREND = { improving: { text: "Improving", tone: "text-ok", arrow: "↘" }, steady: { text: "Steady", tone: "text-muted", arrow: "→" }, slipping: { text: "Slipping", tone: "text-bad", arrow: "↗" } } as const;

export function KpiPanel({ kpis, audits }: { kpis: ClientKpi[]; audits?: Record<string, AuditSummary> | null }) {
  const synced = kpis.map((k) => k.computedAt).filter(Boolean).sort().at(-1);
  return (
    <Section
      title="Performance vs target"
      description="Every agent reads this before it writes for this client, so a brief for an off-target account knows it's off target."
      action={
        <Link href="/kpis" className="text-xs text-muted hover:text-fg">
          All KPIs →
        </Link>
      }
    >
      {kpis.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-dashed border-line px-4 py-4">
          <p className="text-sm text-muted">No KPI target yet. Set one and every brief, copy set and review starts from it.</p>
          <Link href="/kpis" className="rounded-brand border border-line px-3 py-1.5 text-xs text-muted hover:text-fg">
            Set a target
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {kpis.map((k) => {
            const s = STATUS[k.status];
            const live = k.status !== "setup" && k.status !== "idle";
            const month = change(k.vsMonth);
            const trend = k.trend ? TREND[k.trend] : null;
            return (
              <article key={k.id} className="@container grid gap-4 rounded-[14px] border border-line bg-bg/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium ${s.tone}`}>{s.label}</span>
                      <span className="text-xs text-muted">
                        {k.platform === "google" ? "Google" : "Meta"}
                        {k.label ? ` · ${k.label}` : ""} · {k.conversionLabel}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-3 text-[11px] text-faint">
                      {k.owner && <span>Buyer: {k.owner}</span>}
                      <Link href={`/kpis?target=${k.id}`} className="text-muted hover:text-fg">
                        Open on the KPI board →
                      </Link>
                    </span>
                  </div>
                  {live && (
                    <div className="text-right">
                      <p className={`tabular font-display text-3xl leading-none ${s.text}`}>{kpiValue(k.windows.d14?.value, k.roas)}</p>
                      <p className="mt-1 text-[11px] text-faint">
                        last 14 days · target <span className="tabular text-muted">{kpiValue(k.target, k.roas)}</span>
                        {k.source === "client" ? " (client's)" : ""}
                      </p>
                    </div>
                  )}
                </div>

                {live ? (
                  <>
                    <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                      {(
                        [
                          ["Last 7 days", kpiValue(k.windows.d7?.value, k.roas), null],
                          ["Last 30 days", kpiValue(k.windows.d30?.value, k.roas), null],
                          ["vs last month", month.text, month.tone],
                          ["Trend", trend ? `${trend.arrow} ${trend.text}` : "—", trend?.tone ?? "text-faint"],
                        ] as const
                      ).map(([label, value, tone]) => (
                        <div key={label} className="rounded-[10px] bg-surface-2/60 px-3 py-2">
                          <p className="text-[11px] text-faint">{label}</p>
                          <p className={`tabular text-sm ${tone ?? "text-fg"}`}>{value}</p>
                        </div>
                      ))}
                    </div>
                    {gap(k) && <p className={`text-sm ${s.text}`}>{gap(k)} over the last 14 days.</p>}
                    <div className="grid gap-4 @xl:grid-cols-[minmax(0,1fr)_220px]">
                      <div className="grid gap-1">
                        <p className="text-[11px] text-faint">Daily spend and results</p>
                        <DailyChart daily={k.daily.slice(-30)} height={96} />
                      </div>
                      <div className="grid content-start gap-1">
                        <p className="text-[11px] text-faint">This month&apos;s budget</p>
                        <PaceBar pace={k.pace} />
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted">{k.status === "idle" ? "Not spending right now." : k.error ?? "Waiting for its first sync."}</p>
                )}
                {audits && k.accountId && <AuditPanel targetId={k.id} audit={audits[k.id] ?? null} platform={k.platform} />}
              </article>
            );
          })}
          {synced && <p className="text-[11px] text-faint">Synced {new Date(synced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</p>}
        </div>
      )}
    </Section>
  );
}
