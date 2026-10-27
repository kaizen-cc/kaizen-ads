"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaidPromise } from "@/lib/message-promises";
import { closeSaidPromise } from "@/app/today/actions";

// What someone said yes to in Slack or email that's past due with nothing showing it moving: theirs to do (or close),
// and for leads and execs, the ones that went past a second notice.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

export function SaidPromises({ items, me }: { items: SaidPromise[]; me: string }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const shown = items.filter((p) => !gone.has(p.id));
  if (!shown.length) return null;
  const close = (id: string, how: "done" | "dropped") => {
    setGone((g) => new Set(g).add(id));
    start(async () => {
      await closeSaidPromise(id, how);
      router.refresh();
    });
  };
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {shown.map((p) => {
        const mine = p.ownerId === me;
        const second = p.status === "escalated";
        const make = ["creative", "copy", "offer"].includes(p.kind ?? "") && p.clientSlug;
        return (
          <article key={p.id} className={`grid content-start gap-3 rounded-[16px] border bg-bg/70 p-4 ${second ? "border-bad/40" : "border-line"}`}>
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${second ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{second ? "Second notice" : "Past due"}</span>
                {p.clientSlug ? (
                  <Link href={`/clients/${p.clientSlug}`} className="font-medium text-fg hover:underline">
                    {p.client}
                  </Link>
                ) : (
                  <span className="font-medium text-fg">{p.askedBy ?? "Team"}</span>
                )}
                · {p.source === "gmail" ? "Email" : "Slack"} · said {day(p.saidAt)}
              </span>
              <p className="text-[15px] leading-snug">
                <span className="text-muted">{mine ? "You said you'd" : `${p.owner} said they'd`} </span>
                {p.what}
              </p>
              <p className="line-clamp-2 text-xs text-faint">
                {p.askedBy ?? "They"} asked{p.ask ? `: ${p.ask}` : ""} · &ldquo;{p.said.replace(/\s+/g, " ")}&rdquo;
              </p>
              <p className={`text-xs ${second ? "text-bad" : "text-warn"}`}>Due {day(p.dueAt)}. Nothing since shows it&apos;s happened.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {make && mine && (
                <Link href={`/requests/new?client=${p.clientSlug}`} className="inline-flex h-11 w-full items-center justify-center rounded-brand bg-fg px-4 text-sm font-medium text-bg md:h-9 md:w-auto">
                  Make the request
                </Link>
              )}
              {p.url && (
                <a href={p.url} target="_blank" rel="noreferrer" className={`inline-flex h-11 items-center justify-center rounded-brand px-4 text-sm md:h-9 ${make && mine ? "flex-1 border border-line text-muted hover:text-fg md:flex-none" : "w-full bg-fg font-medium text-bg md:w-auto"}`}>
                  {p.source === "gmail" ? "Open the email" : "Open in Slack"} ↗
                </a>
              )}
              {mine && (
                <>
                  <button type="button" onClick={() => close(p.id, "done")} className="h-11 flex-1 rounded-brand border border-line px-3 text-sm text-muted hover:text-fg md:h-9 md:flex-none">
                    It&apos;s done
                  </button>
                  <button type="button" onClick={() => close(p.id, "dropped")} className="h-11 rounded-brand px-3 text-sm text-faint hover:text-fg md:h-9">
                    Not needed
                  </button>
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
