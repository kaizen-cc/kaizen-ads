"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ActionButton, ActionForm } from "@/components/action-form";
import { field, label } from "@/components/ui";
import type { Agg, Pacing, Status, Trend } from "@/lib/kpi/calc";
import { CONVERSIONS } from "@/lib/kpi/conversions";
import { STATUS, deviationTone, kpiValue, money } from "@/lib/kpi/format";
import { freshness } from "@/lib/dates";
import { addKpiTarget, archiveKpiTarget, linkAdAccount, pullClientKpis, saveKpiTarget } from "./actions";
import { DailyChart, Ladder, PaceBar, paceMeta } from "./kpi-charts";

export type KpiRow = {
  id: string;
  clientId: string;
  client: string;
  slug: string;
  clientStatus: string;
  platform: "meta" | "google";
  accountId: string | null;
  label: string | null;
  conversion: string;
  conversionLabel: string;
  customAction: string | null;
  campaignMatch: string | null;
  roas: boolean;
  target: number | null;
  budget: number | null;
  budgetNote: string | null;
  source: "strategy" | "client";
  ownerId: string | null;
  owner: string | null;
  status: Status;
  deviation: number | null;
  vsMonth: number | null;
  vsQuarter: number | null;
  trend: Trend | null;
  windows: Partial<Record<"d3" | "d7" | "d14" | "d30" | "d60" | "d90", Agg>>;
  months: Partial<Record<"mtd" | "lastMonth" | "qtd" | "lastQuarter", Agg>>;
  pace: Pacing | null;
  daily: { d: string; spend: number; results: number }[];
  error: string | null;
  computedAt: string | null;
  dataThrough: string | null;
};

type Person = { id: string; name: string };
const RANK: Record<Status, number> = { off: 0, close: 1, good: 2, excellent: 3, idle: 4, setup: 5 };
const TILES: Status[] = ["excellent", "good", "close", "off"];

/** "16% above target" — said the way a buyer would for a cost, or for ROAS. */
function gapText(r: KpiRow) {
  if (r.deviation == null) return r.status === "off" ? "Spending with no results" : null;
  const n = Math.abs(Math.round(r.deviation * 100));
  if (n === 0) return "Right on target";
  const better = r.deviation < 0;
  if (r.roas) return `${n}% ${better ? "above" : "below"} target`;
  return `${n}% ${better ? "below" : "above"} target`;
}

