"use client";

import { useMemo, useState } from "react";
import { HoverCard } from "@/components/hover-card";
import { pushParams, useParam } from "@/lib/url-state";
import type { ClientKlaviyo, KlaviyoCampaignView } from "@/lib/klaviyo/store";
import { BENCHMARKS, bestSubjects, deliverabilityByWeek, deliverabilityOutliers, filterCampaigns, pulseStatus, revenuePerRecipient, shiftDay, sortCampaigns, type CampaignFilter, type CampaignSort, type HealthFinding } from "@/lib/klaviyo/insights";
import { CampaignPreviewCard, CampaignPreviewSheet } from "./email-preview";

// The Email tab: the pulse of their email and SMS (Klaviyo, read only). Overview (the health tiles against the 30 days
// before, 90 days of revenue by day with the store's total, the account's health in plain alerts and strengths),
// Campaigns (sortable, filtered, each previewed on hover or tap), Flows (with the key flows' coverage), Audience and
// Deliverability. The open sub-tab and the filters live in the address (?etab=, ech=, edays=, esort=, edir=) so back
// returns to them. Nothing is sent, edited or scheduled in Klaviyo from here.

const FLOW = "#6c7ee1";
const CAMPAIGN = "#5be3a5";

const moneyFn = (cur: string | null) => (x: number, cents = false) => `${!cur || cur === "USD" ? "$" : `${cur} `}${cents ? x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number | null, dp = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
const count = (x: number) => Math.round(x).toLocaleString("en-US");
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const sent = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "Not sent");

type Tab = "overview" | "campaigns" | "flows" | "audience" | "deliverability";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "campaigns", label: "Campaigns" },
  { id: "flows", label: "Flows" },
  { id: "audience", label: "Audience" },
  { id: "deliverability", label: "Deliverability" },
];

const TONE = {
  bad: { dot: "bg-bad", text: "text-bad", soft: "bg-bad-soft", label: "Needs attention" },
  warn: { dot: "bg-warn", text: "text-warn", soft: "bg-warn-soft", label: "Watch" },
  good: { dot: "bg-ok", text: "text-ok", soft: "bg-ok-soft", label: "Strength" },
} as const;

// ─── Tiles ────────────────────────────────────────────────────────────────

type Move = { text: string; good: boolean | null } | null;
const relMove = (a: number | null, b: number | null, higherIsGood = true): Move => {
  if (a == null || b == null || !b) return null;
  const d = Math.round(((a - b) / b) * 100);
  return { text: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%`, good: d === 0 ? null : d > 0 === higherIsGood };
};
const ptsMove = (a: number | null, b: number | null, higherIsGood = true, dp = 1): Move => {
  if (a == null || b == null) return null;
  const d = (a - b) * 100;
  if (Math.abs(d) < 10 ** -dp / 2) return { text: "level", good: null };
  return { text: `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(dp)} pts`, good: d > 0 === higherIsGood };
};

function Tile({ k, v, move, sub, children }: { k: string; v: string; move?: Move; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5 rounded-[14px] border border-line bg-surface p-3.5 md:p-4">
      <span className="text-[11px] uppercase tracking-[0.12em] text-faint">{k}</span>
      <span className="tabular font-display text-[24px] leading-none md:text-[28px]">{v}</span>
      {children}
      <span className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
        {move && <span className={move.good == null ? "text-muted" : move.good ? "text-ok" : "text-bad"}>{move.text}</span>}
        {sub && <span className="text-faint">{sub}</span>}
      </span>
    </div>
  );
}

function SplitBar({ a, b }: { a: number; b: number }) {
  const t = a + b || 1;
  return (
    <span className="flex h-1.5 gap-[2px] overflow-hidden rounded-full" aria-hidden>
      <span style={{ width: `${(a / t) * 100}%`, background: CAMPAIGN }} className="rounded-full" />
      <span style={{ width: `${(b / t) * 100}%`, background: FLOW }} className="rounded-full" />
    </span>
  );
}

