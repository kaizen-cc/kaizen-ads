"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { unhideForMe } from "../hide-actions";

// What this person cleared off their board, kept so nothing is gone for good: each with when, whether it was done or
// dismissed, a link back to it, and Restore to put it on the board again.

export type HiddenItem = { key: string; how: "done" | "dismissed"; label: string | null; href: string | null; at: string };

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export function HiddenLog({ items }: { items: HiddenItem[] }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const shown = items.filter((i) => !gone.has(i.key));
  if (!shown.length) return null;
  return (
    <details className="group rounded-[16px] border border-line bg-surface/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm">
        <span className="text-muted">Cleared from your board</span>
        <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-faint">{shown.length}</span>
        <span className="ml-auto text-faint transition-transform group-open:rotate-90">›</span>
      </summary>
      <ul className="grid gap-1.5 px-3 pb-3">
        {shown.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-bg/60 px-3.5 py-2.5 text-[13px]">
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${i.how === "done" ? "bg-ok-soft text-ok" : "bg-surface-2 text-faint"}`}>{i.how === "done" ? "Done" : "Dismissed"}</span>
            <span className="min-w-0 flex-1 truncate" title={i.label ?? undefined}>
              {i.href ? (
                <a href={i.href} target={i.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="hover:underline">
                  {i.label ?? "An item"}
                </a>
              ) : (
                (i.label ?? "An item")
              )}
            </span>
            <span className="shrink-0 text-[11.5px] text-faint">{when(i.at)}</span>
            <button
              type="button"
              onClick={() => {
                setGone((g) => new Set(g).add(i.key));
                start(async () => {
                  await unhideForMe(i.key);
                  router.refresh();
                });
              }}
              className="h-11 shrink-0 rounded-full border border-line px-3 text-xs text-muted hover:text-fg md:h-7"
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
