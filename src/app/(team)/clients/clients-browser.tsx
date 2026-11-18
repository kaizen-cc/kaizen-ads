"use client";

import { useState } from "react";
import type { SlotRole } from "@/lib/roles";
import { pushParams, useParam } from "@/lib/url-state";
import type { Option } from "./assign-select";
import { ClientGrid, type ClientCard } from "./client-grid";
import { SERVICES, type ServiceSlug } from "@/lib/services";
import { KPI_SORTS, LINE_LABEL, LINE_OF_SERVICE, asKpiSort, passesKpiFilter, portfolioOf, sortClients, summarize, summaryText, type KpiSort } from "@/lib/clients-kpi/core";
import { foldMatch } from "@/lib/search-fold";

// The Clients list: one segmented control for the service line (All, Meta, Google...), a small Status menu beside it
// (active, missing someone, paused, archived), and one toolbar for search, team, package tier and order. Everything but
// the search box lives in the address (?filter=, ?status=, ?who=, ?tier=, ?sort=, ?kpi=), so back returns to the list as
// it was. Older links (?filter=missing, ?filter=paused) still land on the same list.

type Service = "all" | ServiceSlug;
type Status = "active" | "missing" | "paused";

const live = (c: ClientCard) => c.status !== "paused";
const SERVICE_TABS: { key: Service; label: string }[] = [{ key: "all", label: "All" }, ...SERVICES.map((s) => ({ key: s.slug as Service, label: s.short }))];
const inService = (c: ClientCard, s: Service) => s === "all" || c.services.includes(s);
const STATUS: { key: Status; label: string; test: (c: ClientCard) => boolean }[] = [
  { key: "active", label: "Active", test: live },
  // Clients with a seat left empty on their team (the card's "N to fill")
  { key: "missing", label: "Missing someone", test: (c) => live(c) && c.missing > 0 },
  { key: "paused", label: "Paused", test: (c) => !live(c) },
];

const control = (on: boolean) =>
  `h-11 min-w-0 rounded-full border pl-4 pr-9 text-sm outline-none transition-colors md:h-9 ${on ? "border-fg/40 bg-surface-2 text-fg" : "border-line bg-surface text-muted hover:border-faint/60 hover:text-fg"} focus-visible:border-brand-text/70`;