function Delta({ label: name, value }: { label: string; value: number | null }) {
  // value: positive = worse. Show the change in the KPI itself, colored by whether it's good.
  return (
    <div className="flex items-baseline justify-between gap-2 whitespace-nowrap text-xs">
      <span className="text-faint">{name}</span>
      <span className={`tabular font-medium ${value == null ? "text-faint" : value > 0.05 ? "text-bad" : value < -0.05 ? "text-ok" : "text-muted"}`}>
        {value == null ? "—" : Math.abs(value) < 0.01 ? "same" : `${Math.round(Math.abs(value) * 100)}% ${value > 0 ? "worse" : "better"}`}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium ${s.tone}`}>{s.label}</span>;
}

/** The fields a buyer sets. Shared by edit and add. */
function TargetFields({ row, buyers, platform }: { row?: KpiRow; buyers: Person[]; platform: "meta" | "google" }) {
  const [conv, setConv] = useState(row?.conversion ?? (platform === "google" ? "conversions" : "purchases"));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className={label}>
        Counts as a result
        <select name="conversion" value={conv} onChange={(e) => setConv(e.target.value)} className={field}>
          {CONVERSIONS.filter((c) => c.platforms.includes(platform)).map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {conv === "roas" ? "Target ROAS" : "Target cost per result"}
        <input name="target" inputMode="decimal" defaultValue={row?.target ?? ""} placeholder={conv === "roas" ? "3.0" : "$45"} className={`${field} tabular`} />
      </label>
      <label className={label}>
        Monthly budget
        <input name="monthly_budget" inputMode="decimal" defaultValue={row?.budget ?? ""} placeholder="$5,000" className={`${field} tabular`} />
      </label>
      <label className={label}>
        Target set by
        <select name="source" defaultValue={row?.source ?? "strategy"} className={field}>
          <option value="strategy">Internal strategy</option>
          <option value="client">The client</option>
        </select>
      </label>
      <label className={label}>
        Buyer
        <select name="owner_id" defaultValue={row?.ownerId ?? ""} className={field}>
          <option value="">{row?.owner && !row.ownerId ? row.owner : "Nobody yet"}</option>
          {buyers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {platform === "google" ? "Google Ads customer ID" : "Meta ad account ID"}
        <input name="ad_account_id" defaultValue={row?.accountId ?? ""} className={`${field} tabular`} placeholder={platform === "google" ? "123-456-7890" : "act_…"} />
      </label>
      <label className={label}>
        <span>
          Only campaigns containing <span className="font-normal text-faint">(optional)</span>
        </span>
        <input name="campaign_match" defaultValue={row?.campaignMatch ?? ""} className={field} placeholder="e.g. Bridal Boudoir" />
      </label>
      <label className={label}>
        <span>
          Name <span className="font-normal text-faint">(optional)</span>
        </span>
        <input name="label" defaultValue={row?.label ?? ""} className={field} placeholder="When a client has several" />
      </label>
      {conv === "custom" && (
        <label className={`${label} sm:col-span-2`}>
          Meta custom conversion
          <input name="custom_action" defaultValue={row?.customAction ?? ""} className={`${field} tabular`} placeholder="offsite_conversion.custom.123456789" />
        </label>
      )}
      <label className={`${label} sm:col-span-2 lg:col-span-4`}>
        <span>
          Budget notes <span className="font-normal text-faint">(optional)</span>
        </span>
        <input name="budget_note" defaultValue={row?.budgetNote ?? ""} className={field} placeholder="e.g. $3,000 Meta and $3,000 Google" />
      </label>
    </div>
  );
}

function Detail({ r, buyers }: { r: KpiRow; buyers: Person[] }) {
  const win = [
    ["3 days", r.windows.d3],
    ["7 days", r.windows.d7],
    ["14 days", r.windows.d14],
    ["30 days", r.windows.d30],
    ["60 days", r.windows.d60],
    ["90 days", r.windows.d90],
  ] as const;
  const months = [
    ["This month", r.months.mtd],
    ["Last month", r.months.lastMonth],
    ["This quarter", r.months.qtd],
    ["Last quarter", r.months.lastQuarter],
  ] as const;
  const cell = (a: Agg | undefined) => (
    <>
      <span className={`tabular text-sm ${r.target ? deviationTone(a?.value != null && r.target ? (r.roas ? (r.target - a.value) / r.target : (a.value - r.target) / r.target) : null) : "text-fg"}`}>
        {kpiValue(a?.value, r.roas)}
      </span>
      <span className="tabular text-[11px] text-faint">
        {money(a?.spend ?? 0)} · {a?.results ?? 0} {a?.results === 1 ? "result" : "results"}
      </span>
    </>
  );
  return (
    <div className="grid gap-6 border-t border-line bg-bg/40 px-5 py-6 sm:px-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Last 30 days</p>
          <DailyChart daily={r.daily} />
          <p className="text-[11px] text-faint">Bars are spend, the line is {r.conversionLabel.toLowerCase()} per day.</p>
        </div>
        <div className="grid content-start gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Budget</p>
          <PaceBar pace={r.pace} note={r.budgetNote} />
          {r.pace && r.pace.dailyNeeded != null && r.pace.status !== "early" && (
            <p className="text-xs leading-relaxed text-muted">
              Spend about <span className="tabular text-fg">{money(r.pace.dailyNeeded)}</span> a day for the next {Math.ceil(r.pace.daysLeft)} days to land on budget.
            </p>
          )}
          {r.budgetNote && r.pace && <p className="text-xs leading-relaxed text-faint">{r.budgetNote}</p>}
        </div>
      </div>

      <div className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {win.map(([name, a]) => (
          <div key={name} className={`grid gap-0.5 bg-surface px-4 py-3 ${name === "14 days" ? "ring-1 ring-inset ring-brand/40" : ""}`}>
            <span className="text-[11px] text-faint">{name}{name === "14 days" && " · sets the status"}</span>
            {cell(a)}
          </div>
        ))}
      </div>
      <div className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {months.map(([name, a]) => (
          <div key={name} className="grid gap-0.5 bg-surface px-4 py-3">
            <span className="text-[11px] text-faint">{name}</span>
            {cell(a)}
          </div>
        ))}
      </div>

      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Target and budget</p>
          <div className="flex items-center gap-3">
            {r.platform === "meta" && r.accountId && <ActionButton action={pullClientKpis.bind(null, r.clientId)} label="Pull from Meta now" />}
            <ActionButton action={archiveKpiTarget.bind(null, r.id)} label="Remove" confirmText="Remove this KPI?" />
          </div>
        </div>
        <ActionForm action={saveKpiTarget.bind(null, r.id, r.clientId)} submitLabel="Save" className="grid gap-4">
          <TargetFields row={r} buyers={buyers} platform={r.platform} />
        </ActionForm>
      </div>
    </div>
  );
}

function Row({ r, open, onToggle, buyers }: { r: KpiRow; open: boolean; onToggle: () => void; buyers: Person[] }) {
  const s = STATUS[r.status];
  const d14 = r.windows.d14;
  const gap = gapText(r);
  return (
    <li className={`overflow-hidden rounded-[14px] border bg-surface transition-colors ${open ? "border-faint/70" : "border-line hover:border-faint/60"}`}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full items-center gap-x-6 gap-y-4 px-5 py-4 text-left sm:px-6 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_172px] xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_172px_minmax(168px,0.8fr)_minmax(0,1fr)]"
      >
        {/* Who and what */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {r.status === "off" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-40" />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-heading text-[15px] leading-snug">
              {r.client}
              {r.label && <span className="text-muted"> · {r.label}</span>}
            </p>
            <p className="mt-0.5 truncate text-xs text-faint">
              {r.conversionLabel}
              {r.owner && ` · ${r.owner}`}
              {r.source === "client" && " · client's target"}
            </p>
          </div>
        </div>

        {/* The KPI */}
        <div className="grid min-w-0 gap-1">
          {r.status === "setup" ? (
            <>
              <StatusPill status="setup" />
              <span className="truncate text-xs text-faint">{r.error ?? (r.target ? "Waiting for data" : "Add a target")}</span>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className={`tabular font-heading text-[22px] leading-none ${s.text}`}>{kpiValue(d14?.value, r.roas)}</span>
                <span className="tabular text-xs text-faint">/ {kpiValue(r.target, r.roas)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={r.status} />
                {gap && <span className="text-[11px] text-muted">{gap}</span>}
              </div>
            </>
          )}
        </div>

        {/* Moving averages */}
        <div className="hidden md:block">
          <Ladder windows={r.windows} target={r.target} roas={r.roas} />
        </div>

        {/* Month and quarter */}
        <div className="hidden min-w-0 gap-1.5 xl:grid">
          <Delta label="vs last month" value={r.vsMonth} />
          <Delta label="vs last quarter" value={r.vsQuarter} />
          {r.trend && r.status !== "setup" && (
            <span className={`text-[11px] ${r.trend === "improving" ? "text-ok" : r.trend === "slipping" ? "text-bad" : "text-faint"}`}>
              {r.trend === "improving" ? "Last 3 days improving" : r.trend === "slipping" ? "Last 3 days slipping" : "Last 3 days steady"}
            </span>
          )}
        </div>

        {/* Budget */}
        <div className="min-w-0 md:col-span-3 xl:col-span-1">
          <PaceBar pace={r.pace} note={r.budgetNote} compact />
        </div>
      </button>
      {open && <Detail r={r} buyers={buyers} />}
    </li>
  );
}

function AddKpi({ clients, buyers, platform, onDone }: { clients: { id: string; name: string }[]; buyers: Person[]; platform: "meta" | "google"; onDone: () => void }) {
  return (
    <div className="grid gap-4 rounded-[14px] border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <p className="font-heading text-[17px]">New {platform === "google" ? "Google Ads" : "Meta"} KPI</p>
        <button onClick={onDone} className="text-xs text-muted hover:text-fg">
          Close
        </button>
      </div>
      <ActionForm action={addKpiTarget} submitLabel="Add KPI" resetOnSuccess className="grid gap-4">
        <input type="hidden" name="platform" value={platform} />
        <label className={label}>
          Client
          <select name="client_id" required defaultValue="" className={field}>
            <option value="" disabled>
              Pick a client
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <TargetFields buyers={buyers} platform={platform} />
      </ActionForm>
    </div>
  );
}

/** Ad accounts Meta shares with the agency that the name match couldn't pin to a client. */
function Unlinked({ accounts, clients }: { accounts: { id: string; name: string }[]; clients: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[14px] border border-dashed border-line px-5 py-4">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left text-sm">
        <span>
          <span className="tabular font-medium">{accounts.length}</span> ad {accounts.length === 1 ? "account" : "accounts"} shared with us that aren&apos;t linked to a client
        </span>
        <span className="text-xs text-muted">{open ? "Hide" : "Review"}</span>
      </button>
      {open && (
        <ul className="mt-4 grid gap-2">
          {accounts.map((a) => (
            <li key={a.id} className="grid items-center gap-3 rounded-[10px] bg-surface px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <span className="min-w-0">
                <span className="block truncate text-sm">{a.name}</span>
                <span className="tabular text-xs text-faint">act_{a.id}</span>
              </span>
              <ActionForm action={linkAdAccount.bind(null, a.id)} submitLabel="Link" className="flex flex-wrap items-center gap-2 [&>div]:shrink-0">
                <select name="client_id" required defaultValue="" className={`${field} min-w-0 flex-1`}>
                  <option value="" disabled>
                    Whose account is this?
                  </option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The KPI dashboard: how every account is pacing toward its target and its budget. */
export function KpiBoard({
  rows,
  buyers,
  clients,
  me,
  initialOwner,
  lastSync,
  unlinked = [],
}: {
  rows: KpiRow[];
  buyers: Person[];
  clients: { id: string; name: string }[];
  me: { id: string; firstName: string };
  initialOwner: string;
  lastSync: string | null;
  unlinked?: { id: string; name: string }[];
}) {
  const [platform, setPlatform] = useState<"meta" | "google">("meta");
  const [owner, setOwner] = useState(initialOwner);
  const [status, setStatus] = useState<Status | "all">("all");
  const [pace, setPace] = useState<Pacing["status"] | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const owners = useMemo(() => {
    const names = new Map<string, string>();
    for (const r of rows) if (r.platform === platform && r.owner) names.set(r.ownerId ?? `name:${r.owner}`, r.owner);
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, platform]);

  const base = rows.filter((r) => r.platform === platform && (owner === "all" || (r.ownerId ?? `name:${r.owner}`) === owner));
  const term = q.trim().toLowerCase();
  const shown = base
    .filter((r) => (status === "all" || r.status === status) && (pace === "all" || r.pace?.status === pace) && (term.length < 2 || `${r.client} ${r.label ?? ""}`.toLowerCase().includes(term)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (b.deviation ?? -9) - (a.deviation ?? -9) || a.client.localeCompare(b.client));

  const count = (s: Status) => base.filter((r) => r.status === s).length;
  const paced = base.filter((r) => r.pace);
  const spent = paced.reduce((t, r) => t + (r.pace?.spent ?? 0), 0);
  const budget = paced.reduce((t, r) => t + (r.pace?.budget ?? 0), 0);
  const projected = paced.reduce((t, r) => t + (r.pace?.projected ?? 0), 0);
  const setup = count("setup") + count("idle");
  const synced = freshness(lastSync);

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">KPIs</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            How every account is pacing toward its target and its budget.
            <span className="inline-flex items-center gap-1.5 text-xs text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${synced.tone === "ok" ? "bg-ok" : synced.tone === "warn" ? "bg-warn" : "bg-faint/60"}`} />
              {synced.label} · every 2 hours
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full border border-line bg-surface p-1">
            {(["meta", "google"] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPlatform(p);
                  setOwner("all");
                  setOpen(null);
                }}
                className={`h-8 rounded-full px-4 text-sm transition-colors ${platform === p ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
              >
                {p === "meta" ? "Meta" : "Google Ads"} <span className="tabular opacity-60">{rows.filter((r) => r.platform === p).length}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setAdding((a) => !a)} className="h-10 rounded-[8px] bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover">
            Add KPI
          </button>
        </div>
      </header>

      {platform === "google" && (
        <p className="rounded-[12px] border border-warn/30 bg-warn-soft px-5 py-4 text-sm leading-relaxed text-warn">
          Google Ads isn&apos;t connected yet, so these targets and budgets are saved but have no numbers. They light up once the Google Ads API is approved.
        </p>
      )}

      {/* Where things stand */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
        {TILES.map((t) => {
          const on = status === t;
          const n = count(t);
          return (
            <button
              key={t}
              onClick={() => setStatus(on ? "all" : t)}
              className={`group relative grid gap-1 overflow-hidden rounded-[14px] border p-4 text-left transition-colors ${on ? "border-fg/40 bg-surface" : "border-line bg-surface hover:border-faint/60"}`}
            >
              <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${STATUS[t].dot}`} />
              <span className="text-xs text-muted">{STATUS[t].label}</span>
              <span className={`tabular font-heading text-[30px] leading-none ${n ? STATUS[t].text : "text-faint"}`}>{n}</span>
              <span className="text-[11px] text-faint">
                {t === "excellent" ? "20%+ better than target" : t === "good" ? "At or better than target" : t === "close" ? "Up to 15% off target" : "More than 15% off target"}
              </span>
            </button>
          );
        })}
        <div className="grid content-start gap-3 rounded-[14px] border border-line bg-surface p-4 sm:col-span-2 xl:col-span-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-muted">Spend this month</span>
            <span className="tabular text-xs text-faint">
              lands at <span className="text-fg">{money(Math.round(projected))}</span> of {money(Math.round(budget))}
            </span>
          </div>
          <span className="tabular font-heading text-[30px] leading-none">{money(Math.round(spent))}</span>
          <div className="flex flex-wrap gap-1.5">
            {(["over", "on", "under"] as const).map((p) => {
              const n = base.filter((r) => r.pace?.status === p).length;
              const m = paceMeta({ status: p } as Pacing);
              return (
                <button
                  key={p}
                  onClick={() => setPace(pace === p ? "all" : p)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${pace === p ? "bg-fg text-bg" : m.chip}`}
                >
                  <span className="tabular">{n}</span> {m.label.toLowerCase()}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {platform === "meta" && unlinked.length > 0 && <Unlinked accounts={unlinked} clients={clients} />}

      {adding && <AddKpi clients={clients} buyers={buyers} platform={platform} onDone={() => setAdding(false)} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap items-center gap-1.5">
          {[["all", "Everyone"] as const, ...(owners.some(([id]) => id === me.id) ? ([[me.id, `Mine`]] as const) : []), ...owners.filter(([id]) => id !== me.id)].map(([id, name]) => (
            <button
              key={id}
              onClick={() => setOwner(id)}
              className={`inline-flex h-9 items-center rounded-full px-4 text-sm transition-colors ${owner === id ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
            >
              {name}
            </button>
          ))}
        </nav>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
          placeholder="Search clients"
          aria-label="Search clients"
          className="h-10 w-64 max-w-full rounded-full border border-line bg-surface px-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70"
        />
      </div>

      {(status !== "all" || pace !== "all") && (
        <p className="-mt-3 text-xs text-faint">
          Showing {shown.length} {status !== "all" && <span className={STATUS[status].text}>{STATUS[status].label.toLowerCase()}</span>}
          {status !== "all" && pace !== "all" && " and "}
          {pace !== "all" && <span>{paceMeta({ status: pace } as Pacing).label.toLowerCase()}</span>}
          <button onClick={() => (setStatus("all"), setPace("all"))} className="ml-2 text-muted underline-offset-4 hover:text-fg hover:underline">
            Show all
          </button>
        </p>
      )}

      {/* Column guide */}
      <div className="-mb-4 hidden gap-x-6 px-6 text-[11px] uppercase tracking-[0.12em] text-faint md:grid md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_172px] xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_172px_minmax(168px,0.8fr)_minmax(0,1fr)]">
        <span>Client</span>
        <span>14-day vs target</span>
        <span>90 → 3 day averages</span>
        <span className="hidden xl:block">Trend</span>
        <span className="hidden xl:block">Budget this month</span>
      </div>

      {shown.length ? (
        <ul className="grid gap-2.5">
          {shown.map((r) => (
            <Row key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} buyers={buyers} />
          ))}
        </ul>
      ) : (
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">Nothing here.</p>
      )}

      {setup > 0 && status === "all" && (
        <p className="text-center text-xs text-faint">
          {setup} {setup === 1 ? "KPI isn't" : "KPIs aren't"} reporting yet: no target, no spend, or Meta can&apos;t see the ad account.{" "}
          <Link href="/clients" className="text-muted hover:text-fg">
            Clients
          </Link>
        </p>
      )}
    </div>
  );
}
