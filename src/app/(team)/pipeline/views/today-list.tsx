"use client";

import Link from "next/link";
import { useState } from "react";
import type { TodayItem, TopicKey } from "@/lib/today";
import { ItemQuickActions } from "@/components/item-quick-actions";
import { pushParams, useParam } from "@/lib/url-state";
import { rowOpens } from "@/lib/exec-overview-core";

// The Overview's list view (switched on per person, never the default): the day as plain rows, Asana-style. One row per
// item: the client, what it is, when it's due and where it stands, with the same quick actions everywhere (Done,
// Snooze to tomorrow, Delegate, Comment). Sections start folded; the open ones live in the address (?open=), so back
// returns to the same list.

const TIER_DOT: Record<string, string> = { critical: "bg-[#ff4d5e]", high: "bg-[#f2b14c]", normal: "bg-[#9aa8ff]" };
const TIER_WORD: Record<string, string> = { critical: "Critical", high: "Important", normal: "Worth a look" };

export type ListSection = { topic: TopicKey; label: string; blurb: string; items: TodayItem[] };

const hrefOf = (i: TodayItem) => i.action.href ?? (i.clientSlug ? `/clients/${i.clientSlug}` : `/today?topic=${i.topic}`);

const TITLE = "text-left text-[14px] leading-snug text-fg hover:underline md:text-[13.5px]";

/** The row's title, opening the item: its own sheet when it would only land back here (the list stays open), else where it lives */
function RowTitle({ i }: { i: TodayItem }) {
  const href = hrefOf(i);
  const how = rowOpens(href);
  if (how === "sheet")
    return (
      <button type="button" onClick={() => pushParams({ item: i.key })} className={TITLE}>
        {i.title}
      </button>
    );
  if (how === "external")
    return (
      <a href={href} target="_blank" rel="noreferrer" className={TITLE}>
        {i.title}
      </a>
    );
  return (
    <Link href={href} className={TITLE}>
      {i.title}
    </Link>
  );
}

/** "Today", "Tomorrow", "Nov 18" (late shows in red), from a date or a timestamp */
function dueOf(due: string | null | undefined): { text: string; late: boolean } | null {
  if (!due) return null;
  const todayNY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const day = due.length > 10 ? new Date(due).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : due;
  const t = new Date(`${todayNY}T12:00:00Z`);
  const tomorrow = new Date(t.getTime() + 864e5).toISOString().slice(0, 10);
  if (day === todayNY) return { text: "Today", late: due.length > 10 && new Date(due) < new Date() };
  if (day === tomorrow) return { text: "Tomorrow", late: false };
  return { text: new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), late: day < todayNY };
}

function statusOf(i: TodayItem): string {
  if (i.state === "saved") return "Saved";
  if (i.state === "new") return "New";
  return i.carried ? "From before" : "Seen";
}

export function TodayList({ sections, badges = {} }: { sections: ListSection[]; /** Comments and "waiting on client", per item key */ badges?: Record<string, { comments: number; waiting: boolean }> }) {
  const openParam = useParam("open");
  const open = new Set((openParam ?? "").split(",").filter(Boolean));
  const [gone, setGone] = useState<Record<string, string>>({});
  const toggle = (t: string) => {
    const next = new Set(open);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    pushParams({ open: [...next].join(",") || null });
  };
  if (!sections.length) return <p className="rounded-[18px] border border-line bg-deep px-4 py-6 text-center text-sm text-ink/60">Nothing on your list right now.</p>;
  return (
    <div className="grid gap-2">
      {sections.map((s) => {
        const left = s.items.filter((i) => !gone[i.key]);
        const isOpen = open.has(s.topic);
        const critical = left.filter((i) => i.tier === "critical").length;
        return (
          <section key={s.topic} className="overflow-hidden rounded-[18px] border border-line bg-deep">
            <button type="button" onClick={() => toggle(s.topic)} aria-expanded={isOpen} className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink/[0.04]">
              <span aria-hidden className={`text-[11px] text-ink/45 transition-transform ${isOpen ? "rotate-90" : ""}`}>
                ▶
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-fg">{s.label}</span>
                <span className="block truncate text-[11.5px] text-ink/50">{s.blurb}</span>
              </span>
              {critical > 0 && <span className="rounded-full bg-[#ff4d5e]/15 px-2 py-0.5 text-[11px] text-[#ff4d5e]">{critical} critical</span>}
              <span className="tabular text-[13px] text-ink/60">{left.length}</span>
            </button>
            {isOpen && (
              <div role="table" aria-label={s.label} className="border-t border-line">
                <div role="row" className="hidden grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6rem_7rem] gap-3 px-4 py-2 text-[10.5px] uppercase tracking-[0.14em] text-ink/40 md:grid">
                  <span role="columnheader">Client</span>
                  <span role="columnheader">What</span>
                  <span role="columnheader">Due</span>
                  <span role="columnheader">Status</span>
                </div>
                {s.items.map((i) => {
                  const due = dueOf(i.due);
                  const done = gone[i.key];
                  return (
                    <div key={i.key} role="row" className="grid gap-1 border-t border-line/60 px-4 py-3 first:border-t-0 md:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6rem_7rem] md:items-start md:gap-3 md:py-2.5">
                      {done ? (
                        <p className="text-[12.5px] text-ink/50 md:col-span-4">
                          {i.client}: {done}
                        </p>
                      ) : (
                        <>
                          <span role="cell" className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink/70">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TIER_DOT[i.tier]}`} title={TIER_WORD[i.tier]} />
                            <span className="truncate">{i.client}</span>
                          </span>
                          <span role="cell" className="grid min-w-0 gap-1.5">
                            <RowTitle i={i} />
                            <ItemQuickActions
                              compact
                              item={{ key: i.key, href: hrefOf(i), dueAt: i.due ?? null, comments: badges[i.key]?.comments, waiting: badges[i.key]?.waiting, snap: { topic: i.topic, client: i.client, title: i.title, clientId: i.clientId } }}
                              onGone={(how, note) => setGone((g) => ({ ...g, [i.key]: note ?? (how === "done" ? "Done" : "Cleared") }))}
                              onBack={() => setGone((g) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== i.key)))}
                            />
                          </span>
                          <span role="cell" className={`text-[12px] ${due?.late ? "text-[#ff4d5e]" : "text-ink/60"}`}>
                            <span className="text-ink/40 md:hidden">Due </span>
                            {due ? due.text : "—"}
                          </span>
                          <span role="cell" className="text-[12px] text-ink/60">
                            {badges[i.key]?.waiting ? "Waiting on client" : `${TIER_WORD[i.tier]} · ${statusOf(i)}`}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
