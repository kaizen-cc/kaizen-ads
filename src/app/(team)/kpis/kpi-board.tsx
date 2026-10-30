"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/action-form";
import { field, label } from "@/components/ui";
import type { Agg, Pacing, Status, Trend } from "@/lib/kpi/calc";
import { CONVERSIONS } from "@/lib/kpi/conversions";
import { STATUS, deviationTone, kpiValue, money } from "@/lib/kpi/format";
import { freshness } from "@/lib/dates";
import { addKpiTarget, archiveKpiTarget, exploreKpi, linkAdAccount, pullClientKpis, saveAccountNotes, saveKpiTarget, setExtraMetrics, type NoteKey } from "./actions";
import { ClientChat } from "../clients/[slug]/client-chat";
import type { Explore } from "@/lib/kpi/explore";
import { HealthChart, PaceBar, TargetGauge, healthHex, healthOf, paceMeta } from "./kpi-charts";
import { AuditPanel, agoText, type AuditSummary, type QuickAction } from "./audit-panel";
import { ChangeLog } from "@/components/change-log";
import type { AccountChange } from "@/lib/account-changes";
import type { SprintSummary } from "@/lib/sprints";
import type { LedgerItem } from "@/lib/ledger";
import { FatigueWatch } from "@/components/fatigue-watch";
import { MarketPanel } from "../clients/[slug]/market-panel";
import { kpiCreative, type KpiCreative } from "./creative-actions";
import { QuickActions } from "./quick-actions";
import { Layer } from "../clients/[slug]/layer";
import { GoogleAdsMark, MetaMark } from "@/components/source-logo";
import { kpiCampaigns, setCampaignCounted, setCampaignResult, setCardMetric, type CampaignPerf } from "./campaign-actions";

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
  audit: AuditSummary;
  extraMetrics: string[];
  /** From the Kaizen Account Overview sheet (the source of truth for buyer, budget and target while the team moves over) */
  sheet: { priority?: string; problem?: string; solution?: string; buying?: string; creative?: string; copy?: string; comments?: string; syncedAt?: string; edits?: Partial<Record<NoteKey, { at: string; by: string; sheetWas: string }>> } | null;
  sprint: SprintSummary | null;
  /** The latest change someone made in the ad account (Meta's activity log), when it was last read */
  lastChange: { at: string | null; who: string | null; what: string | null; object: string | null; checkedAt: string; error: string | null } | null;
  changes: AccountChange[]; // the last 10 changes to the ad account
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
type Ctl = { conv: string; setConv: (v: string) => void; custom: string; setCustom: (v: string) => void; match: string; setMatch: (v: string) => void; actions: { type: string; label: string; count30: number }[] };

