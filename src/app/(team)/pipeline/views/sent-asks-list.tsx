"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { tickAskItem } from "../next-actions";
import type { SentAsk } from "@/lib/sent-asks";
import { CommentButton } from "@/components/item-comments";
import { pushParams, useParam } from "@/lib/url-state";

// The sender's side of a checklist or task sent to a teammate: one row each, its progress at a glance, and opened
// (?sent=<id>, so back closes it and a notification lands on it) the checklist itself, tickable here too, with the
// shared comment thread.

const day = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null);

export function SentAsksList({ items }: { items: SentAsk[] }) {
  const open = useParam("sent");
  const open_ = items.filter((i) => i.status === "open").length;
  return (
    <section id="sent" aria-labelledby="sent-title" className="grid scroll-mt-24 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h3 id="sent-title" className="font-heading text-[20px] tracking-tight">
          Sent by you
        </h3>
        <span className="text-[12px] text-faint">{open_ ? `${open_} with teammates` : "All finished"}</span>
      </div>
      <ul className="grid gap-2">
        {items.map((a) => (
          <Row key={a.id} a={a} expanded={open === a.id} />
        ))}
      </ul>
    </section>
  );
}

function Row({ a, expanded }: { a: SentAsk; expanded: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLLIElement>(null);
  const [ticks, setTicks] = useState(() => a.checklist.map((i) => i.done));
  const [, start] = useTransition();
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);
  const done = ticks.filter(Boolean).length;
  const total = a.checklist.length;
  const finished = a.status === "done";
  const tick = (i: number, v: boolean) => {
    setTicks((t) => t.map((x, k) => (k === i ? v : x)));
    start(async () => {
      const r = await tickAskItem(a.id, i, v);
      if (!r.ok) setTicks((t) => t.map((x, k) => (k === i ? !v : x)));
      else if (r.allDone) router.refresh();
    });
  };
  return (
    <li ref={ref} className={`overflow-hidden rounded-[18px] border bg-surface ${expanded ? "border-ink/25" : "border-line"}`}>
      <button type="button" onClick={() => pushParams({ sent: expanded ? null : a.id })} aria-expanded={expanded} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink/[0.03]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${finished ? "bg-[#5be3a5]" : a.status === "dismissed" ? "bg-ink/30" : "bg-[#9aa8ff]"}`} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-[14px] text-fg">{a.title}</span>
          <span className="truncate text-[12px] text-faint">
            To {a.to}
            {a.client ? ` · ${a.client.name}` : ""}
            {a.due ? ` · due ${day(a.due)}` : ""}
            {finished ? " · done" : a.status === "dismissed" ? " · set aside" : ""}
          </span>
        </span>
        {total > 0 && (
          <span className="flex shrink-0 items-center gap-2" aria-label={`${done} of ${total} done`}>
            <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-ink/10 sm:block">
              <span className="block h-full rounded-full bg-[#5be3a5] transition-[width] duration-500" style={{ width: `${Math.max(4, (done / total) * 100)}%` }} />
            </span>
            <span className="tabular text-[12px] text-ink/60">
              {done}/{total}
            </span>
          </span>
        )}
      </button>
      {expanded && (
        <div className="grid gap-2 border-t border-line px-4 pb-4 pt-3">
          {a.detail && <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink/65">{a.detail}</p>}
          {total > 0 ? (
            <ul className="grid gap-0.5" aria-label="Checklist">
              {a.checklist.map((it, i) => (
                <li key={`${i}-${it.text}`}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-[10px] px-1 py-1.5 text-[13.5px] leading-snug text-ink/80 hover:bg-ink/[0.04] sm:min-h-8">
                    <input type="checkbox" checked={ticks[i] ?? false} onChange={(e) => tick(i, e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
                    <span className={ticks[i] ? "text-ink/40 line-through" : ""}>{it.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-faint">{finished ? `${a.to} marked it done.` : `${a.to} has it on their Next for me.`}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <CommentButton target={{ key: `ask:${a.id}`, clientId: null, title: a.title, href: `/pipeline?tab=work&sent=${a.id}#sent` }} />
            {a.client && (
              <Link href={`/clients/${a.client.slug}`} className="inline-flex min-h-11 items-center rounded-full px-3 text-[12.5px] text-ink/60 hover:text-fg sm:min-h-8">
                {a.client.name} →
              </Link>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