function Tiles({ k, money }: { k: ClientKlaviyo; money: ReturnType<typeof moneyFn> }) {
  const { now, before } = k;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <Tile k="Email revenue" v={money(now.revenue)} move={relMove(now.revenue, before.revenue)} sub="vs prior 30 days">
        <SplitBar a={now.campaignRevenue} b={now.flowRevenue} />
        <span className="text-[11px] text-muted">
          Campaigns {money(now.campaignRevenue)} · Flows {money(now.flowRevenue)}
        </span>
      </Tile>
      <Tile k="Share of store" v={now.share != null ? pct(now.share, 0) : "n/a"} move={ptsMove(now.share, before.share, true, 0)} sub={now.storeRevenue != null ? `of ${money(now.storeRevenue)} in Placed Order` : "Store revenue reads on the next full sync"} />
      <Tile k="Revenue per recipient" v={now.revenuePerRecipient != null ? money(now.revenuePerRecipient, true) : "n/a"} move={relMove(now.revenuePerRecipient, before.revenuePerRecipient)} sub={`${count(now.sends)} messages`} />
      <Tile k="Campaigns sent" v={count(now.campaignsSent)} move={relMove(now.campaignsSent, before.campaignsSent)} sub={`${now.cadence} a week`} />
      <Tile k="Open rate" v={pct(now.openRate)} move={ptsMove(now.openRate, before.openRate)} sub="campaigns, unique" />
      <Tile k="Click rate" v={pct(now.clickRate, 2)} move={ptsMove(now.clickRate, before.clickRate, true, 2)} sub="campaigns, unique" />
      <Tile k="Unsubscribe rate" v={pct(now.unsubscribeRate, 2)} move={ptsMove(now.unsubscribeRate, before.unsubscribeRate, false, 2)} sub={`healthy under ${pct(BENCHMARKS.unsubscribe.warn, 1)}`} />
      <Tile k="List growth" v={now.listGrowth == null ? "n/a" : `${now.listGrowth >= 0 ? "+" : ""}${count(now.listGrowth)}`} sub={now.listGrowth == null ? "Reads on the next full sync" : `joined minus left${before.listGrowth != null ? `, ${before.listGrowth >= 0 ? "+" : ""}${count(before.listGrowth)} before` : ""}`} />
    </div>
  );
}

// ─── The revenue chart ────────────────────────────────────────────────────

function RevenueChart({ k, money }: { k: ClientKlaviyo; money: ReturnType<typeof moneyFn> }) {
  const days = k.daily;
  const hasStore = days.some((d) => d.storeRevenue != null && d.storeRevenue > 0);
  const [showStore, setShowStore] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const store = hasStore && showStore;
  const peak = Math.max(1, ...days.map((d) => Math.max(d.revenue, store ? (d.storeRevenue ?? 0) : 0)));
  const n = days.length;
  const h = hover != null ? days[hover] : null;
  const line = store
    ? days
        .map((d, i) => `${((i + 0.5) / n) * 100},${100 - ((d.storeRevenue ?? 0) / peak) * 100}`)
        .join(" ")
    : "";
  const total = days.reduce((s, d) => s + d.revenue, 0);
  if (!n) return null;
  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="font-heading text-[16px]">Revenue by day</h3>
          <span className="text-[12px] text-faint">
            {n} days · {money(total)} from email and SMS
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CAMPAIGN }} />
            Campaigns
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FLOW }} />
            Flows
          </span>
          {hasStore && (
            <button type="button" onClick={() => setShowStore((s) => !s)} aria-pressed={showStore} className={`flex min-h-11 items-center gap-1.5 rounded-full px-2 md:min-h-0 ${showStore ? "text-fg" : "text-faint line-through"}`}>
              <span className="h-0.5 w-4 rounded-full bg-fg/70" />
              Store total
            </button>
          )}
        </div>
      </div>
      <div className="relative">
        <div className="flex h-44 items-end gap-[2px] md:h-52" role="img" aria-label={`Email revenue per day over ${n} days, ${money(total)} in total${store ? ", with the store's total revenue as a line" : ""}`} onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => (
            <button
              type="button"
              key={d.date}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={() => setHover(i)}
              aria-label={`${shortDay(d.date)}: ${money(d.revenue)}`}
              className={`flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px] ${hover != null && hover !== i ? "opacity-60" : ""}`}
            >
              {d.campaignRevenue > 0 && <span className="block w-full rounded-t-[3px]" style={{ height: `${(d.campaignRevenue / peak) * 100}%`, background: CAMPAIGN }} />}
              {d.flowRevenue > 0 && <span className={`block w-full ${d.campaignRevenue > 0 ? "" : "rounded-t-[3px]"}`} style={{ height: `${(d.flowRevenue / peak) * 100}%`, background: FLOW }} />}
            </button>
          ))}
        </div>
        {store && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full text-fg/70" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
        )}
        {h && hover != null && (
          <div className="pointer-events-none absolute -top-2 z-10 grid w-[200px] -translate-y-full gap-1 rounded-[12px] border border-ink/15 bg-deep-2 p-3 text-[12px] text-fg shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)]" style={{ left: `clamp(0px, calc(${((hover + 0.5) / n) * 100}% - 100px), calc(100% - 200px))` }}>
            <span className="font-medium">{shortDay(h.date)}</span>
            <span className="flex justify-between gap-3"><span className="text-muted">Campaigns</span><span className="tabular">{money(h.campaignRevenue)}</span></span>
            <span className="flex justify-between gap-3"><span className="text-muted">Flows</span><span className="tabular">{money(h.flowRevenue)}</span></span>
            {h.smsRevenue > 0 && <span className="flex justify-between gap-3"><span className="text-muted">of which SMS</span><span className="tabular">{money(h.smsRevenue)}</span></span>}
            {h.storeRevenue != null && (
              <span className="flex justify-between gap-3 border-t border-ink/10 pt-1"><span className="text-muted">Store total</span><span className="tabular">{money(h.storeRevenue)}{h.storeRevenue > 0 ? ` · ${Math.round((h.revenue / h.storeRevenue) * 100)}% email` : ""}</span></span>
            )}
          </div>
        )}
      </div>
      <div className="flex justify-between text-[11px] text-faint">
        <span>{shortDay(days[0].date)}</span>
        <span>{shortDay(days[Math.floor(n / 2)].date)}</span>
        <span>{shortDay(days[n - 1].date)}</span>
      </div>
    </section>
  );
}