function TargetFields({ row, buyers, platform, ctl }: { row?: KpiRow; buyers: Person[]; platform: "meta" | "google"; ctl?: Ctl }) {
  const [ownConv, setOwnConv] = useState(row?.conversion ?? (platform === "google" ? "conversions" : "purchases"));
  const conv = ctl?.conv ?? ownConv;
  const setConv = ctl?.setConv ?? setOwnConv;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className={label}>
        Counts as a result
        <select name="conversion" data-manual value={conv} onChange={(e) => setConv(e.target.value)} className={field}>
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
        {ctl ? (
          <input name="campaign_match" data-manual value={ctl.match} onChange={(e) => ctl.setMatch(e.target.value)} className={field} placeholder="e.g. Bridal Boudoir" />
        ) : (
          <input name="campaign_match" defaultValue={row?.campaignMatch ?? ""} className={field} placeholder="e.g. Bridal Boudoir" />
        )}
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
          {ctl ? (
            <>
              <input name="custom_action" data-manual list={`actions-${row?.id}`} value={ctl.custom} onChange={(e) => ctl.setCustom(e.target.value)} className={`${field} tabular`} placeholder="offsite_conversion.custom.123456789" />
              <datalist id={`actions-${row?.id}`}>
                {ctl.actions.map((a) => (
                  <option key={a.type} value={a.type}>
                    {a.label} · {a.count30} in 30 days
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <input name="custom_action" defaultValue={row?.customAction ?? ""} className={`${field} tabular`} placeholder="offsite_conversion.custom.123456789" />
          )}
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

const fmtMetric = (v: number | null, unit: string) =>
  v == null ? "—" : unit === "$" ? money(v) : unit === "x" ? `${v.toFixed(2)}x` : unit === "%" ? `${v.toFixed(2)}%` : Math.round(v).toLocaleString("en-US");

/** The extra metric boxes on this card, and adding one: from the list, or any action this account reports. */
function MetricBoxes({ r, ex, onChange }: { r: Pick<KpiRow, "id" | "extraMetrics">; ex: Explore | null; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const [keys, setKeys] = useState(r.extraMetrics);
  const save = (next: string[]) =>
    start(async () => {
      setKeys(next);
      const res = await setExtraMetrics(r.id, next);
      if (res.ok) onChange();
    });
  const shown = keys.map((k) => ex?.metrics.find((m) => m.key === k) ?? { key: k, label: ex?.catalog.find((c) => c.key === k)?.label ?? k, unit: "", d7: null, d14: null, d30: null, prev30: null });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">More metrics for this client</p>
        {(adding || !shown.length) && (
          <button type="button" onClick={() => setAdding(!adding)} className="rounded-full border border-line px-3 py-2 text-xs text-muted hover:text-fg md:py-1">
            {adding ? "Done" : "+ Add a metric"}
          </button>
        )}
      </div>
      {adding && ex && (
        <div className="grid gap-3 rounded-[12px] border border-line bg-surface p-4">
          <div className="flex flex-wrap gap-1.5">
            {ex.catalog.map((m) => {
              const on = keys.includes(m.key);
              return (
                <button
                  key={m.key}
                  type="button"
                  disabled={pending}
                  onClick={() => save(on ? keys.filter((k) => k !== m.key) : [...keys, m.key])}
                  className={`rounded-full border px-3 py-2 text-xs transition-colors md:py-1 ${on ? "border-fg/50 bg-fg text-bg" : "border-line text-muted hover:text-fg"}`}
                >
                  {on ? "✓ " : "+ "}
                  {m.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-faint">Only this KPI card shows them; everyone else&apos;s view stays the same. Anything else the account reports can be added from &ldquo;What this account reports&rdquo; below.</p>
        </div>
      )}
      {shown.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {shown.map((m) => {
            const change = m.d30 != null && m.prev30 ? Math.round(((m.d30 - m.prev30) / m.prev30) * 100) : null;
            return (
              <div key={m.key} className="group relative grid min-w-0 content-start gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-3 md:px-4">
                <span className="pr-7 text-[11px] text-faint md:pr-5">{m.label} · 14 days</span>
                <span className="tabular text-sm">{fmtMetric(m.d14, m.unit)}</span>
                <span className="tabular text-[11px] text-faint">
                  7d {fmtMetric(m.d7, m.unit)} · 30d {fmtMetric(m.d30, m.unit)}
                  {change != null && <span className="text-muted"> · {change > 0 ? "+" : ""}{change}% vs the 30 before</span>}
                </span>
                <button
                  type="button"
                  onClick={() => save(keys.filter((k) => k !== m.key))}
                  className="absolute right-0.5 top-0.5 grid h-9 w-9 place-items-center rounded-full text-sm text-faint transition-opacity hover:text-fg focus:opacity-100 md:right-2 md:top-2 md:block md:h-auto md:w-auto md:px-1.5 md:text-xs md:opacity-0 md:group-hover:opacity-100"
                  aria-label={`Remove ${m.label}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="grid min-h-[84px] place-items-center rounded-[10px] border border-dashed border-line text-xs text-faint transition-colors hover:border-fg/30 hover:text-fg"
            >
              + Add a metric
            </button>
          )}
        </div>
      ) : (
        !adding && <p className="text-[11px] text-faint">Add ROAS, engagement, CTR, CPM or any action this account reports, next to its KPI.</p>
      )}
    </div>
  );
}

/** What the account actually reports in the last 30 days: every result type, and every action Meta sends. */
function Reported({ ex, conv, custom, onPick, onAddBox, boxes }: { ex: Explore; conv: string; custom: string; onPick: (conversion: string, custom?: string) => void; onAddBox: (key: string) => void; boxes: string[] }) {
  const [all, setAll] = useState(false);
  const list = all ? ex.actions : ex.actions.slice(0, 8);
  return (
    <details className="group rounded-[12px] border border-line bg-surface">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
        <span className="font-medium">What this account reports</span>
        <span className="text-xs text-faint">
          {ex.conversions.filter((c) => c.results30 > 0).length} of {ex.conversions.length} result types pulling · last 30 days <span className="group-open:hidden">· open</span>
        </span>
      </summary>
      <div className="grid gap-4 border-t border-line px-4 py-4">
        <div className="grid gap-2">
          <p className="text-[11px] text-faint">Click one to see the numbers counted that way (not saved until you press Save).</p>
          <div className="flex flex-wrap gap-1.5">
            {ex.conversions.map((c) => {
              const on = conv === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => onPick(c.key)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2.5 text-xs transition-colors md:py-1.5 ${on ? "border-fg/50 bg-fg text-bg" : c.results30 > 0 ? "border-line text-fg hover:border-fg/30" : "border-dashed border-line text-faint hover:text-muted"}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${c.results30 > 0 ? "bg-ok" : "bg-faint/40"}`} />
                  {c.label}
                  <span className={`tabular ${on ? "" : "text-faint"}`}>{c.results30 > 0 ? c.results30.toLocaleString("en-US") : "none"}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid gap-2">
          <p className="text-[11px] text-faint">Every action Meta reports for this account. Count any of them as the result (as a custom conversion), or add it as a box.</p>
          {/* Phones: each action as a card, its two buttons full-width underneath */}
          <ul className="grid gap-2 md:hidden">
            {list.map((a) => {
              const counted = conv === "custom" && custom === a.type;
              return (
                <li key={a.type} className={`grid gap-2.5 rounded-[10px] border border-line px-3 py-3 text-xs ${counted ? "bg-surface-2" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid min-w-0 gap-0.5">
                      <span>{a.label}</span>
                      <code className="break-all text-[10px] text-faint">{a.type}</code>
                    </span>
                    <span className="grid shrink-0 justify-items-end gap-0.5">
                      <span className="tabular">{a.count30.toLocaleString("en-US")}</span>
                      {a.value30 ? <span className="tabular text-faint">{money(a.value30)}</span> : null}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => onPick("custom", a.type)} className={`h-10 rounded-full border px-3 ${counted ? "border-fg/40 text-fg" : "border-line text-muted"}`}>
                      {counted ? "Counting this" : "Count as result"}
                    </button>
                    <button type="button" disabled={boxes.includes(`action:${a.type}`)} onClick={() => onAddBox(`action:${a.type}`)} className="h-10 rounded-full border border-line px-3 text-muted disabled:opacity-40">
                      + Box
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto rounded-[10px] border border-line md:block">
            <table className="w-full min-w-[560px] text-xs">
              <tbody className="divide-y divide-line">
                {list.map((a) => {
                  const counted = conv === "custom" && custom === a.type;
                  return (
                    <tr key={a.type} className={counted ? "bg-surface-2" : ""}>
                      <td className="px-3 py-2">
                        <span className="block">{a.label}</span>
                        <code className="text-[10px] text-faint">{a.type}</code>
                      </td>
                      <td className="tabular px-3 py-2 text-right">{a.count30.toLocaleString("en-US")}</td>
                      <td className="tabular px-3 py-2 text-right text-faint">{a.value30 ? money(a.value30) : ""}</td>
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex gap-1.5">
                          <button type="button" onClick={() => onPick("custom", a.type)} className={`rounded-full border px-2.5 py-1 ${counted ? "border-fg/40 text-fg" : "border-line text-muted hover:text-fg"}`}>
                            {counted ? "Counting this" : "Count as result"}
                          </button>
                          <button
                            type="button"
                            disabled={boxes.includes(`action:${a.type}`)}
                            onClick={() => onAddBox(`action:${a.type}`)}
                            className="rounded-full border border-line px-2.5 py-1 text-muted hover:text-fg disabled:opacity-40"
                          >
                            + Box
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {ex.actions.length > 8 && (
            <button type="button" onClick={() => setAll(!all)} className="justify-self-start py-2 text-xs text-muted hover:text-fg md:py-0">
              {all ? "Show fewer" : `Show all ${ex.actions.length}`}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

/** "5h", "3 days": how long ago something happened, from the browser's clock. */
function sinceText(iso: string) {
  const h = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
  return h < 1 ? "under an hour" : h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}
/** Someone changed the ad account in the last 48 hours: it's being worked on, even without a sprint. */
const recentlyChanged = (r: KpiRow) => Boolean(r.lastChange?.at && Date.now() - Date.parse(r.lastChange.at) < 48 * 3_600_000);

const SPRINT_TONE: Record<string, string> = {
  started: "bg-surface-2 text-muted",
  no_action: "bg-bad-soft text-bad",
  wrong_move: "bg-warn-soft text-warn",
  on_track: "bg-ok-soft text-ok",
  improving: "bg-ok-soft text-ok",
  worse: "bg-bad-soft text-bad",
  done: "bg-ok-soft text-ok",
};

const NOTE_FIELDS: [NoteKey, string][] = [
  ["problem", "#1 problem"],
  ["solution", "Solution"],
  ["buying", "Media buying update"],
  ["creative", "Creative update"],
  ["copy", "Copy update"],
  ["comments", "Comments"],
];
const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One note: a few lines, with the rest a click away when it's long. */
function Note({ label, text, edited }: { label: string; text: string; edited?: { at: string; by: string } }) {
  const [more, setMore] = useState(false);
  const long = text.length > 320 || text.split("\n").length > 5;
  return (
    <div className="grid content-start gap-1 rounded-[12px] border border-line/70 bg-bg/40 px-4 py-3">
      <dt className="flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-faint">
        {label}
        {edited && <span title={stamp(edited.at)}>Edited here by {edited.by}</span>}
      </dt>
      <dd className={`whitespace-pre-wrap text-sm leading-relaxed text-muted ${long && !more ? "line-clamp-4" : ""}`}>{text}</dd>
      {long && (
        <button type="button" onClick={() => setMore((m) => !m)} className="justify-self-start py-2 text-xs text-brand-text hover:underline md:py-0">
          {more ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

/**
 * The account's notes: #1 problem, solution, and the media buying, creative and copy updates. They come from the
 * Account Overview sheet while it's in use; the pencil edits them here, and an edit holds through the sheet's syncs
 * (the sheet only takes a field back if that cell changes there).
 */
function AccountNotes({ r }: { r: KpiRow }) {
  const s = r.sheet ?? {};
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<NoteKey, string>>>({});
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const filled = NOTE_FIELDS.filter(([k]) => s[k]);
  const edit = () => {
    setDraft(Object.fromEntries([["priority", s.priority ?? ""], ...NOTE_FIELDS.map(([k]) => [k, s[k] ?? ""])]));
    setError(null);
    setEditing(true);
  };
  const save = () =>
    start(async () => {
      const res = await saveAccountNotes(r.id, draft);
      if (!res.ok) return setError(res.error);
      setEditing(false);
      router.refresh();
    });
  return (
    <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          Account notes{s.priority ? ` · ${s.priority} priority` : ""}
          {s.syncedAt && <span className="normal-case tracking-normal"> · from the Account Overview sheet, read {stamp(s.syncedAt)}</span>}
        </p>
        {!editing && (
          <button type="button" onClick={edit} className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-xs text-muted hover:text-fg md:h-8 md:px-3" aria-label="Edit the notes">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="grid gap-3">
          <label className="grid max-w-xs gap-1 text-[11px] text-faint">
            Priority
            <select value={draft.priority ?? ""} onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))} className="h-11 rounded-[10px] border border-line bg-bg px-3 text-sm text-fg md:h-9">
              <option value="">Not set</option>
              {["High", "Medium", "Low"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {NOTE_FIELDS.map(([k, label]) => (
              <label key={k} className="grid gap-1 text-[11px] text-faint">
                {label}
                <textarea value={draft[k] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} rows={k === "buying" || k === "creative" ? 8 : 4} className="resize-y rounded-[10px] border border-line bg-bg px-3 py-2 text-sm leading-relaxed text-fg outline-none focus:border-brand/50" />
              </label>
            ))}
          </div>
          {error && <p className="text-xs text-bad">{error}</p>}
          {/* On phones Save stays in reach above the tab bar while the six fields scroll */}
          <div className="sticky bottom-[calc(58px+env(safe-area-inset-bottom))] z-10 -mx-4 -mb-4 flex flex-wrap items-center gap-2 rounded-b-[16px] border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:static md:z-auto md:mx-0 md:mb-0 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
            <button type="button" onClick={save} disabled={saving} className="h-11 flex-1 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-60 md:h-9 md:flex-none">
              {saving ? "Saving…" : "Save notes"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
              Cancel
            </button>
            {s.syncedAt && <span className="hidden text-[11px] text-faint md:inline">Your edits hold through the sheet&apos;s syncs unless that cell changes in the sheet.</span>}
          </div>
        </div>
      ) : filled.length ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          {filled.map(([k, label]) => (
            <Note key={k} label={label} text={String(s[k])} edited={s.edits?.[k]} />
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">No notes yet. Add the #1 problem, the plan and this week&apos;s updates.</p>
      )}
    </section>
  );
}

/** The sprint on this account: who's on it, how far, and what the last check said. */
function SprintStrip({ s }: { s: SprintSummary }) {
  return (
    <Link href={`/kpis/sprint/${s.id}`} className="group grid gap-2 rounded-[16px] border border-line bg-surface p-4 transition-colors hover:border-faint/70 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Optimization sprint in motion</p>
        <span className="text-xs text-muted group-hover:text-fg">Open the sprint →</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          Owned by <b>{s.buyer ?? "no buyer"}</b>
        </span>
        <span className="tabular text-muted">
          {s.done} of {s.total} actions done
        </span>
        <span className="text-xs text-faint">Next check {new Date(s.nextCheckAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric" })}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-ok" style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%` }} />
      </div>
      {s.message && <p className="line-clamp-2 text-[13px] leading-relaxed text-muted">{s.message}</p>}
    </Link>
  );
}

type Tab = "overview" | "numbers" | "actions" | "creative" | "notes" | "settings";

const TABS: Tab[] = ["overview", "numbers", "actions", "creative", "notes", "settings"];

function Detail({ r, buyers, tab, setTab, onClose, onStep }: { r: KpiRow; buyers: Person[]; tab: Tab; setTab: (t: Tab) => void; onClose: () => void; onStep: (dir: 1 | -1) => void }) {
  const router = useRouter();
  // A sheet over the board: Escape closes it, the arrows step through the accounts, the page behind stays put
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") onStep(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") onStep(-1);
    };
    window.addEventListener("keydown", key);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = was;
    };
  }, [onClose, onStep]);
  // What's being tried in the form; the numbers follow it live, before Save
  const [conv, setConv] = useState(r.conversion);
  const [custom, setCustom] = useState(r.customAction ?? "");
  const [match, setMatch] = useState(r.campaignMatch ?? "");
  const [ex, setEx] = useState<Explore | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const canExplore = Boolean(r.accountId);
  useEffect(() => {
    if (!canExplore) return;
    let live = true;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await exploreKpi(r.id, { conversion: conv, custom: conv === "custom" ? custom || null : null, campaignMatch: match || null });
      if (!live) return;
      setLoading(false);
      if (res.ok) {
        setEx(res.data);
        setErr(null);
      } else setErr(res.error);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [r.id, conv, custom, match, canExplore, nonce]);

  const previewing = conv !== r.conversion || (conv === "custom" && custom !== (r.customAction ?? "")) || match !== (r.campaignMatch ?? "");
  const snap = previewing && ex ? ex.snapshot : null;
  const windows = snap ? snap.windows : r.windows;
  const months = snap ? snap.months : r.months;
  const daily = snap ? snap.daily : r.daily;
  const roas = Boolean(CONVERSIONS.find((c) => c.key === conv)?.roas);
  const convLabel = conv === "custom" ? (custom ? custom.replace(/^offsite_conversion\.custom\./, "Custom ") : "Custom conversion") : (CONVERSIONS.find((c) => c.key === conv)?.label ?? conv);
  const pick = (c: string, a?: string) => {
    setConv(c);
    if (a !== undefined) setCustom(a);
  };
  const reset = () => {
    setConv(r.conversion);
    setCustom(r.customAction ?? "");
    setMatch(r.campaignMatch ?? "");
  };

  const win = [
    ["3 days", windows.d3],
    ["7 days", windows.d7],
    ["14 days", windows.d14],
    ["30 days", windows.d30],
    ["60 days", windows.d60],
    ["90 days", windows.d90],
  ] as const;
  const monthList = [
    ["This month", months.mtd],
    ["Last month", months.lastMonth],
    ["This quarter", months.qtd],
    ["Last quarter", months.lastQuarter],
  ] as const;
  const cell = (a: Agg | undefined) => (
    <>
      <span className={`tabular font-heading text-lg leading-tight ${r.target ? deviationTone(a?.value != null && r.target ? (roas ? (r.target - a.value) / r.target : (a.value - r.target) / r.target) : null) : "text-fg"}`}>
        {kpiValue(a?.value, roas)}
      </span>
      <TargetGauge value={a?.value} target={r.target} roas={roas} />
      <span className="tabular text-[11px] text-faint">
        {money(a?.spend ?? 0)} · {a?.results ?? 0} {a?.results === 1 ? "result" : "results"}
      </span>
    </>
  );
  const color = healthHex(healthOf(r.status));
  const d14 = r.windows.d14;
  const gap = gapText(r);
  const moves = (r.audit?.quick ?? []).filter((q) => !q.done).length;
  const notes = NOTE_FIELDS.filter(([k]) => r.sheet?.[k]).length;
  const tabs: { id: Tab; label: string; count?: number | null; hint: string }[] = [
    { id: "overview", label: "Overview", hint: "Where it stands, the 30 days, budget and the next move" },
    { id: "numbers", label: "Numbers", hint: "Every window, month and quarter, and the metrics Meta reports" },
    { id: "actions", label: "Actions", count: moves || null, hint: "The audit and the moves to make in the ad account" },
    { id: "creative", label: "Creative", hint: "Ads wearing out, what has worked for them, and what's live in their market" },
    { id: "notes", label: "Notes", count: notes || null, hint: "The #1 problem, the plan, this week's updates and every change in the account" },
    { id: "settings", label: "Settings", hint: "What's counted, the target and the budget" },
  ];
  const dim = loading && previewing ? "opacity-60" : "";

  const chart = (
    <div className={`relative isolate grid content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 transition-opacity md:p-5 ${dim}`}>
      <span aria-hidden className="pointer-events-none absolute -left-20 -top-24 -z-10 h-64 w-64 rounded-full blur-[90px]" style={{ background: `${color}33` }} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Last 30 days</p>
          <p className="text-sm text-muted">{roas ? `${convLabel} per day` : `Cost per ${convLabel.toLowerCase().replace(/s$/, "")}, 3-day rolling`}</p>
        </div>
        <span className="flex gap-3 text-[11px] text-faint">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#3fb27f]" />Beating</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#e0a63a]" />Close</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#e0505c]" />Over</span>
        </span>
      </div>
      <HealthChart id={`${r.id}-detail`} daily={daily} target={r.target} roas={roas} status={r.status} unit={convLabel.toLowerCase().replace(/s$/, "")} />
      <p className="text-[11px] text-faint">Faint bars are daily spend. Point at a day for its numbers.</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${r.client} KPI`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px] motion-safe:animate-[fadeIn_.18s_ease-out]" />
      <div className="relative flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg shadow-[0_0_80px_-20px_rgba(0,0,0,0.9)] motion-safe:animate-[sheetIn_.24s_cubic-bezier(.2,.8,.2,1)] md:w-[min(980px,94vw)]">
        {/* Who, how it's doing, and the tabs: always in view */}
        <header className="relative isolate shrink-0 border-b border-line bg-surface/80 backdrop-blur" style={{ backgroundImage: `radial-gradient(90% 140% at 0% 0%, ${color}2e, transparent 60%)` }}>
          <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color, boxShadow: `0 0 22px ${color}` }} />
          <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+16px)] sm:px-6 md:pt-5">
            <div className="grid min-w-0 gap-1">
              <p className="truncate font-heading text-xl leading-tight md:text-2xl">
                {r.client}
                {r.label && <span className="text-muted"> · {r.label}</span>}
              </p>
              <p className="truncate text-xs text-faint">
                {r.platform === "google" ? "Google Ads" : "Meta"} · {r.conversionLabel}
                {r.owner && ` · ${r.owner}`}
                {r.source === "client" && " · client's target"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => onStep(-1)} aria-label="Previous account" className="hidden h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:grid">‹</button>
              <button type="button" onClick={() => onStep(1)} aria-label="Next account" className="hidden h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:grid">›</button>
              <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-lg text-muted hover:bg-surface-2 hover:text-fg md:h-9 md:w-9">
                ×
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 pb-4 sm:px-6">
            {r.status === "setup" ? (
              <div className="flex items-center gap-2">
                <StatusPill status="setup" />
                <span className="text-xs text-faint">{r.error ?? (r.target ? "Waiting for data" : "Add a target in Settings")}</span>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="tabular font-display text-[34px] leading-none tracking-tight" style={{ color }}>
                    {kpiValue(d14?.value, r.roas)}
                  </span>
                  <span className="tabular text-sm text-faint">/ {kpiValue(r.target, r.roas)} target · 14 days</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={r.status} />
                  {gap && <span className="text-xs text-muted">{gap}</span>}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <ClientChat
                variant="inline"
                clientId={r.clientId}
                client={r.client}
                live
                targets={r.accountId ? [{ id: r.id, label: `${r.platform === "google" ? "Google" : "Meta"}${r.label ? ` · ${r.label}` : ""}`, status: r.audit?.status ?? "none", auditId: r.audit?.id ?? null }] : []}
              />
              <Link href={`/clients/${r.slug}?service=${r.platform}`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
                Client page →
              </Link>
            </div>
          </div>
          <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 sm:px-5" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                title={t.hint}
                onClick={() => setTab(t.id)}
                className={`relative inline-flex h-12 shrink-0 items-center gap-1.5 px-3 text-sm transition-colors md:h-11 ${tab === t.id ? "text-fg" : "text-muted hover:text-fg"}`}
              >
                {t.label}
                {t.count ? <span className={`tabular rounded-full px-1.5 text-[10px] leading-4 ${t.id === "actions" ? "bg-brand text-white" : "bg-surface-2 text-muted"}`}>{t.count}</span> : null}
                {tab === t.id && <span aria-hidden className="absolute inset-x-2 bottom-0 h-[2px] rounded-full" style={{ background: color }} />}
              </button>
            ))}
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 pb-[calc(env(safe-area-inset-bottom)+24px)] sm:px-6 md:py-6">
          <div className="grid gap-5 md:gap-6">
            <p className="-mb-2 text-xs text-faint">{tabs.find((t) => t.id === tab)?.hint}</p>

            {previewing && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-brand/40 bg-brand-soft px-4 py-3 text-sm">
                <span>
                  Previewing <b>{convLabel}</b>
                  {match ? ` in campaigns containing "${match}"` : ""}
                  {loading ? " · counting…" : ex?.resultType ? <span className="text-muted"> · counted as Meta&apos;s {ex.resultType}</span> : null}
                  <span className="text-muted"> · not saved yet</span>
                </span>
                <span className="flex gap-2">
                  {tab !== "settings" && (
                    <button type="button" onClick={() => setTab("settings")} className="rounded-full bg-fg px-3 py-2.5 text-xs text-bg md:py-1">
                      Save it
                    </button>
                  )}
                  <button type="button" onClick={reset} className="rounded-full border border-line bg-surface px-3 py-2.5 text-xs text-muted hover:text-fg md:py-1">
                    Back to the saved view
                  </button>
                </span>
              </div>
            )}

            {tab === "overview" && (
              <>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                  {chart}
                  <div className="grid content-start gap-3">
                    <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Budget this month</p>
                      <PaceBar pace={r.pace} note={r.budgetNote} />
                      {r.pace && r.pace.dailyNeeded != null && r.pace.status !== "early" && (
                        <p className="text-xs leading-relaxed text-muted">
                          About <span className="tabular text-fg">{money(r.pace.dailyNeeded)}</span> a day for the next {Math.ceil(r.pace.daysLeft)} days lands it on budget.
                        </p>
                      )}
                    </div>
                    <div className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Momentum</p>
                      <Delta label="vs last month" value={r.vsMonth} />
                      <Delta label="vs last quarter" value={r.vsQuarter} />
                      {r.trend && r.status !== "setup" && (
                        <span className={`text-xs ${r.trend === "improving" ? "text-ok" : r.trend === "slipping" ? "text-bad" : "text-faint"}`}>
                          {r.trend === "improving" ? "Last 3 days improving" : r.trend === "slipping" ? "Last 3 days slipping" : "Last 3 days steady"}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <NextMove r={r} moves={moves} onActions={() => setTab("actions")} onNotes={() => setTab("notes")} />
                {r.accountId && <Campaigns key={`${r.id}:${r.conversion}:${r.target}`} id={r.id} target={r.target} conversion={r.conversion} platform={r.platform} />}
                {r.audit?.status === "ready" && r.audit.quick && r.audit.quick.length > 0 && (
                  <section className="grid gap-1 rounded-[20px] border border-line bg-surface px-4 pb-4 md:px-5 md:pb-5">
                    <QuickActions key={r.audit.id} auditId={r.audit.id} items={r.audit.quick} platform={r.audit.platform ?? r.platform} />
                    <button type="button" onClick={() => setTab("actions")} className="justify-self-start py-2 text-xs text-muted hover:text-fg">
                      The whole audit, with why and every step →
                    </button>
                  </section>
                )}
                {r.sprint && <SprintStrip s={r.sprint} />}
              </>
            )}

            {tab === "numbers" && (
              <>
                <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line transition-opacity sm:grid-cols-3 lg:grid-cols-6 ${dim}`}>
                  {win.map(([name, a]) => (
                    <div key={name} className={`grid min-w-0 gap-1.5 bg-surface px-3 py-3 md:px-4 ${name === "14 days" ? "ring-1 ring-inset ring-fg/25" : ""}`}>
                      <span className="text-[11px] text-faint">
                        {name}
                        {name === "14 days" && " · sets the status"}
                      </span>
                      {cell(a)}
                    </div>
                  ))}
                </div>
                <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line transition-opacity lg:grid-cols-4 ${dim}`}>
                  {monthList.map(([name, a]) => (
                    <div key={name} className="grid min-w-0 gap-1.5 bg-surface px-3 py-3 md:px-4">
                      <span className="text-[11px] text-faint">{name}</span>
                      {cell(a)}
                    </div>
                  ))}
                </div>
                {canExplore && <MetricBoxes key={r.extraMetrics.join(",")} r={r} ex={ex} onChange={() => { setNonce((n) => n + 1); router.refresh(); }} />}
                {canExplore && ex && (
                  <Reported
                    ex={ex}
                    conv={conv}
                    custom={custom}
                    onPick={pick}
                    boxes={r.extraMetrics}
                    onAddBox={async (k) => {
                      await setExtraMetrics(r.id, [...r.extraMetrics, k]);
                      setNonce((n) => n + 1);
                      router.refresh();
                    }}
                  />
                )}
                {err && <p className="text-xs text-bad">{err}</p>}
              </>
            )}

            {tab === "actions" &&
              (r.accountId ? (
                <>
                  {(r.status === "off" || r.status === "close") && !r.sprint && r.audit?.status !== "running" && !recentlyChanged(r) && (
                    <p suppressHydrationWarning className="rounded-[14px] border border-dashed border-bad/50 px-4 py-3 text-sm text-bad">
                      Nobody&apos;s optimizing this account yet{r.lastChange?.at ? `: no changes in ${sinceText(r.lastChange.at)}` : ""}. Run the audit and make the first moves below.
                    </p>
                  )}
                  <AuditPanel targetId={r.id} audit={r.audit} platform={r.platform} />
                  {r.sprint && <SprintStrip s={r.sprint} />}
                </>
              ) : (
                <p className="rounded-[14px] border border-dashed border-line px-5 py-10 text-center text-sm text-muted">Link the ad account (in Settings) and the audit can read it.</p>
              ))}

            {tab === "creative" && <CreativeTab r={r} />}

            {tab === "notes" && (
              <>
                <AccountNotes r={r} />
                {r.accountId && <ChangeLog changes={r.changes} platform={r.platform} limit={10} collapsed={5} />}
              </>
            )}

            {tab === "settings" && (
              <section className="grid gap-4 rounded-[16px] border border-line bg-surface p-4 md:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  {r.sheet ? <p className="text-[11px] text-faint">Buyer, budget and target come from the Account Overview sheet (read at 12pm and 5pm): change them there.</p> : <span />}
                  <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                    {r.accountId && <ActionButton action={pullClientKpis.bind(null, r.clientId)} label={r.platform === "google" ? "Pull from Google now" : "Pull from Meta now"} />}
                    <ActionButton action={archiveKpiTarget.bind(null, r.id)} label="Remove" confirmText="Remove this KPI?" />
                  </div>
                </div>
                <ActionForm action={saveKpiTarget.bind(null, r.id, r.clientId)} submitLabel={`Save, counting ${convLabel}`} autosave={!previewing} button={previewing} className="grid gap-4">
                  <TargetFields row={r} buyers={buyers} platform={r.platform} ctl={{ conv, setConv, custom, setCustom, match, setMatch, actions: ex?.actions ?? [] }} />
                </ActionForm>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Every campaign in the account against the card's target: one card per client, the campaigns inside it. Each
 * campaign is judged on its own result (what it's optimized for, or one picked here), and one the client runs
 * themselves can be switched out of the KPI. At the top, what the whole card is judged on and its target. Any change
 * works the card's numbers out again straight away.
 */
function Campaigns({ id, target, conversion, platform }: { id: string; target: number | null; conversion: string; platform: "meta" | "google" }) {
  const router = useRouter();
  const [data, setData] = useState<{ roas: boolean; campaigns: CampaignPerf[] } | null>(null);
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState(conversion);
  const [goal, setGoal] = useState(target == null ? "" : String(target));
  const load = () => kpiCampaigns(id).then(setData, () => setData({ roas: false, campaigns: [] }));
  useEffect(() => {
    let live = true;
    kpiCampaigns(id).then(
      (d) => {
        if (!live) return;
        setData(d);
        // The campaigns' goals were just read from Meta: the card's own numbers changed with them
        if (d.fetched) router.refresh();
      },
      () => live && setData({ roas: false, campaigns: [] }),
    );
    return () => {
      live = false;
    };
  }, [id, router]);
  const after = async (res: { ok: true } | { ok: false; error: string }) => {
    setError(res.ok ? null : res.error);
    await load();
    setSaving(null);
    router.refresh();
  };
  const toggle = async (c: CampaignPerf) => {
    setSaving(c.id);
    setData((d) => (d ? { ...d, campaigns: d.campaigns.map((x) => (x.id === c.id ? { ...x, excluded: !x.excluded } : x)) } : d));
    await after(await setCampaignCounted(id, c.id, c.excluded));
  };
  const pick = async (c: CampaignPerf, type: string | null) => {
    setSaving(c.id);
    await after(await setCampaignResult(id, c.id, type));
  };
  const options = CONVERSIONS.filter((c) => c.platforms.includes(platform) && c.key !== "custom");
  const roasMetric = Boolean(CONVERSIONS.find((c) => c.key === metric)?.roas);
  const changed = metric !== conversion || goal !== (target == null ? "" : String(target));
  const saveMetric = async () => {
    setSaving("card");
    await after(await setCardMetric(id, metric, goal ? Number(goal) : null));
  };

  if (data && !data.campaigns.length) return null;
  const fmt = (v: number | null) => (v == null ? "—" : data?.roas ? `${v.toFixed(2)}x` : money(v));
  // Counted first (spending now first, then the month's spend); switched-out ones drop to the bottom at once
  const sorted = data ? [...data.campaigns].sort((a, b) => Number(a.excluded) - Number(b.excluded) || Number(b.spend7 > 0) - Number(a.spend7 > 0) || b.spend30 - a.spend30) : [];
  const list = all ? sorted : sorted.slice(0, 8);
  const out = sorted.filter((c) => c.excluded).length;
  const cols = "md:grid-cols-[minmax(0,1fr)_92px_minmax(150px,190px)_104px_92px_44px]";

  return (
    <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Campaigns</p>
          <p className="text-xs text-faint">Last 30 days, each judged on its own result{out ? ` · ${out} switched out of the KPI` : ""}</p>
        </div>
      </div>

      {/* What the whole card is judged on */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] border border-line/70 bg-bg/40 px-4 py-3">
        <span className="text-xs text-faint">Judge the card on</span>
        <span className="relative">
          <select
            value={metric}
            onChange={(e) => {
              const next = e.target.value;
              setMetric(next);
              // A cost target and a ROAS target aren't the same number: asked again when switching between them
              if (Boolean(CONVERSIONS.find((c) => c.key === next)?.roas) !== Boolean(CONVERSIONS.find((c) => c.key === conversion)?.roas)) setGoal("");
            }}
            aria-label="What the card is judged on"
            className="h-11 appearance-none rounded-full border border-line bg-surface pl-4 pr-9 text-sm font-medium outline-none transition-colors hover:border-faint focus:border-brand-text/60 md:h-9"
          >
            {options.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key === "campaign_goal" ? "Each campaign's own result" : c.roas ? `ROAS (${c.label === "ROAS" ? "purchases" : c.label})` : `Cost per ${c.label.toLowerCase().replace(/s$/, "")}`}
              </option>
            ))}
          </select>
          <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-faint">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
        <span className="text-xs text-faint">at</span>
        <span className="relative">
          {!roasMetric && <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-faint">$</span>}
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            placeholder={roasMetric ? "3.0" : "45"}
            aria-label="Target"
            className={`tabular h-11 w-24 rounded-full border border-line bg-surface pr-4 text-sm font-medium outline-none transition-colors hover:border-faint focus:border-brand-text/60 md:h-9 ${roasMetric ? "pl-4" : "pl-7"}`}
          />
          {roasMetric && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-faint">x</span>}
        </span>
        <span className="text-xs text-faint">{roasMetric ? "or better" : "or less per result"}</span>
        {changed && (
          <button type="button" disabled={saving === "card" || !goal} onClick={saveMetric} className="ml-auto h-11 rounded-full bg-fg px-5 text-sm font-medium text-bg transition-opacity disabled:opacity-40 md:h-9">
            {saving === "card" ? "Saving…" : "Save"}
          </button>
        )}
        {error && <span className="w-full text-xs text-bad">{error}</span>}
      </div>

      {!data ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((n) => (
            <span key={n} className="h-14 animate-pulse rounded-[14px] bg-surface-2" />
          ))}
        </div>
      ) : (
        <div className="grid">
          <div className={`hidden gap-4 px-3 pb-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-faint md:grid ${cols}`}>
            <span>Campaign</span>
            <span className="text-right">Spend</span>
            <span>Result</span>
            <span className="text-right">{data.roas ? "ROAS" : "Per result"}</span>
            <span className="text-right">{data.roas ? "Purchases" : "ROAS"}</span>
            <span className="text-right" title="Counted in the KPI">KPI</span>
          </div>
          <ul className="grid gap-1.5">
            {list.map((c) => {
              const tone = c.deviation == null ? (c.spend30 > 0 && !c.results30 ? "text-bad" : "text-faint") : c.deviation <= 0 ? "text-ok" : c.deviation <= 0.15 ? "text-warn" : "text-bad";
              return (
                <li
                  key={c.id}
                  className={`grid grid-cols-2 items-center gap-x-4 gap-y-3 rounded-[14px] border px-3 py-3 transition-[opacity,background-color] md:gap-y-0 ${cols} ${c.excluded ? "border-dashed border-line bg-transparent opacity-50" : "border-line/60 bg-bg/40 hover:bg-bg/70"}`}
                >
                  {/* The campaign */}
                  <span className="col-span-2 flex min-w-0 items-start gap-2.5 md:col-span-1">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c.spend7 > 0 ? "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]" : "bg-faint/40"}`} title={c.spend7 > 0 ? "Spending this week" : c.lastSpent ? `Last spent ${c.lastSpent}` : "Not spending"} />
                    <span className="grid min-w-0 gap-0.5">
                      <span className={`truncate text-[13.5px] font-medium ${c.excluded ? "line-through decoration-faint/60" : ""}`} title={c.name}>
                        {c.name}
                      </span>
                      <span className="truncate text-[11px] text-faint">
                        {c.excluded ? "Run by the client · not in the KPI" : c.goal ? `Optimized for ${c.goal}` : c.spend7 > 0 ? "Spending this week" : c.lastSpent ? `Last spent ${c.lastSpent}` : "Not spending"}
                      </span>
                    </span>
                  </span>

                  {/* Spend */}
                  <span className="grid justify-items-start gap-0.5 md:justify-items-end">
                    <span className="tabular text-[13.5px]">{money(c.spend30)}</span>
                    <span className="tabular text-[11px] text-faint">{money(c.spend7)} this week</span>
                  </span>

                  {/* The result it's judged on, and the picker */}
                  <span className="justify-self-end md:justify-self-stretch">
                    <ResultPicker c={c} busy={saving === c.id} onPick={(t) => pick(c, t)} />
                  </span>

                  {/* Cost per result (ROAS on a ROAS card) */}
                  <span className="grid justify-items-start gap-0.5 md:justify-items-end">
                    <span className={`tabular font-display text-[17px] leading-none ${tone}`}>{c.value30 == null ? (c.spend30 > 0 ? "None" : "—") : fmt(c.value30)}</span>
                    <span className="text-[11px] text-faint">{c.value30 == null && c.spend30 > 0 ? "no results yet" : data.roas ? "return" : "per result"}</span>
                  </span>

                  {/* ROAS from purchases (purchases on a ROAS card) */}
                  <span className="grid justify-items-end gap-0.5" title={c.revenue30 ? `${c.purchases30} purchases, ${money(c.revenue30)} in sales` : "No purchases tracked"}>
                    {data.roas ? (
                      <span className="tabular text-[13.5px]">{c.purchases30 || "—"}</span>
                    ) : (
                      <span className={`tabular text-[13.5px] ${c.roas30 != null && c.revenue30 ? (c.roas30 >= 1 ? "text-ok" : "text-warn") : "text-faint"}`}>{c.roas30 != null && c.revenue30 ? `${c.roas30.toFixed(2)}x` : "—"}</span>
                    )}
                    <span className="text-[11px] text-faint">{data.roas ? "purchases" : c.purchases30 ? `${c.purchases30} purchase${c.purchases30 === 1 ? "" : "s"}` : "no purchases"}</span>
                  </span>

                  {/* In the KPI or not */}
                  <span className="col-span-2 flex justify-end md:col-span-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!c.excluded}
                      disabled={saving === c.id}
                      onClick={() => toggle(c)}
                      title={c.excluded ? "Switched out: the client runs it. Switch it back into the KPI" : "In the KPI. Switch it out if the client runs it themselves"}
                      className="group/sw flex min-h-11 items-center gap-2 disabled:opacity-50 md:min-h-0"
                    >
                      <span className="text-[11px] text-faint md:hidden">{c.excluded ? "Not in the KPI" : "In the KPI"}</span>
                      <span className={`relative h-5 w-9 rounded-full transition-colors ${c.excluded ? "bg-surface-2 ring-1 ring-line" : "bg-ok/80"}`}>
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] ${c.excluded ? "left-0.5" : "left-[18px]"}`} />
                      </span>
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {data.campaigns.length > 8 && (
            <button type="button" onClick={() => setAll((a) => !a)} className="mt-2 h-11 justify-self-start px-1 text-xs text-muted hover:text-fg md:h-8">
              {all ? "Show fewer" : `All ${data.campaigns.length} campaigns`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** The result a campaign is judged on, as a chip; it opens a short list of what the campaign reports to pick from. */
function ResultPicker({ c, busy, onPick }: { c: CampaignPerf; busy: boolean; onPick: (type: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const unset = !c.result || c.result === "campaign_goal";
  const auto = !c.goal;
  const choose = (t: string | null) => {
    setOpen(false);
    onPick(t);
  };
  return (
    <span ref={box} className="relative block">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group/rp flex min-h-11 w-full items-center gap-2 rounded-[12px] border px-3 py-1.5 text-left transition-colors disabled:opacity-50 md:min-h-0 ${unset ? "border-dashed border-warn/50 hover:border-warn" : "border-transparent hover:border-line hover:bg-surface"}`}
      >
        <span className="grid min-w-0 flex-1">
          <span className="tabular text-[15px] font-medium leading-tight">{unset ? "—" : c.results30.toLocaleString("en-US")}</span>
          <span className={`truncate text-[11px] ${unset ? "text-warn" : "text-faint"}`}>
            {busy ? "Saving…" : c.resultLabel}
            {c.resultFrom === "picked" && !busy && <span className="text-brand-text"> · set</span>}
          </span>
        </span>
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={`shrink-0 text-faint transition-transform group-hover/rp:text-fg ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <span role="menu" className="absolute right-0 top-full z-30 mt-1.5 grid w-[260px] gap-0.5 rounded-[16px] border border-line bg-surface p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.7)] md:left-0 md:right-auto" style={{ animation: "fadeIn .15s ease-out" }}>
          <span className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-faint">Judge {c.name.length > 26 ? "this campaign" : c.name} on</span>
          {(c.goal || c.resultFrom === "auto" || (c.resultFrom === "picked" && auto)) && (
            <button type="button" role="menuitemradio" aria-checked={c.resultFrom === "goal" || c.resultFrom === "auto"} onClick={() => choose(null)} className={`flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${c.resultFrom === "goal" || c.resultFrom === "auto" ? "bg-surface-2" : ""}`}>
              <span className="grid min-w-0 flex-1">
                <span className="truncate">{c.goal ?? (c.resultFrom === "auto" ? c.resultLabel : "Automatic")}</span>
                <span className="text-[10.5px] text-faint">{c.goal ? "What it's optimized for" : "Automatic: its strongest result"}</span>
              </span>
              {(c.resultFrom === "goal" || c.resultFrom === "auto") && <span className="text-ok">✓</span>}
            </button>
          )}
          {(c.goal || c.resultFrom === "auto") && c.options.length > 0 && <span className="mx-2.5 my-1 h-px bg-line" />}
          {c.options.map((o) => {
            const on = c.resultFrom === "picked" && c.result === o.type;
            return (
              <button key={o.type} type="button" role="menuitemradio" aria-checked={on} onClick={() => choose(o.type)} className={`flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${on ? "bg-surface-2" : ""}`}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="tabular text-[11.5px] text-faint">{o.count.toLocaleString("en-US")}</span>
                <span className="w-3 text-ok">{on ? "✓" : ""}</span>
              </button>
            );
          })}
          {!c.options.length && <span className="px-2.5 py-2 text-xs text-faint">This campaign hasn&apos;t reported any results yet.</span>}
        </span>
      )}
    </span>
  );
}

function NextMove({ r, moves, onActions, onNotes }: { r: KpiRow; moves: number; onActions: () => void; onNotes: () => void }) {
  const v = r.audit?.status === "ready" ? r.audit.verdict : null;
  const problem = r.sheet?.problem;
  const solution = r.sheet?.solution;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <button type="button" onClick={onActions} className="group grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">What to do</span>
          <span className="text-xs text-muted group-hover:text-fg">{moves ? `${moves} ${moves === 1 ? "move" : "moves"} →` : "Actions →"}</span>
        </span>
        {v ? (
          <>
            <span className="font-heading text-[17px] leading-snug">{v.headline}</span>
            <span className="line-clamp-3 text-sm leading-relaxed text-muted">{v.summary}</span>
            <span suppressHydrationWarning className="text-[11px] text-faint">
              Audited {agoText(r.audit!.createdAt)}
              {r.audit!.by ? ` by ${r.audit!.by}` : ""}
            </span>
          </>
        ) : r.audit?.status === "running" || r.audit?.status === "queued" ? (
          <span className="text-sm text-brand-text">{r.audit.status === "running" ? `The audit is running (${r.audit.progress}%)` : "The audit is queued"}</span>
        ) : (
          <span className="text-sm text-muted">No audit yet. Run one and the moves to make in the account show up here.</span>
        )}
      </button>
      <button type="button" onClick={onNotes} className="group grid content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint/70 md:p-5">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">#1 problem{r.sheet?.priority ? ` · ${r.sheet.priority} priority` : ""}</span>
          <span className="text-xs text-muted group-hover:text-fg">Notes →</span>
        </span>
        {problem ? <span className="line-clamp-3 text-sm leading-relaxed">{problem}</span> : <span className="text-sm text-muted">Not written down yet.</span>}
        {solution && (
          <span className="line-clamp-3 text-sm leading-relaxed text-muted">
            <span className="text-faint">Plan: </span>
            {solution}
          </span>
        )}
        {r.lastChange?.at && (
          <span suppressHydrationWarning className="truncate text-[11px] text-faint">
            Last change {sinceText(r.lastChange.at)} ago · {r.lastChange.what}
            {r.lastChange.who ? ` by ${r.lastChange.who}` : ""}
          </span>
        )}
      </button>
    </div>
  );
}

const ledgerMetric = (i: LedgerItem) => (i.roas != null ? `${i.roas}x ROAS` : i.costPerResult != null ? `${money(i.costPerResult)} each` : `${Math.round(i.results)} results`);

/** Creative, read when the tab opens: ads wearing out, what has and hasn't worked for this client, their market. */
function CreativeTab({ r }: { r: KpiRow }) {
  const [d, setD] = useState<KpiCreative | null>(null);
  useEffect(() => {
    let live = true;
    void kpiCreative(r.clientId).then((x) => {
      if (live) setD(x);
    });
    return () => {
      live = false;
    };
  }, [r.clientId]);
  if (!d)
    return (
      <div className="grid gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-[20px] bg-surface" />
        ))}
      </div>
    );
  return (
    <>
      <FatigueWatch rows={d.fatigue} showClient={false} empty="No ads wearing out right now." />
      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="font-heading text-[17px]">What has worked for them</h2>
            <p className="mt-1 text-sm text-muted">From their playbook: build the next creative on these.</p>
          </div>
          <span className="flex flex-wrap gap-3 text-xs">
            <Link href={`/clients/${r.slug}?service=business&tab=playbook`} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
              Full playbook →
            </Link>
            <Link href={`/clients/${r.slug}?service=creative&tab=production`} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
              Creative in production →
            </Link>
          </span>
        </div>
        {d.winners.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.winners.map((i) => (
              <li key={i.id} className="flex gap-3 rounded-[14px] bg-bg/50 p-3">
                {i.kind === "creative" &&
                  (i.detail.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.detail.image} alt="" loading="lazy" className="h-16 w-12 shrink-0 rounded-[8px] bg-surface-2 object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  ) : (
                    <span className="h-16 w-12 shrink-0 rounded-[8px] bg-surface-2" />
                  ))}
                <span className="grid min-w-0 content-start gap-1">
                  <span className="flex items-center gap-2 text-[11px]">
                    <span className="rounded-full bg-ok-soft px-2 py-0.5 font-medium text-ok">{i.kind === "angle" ? "Winning angle" : "Winning ad"}</span>
                    {i.live && <span className="text-ok">Live</span>}
                  </span>
                  <span className="line-clamp-2 text-sm leading-snug">{i.title}</span>
                  <span className="tabular text-[11px] text-muted">
                    {money(i.spend)} spent · {ledgerMetric(i)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-faint">No clear winners yet: the playbook fills in as their ads gather results.</p>
        )}
        {d.losers.length > 0 && (
          <div className="grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Didn&apos;t work, don&apos;t repeat</span>
            <ul className="flex flex-wrap gap-1.5">
              {d.losers.map((i) => (
                <li key={i.id} className="rounded-full bg-bad-soft px-3 py-1 text-xs text-bad" title={i.reason ?? undefined}>
                  {i.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {d.market.length ? (
        <MarketPanel clientId={r.clientId} industry={d.industry} label={d.industryLabel} ads={d.market} />
      ) : (
        <p className="rounded-[20px] border border-dashed border-line px-5 py-8 text-center text-sm text-faint">Nothing from their market yet: set their industry or competitors on the client page.</p>
      )}
    </>
  );
}

function Card({ r, active, onOpen, onMove }: { r: KpiRow; active: boolean; onOpen: () => void; onMove: (index: number) => void }) {
  const d14 = r.windows.d14;
  const gap = gapText(r);
  const color = healthHex(healthOf(r.status));
  const moves = (r.audit?.quick ?? []).filter((q) => !q.done).length;
  const idle = (r.status === "off" || r.status === "close") && !r.sprint && r.audit?.status !== "running" && !recentlyChanged(r);
  const headline = r.sheet?.problem || (r.audit?.status === "ready" ? r.audit.verdict?.headline : null);
  return (
    <li id={`kpi-${r.id}`} className="scroll-mt-24">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={`group relative isolate grid h-full w-full content-start gap-3 overflow-hidden rounded-[20px] border bg-surface p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_50px_-28px_rgba(0,0,0,0.95)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/40 ${active ? "border-fg/40" : "border-line hover:border-faint/60"}`}
        style={{ backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${color}26, transparent 55%)` }}
      >
        <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color, boxShadow: `0 0 18px ${color}` }} />

        {/* Who */}
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-heading text-[16px] leading-snug">
              {r.client}
              {r.label && <span className="text-muted"> · {r.label}</span>}
            </p>
            <p className="mt-0.5 truncate text-xs text-faint">
              {r.conversionLabel}
              {r.owner && ` · ${r.owner}`}
            </p>
          </div>
          <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0">
            {r.status === "off" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: color }} />}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          </span>
        </div>

        {/* The KPI */}
        {r.status === "setup" ? (
          <div className="grid gap-1">
            <StatusPill status="setup" />
            <span className="truncate text-xs text-faint">{r.error ?? (r.target ? "Waiting for data" : "Add a target")}</span>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="tabular font-display text-[30px] leading-none tracking-tight" style={{ color }}>
                {kpiValue(d14?.value, r.roas)}
              </span>
              <span className="tabular truncate text-xs text-faint">/ {kpiValue(r.target, r.roas)}</span>
            </div>
            <TargetGauge value={d14?.value} target={r.target} roas={r.roas} />
            <span className="flex items-center gap-2">
              <StatusPill status={r.status} />
              {gap && <span className="truncate text-[11px] text-muted">{gap}</span>}
            </span>
          </div>
        )}

        {/* The 30 days and the budget: pointing at the chart reads a day; pointing anywhere else on the card shows the quick read */}
        <div className="relative">
          <div className="grid gap-2.5 transition-opacity duration-200 group-focus-visible:opacity-0 [.group:hover:not(:has(.kpi-chart:hover,.kpi-chip:hover))_&]:opacity-0">
            <div className="kpi-chart">
              <HealthChart id={r.id} daily={r.daily} target={r.target} roas={r.roas} status={r.status} compact height={44} unit={r.conversionLabel.toLowerCase().replace(/s$/, "")} />
            </div>
            <PaceBar pace={r.pace} note={r.budgetNote} compact />
          </div>
          <div className="pointer-events-none absolute inset-0 grid content-start gap-1.5 overflow-hidden opacity-0 transition-opacity duration-200 group-focus-visible:opacity-100 [.group:hover:not(:has(.kpi-chart:hover,.kpi-chip:hover))_&]:opacity-100">
            <Delta label="vs last month" value={r.vsMonth} />
            <Delta label="vs last quarter" value={r.vsQuarter} />
            {r.trend && r.status !== "setup" && (
              <span className={`text-xs ${r.trend === "improving" ? "text-ok" : r.trend === "slipping" ? "text-bad" : "text-faint"}`}>
                {r.trend === "improving" ? "Last 3 days improving" : r.trend === "slipping" ? "Last 3 days slipping" : "Last 3 days steady"}
              </span>
            )}
            {headline ? <span className="line-clamp-2 text-xs leading-snug text-fg/85">{headline}</span> : r.pace?.dailyNeeded != null && r.pace.status !== "early" ? <span className="text-xs text-muted">{money(r.pace.dailyNeeded)}/day lands it on budget</span> : null}
            {r.lastChange?.at && <span suppressHydrationWarning className="truncate text-[11px] text-faint">Changed {sinceText(r.lastChange.at)} ago{r.lastChange.who ? ` by ${r.lastChange.who}` : ""}</span>}
          </div>
        </div>

        {/* What's happening on it */}
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          {r.sprint ? (
            <ChipTip
              tip={<SprintTip s={r.sprint} />}
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] ${SPRINT_TONE[r.sprint.verdict ?? "started"] ?? "bg-surface-2 text-muted"}`}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              Sprint · {r.sprint.done}/{r.sprint.total}
            </ChipTip>
          ) : idle ? (
            <span className="inline-flex rounded-full border border-dashed border-bad/50 px-2 py-0.5 text-[10.5px] text-bad">Nobody&apos;s on it</span>
          ) : null}
          {(r.audit?.status === "running" || r.audit?.status === "queued") && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] text-brand-text">{r.audit.status === "running" ? `Auditing ${r.audit.progress}%` : "Audit queued"}</span>}
          {moves > 0 && (
            <ChipTip tip={<MovesTip items={(r.audit?.quick ?? []).filter((q) => !q.done)} google={r.platform === "google"} onMove={onMove} />} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] text-fg/85">
              {r.platform === "google" ? <GoogleAdsMark size={11} /> : <MetaMark size={13} />}
              {moves} {moves === 1 ? "move" : "moves"} to make
            </ChipTip>
          )}
          <span className="ml-auto text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100">Open →</span>
        </div>
      </button>
    </li>
  );
}

/**
 * A chip on a card with a read of its own on hover, drawn above the page so the card's edges don't cut it off. The
 * pointer can travel into it and pick something there; it closes a moment after the pointer leaves both.
 */
function ChipTip({ tip, className, children }: { tip: React.ReactNode; className: string; children: React.ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const leave = () => {
    keep();
    timer.current = setTimeout(() => setAt(null), 180);
  };
  const show = (el: HTMLElement) => {
    keep();
    const b = el.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    const up = b.top > window.innerHeight / 2;
    setAt({ x: Math.max(12, Math.min(b.left, window.innerWidth - w - 12)), y: up ? b.top - 6 : b.bottom + 6, up });
  };
  return (
    <span className={`kpi-chip ${className}`} onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={leave}>
      {children}
      {at && (
        <Layer>
          {/* Clicks in here stay here: the card underneath would open otherwise */}
          <div
            role="dialog"
            onMouseEnter={keep}
            onMouseLeave={leave}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[80] w-[min(320px,calc(100vw-24px))]"
            style={{ left: at.x, top: at.y, transform: at.up ? "translateY(-100%)" : undefined, padding: at.up ? "0 0 6px" : "6px 0 0", margin: at.up ? "0 0 -6px" : "-6px 0 0" }}
          >
            <div className="grid gap-2 rounded-[14px] border border-line bg-surface/95 p-3 text-left text-xs shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur" style={{ animation: "fadeIn .15s ease-out" }}>
              {tip}
            </div>
          </div>
        </Layer>
      )}
    </span>
  );
}

const VERDICT_TEXT: Record<string, string> = {
  started: "Just started",
  no_action: "Nothing done since the last check",
  wrong_move: "A move went the wrong way",
  on_track: "On track",
  improving: "Improving",
  worse: "Getting worse",
  done: "Done",
};
const WHEN_TEXT: Record<string, string> = { now: "today", this_week: "this week", next: "next" };
const whenText = (w: string | null | undefined) => (w ? (WHEN_TEXT[w] ?? w.replaceAll("_", " ")) : null);

function TipRow({ title, meta, ...link }: { title: string; meta?: string | null } & ({ href: string } | { onClick: () => void })) {
  const body = (
    <>
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full border border-faint transition-colors group-hover/row:border-fg group-hover/row:bg-fg" />
      <span className="min-w-0 flex-1">
        <span className="text-fg/90 group-hover/row:text-fg">{title}</span>
        {meta && <span className="text-faint"> · {meta}</span>}
      </span>
      <span aria-hidden className="mt-px shrink-0 text-faint opacity-0 transition-opacity group-hover/row:opacity-100">→</span>
    </>
  );
  const cls = "group/row -mx-1.5 flex gap-2 rounded-[8px] px-1.5 py-1 text-left leading-snug transition-colors hover:bg-surface-2";
  return "href" in link ? (
    <Link href={link.href} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={link.onClick} className={cls}>
      {body}
    </button>
  );
}

function SprintTip({ s }: { s: SprintSummary }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="font-heading text-[13px]">Sprint{s.buyer ? ` · ${s.buyer}` : ""}</span>
        <span className="tabular text-faint">
          {s.done}/{s.total} done
        </span>
      </div>
      <span className="h-1 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
      </span>
      {(s.verdict || s.message) && (
        <p className="leading-snug text-fg/85">
          {s.verdict && <span className="font-medium">{VERDICT_TEXT[s.verdict] ?? s.verdict}. </span>}
          {s.message && <span className="text-muted">{s.message.length > 220 ? `${s.message.slice(0, 220)}…` : s.message}</span>}
        </p>
      )}
      {s.next && s.next.length > 0 && (
        <div className="grid gap-0.5">
          <span className="text-[10px] uppercase tracking-[0.14em] text-faint">What comes next</span>
          {s.next.map((a) => (
            <TipRow key={a.id} href={`/kpis/sprint/${s.id}#move-${a.id}`} title={a.title} meta={whenText(a.when)} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span suppressHydrationWarning className="text-faint">
          Next check {new Date(s.nextCheckAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </span>
        <Link href={`/kpis/sprint/${s.id}`} className="text-muted hover:text-fg">
          Open the sprint →
        </Link>
      </div>
    </>
  );
}

function MovesTip({ items, google, onMove }: { items: QuickAction[]; google: boolean; onMove: (index: number) => void }) {
  const where = google ? "Google Ads" : "Meta";
  return (
    <>
      <div className="flex items-center gap-2">
        {google ? <GoogleAdsMark size={13} /> : <MetaMark size={15} />}
        <span className="font-heading text-[13px]">
          {items.length} {items.length === 1 ? "move" : "moves"} ready for {where}
        </span>
      </div>
      <div className="grid gap-0.5">
        {items.slice(0, 6).map((q) => (
          <TipRow key={q.index} onClick={() => onMove(q.index)} title={q.label || q.title} meta={[q.area, whenText(q.when)].filter(Boolean).join(" · ") || null} />
        ))}
        {items.length > 6 && <span className="text-[11px] text-faint">and {items.length - 6} more</span>}
      </div>
      <span className="text-[11px] text-muted">Pick one to make it in {where} from here.</span>
    </>
  );
}

function AddKpi({ clients, buyers, platform, onDone }: { clients: { id: string; name: string }[]; buyers: Person[]; platform: "meta" | "google"; onDone: () => void }) {
  return (
    <div className="grid gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <p className="font-heading text-[17px]">New {platform === "google" ? "Google Ads" : "Meta"} KPI</p>
        <button onClick={onDone} className="-mr-2 h-10 px-2 text-xs text-muted hover:text-fg md:mr-0 md:h-auto md:px-0">
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
    <div className="rounded-[14px] border border-dashed border-line px-4 py-2 md:px-5 md:py-4">
      <button onClick={() => setOpen((o) => !o)} className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left text-sm md:min-h-0">
        <span>
          <span className="tabular font-medium">{accounts.length}</span> ad {accounts.length === 1 ? "account" : "accounts"} shared with us that aren&apos;t linked to a client
        </span>
        <span className="shrink-0 text-xs text-muted">{open ? "Hide" : "Review"}</span>
      </button>
      {open && (
        <ul className="mb-2 mt-2 grid gap-2 md:mb-0 md:mt-4">
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
  googleConnected = false,
  focus = null,
  only = null,
}: {
  rows: KpiRow[];
  buyers: Person[];
  clients: { id: string; name: string }[];
  me: { id: string; firstName: string };
  initialOwner: string;
  lastSync: string | null;
  unlinked?: { id: string; name: string }[];
  /** Google Ads is set up (it reads through the manager account); its KPIs fill in on the next sync */
  googleConnected?: boolean;
  /** One account to open and bring into view (from a recap card, a notification or the client page) */
  focus?: { id: string; platform: "meta" | "google" } | null;
  /** Someone on one platform's team (the Meta buyers, the Google buyers) sees only that platform: no switch */
  only?: "meta" | "google" | null;
}) {
  // Where you are on the board lives in the address (platform, buyer, filters, the open account and its tab): back and
  // forward walk through it, and a link lands on the same view. Changes go through the History API, so nothing reloads
  const sp = useSearchParams();
  const linked = Boolean(sp.get("target") || sp.get("client"));
  const platform = only ?? (sp.get("p") as "meta" | "google" | null) ?? focus?.platform ?? "meta";
  const owner = sp.get("who") ?? initialOwner;
  const status = (sp.get("status") as Status | null) ?? "all";
  const pace = (sp.get("pace") as Pacing["status"] | null) ?? "all";
  const open = sp.get("open") ?? (linked ? (focus?.id ?? null) : null);
  const tab = (TABS as string[]).includes(sp.get("tab") ?? "") ? (sp.get("tab") as Tab) : "overview";
  const [q, setQ] = useState(() => sp.get("q") ?? "");
  const go = (patch: Record<string, string | null>, how: "push" | "replace" = "push") => {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    if (u.href !== window.location.href) window.history[how === "push" ? "pushState" : "replaceState"](null, "", u);
  };
  const setPlatform = (p: "meta" | "google") => go({ p, who: null, open: null, tab: null, target: null, client: null, platform: null });
  const setOwner = (who: string) => go({ who: who === initialOwner ? null : who });
  const setStatus = (v: Status | "all") => go({ status: v === "all" ? null : v });
  const setPace = (v: Pacing["status"] | "all") => go({ pace: v === "all" ? null : v });
  const setOpen = (id: string | null) => go({ open: id, tab: null, move: null, target: null, client: null, platform: null });
  const setTab = (t: Tab) => go({ open, tab: t === "overview" ? null : t, move: null, target: null, client: null, platform: null });
  const search = (v: string) => {
    setQ(v);
    go({ q: v.trim() || null }, "replace");
  };
  const close = () => setOpen(null);
  const [adding, setAdding] = useState(false);
  // The focused card scrolls into view once it's on screen
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => document.getElementById(`kpi-${focus.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    return () => clearTimeout(t);
  }, [focus]);

  // A buyer kept only as a name (an older import) is the same person as the buyer with that name, not a second chip
  const byName = new Map(rows.filter((r) => r.ownerId && r.owner).map((r) => [r.owner!.toLowerCase(), r.ownerId!]));
  const ownerKey = (r: KpiRow) => r.ownerId ?? (r.owner ? (byName.get(r.owner.toLowerCase()) ?? `name:${r.owner}`) : null);
  const owners = (() => {
    const names = new Map<string, string>();
    for (const r of rows) if (r.platform === platform && r.owner) names.set(ownerKey(r)!, r.owner);
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  })();

  const base = rows.filter((r) => r.platform === platform && (owner === "all" || ownerKey(r) === owner));
  const term = q.trim().toLowerCase();
  const shown = base
    .filter((r) => (status === "all" || r.status === status) && (pace === "all" || r.pace?.status === pace) && (term.length < 2 || `${r.client} ${r.label ?? ""}`.toLowerCase().includes(term)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (b.deviation ?? -9) - (a.deviation ?? -9) || a.client.localeCompare(b.client));

  const openRow = open ? (rows.find((r) => r.id === open) ?? null) : null;
  const step = (dir: 1 | -1) => {
    const at = shown.findIndex((r) => r.id === open);
    if (at >= 0 && shown.length > 1) setOpen(shown[(at + dir + shown.length) % shown.length].id);
  };

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
            <span suppressHydrationWarning className="inline-flex items-center gap-1.5 text-xs text-faint">
              <span className={`h-1.5 w-1.5 rounded-full ${synced.tone === "ok" ? "bg-ok" : synced.tone === "warn" ? "bg-warn" : "bg-faint/60"}`} />
              {synced.label} · every 30 min in business hours
            </span>
          </p>
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          <div className="flex flex-1 rounded-full border border-line bg-surface p-1 md:inline-flex md:flex-none">
            {(only ? [only] : (["meta", "google"] as const)).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`h-10 flex-1 rounded-full px-3 text-sm transition-colors md:h-8 md:flex-none md:px-4 ${platform === p ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
              >
                {p === "meta" ? "Meta" : "Google Ads"} <span className="tabular opacity-60">{rows.filter((r) => r.platform === p).length}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setAdding((a) => !a)} className="h-12 shrink-0 rounded-[8px] bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover md:h-10">
            Add KPI
          </button>
        </div>
      </header>

      {platform === "google" && !googleConnected && (
        <p className="rounded-[12px] border border-warn/30 bg-warn-soft px-5 py-4 text-sm leading-relaxed text-warn">
          Google Ads isn&apos;t connected yet, so these targets and budgets are saved but have no numbers. They light up once the connection is set up in Vercel.
        </p>
      )}

      {/* Where things stand */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
        {TILES.map((t) => {
          const on = status === t;
          const n = count(t);
          return (
            <button
              key={t}
              onClick={() => setStatus(on ? "all" : t)}
              className={`group relative grid min-w-0 content-start gap-1 overflow-hidden rounded-[14px] border p-3.5 text-left md:content-normal md:p-4 transition-colors ${on ? "border-fg/40 bg-surface" : "border-line bg-surface hover:border-faint/60"}`}
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
        <div className="col-span-2 grid content-start gap-3 rounded-[14px] border border-line bg-surface p-4 xl:col-span-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 md:flex-nowrap">
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
                  className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs transition-colors md:h-7 ${pace === p ? "bg-fg text-bg" : m.chip}`}
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
        {/* Phones: the buyers scroll sideways in one strip instead of stacking rows */}
        <nav className="no-scrollbar -mx-4 flex w-[calc(100%+2rem)] items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:w-auto md:flex-wrap md:overflow-visible md:px-0">
          {[["all", "Everyone"] as const, ...(owners.some(([id]) => id === me.id) || owner === me.id ? ([[me.id, `Mine`]] as const) : []), ...owners.filter(([id]) => id !== me.id)].map(([id, name]) => (
            <button
              key={id}
              onClick={() => setOwner(id)}
              className={`inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 md:shrink md:whitespace-normal ${owner === id ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
            >
              {name}
            </button>
          ))}
        </nav>
        <input
          type="search"
          value={q}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && search("")}
          placeholder="Search clients"
          aria-label="Search clients"
          className="h-11 w-full max-w-full rounded-full border border-line bg-surface px-4 text-sm outline-none md:h-10 md:w-64 transition-colors hover:border-faint/60 focus:border-brand-text/70"
        />
      </div>

      {(status !== "all" || pace !== "all") && (
        <p className="-mt-3 text-xs text-faint">
          Showing {shown.length} {status !== "all" && <span className={STATUS[status].text}>{STATUS[status].label.toLowerCase()}</span>}
          {status !== "all" && pace !== "all" && " and "}
          {pace !== "all" && <span>{paceMeta({ status: pace } as Pacing).label.toLowerCase()}</span>}
          <button onClick={() => go({ status: null, pace: null })} className="ml-2 py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
            Show all
          </button>
        </p>
      )}

      {shown.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {shown.map((r) => (
            <Card key={r.id} r={r} active={open === r.id} onOpen={() => setOpen(r.id)} onMove={(i) => go({ open: r.id, tab: "actions", move: String(i), target: null, client: null, platform: null })} />
          ))}
        </ul>
      ) : (
        <p className="rounded-[14px] border border-dashed border-line px-6 py-14 text-center text-sm text-faint">Nothing here.</p>
      )}
      {openRow && <Detail key={openRow.id} r={openRow} buyers={buyers} tab={tab} setTab={setTab} onClose={close} onStep={step} />}

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

/**
 * The KPI's working parts on the client page: the metric boxes and the campaigns (what the card is judged on, each
 * campaign's result, which ones count). The same parts as the KPI board's card, saved to the same KPI, so a change in
 * either place shows in both.
 */
export function KpiExtras({ k }: { k: { id: string; target: number | null; conversion: string; customAction: string | null; campaignMatch: string | null; platform: "meta" | "google"; extraMetrics: string[] } }) {
  const router = useRouter();
  const [ex, setEx] = useState<Explore | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    exploreKpi(k.id, { conversion: k.conversion, custom: k.customAction, campaignMatch: k.campaignMatch }).then((res) => live && res.ok && setEx(res.data));
    return () => {
      live = false;
    };
  }, [k.id, k.conversion, k.customAction, k.campaignMatch, nonce]);
  return (
    <div className="grid gap-4">
      <MetricBoxes
        key={k.extraMetrics.join(",")}
        r={k}
        ex={ex}
        onChange={() => {
          setNonce((n) => n + 1);
          router.refresh();
        }}
      />
      <Campaigns key={`${k.id}:${k.conversion}:${k.target}`} id={k.id} target={k.target} conversion={k.conversion} platform={k.platform} />
    </div>
  );
}
