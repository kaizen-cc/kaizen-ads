"use client";

import { useEffect, useState } from "react";
import type { AccountChange } from "@/lib/account-changes";

// An ad account's change history: who changed what, when, and how long between changes, so a quiet stretch (or a
// burst of edits right before results moved) is easy to see. Times are worked out in the browser.

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function gapText(ms: number) {
  const h = ms / 3_600_000;
  if (h < 1) return "within the hour";
  if (h < 24) return `${Math.round(h)}h later`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} later`;
}

function agoText(ms: number) {
  const h = ms / 3_600_000;
  if (h < 1) return "just now";
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** limit: how many changes it holds. collapsed: how many show until "Show all" (all of them when not set). */
export function ChangeLog({ changes, platform, title = "Change history", limit, collapsed }: { changes: AccountChange[]; platform: "meta" | "google"; title?: string; limit: number; collapsed?: number }) {
  const [now, setNow] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(t);
  }, []);
  const list = changes.slice(0, limit);
  const span = list.length > 1 ? Date.parse(list[0].at) - Date.parse(list.at(-1)!.at) : 0;
  const avgGap = list.length > 1 ? span / (list.length - 1) : null;
  return (
    <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          {title} · {platform === "google" ? "Google" : "Meta"}
        </p>
        {list.length > 0 && (
          <span className="text-[11px] text-faint">
            Last {list.length} {list.length === 1 ? "change" : "changes"}
            {avgGap != null && ` · about ${gapText(avgGap).replace(" later", "")} apart on average`}
            {now != null && ` · latest ${agoText(now - Date.parse(list[0].at))}`}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted">No changes logged yet. They show here from the next sync (every 2 hours), up to {platform === "google" ? "30" : "90"} days back.</p>
      ) : (
        <ol className="grid">
          {list.slice(0, collapsed && !all ? collapsed : list.length).map((c, i) => {
            const prev = list[i + 1];
            const gap = prev ? Date.parse(c.at) - Date.parse(prev.at) : null;
            const long = gap != null && gap > 7 * 86_400_000;
            return (
              <li key={`${c.at}${c.what}${i}`} className="grid grid-cols-[14px_minmax(0,1fr)_auto] gap-3">
                <span className="relative flex justify-center">
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-brand" />
                  {i < list.length - 1 && <span className={`absolute bottom-0 top-4 w-px ${long ? "bg-warn/50" : "bg-line"}`} />}
                </span>
                <span className="grid min-w-0 gap-0.5 pb-3">
                  <span className="text-sm">
                    {c.what}
                    {c.object && <span className="text-muted"> · {c.object}</span>}
                  </span>
                  <span className="text-[11px] text-faint">
                    {c.who ?? "Someone"}
                    {gap != null && <span className={long ? "text-warn" : ""}> · {gapText(gap)} than the one before</span>}
                  </span>
                </span>
                <span className="tabular pt-0.5 text-[11px] text-faint">{when(c.at)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {collapsed != null && list.length > collapsed && (
        <button type="button" onClick={() => setAll((a) => !a)} className="justify-self-start text-xs text-brand-text hover:underline">
          {all ? "Show fewer" : `Show all ${list.length} changes`}
        </button>
      )}
    </section>
  );
}
