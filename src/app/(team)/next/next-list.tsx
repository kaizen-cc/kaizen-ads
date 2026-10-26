"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NextForMe, NextItem } from "@/lib/next-for-me";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";

const SECTIONS: { key: keyof Omit<NextForMe, "stats">; title: string; hint: string; empty: string }[] = [
  { key: "now", title: "Now", hint: "Late, due today, or waiting on you", empty: "Nothing urgent. Nice." },
  { key: "decide", title: "To decide", hint: "Briefs the AI wrote for your clients", empty: "No briefs waiting on you." },
  { key: "watch", title: "Keep an eye on", hint: "Your accounts and clients", empty: "Your accounts look healthy." },
  { key: "coming", title: "Coming up", hint: "On you, not due yet", empty: "Nothing else lined up." },
];

const DOT: Record<NextItem["tone"], string> = { bad: "bg-bad", warn: "bg-warn", brand: "bg-brand", ok: "bg-ok" };

const KIND: Record<NextItem["kind"], string> = {
  sprint: "Sprint",
  ticket: "Ticket",
  review: "Review",
  launch: "Launch",
  brief: "AI brief",
  promise: "Promised on a call",
  first_round: "First round",
  refresh: "Refresh brief",
  kpi: "KPI",
  fatigue: "Ad wearing out",
  intake: "Onboarding",
  client: "Client",
};

/** Everything on one person, in four calm sections. Briefs open right here; everything else goes where it lives. */
export function NextList({ data }: { data: NextForMe }) {
  const router = useRouter();
  const [sheet, setSheet] = useState<OpenSuggestion | null>(null);
  const total = data.now.length + data.decide.length + data.watch.length;
  return (
    <div className="grid gap-8">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ["On you", data.stats.onMe, null],
            ["Late", data.stats.late, data.stats.late ? "text-bad" : null],
            ["Due today", data.stats.dueToday, data.stats.dueToday ? "text-warn" : null],
            ["To decide", data.stats.toDecide, data.stats.toDecide ? "text-brand-text" : null],
          ] as const
        ).map(([label, n, tone]) => (
          <div key={label} className="rounded-[14px] border border-line bg-surface px-4 py-3">
            <p className={`tabular font-display text-2xl ${tone ?? "text-fg"}`}>{n}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>

      {total === 0 && data.coming.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">You&apos;re all caught up</p>
          <p className="max-w-sm text-sm text-muted">New work, briefs to decide and anything off on your accounts land here as they come in.</p>
        </div>
      ) : (
        SECTIONS.map((s) => {
          const items = data[s.key];
          if (!items.length && s.key === "coming") return null;
          return (
            <section key={s.key} className="grid gap-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <h2 className="font-heading text-lg">
                  {s.title} {items.length > 0 && <span className="text-faint">{items.length}</span>}
                </h2>
                <span className="text-xs text-faint">{s.hint}</span>
              </div>
              {items.length === 0 ? (
                <p className="rounded-[14px] border border-line bg-surface px-4 py-3 text-sm text-faint">{s.empty}</p>
              ) : (
                <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
                  {items.map((it) => (
                    <Row key={it.id} it={it} onBrief={setSheet} />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}

      {sheet && (
        <SuggestionSheet
          s={sheet}
          onClose={() => {
            setSheet(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function Row({ it, onBrief }: { it: NextItem; onBrief: (s: OpenSuggestion) => void }) {
  const body = (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[it.tone]}`} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{it.title}</span>
        </span>
        <span className="truncate text-xs text-muted">
          <span className="text-faint">{KIND[it.kind]} · </span>
          {it.client} · {it.why}
        </span>
        {/* Phones: when it's due sits under the line (there's no room beside it) */}
        {it.when && <span className={`text-xs sm:hidden ${it.tone === "bad" ? "text-bad" : it.tone === "warn" ? "text-warn" : "text-faint"}`}>{it.when}</span>}
      </span>
      {it.when && <span className={`hidden shrink-0 text-xs sm:block ${it.tone === "bad" ? "text-bad" : it.tone === "warn" ? "text-warn" : "text-faint"}`}>{it.when}</span>}
      <span className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors group-hover:border-faint group-hover:text-fg">{it.action}</span>
    </>
  );
  const cls = "group flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 active:bg-surface-2/50 sm:items-center md:py-3";
  return (
    <li>
      {it.suggestion ? (
        <button onClick={() => onBrief(it.suggestion!)} className={cls}>
          {body}
        </button>
      ) : (
        <Link href={it.href ?? "#"} className={cls}>
          {body}
        </Link>
      )}
    </li>
  );
}