// ─── Health ───────────────────────────────────────────────────────────────

function HealthList({ health }: { health: HealthFinding[] }) {
  const status = pulseStatus(health);
  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-[16px]">Account health</h3>
        <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] ${TONE[status.tone].soft} ${TONE[status.tone].text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${TONE[status.tone].dot}`} />
          {status.label}
        </span>
      </div>
      {health.length ? (
        <ul className="grid gap-2">
          {health.map((f) => (
            <li key={f.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-[12px] border border-line bg-bg/40 px-3 py-2.5">
              <span className={`mt-1.5 h-2 w-2 rounded-full ${TONE[f.tone].dot}`} aria-label={TONE[f.tone].label} />
              <span className="text-[13.5px] font-medium leading-snug">{f.title}</span>
              <span />
              <span className="text-[12px] leading-snug text-muted">
                {f.detail}
                {f.action && <span className="text-fg/80"> {f.action}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">Nothing to flag yet.</p>
      )}
    </section>
  );
}

// ─── Campaigns ────────────────────────────────────────────────────────────

const SORT_LABEL: Record<CampaignSort, string> = { date: "Date", recipients: "Recipients", open: "Open", click: "Click", revenue: "Revenue", rpr: "Per recipient" };

function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full border border-line bg-surface p-1">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)} className={`min-h-9 rounded-full px-3 text-[12.5px] transition-colors md:min-h-8 ${value === o.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CampaignsTab({ k, clientId, money }: { k: ClientKlaviyo; clientId: string; money: ReturnType<typeof moneyFn> }) {
  const ch = (useParam("ech") as CampaignFilter["channel"] | null) ?? "all";
  const daysParam = Number(useParam("edays"));
  const days: CampaignFilter["days"] = daysParam === 30 || daysParam === 120 ? daysParam : 90;
  const sortParam = useParam("esort") as CampaignSort | null;
  const sort: CampaignSort = sortParam && sortParam in SORT_LABEL ? sortParam : "date";
  const dir = useParam("edir") === "asc" ? "asc" : "desc";
  const list = useMemo(() => sortCampaigns(filterCampaigns(k.campaigns, { channel: ch, days }, k.today), sort, dir), [k.campaigns, k.today, ch, days, sort, dir]);
  const best = useMemo(() => bestSubjects(filterCampaigns(k.campaigns, { channel: "email", days: 120 }, k.today)), [k.campaigns, k.today]);
  const totals = list.reduce((s, c) => ({ rev: s.rev + c.revenue, rec: s.rec + c.recipients }), { rev: 0, rec: 0 });
  // The same column again turns the order around; another column starts high to low
  const setSort = (s: CampaignSort) => pushParams({ esort: s === "date" ? null : s, edir: s === sort && dir === "desc" ? "asc" : null });
  const head = (s: CampaignSort, className = "") => (
    <button type="button" onClick={() => setSort(s)} className={`flex items-center gap-1 text-right text-[11px] uppercase tracking-[0.08em] ${sort === s ? "text-fg" : "text-faint hover:text-muted"} ${className}`}>
      {SORT_LABEL[s]}
      {sort === s && <span aria-hidden>{dir === "desc" ? "↓" : "↑"}</span>}
    </button>
  );
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pills label="Channel" value={ch} onChange={(v) => pushParams({ ech: v === "all" ? null : v })} options={[{ id: "all", label: "All" }, { id: "email", label: "Email" }, { id: "sms", label: "SMS" }]} />
        <Pills label="Window" value={String(days) as "30" | "90" | "120"} onChange={(v) => pushParams({ edays: v === "90" ? null : v })} options={[{ id: "30", label: "30 days" }, { id: "90", label: "90 days" }, { id: "120", label: "120 days" }]} />
        <label className="flex items-center gap-2 text-[12px] text-muted md:hidden">
          Sort
          <select value={sort} onChange={(e) => pushParams({ esort: e.target.value === "date" ? null : e.target.value, edir: null })} className="min-h-11 rounded-full border border-line bg-surface px-3 text-[13px] text-fg">
            {(Object.keys(SORT_LABEL) as CampaignSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-[12px] text-faint">
          {list.length} campaigns · {money(totals.rev)} · {count(totals.rec)} recipients
        </span>
      </div>

      <section className="grid gap-1 rounded-[18px] border border-line bg-surface p-2 md:p-3">
        <div className="hidden grid-cols-[minmax(0,1fr)_92px_64px_64px_96px_96px] items-center gap-3 px-3 pb-2 pt-1 md:grid">
          {head("date", "justify-start text-left")}
          {head("recipients", "justify-end")}
          {head("open", "justify-end")}
          {head("click", "justify-end")}
          {head("revenue", "justify-end")}
          {head("rpr", "justify-end")}
        </div>
        {list.length ? (
          <ul className="grid">
            {list.map((c) => (
              <CampaignRow key={c.id} c={c} clientId={clientId} money={money} />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-faint">No {ch === "all" ? "" : ch === "sms" ? "SMS " : "email "}campaigns sent in the last {days} days.</p>
        )}
      </section>

      {best.length > 0 && (
        <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
          <div className="grid gap-0.5">
            <h3 className="font-heading text-[16px]">Best subject lines</h3>
            <span className="text-[12px] text-faint">By open rate, last 120 days, emails sent to 200 or more</span>
          </div>
          <ol className="grid gap-2">
            {best.map((c, i) => (
              <li key={c.id} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-2">
                <span className="tabular text-[12px] text-faint">{i + 1}</span>
                <span className="min-w-0 text-[13.5px] leading-snug [overflow-wrap:anywhere]">&ldquo;{c.subject}&rdquo;</span>
                <span className="tabular text-[13px] text-ok">{pct(c.openRate)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <CampaignPreviewSheet clientId={clientId} campaigns={k.campaigns} />
    </div>
  );
}

function CampaignRow({ c, clientId, money }: { c: KlaviyoCampaignView; clientId: string; money: ReturnType<typeof moneyFn> }) {
  const rpr = revenuePerRecipient(c);
  const sms = c.channel === "sms";
  return (
    <li className="border-t border-line/60 first:border-t-0">
      <HoverCard width={380} className="block" content={<CampaignPreviewCard clientId={clientId} campaign={c} />}>
        <button type="button" onClick={() => pushParams({ epreview: c.id })} className="grid w-full gap-2 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-surface-2/60 md:grid-cols-[minmax(0,1fr)_92px_64px_64px_96px_96px] md:items-center md:gap-3" aria-label={`Preview ${c.name}`}>
          <span className="grid min-w-0 gap-0.5">
            <span className="flex items-center gap-2 text-[11.5px] text-faint">
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted">{sms ? "SMS" : "Email"}</span>
              {sent(c.sendTime)}
              {c.audiences.length > 0 && <span className="truncate">· {c.audiences.slice(0, 2).join(", ")}</span>}
            </span>
            <span className="truncate text-[13.5px] font-medium">{sms ? c.name : (c.subject ?? c.name)}</span>
            {!sms && c.subject && c.subject !== c.name && <span className="truncate text-[11.5px] text-faint">{c.name}</span>}
          </span>
          <span className="grid grid-cols-5 gap-2 text-[12px] md:contents">
            {[
              ["Recipients", count(c.recipients)],
              ["Open", sms ? "n/a" : pct(c.openRate)],
              ["Click", pct(c.clickRate, 2)],
              ["Revenue", money(c.revenue)],
              ["Per recip.", rpr != null ? money(rpr, true) : "n/a"],
            ].map(([key, v]) => (
              <span key={key} className="grid gap-0.5 md:text-right">
                <span className="text-[10px] text-faint md:hidden">{key}</span>
                <span className="tabular text-fg">{v}</span>
              </span>
            ))}
          </span>
        </button>
      </HoverCard>
    </li>
  );
}

// ─── Flows ────────────────────────────────────────────────────────────────

const STATE = { live: { label: "Live", cls: "bg-ok-soft text-ok" }, present: { label: "Not live", cls: "bg-warn-soft text-warn" }, missing: { label: "Missing", cls: "bg-bad-soft text-bad" } } as const;

function FlowsTab({ k, money }: { k: ClientKlaviyo; money: ReturnType<typeof moneyFn> }) {
  const total30 = k.flows.reduce((s, f) => s + f.revenue30, 0);
  const flows = [...k.flows].sort((a, b) => b.revenue30 - a.revenue30 || b.revenue90 - a.revenue90);
  return (
    <div className="grid gap-5">
      <section className="grid gap-3">
        <h3 className="font-heading text-[16px]">Key flows</h3>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {k.keyFlows.map((f) => (
            <div key={f.id} className="grid content-start gap-1.5 rounded-[14px] border border-line bg-surface p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{f.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${STATE[f.state].cls}`}>{STATE[f.state].label}</span>
              </div>
              <span className="text-[11.5px] leading-snug text-faint">{f.flows.length ? f.flows.map((x) => x.name).slice(0, 2).join(", ") : f.why}</span>
              {f.flows.length > 0 && <span className="tabular text-[12px] text-muted">{money(f.flows.reduce((s, x) => s + x.revenue30, 0))} in 30 days</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-1 rounded-[18px] border border-line bg-surface p-2 md:p-3">
        <div className="hidden grid-cols-[minmax(0,1fr)_96px_96px_88px_64px_64px] gap-3 px-3 pb-2 pt-1 text-right text-[11px] uppercase tracking-[0.08em] text-faint md:grid">
          <span className="text-left">Flow</span>
          <span>30 days</span>
          <span>90 days</span>
          <span>Recipients</span>
          <span>Open</span>
          <span>Click</span>
        </div>
        {flows.length ? (
          <ul className="grid">
            {flows.map((f) => {
              const share = total30 ? f.revenue30 / total30 : 0;
              const live = (f.status ?? "").toLowerCase() === "live";
              return (
                <li key={f.id} className="grid gap-2 border-t border-line/60 px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_96px_96px_88px_64px_64px] md:items-center md:gap-3">
                  <span className="grid min-w-0 gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-ok" : "bg-faint"}`} aria-label={live ? "Live" : (f.status ?? "Not live")} />
                      <span className="truncate text-[13.5px] font-medium">{f.name}</span>
                    </span>
                    <span className="text-[11.5px] text-faint">{[f.status, f.trigger].filter(Boolean).join(" · ")}{share > 0 ? ` · ${Math.round(share * 100)}% of flow revenue` : ""}</span>
                    {share > 0 && (
                      <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: FLOW }} />
                      </span>
                    )}
                  </span>
                  <span className="grid grid-cols-5 gap-2 text-[12px] md:contents">
                    {[
                      ["30 days", money(f.revenue30)],
                      ["90 days", money(f.revenue90)],
                      ["Recipients", count(f.recipients30)],
                      ["Open", pct(f.openRate30)],
                      ["Click", pct(f.clickRate30, 2)],
                    ].map(([key, v]) => (
                      <span key={key} className="grid gap-0.5 md:text-right">
                        <span className="text-[10px] text-faint md:hidden">{key}</span>
                        <span className="tabular">{v}</span>
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-faint">No flows in this account.</p>
        )}
      </section>
    </div>
  );
}

// ─── Audience ─────────────────────────────────────────────────────────────

function AudienceTab({ k }: { k: ClientKlaviyo }) {
  const from30 = shiftDay(k.today, -29);
  const last = k.daily.filter((d) => d.date >= from30);
  const joined = last.some((d) => d.subscribed != null) ? last.reduce((s, d) => s + (d.subscribed ?? 0), 0) : null;
  const left = last.some((d) => d.unsubscribed != null) ? last.reduce((s, d) => s + (d.unsubscribed ?? 0), 0) : null;
  const sized = k.audiences.filter((a) => a.profiles != null);
  const biggest = Math.max(1, ...sized.map((a) => a.profiles ?? 0));
  const rest = k.audiences.filter((a) => a.profiles == null);
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-3 gap-2.5">
        <Tile k="Joined lists" v={joined == null ? "n/a" : count(joined)} sub="last 30 days" />
        <Tile k="Left lists" v={left == null ? "n/a" : count(left)} sub="last 30 days" />
        <Tile k="Net growth" v={joined == null || left == null ? "n/a" : `${joined - left >= 0 ? "+" : ""}${count(joined - left)}`} sub={joined != null && joined + (left ?? 0) > 0 ? `${Math.round((joined / (joined + (left ?? 0))) * 100)}% of movement is joins` : "list movement"} />
      </div>
      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
        <div className="grid gap-0.5">
          <h3 className="font-heading text-[16px]">Lists and segments</h3>
          <span className="text-[12px] text-faint">The main ones are counted on each daily read; growth shows once there are two reads a few days apart.</span>
        </div>
        {sized.length ? (
          <ul className="grid gap-3">
            {sized.map((a) => (
              <li key={a.id} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
                  <span className="min-w-0 truncate">
                    {a.name} <span className="text-[11px] text-faint">{a.kind}</span>
                  </span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    {a.growth && a.growth.change !== 0 && (
                      <span className={`tabular text-[11.5px] ${a.growth.change > 0 ? "text-ok" : "text-bad"}`} title={`Since ${a.growth.since}`}>
                        {a.growth.change > 0 ? "+" : ""}
                        {count(a.growth.change)}
                      </span>
                    )}
                    <span className="tabular">{count(a.profiles ?? 0)}</span>
                  </span>
                </div>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(2, ((a.profiles ?? 0) / biggest) * 100)}%` }} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">Sizes are read on the next full sync.</p>
        )}
        {rest.length > 0 && (
          <details className="text-[12.5px] text-muted">
            <summary className="flex min-h-11 cursor-pointer items-center">{rest.length} more lists and segments (not counted)</summary>
            <p className="leading-relaxed">{rest.map((a) => a.name).join(", ")}</p>
          </details>
        )}
      </section>
    </div>
  );
}

// ─── Deliverability ───────────────────────────────────────────────────────

function RateChart({ title, points, healthy, bad }: { title: string; points: { week: string; rate: number | null }[]; healthy: number; bad: number }) {
  const vals = points.map((p) => p.rate ?? 0);
  const peak = Math.max(bad * 1.2, ...vals) || 1;
  const n = points.length;
  const latest = [...points].reverse().find((p) => p.rate != null)?.rate ?? null;
  const tone = latest == null ? "text-muted" : latest > bad ? "text-bad" : latest > healthy ? "text-warn" : "text-ok";
  return (
    <section className="grid gap-2 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-medium">{title}</h4>
        <span className={`tabular text-[13px] ${tone}`}>{pct(latest, 2)}</span>
      </div>
      <div className="relative h-24">
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`${title} by week; healthy under ${pct(healthy, 2)}`} role="img">
          <line x1="0" x2="100" y1={100 - (healthy / peak) * 100} y2={100 - (healthy / peak) * 100} className="text-ok" stroke="currentColor" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.6" />
          <line x1="0" x2="100" y1={100 - (bad / peak) * 100} y2={100 - (bad / peak) * 100} className="text-bad" stroke="currentColor" strokeDasharray="3 3" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.6" />
          {n > 1 && <polyline points={points.map((p, i) => `${(i / (n - 1)) * 100},${100 - ((p.rate ?? 0) / peak) * 100}`).join(" ")} fill="none" className="text-fg" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        </svg>
        <div className="absolute inset-0 flex">
          {points.map((p) => (
            <span key={p.week} className="flex-1" title={`Week of ${shortDay(p.week)}: ${pct(p.rate, 2)}`} />
          ))}
        </div>
      </div>
      <span className="flex justify-between text-[10.5px] text-faint">
        <span>{n ? shortDay(points[0].week) : ""}</span>
        <span>healthy under {pct(healthy, 2)}</span>
      </span>
    </section>
  );
}

function DeliverabilityTab({ k }: { k: ClientKlaviyo }) {
  const weeks = deliverabilityByWeek(k.campaigns);
  const outliers = deliverabilityOutliers(k.campaigns).slice(0, 10);
  const kind = { bounce: "bounces", spam: "spam", unsubscribe: "unsubscribes" } as const;
  if (!weeks.length) return <p className="text-sm text-faint">No email campaigns in the last 120 days to read deliverability from.</p>;
  return (
    <div className="grid gap-5">
      <div className="grid gap-2.5 md:grid-cols-3">
        <RateChart title="Bounce rate" points={weeks.map((w) => ({ week: w.week, rate: w.bounceRate }))} healthy={BENCHMARKS.bounce.warn} bad={BENCHMARKS.bounce.bad} />
        <RateChart title="Spam complaints" points={weeks.map((w) => ({ week: w.week, rate: w.spamRate }))} healthy={BENCHMARKS.spam.warn} bad={BENCHMARKS.spam.bad} />
        <RateChart title="Unsubscribe rate" points={weeks.map((w) => ({ week: w.week, rate: w.unsubscribeRate }))} healthy={BENCHMARKS.unsubscribe.warn} bad={BENCHMARKS.unsubscribe.bad} />
      </div>
      <p className="text-[12px] text-faint">Email campaigns by week of sending. Dashed lines: the healthy line (green) and the line mailbox providers act on (red).</p>
      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
        <h3 className="font-heading text-[16px]">Campaigns over the line</h3>
        {outliers.length ? (
          <ul className="grid gap-2">
            {outliers.map((o) => (
              <li key={o.campaign.id} className="grid gap-1 rounded-[12px] border border-line bg-bg/40 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-[13.5px] font-medium">{o.campaign.subject ?? o.campaign.name}</span>
                  <span className="text-[11.5px] text-faint">
                    {sent(o.campaign.sendTime)} · {count(o.campaign.recipients)} recipients
                  </span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {o.issues.map((i) => (
                    <span key={i.kind} className="tabular rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] text-warn">
                      {pct(i.rate, 2)} {kind[i.kind]}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">Every campaign stayed inside the healthy lines.</p>
        )}
      </section>
    </div>
  );
}

// ─── The tab ──────────────────────────────────────────────────────────────

export function EmailPanel({ k, clientId }: { k: ClientKlaviyo; clientId: string }) {
  const param = useParam("etab") as Tab | null;
  const tab: Tab = param && TABS.some((t) => t.id === param) ? param : "overview";
  const money = moneyFn(k.currency);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          {k.account ?? "Klaviyo"} · last 30 days against the 30 before{k.through ? `, data through ${shortDay(k.through)}` : ""}. Revenue is what Klaviyo attributes to email and SMS on Placed Order.
        </p>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Read only</span>
      </div>
      {(k.warning || k.now.estimated) && (
        <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-fg/90">
          {k.warning ?? "Revenue by day isn't in yet"}
          {k.now.estimated ? ". The 30-day totals are added up from the campaigns sent and the flows' own numbers until it is." : "."}
        </p>
      )}
      <nav className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist" aria-label="Email">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => pushParams({ etab: t.id === "overview" ? null : t.id })} className={`flex h-11 shrink-0 items-center rounded-full px-4 text-[13.5px] transition-colors ${tab === t.id ? "bg-fg text-bg" : "bg-surface-2/70 text-muted hover:text-fg"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div key={tab} style={{ animation: "tab-in .25s ease-out both" }}>
        {tab === "overview" && (
          <div className="grid gap-5">
            <Tiles k={k} money={money} />
            <RevenueChart k={k} money={money} />
            <HealthList health={k.health} />
          </div>
        )}
        {tab === "campaigns" && <CampaignsTab k={k} clientId={clientId} money={money} />}
        {tab === "flows" && <FlowsTab k={k} money={money} />}
        {tab === "audience" && <AudienceTab k={k} />}
        {tab === "deliverability" && <DeliverabilityTab k={k} />}
      </div>
    </div>
  );
}
