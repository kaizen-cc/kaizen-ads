"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PERIOD_PRESETS, matchPreset, previousPeriod, rangeLabel, resolvePeriod, shiftDay, type PeriodKey } from "@/lib/reports/period";
import { changePeriod } from "./actions";

// The report's dates, in one dropdown: last week (Mon to Sun), the last 7, 14 or 30 days, this month, last month, or
// custom dates. Picking one moves the whole report and redraws every page with fresh numbers, against the same number
// of days just before. Saved on change.

export function PeriodPicker({ reportId, start, end, periodKey, today, locked }: { reportId: string; start: string; end: string; periodKey: string | null; today: string; locked: string | null }) {
  const router = useRouter();
  const [pending, go] = useTransition();
  const current = (periodKey && periodKey !== "custom" && (() => {
    const p = resolvePeriod(periodKey as PeriodKey, today);
    return p && p.start === start && p.end === end ? (periodKey as PeriodKey) : null;
  })()) || matchPreset({ start, end }, today);
  const [custom, setCustom] = useState<{ start: string; end: string } | null>(null);
  const [error, setError] = useState<{ text: string; openId?: string } | null>(null);
  const yesterday = shiftDay(today, -1);
  const prev = previousPeriod({ start, end });

  const apply = (key: PeriodKey, dates?: { start: string; end: string }) =>
    go(async () => {
      setError(null);
      const r = await changePeriod(reportId, key, dates);
      if (!r.ok) return setError({ text: r.error, openId: r.openId });
      setCustom(null);
      router.refresh();
    });

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative inline-flex min-w-0 items-center">
          <span className="sr-only">Report dates</span>
          <span aria-hidden className="pointer-events-none absolute left-3.5 text-faint">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
              <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
            </svg>
          </span>
          <select
            value={custom ? "custom" : current}
            disabled={pending || Boolean(locked)}
            title={locked ?? undefined}
            onChange={(e) => {
              const key = e.target.value as PeriodKey;
              if (key === "custom") return setCustom({ start, end });
              apply(key);
            }}
            className="h-11 max-w-full appearance-none truncate rounded-full border border-line bg-surface py-0 pl-10 pr-9 text-sm text-fg transition-colors hover:border-faint disabled:opacity-60 md:h-9"
          >
            {PERIOD_PRESETS.map((p) => {
              const r = p.key === "custom" ? null : resolvePeriod(p.key, today);
              return (
                <option key={p.key} value={p.key}>
                  {p.key === "custom" ? (current === "custom" ? `Custom · ${rangeLabel({ start, end }, today)}` : "Custom dates…") : `${p.label}${r ? ` · ${rangeLabel(r, today)}` : ""}`}
                </option>
              );
            })}
          </select>
          <span aria-hidden className="pointer-events-none absolute right-3.5 text-[10px] text-faint">▼</span>
        </label>
        <span className="text-xs text-faint">{pending ? "Redrawing every page…" : `vs ${rangeLabel(prev, today)}`}</span>
      </div>
      {custom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply("custom", custom);
          }}
          className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface p-2"
        >
          <input type="date" aria-label="From" value={custom.start} max={yesterday} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="h-11 rounded-[10px] border border-line bg-bg px-3 text-sm md:h-9" />
          <span className="text-xs text-faint">to</span>
          <input type="date" aria-label="To" value={custom.end} min={custom.start} max={yesterday} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="h-11 rounded-[10px] border border-line bg-bg px-3 text-sm md:h-9" />
          <button type="submit" disabled={pending || !custom.start || !custom.end || custom.start > custom.end} className="h-11 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40 md:h-9">
            Use these dates
          </button>
          <button type="button" onClick={() => setCustom(null)} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:h-9">
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="flex flex-wrap items-center gap-2 rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">
          {error.text}
          {error.openId && (
            <button type="button" onClick={() => router.push(`/reports/${error.openId}`)} className="h-9 rounded-full bg-fg px-3.5 text-[12.5px] text-bg">
              Open it
            </button>
          )}
        </p>
      )}
    </div>
  );
}
