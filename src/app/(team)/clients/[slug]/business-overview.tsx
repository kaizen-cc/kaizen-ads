import type { ClientKpi } from "@/lib/kpi/client";
import type { PlatformSummary } from "@/lib/client-campaigns";
import { STATUS, kpiValue } from "@/lib/kpi/format";
import type { AuditSummary } from "../../kpis/audit-panel";
import type { SprintSummary } from "@/lib/sprints";
import { OpenService } from "./client-sections";
import { allotmentPools, type PoolCounts } from "@/lib/allotment";
import { pulseStatus, type HealthFinding } from "@/lib/klaviyo/insights";
import type { SocialSummary } from "@/lib/social/summary";
import Link from "next/link";

// The whole business at a glance: every service the client buys side by side (paid ads on each platform, creative,
// and what's run outside Kaizen Ads), what all their advertising spent together, and a way into each service.

export type ServiceCard =
  | { id: "meta" | "google" | "tiktok"; kind: "ads"; label: string; kpis: ClientKpi[]; summary: PlatformSummary | null; extra: string[] }
  | { id: "creative"; kind: "creative"; label: string; package: string | null; pools: PoolCounts; moving: number; waiting: number; live: number; asana?: number }
  | { id: string; kind: "other"; label: string; tier: string | null };

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const RANK = { off: 0, close: 1, setup: 2, idle: 3, unset: 3, good: 4, excellent: 5 } as const;
const COLOR: Record<string, string> = { meta: "#6c7ee1", google: "#5be3a5", tiktok: "#e0508c", email: "#f2b14c", social: "#e0508c" };

/** Their email and SMS (Klaviyo, read only): attributed revenue over the last 30 days and the 30 before, and its health */
export type EmailSummary = { revenue: number; prev: number; campaigns: number; openRate: number | null; currency: string | null; share: number | null; revenuePerRecipient: number | null; findings: Pick<HealthFinding, "tone" | "title">[] };

/** Their organic social (Facebook and Instagram, read only), for a client with the social media service: its numbers once read, or just whether accounts are linked */
export type SocialCardData = { data: SocialSummary | null; linked: boolean };

export function BusinessOverview({ cards, audits, sprints, email = null, social = null }: { cards: ServiceCard[]; audits: Record<string, AuditSummary>; sprints: Record<string, SprintSummary>; email?: EmailSummary | null; social?: SocialCardData | null }) {
  const ads = cards.filter((c): c is Extract<ServiceCard, { kind: "ads" }> => c.kind === "ads");
  const spend = ads.reduce((n, c) => n + (c.summary?.spend ?? 0), 0);
  const prev = ads.reduce((n, c) => n + (c.summary?.prevSpend ?? 0), 0);
  // Revenue each channel reports for itself (ads where they track purchase value, and email's attributed revenue),
  // side by side: platforms each claim their own, so the parts can overlap and aren't a total
  const revenue = [...ads.filter((c) => c.summary?.roas && c.summary.value > 0).map((c) => ({ id: c.id, label: c.label, value: c.summary!.value })), ...(email && email.revenue > 0 ? [{ id: "email", label: "Email", value: email.revenue }] : [])];
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
          {revenue.length > 0 && email && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-muted">
              <span className="text-faint">Revenue each channel reports</span>
              {revenue.map((r) => (
                <span key={r.id} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: COLOR[r.id] }} />
                  {r.label} {money(r.value)}
                </span>
              ))}
            </div>
          )}
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
            // Per pool, never summed: images and videos are separate allotments, and an overage shows as one
            const pools = allotmentPools(c.pools);
            return (
              <OpenService key={c.id} id={c.id} className="group grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#f2b14c]" />
                    {c.label}
                  </span>
                  {c.package && <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand-text">{c.package}</span>}
                </span>
                {pools.length ? (
                  <span className={`grid gap-3 ${pools.length > 1 ? "grid-cols-2" : ""}`}>
                    {pools.map((p) => (
                      <span key={p.key} className="grid gap-1.5">
                        <span className="flex flex-wrap items-end gap-x-2 gap-y-0.5">
                          <span className={`tabular font-display text-3xl leading-none ${p.over ? "text-bad" : ""}`}>
                            {p.used}
                            <span className="text-lg text-faint">/{p.cap}</span>
                          </span>
                          <span className={`pb-0.5 text-xs ${p.over ? "text-bad" : "text-faint"}`}>{p.over ? `${p.label.toLowerCase()} · ${p.over} over` : p.label.toLowerCase()}</span>
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                          <span className={`block h-full rounded-full ${p.over ? "bg-bad" : "bg-[#f2b14c]"}`} style={{ width: `${p.cap ? Math.min(100, Math.round((p.used / p.cap) * 100)) : 100}%` }} />
                        </span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-sm text-faint">No monthly allotment set</span>
                )}
                <span className="grid grid-cols-3 gap-2 text-xs">
                  <Stat k={c.asana ? `In production · ${c.asana} in Asana` : "In production"} v={String(c.moving + (c.asana ?? 0))} />
                  <Stat k="With the client" v={String(c.waiting)} />
                  <Stat k="Ads live" v={String(c.live)} />
                </span>
                <span className="text-xs text-faint group-hover:text-fg">Open Creative →</span>
              </OpenService>
            );
          }
          // Email with Klaviyo connected is its own card below; without it, a way to connect it
          if (c.id === "email-marketing") {
            if (email) return null;
            return (
              <div key={c.id} className="grid content-start gap-1.5 rounded-[18px] border border-dashed border-line p-4 md:p-5">
                <span className="flex items-center justify-between gap-2 font-medium">
                  {c.label}
                  {c.tier && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">{c.tier}</span>}
                </span>
                <Link href="?tab=team#klaviyo" className="flex min-h-11 items-center text-xs text-faint underline-offset-2 hover:text-fg hover:underline md:min-h-0">
                  Connect Klaviyo in Team &amp; setup to see email here →
                </Link>
              </div>
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
        {email && <EmailCard email={email} />}
        {social && <SocialCard social={social} />}
      </div>
    </div>
  );
}

const PILL = { good: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" } as const;
const DOT = { good: "bg-ok", warn: "bg-warn", bad: "bg-bad" } as const;

/** Email (Klaviyo, read only) as a service card: its health, 30-day revenue and share of the store, three tiles, the top findings */
function EmailCard({ email }: { email: EmailSummary }) {
  const cur = (x: number, cents = false) => `${email.currency && email.currency !== "USD" ? `${email.currency} ` : "$"}${cents ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")}`;
  const status = pulseStatus(email.findings);
  const lines = email.findings.filter((f) => f.tone !== "good").slice(0, 3);
  const shown = lines.length ? lines : email.findings.slice(0, 2);
  return (
    <OpenService id="email" className="group grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR.email }} />
          Email
        </span>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${PILL[status.tone]}`}>{status.label}</span>
      </span>
      <span className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="tabular font-display text-3xl leading-none">{cur(email.revenue)}</span>
        <span className="pb-0.5 text-xs text-faint">
          revenue · 30 days{email.share != null ? ` · ${Math.round(email.share * 100)}% of the store` : ""}
          {email.prev > 0 ? ` · ${email.revenue >= email.prev ? "+" : ""}${Math.round(((email.revenue - email.prev) / email.prev) * 100)}% vs the 30 before` : ""}
        </span>
      </span>
      <span className="grid grid-cols-3 gap-2 text-xs">
        <Stat k="Campaigns sent" v={String(email.campaigns)} />
        <Stat k="Open rate" v={email.openRate != null ? `${(email.openRate * 100).toFixed(1)}%` : "n/a"} />
        <Stat k="Per recipient" v={email.revenuePerRecipient != null ? cur(email.revenuePerRecipient, true) : "n/a"} />
      </span>
      {shown.length > 0 && (
        <span className="grid gap-1 border-t border-line pt-3 text-xs text-muted">
          {shown.map((f) => (
            <span key={f.title} className="flex items-start gap-2">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.tone]}`} />
              <span className="line-clamp-1">{f.title}</span>
            </span>
          ))}
        </span>
      )}
      <span className="text-xs text-faint group-hover:text-fg">Open Email →</span>
    </OpenService>
  );
}

