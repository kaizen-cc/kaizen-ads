"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { tickAuditAction } from "./audit-actions";
import type { QuickAction } from "./audit-panel";
import { GoogleChange } from "./google-change";

// Under an audit's verdict: the moves Kaizen Ads can make in the ad account itself, one line each, stacked. Hover and
// the line opens a little in place with the gist; click to open the whole move with the button that makes it. No need
// to open the full audit to act on it.

const KIND: { test: RegExp; icon: string; tone: string }[] = [
  // Budgets
  { test: /budget|\$\d|scale|raise|lower|cut|reallocat|shift/i, icon: "M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", tone: "text-ok bg-ok/12" },
  // Pausing, turning off
  { test: /\b(pause|turn (it |them )?off|switch (it |them )?off|shut|kill|stop)\b/i, icon: "M10 4v16M14 4v16", tone: "text-warn bg-warn/12" },
  // Turning on
  { test: /\b(turn (it |them )?on|unpause|re-?enable|launch|restart)\b/i, icon: "M6 4l14 8-14 8z", tone: "text-[#7aa7ff] bg-[#0866ff]/15" },
  // Bids and keywords (Google)
  { test: /bid|cpa|roas|keyword|negative/i, icon: "M3 17l6-6 4 4 8-8M14 7h7v7", tone: "text-[#8ab4f8] bg-[#4285f4]/15" },
];
const kindOf = (a: QuickAction) => KIND.find((k) => k.test.test(`${a.label} ${a.title}`)) ?? { icon: "M4 6h16M4 12h16M4 18h10", tone: "text-muted bg-surface-3" };
const WHEN: Record<string, string> = { now: "Today", this_week: "This week", next: "Next" };

export function QuickActions({ auditId, items, platform }: { auditId: string; items: QuickAction[]; platform: "meta" | "google" }) {
  const router = useRouter();
  const [hover, setHover] = useState<number | null>(null);
  // ?move=<n>: one move picked from a card's hover, opened and brought into view
  const picked = Number(useSearchParams().get("move") ?? NaN);
  const [open, setOpen] = useState<number | null>(() => (items.some((a) => a.index === picked) ? picked : null));
  useEffect(() => {
    if (!Number.isNaN(picked)) document.getElementById(`qa-${auditId}-${picked}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [auditId, picked]);
  const [done, setDone] = useState<Record<number, boolean>>(() => Object.fromEntries(items.map((a) => [a.index, a.done])));
  const [, start] = useTransition();
  const name = platform === "google" ? "Google Ads" : "Meta";
  const left = items.filter((a) => !done[a.index]).length;

  const tick = (i: number) =>
    start(async () => {
      const next = !done[i];
      setDone((d) => ({ ...d, [i]: next }));
      await tickAuditAction(auditId, i, next);
      router.refresh();
    });

  return (
    <div className="grid gap-2.5 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">
          Quick actions in {name} <span className="normal-case tracking-normal">· done from here</span>
        </p>
        <span className="text-[11px] text-faint">{left ? `${left} to do` : "All done"}</span>
      </div>
      <ul className="grid gap-2">
        {items.map((a) => {
          const k = kindOf(a);
          const isOpen = open === a.index;
          const isDone = done[a.index];
          return (
            <li key={a.index} id={`qa-${auditId}-${a.index}`} className="scroll-mt-24" onMouseEnter={() => setHover(a.index)} onMouseLeave={() => setHover((h) => (h === a.index ? null : h))}>
              <div className={`grid rounded-[14px] border transition-colors ${isOpen ? "border-[#0866ff]/40 bg-[#0866ff]/[0.05]" : "border-line bg-bg/40 hover:border-fg/20 hover:bg-surface-2"}`}>
                <button type="button" onClick={() => setOpen(isOpen ? null : a.index)} aria-expanded={isOpen} className="flex min-h-12 items-center gap-3 px-3 py-2 text-left">
                  <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${isDone ? "bg-ok/15 text-ok" : k.tone}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d={isDone ? "M5 12.5l4.5 4.5L19 7" : k.icon} />
                    </svg>
                  </span>
                  <span className={`min-w-0 flex-1 text-sm leading-snug ${isDone ? "text-muted line-through decoration-faint" : ""}`}>{a.label}</span>
                  <span className="shrink-0 text-[10.5px] text-faint max-sm:hidden">{WHEN[a.when] ?? ""}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 text-faint transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {/* Hover: the gist, opening in place (computers; a tap opens the whole move) */}
                {!isOpen && (
                  <div className={`hidden transition-[grid-template-rows,opacity] duration-200 ease-out md:grid ${hover === a.index ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                    <div className="overflow-hidden">
                      <div className="grid gap-1.5 px-3 pb-3 pl-[52px]">
                        <p className="text-[13px] leading-relaxed text-ok">{a.impact}</p>
                        {a.steps.length > 0 && (
                          <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">
                            {a.steps[0]}
                            {a.steps.length > 1 ? ` · +${a.steps.length - 1} more` : ""}
                          </p>
                        )}
                        <p className="text-[11px] text-faint">Click to open it and make the change in {name}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Open: the whole move, and the button that makes it */}
                {isOpen && (
                  <div className="grid gap-3 border-t border-line px-4 pb-4 pt-3" style={{ animation: "fade-in-late .18s ease-out" }}>
                    {a.label !== a.title && <p className="font-heading text-[15px] leading-snug">{a.title}</p>}
                    <p className="text-[13px] leading-relaxed text-ok">{a.impact}</p>
                    {a.steps.length > 0 && (
                      <ol className="grid gap-1.5 text-[13px] leading-relaxed">
                        {a.steps.map((s, i) => (
                          <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                            <span className="text-[11px] tabular text-faint">{i + 1}</span>
                            <span>{s}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="text-xs leading-relaxed text-muted">{a.why}</p>
                    {!isDone && <GoogleChange platform={platform} from={{ source: "audit", auditId, index: a.index }} />}
                    <button type="button" onClick={() => tick(a.index)} className="justify-self-start rounded-full border border-line px-3.5 py-1.5 text-xs text-muted hover:text-fg max-md:min-h-11">
                      {isDone ? "Mark as not done" : "Mark as done"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
