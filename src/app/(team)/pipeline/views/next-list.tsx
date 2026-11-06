"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { markBibleReviewed } from "../next-actions";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import type { NextForMe, NextItem } from "@/lib/next-for-me";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "./suggested-briefs";
import { SaveIdeaStar } from "@/components/save-idea-star";

const SECTIONS: { key: keyof Omit<NextForMe, "stats">; title: string; hint: string; empty: string }[] = [
  { key: "now", title: "Now", hint: "Late, due today, or waiting on you", empty: "Nothing urgent. Nice." },
  { key: "decide", title: "To decide", hint: "Briefs the AI suggests for your clients", empty: "No briefs waiting on you." },
  { key: "bibles", title: "Brand Bibles to review", hint: "Read each one, then mark it reviewed", empty: "" },
  { key: "watch", title: "Keep an eye on", hint: "Your accounts and clients", empty: "Your accounts look healthy." },
  { key: "coming", title: "Coming up", hint: "On you, not due yet", empty: "Nothing else lined up." },
];
// Sections that only show when they have something in them
const OPTIONAL = new Set<string>(["bibles", "coming"]);

const DOT: Record<NextItem["tone"], string> = { bad: "bg-bad", warn: "bg-warn", brand: "bg-brand", ok: "bg-ok" };

// Which sections someone folded away, remembered per person in this browser (kz:next:closed:<their id>). Before the
// browser has said (the server render), every section is open.
const listeners = new Set<() => void>();
const keyOf = (me: string) => `kz:next:closed:${me}`;
const readClosed = (me: string) => {
  try {
    return localStorage.getItem(keyOf(me)) ?? "";
  } catch {
    return "";
  }
};
const writeClosed = (me: string, keys: string[]) => {
  try {
    localStorage.setItem(keyOf(me), keys.join(","));
  } catch {
    /* private window: what's folded just isn't remembered */
  }
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function useClosed(me: string) {
  const raw = useSyncExternalStore(subscribe, () => readClosed(me), () => "");
  return raw ? raw.split(",") : [];
}

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
  task: "Plan task",
  bible: "Brand Bible",
};

/** Everything on one person, in four calm sections, each folding away. Briefs open right here; everything else goes where it lives. */
export function NextList({ data, me }: { data: NextForMe; me: string }) {
  const router = useRouter();
  const closed = useClosed(me);
  const toggle = (key: string) => writeClosed(me, closed.includes(key) ? closed.filter((k) => k !== key) : [...closed, key]);
  // The brief open is in the address (?todo=id), so back closes it and a link opens it. Its own param, not ?brief:
  // the suggested briefs in the Overview's themes above use that one, and the same brief can be in both
  const openId = useParam("todo");
  const sheet = (openId && SECTIONS.flatMap((x) => data[x.key]).find((it) => it.suggestion?.id === openId)?.suggestion) || null;
  // Bibles marked reviewed leave the list at once; the page catches up behind it
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [, startReview] = useTransition();
  const review = (it: NextItem) => {
    if (!it.bible) return;
    const b = it.bible;
    setReviewed((r) => [...r, it.id]);
    startReview(async () => {
      const r = await markBibleReviewed(b.clientId, b.version);
      if (!r.ok) setReviewed((x) => x.filter((id) => id !== it.id));
      else router.refresh();
    });
  };
  const bibles = data.bibles.filter((it) => !reviewed.includes(it.id));
  const total = data.now.length + data.decide.length + data.watch.length + bibles.length;
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
          const items = s.key === "bibles" ? bibles : data[s.key];
          if (!items.length && OPTIONAL.has(s.key)) return null;
          const open = !closed.includes(s.key);
          const urgent = items.filter((it) => it.tone === "bad").length;
          return (
            <section key={s.key} className="grid gap-2.5">
              <h2>
                <button
                  type="button"
                  onClick={() => toggle(s.key)}
                  aria-expanded={open}
                  aria-controls={`next-${s.key}`}
                  className="group flex min-h-11 w-full items-center gap-3 rounded-[12px] text-left"
                >
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="font-heading text-lg">{s.title}</span>
                    <span className={`tabular rounded-full px-2 py-0.5 text-xs ${items.length ? "bg-surface-2 text-muted" : "text-faint"}`}>{items.length}</span>
                    {!open && urgent > 0 && <span className="tabular text-xs text-bad">{urgent} late</span>}
                    <span className="hidden text-xs text-faint sm:inline">{s.hint}</span>
                  </span>
                  <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-faint transition-colors group-hover:bg-surface-2 group-hover:text-fg">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-200 ${open ? "" : "-rotate-90"}`}>
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                </button>
              </h2>
              {!open ? null : items.length === 0 ? (
                <p className="rounded-[14px] border border-line bg-surface px-4 py-3 text-sm text-faint">{s.empty}</p>
              ) : (
                <ul id={`next-${s.key}`} className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
                  {items.map((it) => (
                    <Row key={it.id} it={it} onBrief={(b) => pushParams({ todo: b.id })} onReviewed={it.bible ? () => review(it) : undefined} />
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
          onClose={() => closeThen(() => router.refresh(), "todo")}
        />
      )}
    </div>
  );
}

function Row({ it, onBrief, onReviewed }: { it: NextItem; onBrief: (s: OpenSuggestion) => void; onReviewed?: () => void }) {
  const body = (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[it.tone]}`} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium">{it.title}</span>
          {it.chip && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${it.chip.tone === "ok" ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>{it.chip.label}</span>}
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
        <span className="flex items-center pr-3">
          <button onClick={() => onBrief(it.suggestion!)} className={`${cls} min-w-0 flex-1`}>
            {body}
          </button>
          <SaveIdeaStar source={{ kind: "suggestion", id: it.suggestion.id }} from={{ kicker: KIND[it.kind], label: it.title }} clientId={it.suggestion.clientId} clientName={it.client} size="sm" />
        </span>
      ) : onReviewed ? (
        // A Brand Bible: open it to read, or mark it reviewed right here (phones: the button sits under the row)
        <span className="flex flex-col sm:flex-row sm:items-center sm:pr-3">
          <Link href={it.href ?? "#"} className={`${cls} min-w-0 flex-1`}>
            {body}
          </Link>
          <span className="flex justify-end px-4 pb-3 sm:p-0">
            <button type="button" onClick={onReviewed} className="min-h-11 rounded-full px-3 text-xs text-faint transition-colors hover:bg-surface-2 hover:text-fg sm:min-h-9">
              Mark reviewed
            </button>
          </span>
        </span>
      ) : (
        <Link href={it.href ?? "#"} className={cls}>
          {body}
        </Link>
      )}
    </li>
  );
}
