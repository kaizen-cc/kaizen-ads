"use client";

import { useState, useTransition } from "react";
import { setLaunchRule } from "./actions";

// Where this client's new ads go, learned from their buyers moving ads the launcher placed. The launcher reads these
// first. A rule that no longer applies is turned off (kept, with when and why it was made).

export type LaunchRule = { id: string; rule: string; from: string | null; to: string | null; via: string; by: string | null; at: string; active: boolean };

export function LaunchRules({ rules, slug, canEdit }: { rules: LaunchRule[]; slug: string; canEdit: boolean }) {
  const [list, setList] = useState(rules);
  const [pending, start] = useTransition();
  const toggle = (r: LaunchRule) =>
    start(async () => {
      const res = await setLaunchRule(r.id, slug, !r.active);
      if (res.ok) setList((l) => l.map((x) => (x.id === r.id ? { ...x, active: !r.active } : x)));
    });
  return (
    <ul className="grid gap-2">
      {list.map((r) => (
        <li key={r.id} className={`grid gap-1 rounded-[12px] border border-line px-4 py-3 ${r.active ? "" : "opacity-50"}`}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm">{r.rule}</p>
            {canEdit && (
              <button type="button" disabled={pending} onClick={() => toggle(r)} className="shrink-0 text-xs text-faint hover:text-fg">
                {r.active ? "Turn off" : "Turn on"}
              </button>
            )}
          </div>
          <p className="text-[11px] text-faint">
            {r.from && r.to ? `Moved from "${r.from}" to "${r.to}"${r.via === "ads_manager" ? " in Ads Manager" : ""}` : "From a move"}
            {r.by ? ` by ${r.by}` : ""} · {new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {!r.active && " · turned off"}
          </p>
        </li>
      ))}
    </ul>
  );
}