const kk = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString("en-US"));

/** Social (Facebook and Instagram, read only) as a service card: its health, followers with 30-day growth, three tiles, the top findings */
function SocialCard({ social }: { social: SocialCardData }) {
  const d = social.data;
  if (!d)
    return (
      <OpenService id="social" className="group grid content-start gap-1.5 rounded-[18px] border border-dashed border-line p-4 text-left md:p-5">
        <span className="flex items-center gap-2 font-medium">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR.social }} />
          Social
        </span>
        <span className="flex min-h-11 items-center text-xs text-faint group-hover:text-fg md:min-h-0">{social.linked ? "Linked. The numbers show once the first read is in →" : "Link their Facebook Page and Instagram account to see social here →"}</span>
      </OpenService>
    );
  const status = pulseStatus(d.findings);
  const lines = d.findings.filter((f) => f.tone !== "good").slice(0, 3);
  const shown = lines.length ? lines : d.findings.slice(0, 2);
  const move = d.reach != null && d.prevReach ? Math.round(((d.reach - d.prevReach) / d.prevReach) * 100) : null;
  return (
    <OpenService id="social" className="group grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR.social }} />
          Social
        </span>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${PILL[status.tone]}`}>{status.label}</span>
      </span>
      <span className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <span className="tabular font-display text-3xl leading-none">{d.followers != null ? kk(d.followers) : "n/a"}</span>
        <span className="pb-0.5 text-xs text-faint">
          followers
          {d.change != null ? ` · ${d.change >= 0 ? "+" : "-"}${kk(Math.abs(d.change))} in 30 days` : ""}
        </span>
      </span>
      <span className="grid grid-cols-3 gap-2 text-xs">
        <Stat k="Reach, 30 days" v={d.reach != null ? `${kk(d.reach)}${move != null ? ` (${move >= 0 ? "+" : ""}${move}%)` : ""}` : "n/a"} />
        <Stat k="Engagement rate" v={d.rate != null ? `${(d.rate * 100).toFixed(1)}%` : "n/a"} />
        <Stat k="Posts a week" v={String(d.postsPerWeek)} />
      </span>
      {shown.length > 0 && (
        <span className="grid gap-1 border-t border-line pt-3 text-xs text-muted">
          {shown.map((f) => (
            <span key={f.title} className="flex items-start gap-2">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.tone]}`} />
              <span className="line-clamp-1">{f.title}</span>
            </span>
          ))}
        </span>
      )}
      <span className="text-xs text-faint group-hover:text-fg">Open Social →</span>
    </OpenService>
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