/** Every client in one place: the service line, the status, a live search from two letters typed, team, tier and order. */
export function ClientsBrowser({
  cards,
  slotOptions,
  canEdit,
  defaultSort = "name",
  archived = 0,
}: {
  cards: ClientCard[];
  slotOptions: Record<SlotRole, Option[]>;
  canEdit: boolean;
  /** The order the list opens in: most critical first for execs, A to Z for everyone else */
  defaultSort?: KpiSort;
  /** How many clients are archived (listed below the cards): the Status menu's last option */
  archived?: number;
}) {
  const [q, setQ] = useState("");
  const term = q.trim();
  const searching = term.length >= 2;
  // The service line and the status are in the address. ?filter=missing and ?filter=paused (older links) are statuses
  const askedFilter = useParam("filter");
  const askedStatus = useParam("status");
  const service: Service = SERVICE_TABS.find((f) => f.key === askedFilter)?.key ?? "all";
  const status: Status = STATUS.find((s) => s.key === askedStatus)?.key ?? STATUS.find((s) => s.key === askedFilter)?.key ?? "active";
  const statusTest = STATUS.find((s) => s.key === status)!.test;
  // Narrow by who's on the account and by creative package tier (each in the address too)
  const who = useParam("who");
  const tier = useParam("tier");
  const people = [...new Map(cards.flatMap((c) => Object.values(c.assigned).filter((o): o is Option => Boolean(o)).map((o) => [o.id, o.name] as const))).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tiers = [...new Set(cards.map((c) => (c.pkg !== "none" ? c.packageLabel : null)).filter((t): t is string => Boolean(t)))].sort();
  const narrow = (c: ClientCard) => (!who || Object.values(c.assigned).some((o) => o?.id === who)) && (!tier || (c.pkg !== "none" && c.packageLabel === tier));
  const inFilter = cards.filter((c) => statusTest(c) && inService(c, service)).filter(narrow);
  // The order and the summary's filter are in the address too (?sort=, ?kpi=). A service tab judges by that line's KPI alone
  const sort: KpiSort = asKpiSort(useParam("sort")) ?? defaultSort;
  const only = service === "all" ? null : (LINE_OF_SERVICE[service] ?? null);
  const askedKpi = useParam("kpi");
  const kpiFilter = askedKpi === "off" || askedKpi === "critical" ? askedKpi : null;
  // Business size is judged against every client we work for now (the book), so a tab doesn't change who counts as big
  const book = portfolioOf(cards.filter(live), only);
  const summary = summarize(inFilter, only, book);
  const ordered = sortClients(kpiFilter ? inFilter.filter((c) => passesKpiFilter(c, kpiFilter, only, book)) : inFilter, sort, only, book);
  // Accents, case and punctuation don't matter ("cafe" finds "Café Diario")
  const shown = ordered.filter((c) => !searching || foldMatch(c.name, term) || (c.kaizenId != null && String(c.kaizenId) === term.replace(/\D/g, "")));

  const pickService = (s: Service) => pushParams({ filter: s === "all" ? null : s });
  const pickStatus = (v: string) => {
    if (v === "archived") {
      pushParams({ view: "archived" });
      requestAnimationFrame(() => document.getElementById("archived")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    // An older ?filter=missing or ?filter=paused gives way to ?status=
    pushParams({ status: v === "active" ? null : v, ...(STATUS.some((s) => s.key === askedFilter) ? { filter: null } : {}) });
  };
  const pickKpi = (k: "off" | "critical") => pushParams({ kpi: kpiFilter === k ? null : k });
  const narrowed = Boolean(who || tier || kpiFilter || status !== "active");

  return (
    <>
      <div className="grid gap-3">
        {/* The service line, and the status beside it */}
        <div className="flex items-center gap-3">
          <div className="no-scrollbar -mx-4 min-w-0 flex-1 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] md:mx-0 md:px-0 md:[mask-image:none]">
            <nav aria-label="Service line" className="inline-flex shrink-0 rounded-full border border-line bg-surface p-1">
              {SERVICE_TABS.map((f) => {
                const n = cards.filter((c) => statusTest(c) && inService(c, f.key)).length;
                const on = service === f.key;
                if (!n && f.key !== "all" && !on) return null;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => pickService(f.key)}
                    aria-pressed={on}
                    className={`inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm transition-colors md:h-8 ${on ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
                  >
                    {f.label}
                    <span className={`tabular text-[11px] ${on ? "opacity-60" : "text-faint"}`}>{n}</span>
                  </button>
                );
              })}
            </nav>
          </div>
          <label className="relative hidden shrink-0 md:block">
            <span className="sr-only">Status</span>
            <select value={status} onChange={(e) => pickStatus(e.target.value)} className={`appearance-none ${control(status !== "active")}`}>
              {STATUS.map((s) => {
                const n = cards.filter((c) => s.test(c) && inService(c, service)).length;
                return n || s.key === status || s.key === "active" ? (
                  <option key={s.key} value={s.key}>
                    {s.label} · {n}
                  </option>
                ) : null;
              })}
              {archived > 0 && <option value="archived">Archived · {archived}</option>}
            </select>
            <Chevron />
          </label>
        </div>

        {/* Search, then team, tier, status (phones) and order: one row that wraps */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full md:w-72">
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
              placeholder="Search clients"
              aria-label="Search clients"
              className="h-11 w-full rounded-full border border-line bg-surface pl-10 pr-4 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70 md:h-9"
            />
          </div>
          <div className="grid w-full grid-cols-2 gap-2 md:flex md:w-auto md:flex-wrap md:items-center">
            {(
              [
                ["who", who, "Everyone", "Team member", people],
                ["tier", tier, "Any tier", "Package tier", tiers.map((t) => [t, t] as const)],
              ] as const
            ).map(([key, value, all, label, options]) => (
              <label key={key} className="relative min-w-0">
                <span className="sr-only">{label}</span>
                <select value={value ?? ""} onChange={(e) => pushParams({ [key]: e.target.value || null })} className={`w-full appearance-none md:w-auto md:max-w-52 ${control(Boolean(value))}`}>
                  <option value="">{all}</option>
                  {options.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
                <Chevron />
              </label>
            ))}
            <label className="relative min-w-0 md:hidden">
              <span className="sr-only">Status</span>
              <select value={status} onChange={(e) => pickStatus(e.target.value)} className={`w-full appearance-none ${control(status !== "active")}`}>
                {STATUS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} · {cards.filter((c) => s.test(c) && inService(c, service)).length}
                  </option>
                ))}
                {archived > 0 && <option value="archived">Archived · {archived}</option>}
              </select>
              <Chevron />
            </label>
            <label className="relative min-w-0">
              <span className="sr-only">Sort clients</span>
              <select value={sort} onChange={(e) => pushParams({ sort: e.target.value === defaultSort ? null : e.target.value })} className={`w-full appearance-none md:w-auto ${control(false)}`}>
                {KPI_SORTS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Chevron />
            </label>
          </div>
          {narrowed && (
            <button type="button" onClick={() => pushParams({ who: null, tier: null, kpi: null, status: null, ...(STATUS.some((s) => s.key === askedFilter) ? { filter: null } : {}) })} className="inline-flex h-11 items-center px-2 text-xs text-muted hover:text-fg md:h-9">
              Clear filters
            </button>
          )}
        </div>

        {(summary.judged > 0 || searching) && (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm" aria-live="polite">
            {searching ? (
              <span className="text-xs text-faint">
                {shown.length ? `${shown.length} of ${inFilter.length} match "${term}"` : `Nothing matches "${term}"`}
                {!shown.length && (
                  <button type="button" onClick={() => setQ("")} className="ml-2 min-h-11 text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
                    Clear
                  </button>
                )}
              </span>
            ) : (
              <SummaryLine s={summary} only={only} active={kpiFilter} onPick={pickKpi} />
            )}
          </div>
        )}
      </div>

      {shown.length ? (
        <ClientGrid cards={shown} slotOptions={slotOptions} canEdit={canEdit} />
      ) : searching ? null : (
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">
          {status === "paused" ? "No paused clients." : status === "missing" ? "Every client has their full team." : "No clients here yet."}
        </p>
      )}
    </>
  );
}

function Chevron() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-faint">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** "12 clients off target across 3 lines: 5 critical", the two numbers pressable to narrow the list to them */
function SummaryLine({ s, only, active, onPick }: { s: ReturnType<typeof summarize>; only: Parameters<typeof summarize>[1]; active: "off" | "critical" | null; onPick: (k: "off" | "critical") => void }) {
  if (!s.offTarget) return <span className="text-muted">{summaryText(s)}</span>;
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? "" : "s"}`;
  const pill = (on: boolean) => `inline-flex h-11 items-center rounded-full px-3 text-[13px] font-medium transition-colors md:h-7 ${on ? "bg-fg text-bg" : "bg-bad-soft text-bad hover:brightness-110"}`;
  return (
    <>
      <button type="button" onClick={() => onPick("off")} aria-pressed={active === "off"} title="Show only these clients" className={pill(active === "off")}>
        {n(s.offTarget, "client")} off target
      </button>
      <span className="text-muted">
        across {only ? LINE_LABEL[only] : n(s.lines.length, "line")}
        {s.critical ? ":" : ""}
      </span>
      {s.critical > 0 && (
        <button type="button" onClick={() => onPick("critical")} aria-pressed={active === "critical"} title="Show only the critical ones" className={pill(active === "critical")}>
          {s.critical} critical
        </button>
      )}
    </>
  );
}
