"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/action-form";
import { field, label } from "@/components/ui";
import type { Agg, Pacing, Status, Trend } from "@/lib/kpi/calc";
import { CONVERSIONS } from "@/lib/kpi/conversions";
import { STATUS, deviationTone, kpiValue, money } from "@/lib/kpi/format";
import { freshness } from "@/lib/dates";
import { addKpiTarget, archiveKpiTarget, exploreKpi, linkAdAccount, pullClientKpis, saveAccountNotes, saveKpiTarget, setExtraMetrics, type NoteKey } from "./actions";
import { ClientChat } from "../clients/[slug]/client-chat";
import type { Explore } from "@/lib/kpi/explore";
import { DailyChart, Ladder, PaceBar, paceMeta } from "./kpi-charts";
import { AuditPanel, agoText, type AuditSummary } from "./audit-panel";
import { ChangeLog } from "@/components/change-log";
import type { AccountChange } from "@/lib/account-changes";
import type { SprintSummary } from "@/lib/sprints";

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
function MetricBoxes({ r, ex, onChange }: { r: KpiRow; ex: Explore | null; onChange: () => void }) {
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

function Detail({ r, buyers }: { r: KpiRow; buyers: Person[] }) {
  const router = useRouter();
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
      <span className={`tabular text-sm ${r.target ? deviationTone(a?.value != null && r.target ? (roas ? (r.target - a.value) / r.target : (a.value - r.target) / r.target) : null) : "text-fg"}`}>
        {kpiValue(a?.value, roas)}
      </span>
      <span className="tabular text-[11px] text-faint">
        {money(a?.spend ?? 0)} · {a?.results ?? 0} {a?.results === 1 ? "result" : "results"}
      </span>
    </>
  );
  return (
    <div className="grid gap-5 border-t border-line bg-bg/40 px-4 py-5 sm:px-6 md:gap-6 md:py-6">
      {/* First the audit and the AI to talk the account through with (the same thread as the client page) */}
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ClientChat
            variant="inline"
            clientId={r.clientId}
            client={r.client}
            live
            targets={r.accountId ? [{ id: r.id, label: `${r.platform === "google" ? "Google" : "Meta"}${r.label ? ` · ${r.label}` : ""}`, status: r.audit?.status ?? "none", auditId: r.audit?.id ?? null }] : []}
          />
          <Link href={`/clients/${r.slug}`} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
            Client page →
          </Link>
        </div>
        {r.accountId && <AuditPanel targetId={r.id} audit={r.audit} platform={r.platform} />}
      </div>
      {r.sprint && <SprintStrip s={r.sprint} />}

      {previewing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-brand/40 bg-brand-soft px-4 py-3 text-sm">
          <span>
            Previewing <b>{convLabel}</b>
            {match ? ` in campaigns containing "${match}"` : ""}
            {loading ? " · counting…" : ex?.resultType ? <span className="text-muted"> · counted as Meta&apos;s {ex.resultType}</span> : null}
            <span className="text-muted"> · not saved yet</span>
          </span>
          <button type="button" onClick={reset} className="rounded-full border border-line bg-surface px-3 py-2.5 text-xs text-muted hover:text-fg md:py-1">
            Back to the saved view
          </button>
        </div>
      )}

      <div className={`grid gap-6 transition-opacity lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] ${loading && previewing ? "opacity-60" : ""}`}>
        <div className="grid content-start gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-faint">Last 30 days</p>
          <DailyChart daily={daily} />
          <p className="text-[11px] text-faint">Bars are spend, the line is {convLabel.toLowerCase()} per day.</p>
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

      <div className={`grid gap-px overflow-hidden rounded-[10px] border border-line bg-line transition-opacity grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 ${loading && previewing ? "opacity-60" : ""}`}>
        {win.map(([name, a]) => (
          <div key={name} className={`grid min-w-0 gap-0.5 bg-surface px-3 py-3 md:px-4 ${name === "14 days" ? "ring-1 ring-inset ring-brand/40" : ""}`}>
            <span className="text-[11px] text-faint">
              {name}
              {name === "14 days" && " · sets the status"}
            </span>
            {cell(a)}
          </div>
        ))}
      </div>
      <div className={`grid gap-px overflow-hidden rounded-[10px] border border-line bg-line transition-opacity grid-cols-2 lg:grid-cols-4 ${loading && previewing ? "opacity-60" : ""}`}>
        {monthList.map(([name, a]) => (
          <div key={name} className="grid min-w-0 gap-0.5 bg-surface px-3 py-3 md:px-4">
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

      {/* The target's settings, folded away (open while previewing a change to what's counted, so it can be saved) */}
      <details open={previewing || undefined} className="group rounded-[16px] border border-line bg-surface">
        <summary className="flex cursor-pointer list-none flex-nowrap items-center justify-between gap-3 px-4 py-4 md:flex-wrap md:px-5">
          <span className="min-w-0 text-xs font-medium uppercase tracking-[0.12em] text-faint">
            Target and budget settings
            <span className="ml-2 normal-case tracking-normal">
              · {kpiValue(r.target, r.roas)} target{r.budget ? ` · ${money(r.budget)} a month` : ""}
              {r.owner ? ` · ${r.owner}` : ""}
            </span>
          </span>
          <span className="text-faint transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="grid gap-4 border-t border-line px-4 py-5 md:px-5">
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
        </div>
      </details>

      <AccountNotes r={r} />
      {r.accountId && <ChangeLog changes={r.changes} platform={r.platform} limit={10} collapsed={3} />}
    </div>
  );
}

function Row({ r, open, onToggle, buyers }: { r: KpiRow; open: boolean; onToggle: () => void; buyers: Person[] }) {
  const s = STATUS[r.status];
  const d14 = r.windows.d14;
  const gap = gapText(r);
  return (
    <li id={`kpi-${r.id}`} className={`scroll-mt-20 overflow-hidden rounded-[14px] md:scroll-mt-6 border bg-surface transition-colors ${open ? "border-faint/70" : "border-line hover:border-faint/60"}`}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-2 items-center gap-x-4 gap-y-4 px-4 py-4 text-left sm:px-6 md:gap-x-6 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_172px] xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_172px_minmax(168px,0.8fr)_minmax(0,1fr)]"
      >
        {/* Who and what */}
        <div className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
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
            {r.sprint ? (
              <span className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] ${SPRINT_TONE[r.sprint.verdict ?? "started"] ?? "bg-surface-2 text-muted"}`}>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                Sprint in motion · {r.sprint.buyer ?? "no buyer"} · {r.sprint.done}/{r.sprint.total}
              </span>
            ) : (r.status === "off" || r.status === "close") && r.audit?.status !== "running" && !recentlyChanged(r) ? (
              <span className="mt-1.5 inline-flex rounded-full border border-dashed border-bad/50 px-2 py-0.5 text-[10px] text-bad">
                Nobody&apos;s optimizing it yet{r.lastChange?.at ? ` · no changes in ${sinceText(r.lastChange.at)}` : ""}
              </span>
            ) : null}
            {r.audit?.status === "ready" && !r.sprint && (
              <p className="mt-1 truncate text-[11px] text-faint">
                Audited {agoText(r.audit.createdAt)}
                {r.audit.by ? ` by ${r.audit.by}` : ""}
              </p>
            )}
            {(r.audit?.status === "running" || r.audit?.status === "queued") && (
              <p className="mt-1 truncate text-[11px] text-brand-text">
                {r.audit.status === "running" ? `Audit running (${r.audit.progress}%)` : "Audit queued"}
                {r.audit.by ? ` · ${r.audit.by}` : ""}
              </p>
            )}
            {r.lastChange?.at && (
              <p className="mt-1 line-clamp-2 text-[11px] text-faint md:line-clamp-none md:truncate" title={`${r.lastChange.who ?? "Someone"}: ${r.lastChange.what}${r.lastChange.object ? ` · ${r.lastChange.object}` : ""}`}>
                Last change {sinceText(r.lastChange.at)} ago · {r.lastChange.what}
                {r.lastChange.who ? ` by ${r.lastChange.who}` : ""}
              </p>
            )}
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
              <div className="flex flex-wrap items-baseline gap-x-2 md:flex-nowrap">
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
}) {
  const [platform, setPlatform] = useState<"meta" | "google">(focus?.platform ?? "meta");
  const [owner, setOwner] = useState(initialOwner);
  const [status, setStatus] = useState<Status | "all">("all");
  const [pace, setPace] = useState<Pacing["status"] | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(focus?.id ?? null);
  const [adding, setAdding] = useState(false);
  // The focused card scrolls into view once it's on screen
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => document.getElementById(`kpi-${focus.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
    return () => clearTimeout(t);
  }, [focus]);

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
        <div className="flex w-full items-center gap-2 md:w-auto">
          <div className="flex flex-1 rounded-full border border-line bg-surface p-1 md:inline-flex md:flex-none">
            {(["meta", "google"] as const).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setPlatform(p);
                  setOwner("all");
                  setOpen(null);
                }}
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
          {[["all", "Everyone"] as const, ...(owners.some(([id]) => id === me.id) ? ([[me.id, `Mine`]] as const) : []), ...owners.filter(([id]) => id !== me.id)].map(([id, name]) => (
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
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
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
          <button onClick={() => (setStatus("all"), setPace("all"))} className="ml-2 py-2 text-muted underline-offset-4 hover:text-fg hover:underline md:py-0">
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
