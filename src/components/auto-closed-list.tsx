"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reopenAutoClosed } from "@/app/(team)/done-check-actions";
import { closedNote } from "@/lib/done-check-core";
import type { AutoClosed } from "@/lib/done-check";

// Closed automatically: the item, the quote that closed it, where and when it was said, and Reopen in one tap.

export function AutoClosedList({ items }: { items: AutoClosed[] }) {
  const router = useRouter();
  const [gone, setGone] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const left = items.filter((i) => !gone[i.key]);
  if (!left.length) return null;
  return (
    <section id="closed-automatically" aria-labelledby="auto-closed-title" className="grid gap-2 rounded-[20px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="auto-closed-title" className="text-[13px] font-semibold text-fg">
          Closed automatically <span className="font-normal text-faint">· {left.length}</span>
        </h2>
        <span className="text-[11.5px] text-faint">Slack, email or call notes showed these done. Wrong? Reopen.</span>
      </div>
      <ul className="grid max-h-[18rem] gap-1.5 overflow-y-auto overscroll-contain pr-1">
        {left.map((i) => (
          <li key={i.key} className="flex flex-col gap-1.5 rounded-[14px] bg-ink/[0.04] px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="truncate text-[13px] text-fg">
                {i.client ? `${i.client}: ` : ""}
                {i.title}
              </span>
              <span className="text-[12px] text-muted">
                {i.link ? (
                  <a href={i.link} target="_blank" rel="noreferrer" className="underline decoration-ink/20 underline-offset-2 hover:text-fg">
                    {closedNote(i.quote, i.source ?? "", i.saidAt ?? i.closedAt)}
                  </a>
                ) : (
                  closedNote(i.quote, i.source ?? "", i.saidAt ?? i.closedAt)
                )}
              </span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  setGone((g) => ({ ...g, [i.key]: true }));
                  const r = await reopenAutoClosed(i.key);
                  if (!r.ok) {
                    setGone((g) => {
                      const n = { ...g };
                      delete n[i.key];
                      return n;
                    });
                    return setError(r.error);
                  }
                  router.refresh();
                })
              }
              className="min-h-11 shrink-0 self-start rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 sm:min-h-8 sm:self-center"
            >
              Reopen
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </section>
  );
}
