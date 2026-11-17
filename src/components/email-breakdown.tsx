"use client";

import { useMemo, useState } from "react";
import type { EmailProvider } from "@/lib/email-providers/core";
import { CampaignPreviewCard, CampaignPreviewSheet } from "@/app/(team)/clients/[slug]/email-preview";
import { HoverCard } from "@/components/hover-card";
import { pushParams, useParam } from "@/lib/url-state";
import { BARS, CAMPAIGN_TABS, FLOW_SORTS, PAGE, campaignsFor, flowRpr, klaviyoFlowUrl, rateTone, sortFlows, type BCampaign, type BFlow, type CampaignTab, type FlowSortKey, type FlowWindow, type RateTone } from "@/lib/email-breakdown";

// Under the score: how each campaign and each live flow is performing, so the team sees where the score is being lost.
// One component for the KPI board's sheet and the client's Email panel. Where you are (campaign tab, flow sort and
// window) lives in the address, so back returns to it. Read only. With the client's id, a campaign row previews the
// email or SMS as sent (the client page's own preview: hover on a computer, tap on a phone, full size in ?epreview=),
// and a flow's name opens it in Klaviyo.

const TONE: Record<RateTone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };
const moneyOf = (cur: string | null) => (x: number, cents = false) => `${!cur || cur === "USD" ? "$" : `${cur} `}${cents ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number | null, dp = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(dp)}%`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

function Rate({ v, bar, dp = 1 }: { v: number | null; bar: number | null; dp?: number }) {
  const t = bar == null ? null : rateTone(v, bar);
  return <span className={`tabular ${t ? TONE[t] : "text-muted"}`}>{pct(v, dp)}</span>;
}

