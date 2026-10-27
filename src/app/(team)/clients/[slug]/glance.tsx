import Link from "next/link";
import type { ClientKpi } from "@/lib/kpi/client";
import { STATUS, kpiValue } from "@/lib/kpi/format";
import type { SprintSummary } from "@/lib/sprints";
import type { AuditSummary } from "../../kpis/audit-panel";
import type { AccountChange } from "@/lib/account-changes";

// The top of a client page: in a minute, how each account is doing against its target, what the latest audit said,
// how the sprint is going, what's in motion, and anything that needs someone. Everything here is a link to the detail.

export type Alert = { tone: "bad" | "warn" | "info"; text: string; href: string };

const TONE = { bad: "bg-[#ff4d5e]", warn: "bg-[#f2b14c]", info: "bg-[#9aa8ff]" } as const;
const VERDICT: Record<string, string> = { off: "text-[#ff4d5e]", at_risk: "text-[#f2b14c]", on_track: "text-[#5be3a5]", winning: "text-[#5be3a5]" };

const ago = (iso: string, today: string) => {
  const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

export function Glance({
  accounts = true,
  kpis,
  audits,
  sprints,
  changes,
  alerts,
  inMotion,
  summary,
  today,
}: {
  /** The accounts against target (off on the whole-business view, where each service has its own card) */
  accounts?: boolean;
  kpis: ClientKpi[];
  audits: Record<string, AuditSummary>;
  sprints: Record<string, SprintSummary>;
  changes: Record<string, AccountChange[]>;
  alerts: Alert[];
  inMotion: { label: string; value: number; href: string }[];
  summary: string | null;
  today: string;
}) {
  const worst = kpis.some((k) => k.status === "off") ? "bad" : kpis.some((k) => k.status === "close") ? "warn" : kpis.length ? "ok" : "none";
  const glow = worst === "bad" ? "rgba(200,16,46,0.45)" : worst === "warn" ? "rgba(224,150,40,0.35)" : worst === "ok" ? "rgba(40,180,120,0.3)" : "rgba(90,110,255,0.28)";
  return (
    <section className="relative isolate grid gap-6 overflow-hidden rounded-[26px] border border-ink/[0.07] bg-deep p-5 md:p-7">
      <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 -z-10 h-[360px] w-[360px] rounded-full blur-[110px]" style={{ background: glow }} />
      <span aria-hidden className="pointer-events-none absolute -bottom-40 right-0 -z-10 h-[280px] w-[280px] rounded-full bg-[rgba(90,110,255,0.14)] blur-[120px]" />
      {summary && <p className="max-w-3xl text-[15px] leading-relaxed text-ink/80">{summary}</p>}

      <div className={`grid gap-5 ${accounts ? "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]" : "lg:grid-cols-2"}`}>
        {/* Each account against its target, with its audit and sprint */}
        <div className={accounts ? "grid content-start gap-3" : "hidden"}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/45">How the accounts are doing</p>
          {kpis.length === 0 && (
            <Link href="/kpis" className="rounded-[16px] border border-dashed border-ink/15 px-4 py-4 text-sm text-ink/60 hover:text-fg">
              No KPI target yet. Set one and every brief, report and audit starts from it →
            </Link>
          )}
          {kpis.map((k) => {
            const s = STATUS[k.status];
            const a = audits[k.id];
            const sp = sprints[k.id];
            const last = changes[k.id]?.[0];
            const live = k.status !== "setup" && k.status !== "idle";
            return (
              <div key={k.id} className="grid gap-3 rounded-[18px] border border-ink/[0.07] bg-ink/[0.03] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Link href={`/kpis?target=${k.id}`} className="grid min-w-0 gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium ${s.tone}`}>{s.label}</span>
                      <span className="text-ink/70">
                        {k.platform === "google" ? "Google" : "Meta"}
                        {k.label ? ` · ${k.label}` : ""} · {k.conversionLabel}
                      </span>
                    </span>
                    {k.owner && <span className="text-[11px] text-ink/40">{k.owner}</span>}
                  </Link>
                  {live && (
                    <Link href={`/kpis?target=${k.id}`} className="max-md:basis-full md:text-right">
                      <span className={`tabular block font-display text-3xl leading-none ${s.text}`}>{kpiValue(k.windows.d14?.value, k.roas)}</span>
                      <span className="text-[11px] text-ink/45">
                        14 days · target {kpiValue(k.target, k.roas)}
                        {k.trend ? ` · ${k.trend}` : ""}
                      </span>
                    </Link>
                  )}
                </div>
                <div className="grid gap-2 text-[12.5px] sm:grid-cols-2">
                  {a?.status === "ready" && a.verdict ? (
                    <Link href={`/kpis/audit/${a.id}`} className="grid gap-0.5 rounded-[12px] bg-ink/[0.04] px-3 py-2 hover:bg-ink/[0.07]">
                      <span className="text-[10px] uppercase tracking-[0.14em] text-ink/40">Latest audit · {ago(a.createdAt, today)}</span>
                      <span className={`line-clamp-2 ${VERDICT[a.verdict.status] ?? "text-ink/80"}`}>{a.verdict.headline}</span>
                    </Link>
                  ) : (
                    <span className="grid gap-0.5 rounded-[12px] bg-ink/[0.03] px-3 py-2 text-ink/45">
                      <span className="text-[10px] uppercase tracking-[0.14em]">Audit</span>
                      {a?.status === "running" ? "Running now…" : "Not audited yet"}
                    </span>
                  )}
                  {sp ? (
                    <Link href={`/kpis/sprint/${sp.id}`} className="grid gap-1 rounded-[12px] bg-ink/[0.04] px-3 py-2 hover:bg-ink/[0.07]">
                      <span className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-ink/40">
                        Sprint in motion
                        <span className="tabular normal-case tracking-normal text-ink/60">
                          {sp.done}/{sp.total}
                        </span>
                      </span>
                      <span className="h-1 overflow-hidden rounded-full bg-ink/10">
                        <span className="block h-full rounded-full bg-[#5be3a5]" style={{ width: `${sp.total ? (sp.done / sp.total) * 100 : 0}%` }} />
                      </span>
                      {sp.message && <span className="line-clamp-1 text-ink/60">{sp.message}</span>}
                    </Link>
                  ) : (
                    <span className="grid gap-0.5 rounded-[12px] bg-ink/[0.03] px-3 py-2 text-ink/45">
                      <span className="text-[10px] uppercase tracking-[0.14em]">Sprint</span>
                      {last ? `Last change ${ago(last.at, today)}${last.who ? ` by ${last.who}` : ""}` : "No sprint running"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* What's in motion, and what needs someone */}
        <div className="grid content-start gap-4">
          {inMotion.length > 0 && (
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/45">In motion</p>
              <div className="grid grid-cols-2 gap-2">
                {inMotion.map((m) => (
                  <Link key={m.label} href={m.href} className="grid gap-0.5 rounded-[14px] bg-ink/[0.04] px-3 py-2.5 hover:bg-ink/[0.07]">
                    <span className="tabular font-display text-2xl leading-none text-fg">{m.value}</span>
                    <span className="text-[11px] text-ink/50">{m.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ink/45">Needs someone</p>
            {alerts.length ? (
              <ul className="grid gap-1.5">
                {alerts.map((a) => (
                  <li key={a.text}>
                    <Link href={a.href} className="flex min-h-11 items-start gap-2.5 rounded-[12px] px-2 py-2.5 text-[13px] md:min-h-0 md:py-1.5 text-ink/80 hover:bg-ink/[0.05] hover:text-fg">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE[a.tone]}`} />
                      {a.text}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-2 text-[13px] text-[#5be3a5]">
                <span className="grid h-4 w-4 place-items-center rounded-full bg-[#5be3a5]/20 text-[9px]">✓</span>
                Nothing waiting on anyone
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