function TabBar<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar flex gap-1 overflow-x-auto rounded-full border border-line bg-surface p-1">
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id} onClick={() => onChange(o.id)} className={`min-h-11 shrink-0 rounded-full px-3.5 text-[12.5px] transition-colors md:min-h-8 ${value === o.id ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Campaigns ────────────────────────────────────────────────────────────

const CAMPAIGN_COLS = "md:grid-cols-[56px_minmax(0,1fr)_52px_84px_64px_64px_84px_72px]";

function Campaigns({ rows, money, clientId }: { rows: BCampaign[]; money: ReturnType<typeof moneyOf>; clientId?: string }) {
  const raw = useParam("ebt");
  const tab: CampaignTab = CAMPAIGN_TABS.some((t) => t.id === raw) ? (raw as CampaignTab) : "last10";
  const [more, setMore] = useState(0);
  const list = useMemo(() => campaignsFor(rows, tab), [rows, tab]);
  const shown = tab === "last10" ? list : list.slice(0, PAGE * (1 + more));
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-[16px]">Campaigns</h3>
        <TabBar
          label="Campaigns shown"
          value={tab}
          options={CAMPAIGN_TABS}
          onChange={(t) => {
            setMore(0);
            pushParams({ ebt: t === "last10" ? null : t });
          }}
        />
      </div>
      <div className="grid gap-1 rounded-[16px] border border-line bg-surface p-2 md:p-3">
        <div className={`hidden gap-3 px-3 pb-2 pt-1 text-right text-[11px] uppercase tracking-[0.08em] text-faint md:grid ${CAMPAIGN_COLS}`}>
          <span className="text-left">Sent</span>
          <span className="text-left">Campaign</span>
          <span className="text-left">Via</span>
          <span>Recipients</span>
          <span>Open</span>
          <span>Click</span>
          <span>Revenue</span>
          <span>Per recip.</span>
        </div>
        {shown.length ? (
          <ul>
            {shown.map((c) => {
              const email = c.channel === "email";
              const cells = (
                <>
                  <span className="tabular text-[12px] text-faint">{day(c.sendTime)}</span>
                  <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                  <span className="text-[11.5px] text-faint">{email ? "Email" : "SMS"}</span>
                  <span className="grid grid-cols-4 gap-2 text-[12px] md:contents">
                    {[
                      ["Recipients", <span key="r" className="tabular text-right">{c.recipients.toLocaleString("en-US")}</span>],
                      ["Open", email ? <Rate key="o" v={c.openRate} bar={BARS.campaignOpen} /> : <span key="o" className="text-faint">n/a</span>],
                      ["Click", <Rate key="c" v={c.clickRate} bar={email ? BARS.campaignClick : null} dp={2} />],
                      ["Revenue", <span key="v" className="tabular">{money(c.revenue)}</span>],
                    ].map(([k, v]) => (
                      <span key={k as string} className="grid gap-0.5 md:text-right">
                        <span className="text-[10px] text-faint md:hidden">{k}</span>
                        {v}
                      </span>
                    ))}
                  </span>
                  <span className="tabular hidden text-right text-[12px] md:block">{c.rpr == null ? "n/a" : money(c.rpr, true)}</span>
                  <span className="tabular text-[11px] text-faint md:hidden">{c.rpr == null ? "" : `${money(c.rpr, true)} per recipient`}</span>
                </>
              );
              const cls = `grid w-full gap-2 px-3 py-3 text-left md:items-center md:gap-3 ${CAMPAIGN_COLS}`;
              return (
                <li key={c.id} className="border-t border-line/60 first:border-t-0">
                  {clientId ? (
                    <HoverCard width={380} className="block" content={<CampaignPreviewCard clientId={clientId} campaign={{ id: c.id, name: c.name, channel: c.channel, subject: c.subject ?? null, previewText: c.previewText ?? null }} />}>
                      <button type="button" onClick={() => pushParams({ epreview: c.id })} aria-label={`Preview ${c.name}`} className={`${cls} rounded-[12px] transition-colors hover:bg-surface-2/60`}>
                        {cells}
                      </button>
                    </HoverCard>
                  ) : (
                    <div className={cls}>{cells}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-faint">{tab === "sms" ? "No SMS campaigns in the last 120 days." : "No campaigns sent in the last 120 days."}</p>
        )}
        {tab !== "last10" && list.length > shown.length && (
          <button type="button" onClick={() => setMore((n) => n + 1)} className="mx-auto mt-1 inline-flex min-h-11 items-center rounded-full px-4 text-[13px] text-muted hover:text-fg">
            Show more ({list.length - shown.length} left)
          </button>
        )}
      </div>
      {clientId && <CampaignPreviewSheet clientId={clientId} campaigns={rows.map((c) => ({ id: c.id, name: c.name, channel: c.channel, subject: c.subject ?? null, previewText: c.previewText ?? null, sendTime: c.sendTime }))} />}
    </section>
  );
}

// ─── Flows ────────────────────────────────────────────────────────────────

const FLOW_COLS = "md:grid-cols-[minmax(0,1fr)_84px_64px_64px_84px_72px]";
const FLOW_HEAD: { key: FlowSortKey; label: string }[] = [
  { key: "recipients", label: "Recipients" },
  { key: "open", label: "Open" },
  { key: "click", label: "Click" },
  { key: "revenue", label: "Revenue" },
  { key: "rpr", label: "Per recip." },
];

function Flows({ flows, money, link }: { flows: BFlow[]; money: ReturnType<typeof moneyOf>; /** The flow's editor opens in Klaviyo: only for Klaviyo clients */ link: boolean }) {
  const sortRaw = useParam("ebs");
  const key: FlowSortKey | null = FLOW_SORTS.includes(sortRaw as FlowSortKey) ? (sortRaw as FlowSortKey) : null;
  const dir = useParam("ebd") === "desc" ? "desc" : "asc";
  const w: FlowWindow = useParam("ebw") === "90" ? 90 : 30;
  const list = useMemo(() => sortFlows(flows, key, dir, w), [flows, key, dir, w]);
  // Same column again flips it; a new column starts at its natural end (names a to z, numbers biggest first)
  const sortBy = (k: FlowSortKey) => pushParams({ ebs: k, ebd: k === key ? (dir === "asc" ? "desc" : "asc") : k === "name" ? null : "desc" });
  const arrow = (k: FlowSortKey) => (k === key ? (dir === "asc" ? " ▲" : " ▼") : "");
  const sortHead = (k: FlowSortKey, label: string, left = false) => (
    <button type="button" onClick={() => sortBy(k)} aria-label={`Sort by ${label}`} className={`min-h-11 hover:text-fg md:min-h-0 ${left ? "text-left" : "text-right"} ${k === key ? "text-fg" : ""}`}>
      {label}
      {arrow(k)}
    </button>
  );
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-heading text-[16px]">Live flows</h3>
          <p className="text-[11.5px] text-faint">{key ? "Sorted by your column" : "Least performing first: lowest revenue per recipient"}</p>
        </div>
        <TabBar label="Flow window" value={String(w)} options={[{ id: "30", label: "30 days" }, { id: "90", label: "90 days" }]} onChange={(v) => pushParams({ ebw: v === "30" ? null : v })} />
      </div>
      <div className="grid gap-1 rounded-[16px] border border-line bg-surface p-2 md:p-3">
        <div className={`hidden gap-3 px-3 pb-2 pt-1 text-[11px] uppercase tracking-[0.08em] text-faint md:grid ${FLOW_COLS}`}>
          {sortHead("name", "Flow", true)}
          {FLOW_HEAD.map((h) => (
            <span key={h.key} className="grid">
              {sortHead(h.key, h.label)}
            </span>
          ))}
        </div>
        {/* On a phone the columns are one picker, since the table collapses to cards */}
        <label className="flex items-center gap-2 px-3 pt-1 text-[12px] text-faint md:hidden">
          Sort
          <select
            value={key ? `${key}:${dir}` : ""}
            onChange={(e) => {
              const [k, d] = e.target.value.split(":");
              pushParams({ ebs: k || null, ebd: k ? d : null });
            }}
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2 text-sm text-fg"
          >
            <option value="">Least performing first</option>
            {[{ key: "name" as const, label: "Flow" }, ...FLOW_HEAD].flatMap((h) => [
              <option key={`${h.key}:asc`} value={`${h.key}:asc`}>{h.label}, low to high</option>,
              <option key={`${h.key}:desc`} value={`${h.key}:desc`}>{h.label}, high to low</option>,
            ])}
          </select>
        </label>
        {list.length ? (
          <ul>
            {list.map((f) => {
              const open = w === 30 ? f.openRate30 : f.openRate90;
              const click = w === 30 ? f.clickRate30 : f.clickRate90;
              const rec = w === 30 ? f.recipients30 : f.recipients90;
              const rev = w === 30 ? f.revenue30 : f.revenue90;
              const rpr = flowRpr(f, w);
              return (
                <li key={f.id} className={`grid gap-2 border-t border-line/60 px-3 py-3 first:border-t-0 md:items-center md:gap-3 ${FLOW_COLS}`}>
                  {link ? (
                    <a href={klaviyoFlowUrl(f.id)} target="_blank" rel="noreferrer" title="Open this flow in Klaviyo" className="group/flow flex min-h-11 min-w-0 items-center gap-1.5 text-[13.5px] font-medium underline-offset-4 hover:underline md:min-h-0">
                      <span className="truncate">{f.name}</span>
                      <span aria-hidden className="shrink-0 text-[11px] text-faint transition-colors group-hover/flow:text-fg">↗</span>
                    </a>
                  ) : (
                    <span className="flex min-h-11 min-w-0 items-center text-[13.5px] font-medium md:min-h-0"><span className="truncate">{f.name}</span></span>
                  )}
                  <span className="grid grid-cols-5 gap-2 text-[12px] md:contents">
                    {[
                      ["Recipients", <span key="r" className="tabular">{rec.toLocaleString("en-US")}</span>],
                      ["Open", <Rate key="o" v={open} bar={BARS.flowOpen} />],
                      ["Click", <Rate key="c" v={click} bar={BARS.flowClick} dp={2} />],
                      ["Revenue", <span key="v" className="tabular">{money(rev)}</span>],
                      ["Per recip.", <span key="p" className="tabular">{rpr == null ? "n/a" : money(rpr, true)}</span>],
                    ].map(([k, v]) => (
                      <span key={k as string} className="grid gap-0.5 md:text-right">
                        <span className="text-[10px] text-faint md:hidden">{k}</span>
                        {v}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-4 text-sm text-faint">No live flows in this account.</p>
        )}
      </div>
    </section>
  );
}

/** Campaigns and live flows under an account's score */
export function EmailBreakdown({ campaigns, flows, currency, clientId, provider = null, revenueMeasured = true, only = null }: { campaigns: BCampaign[]; flows: BFlow[]; currency: string | null; /** Turns on the campaign preview */ clientId?: string; /** Which email provider the numbers are from (flow links and the revenue columns depend on it) */ provider?: EmailProvider | null; revenueMeasured?: boolean; /** One table alone (the KPI sheet gives campaigns and flows a tab each) */ only?: "campaigns" | "flows" | null }) {
  // A source with no revenue shows n/a, never $0
  const money: ReturnType<typeof moneyOf> = revenueMeasured ? moneyOf(currency) : () => "n/a";
  return (
    <div className="grid gap-6">
      {only !== "flows" && <Campaigns rows={campaigns} money={money} clientId={clientId} />}
      {only !== "campaigns" && <Flows flows={flows} money={money} link={!provider || provider === "klaviyo"} />}
    </div>
  );
}
