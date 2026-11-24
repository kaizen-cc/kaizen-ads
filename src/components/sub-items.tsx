"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubItem } from "@/lib/exec-overview-core";
import { closeSubItem } from "@/app/today/actions";
import { useClosed } from "@/lib/closed-items";
import { deferClear } from "@/lib/undo";
import { pushParams, useParam } from "@/lib/url-state";

// A group card's own items, each reviewed on its own (owner, Nov 24 2026: "4 call safety reviews" should open to each
// call; each "- line" of a reminder's follow-ups is its own item): who, when, what, its own page, and Done or Dismiss
// for that one alone. Closing counts at once everywhere on the page (the card's title, the block's number; the last
// line of a reminder takes the reminder with it), then saves. Opening the list lives in the URL (?sub=<card key>).

export function SubItems({ id, subs, dark = false, noun = "items" }: { id: string; subs: SubItem[]; dark?: boolean; noun?: string }) {
  const router = useRouter();
  const open = useParam("sub") === id;
  const closed = useClosed();
  const [error, setError] = useState<string | null>(null);
  const left = subs.filter((s) => !closed.has(s.key) && !closed.has(s.key.split("#")[0]));
  if (!left.length) return null;
  const c = dark
    ? { row: "border-white/10 bg-white/[0.05]", group: "text-white/60", title: "text-white", meta: "text-white/55", detail: "text-white/80", btn: "border-white/25 text-white/85 hover:bg-white/10", done: "border-[#5be3a5]/50 text-[#5be3a5] hover:bg-[#5be3a5]/10", toggle: "border-white/25 text-white/85 hover:bg-white/10" }
    : { row: "border-line bg-ink/[0.02]", group: "text-ink/60", title: "text-fg", meta: "text-muted", detail: "text-ink/80", btn: "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg", done: "border-ok/40 text-ok hover:bg-ok-soft", toggle: "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg" };
  const close = (key: string, how: "done" | "dismissed") => {
    setError(null);
    // Off now (the reminder too when this was its last open line), written once the Undo window closes; Undo brings
    // both back with nothing written (src/lib/undo.ts)
    const askId = /^ask:([^#]+)#/.exec(key)?.[1];
    const lines = askId ? subs.filter((s) => s.key.startsWith(`ask:${askId}#`)) : [];
    const last = lines.length > 0 && lines.every((s) => s.key === key || closed.has(s.key));
    deferClear({
      keys: last && askId ? [key, `ask:${askId}`] : [key],
      label: last ? "Done, and its reminder with it" : how === "done" ? "Marked done" : "Dismissed",
      commit: async () => {
        const r = await closeSubItem(key, how);
        if (r.ok) router.refresh();
        return r;
      },
      onError: setError,
    });
  };
  // Lines of one reminder under its title (shown above its first line)
  const heads = left.map((s, n) => (s.group && s.group !== left[n - 1]?.group ? s.group : null));
  return (
    <div className="grid gap-2">
      <button type="button" onClick={() => pushParams({ sub: open ? null : id })} aria-expanded={open} className={`inline-flex min-h-11 items-center justify-self-start rounded-full border px-4 text-[13px] sm:min-h-8 sm:text-[12px] ${c.toggle}`}>
        {open ? "Hide the list" : `Show each of the ${left.length} ${noun}`}
      </button>
      {open && (
        <ul className="grid gap-2">
          {left.map((s, n) => {
            const head = heads[n];
            return (
              <li key={s.key} className="grid gap-2">
                {head && <p className={`px-1 pt-1 text-[12px] font-medium uppercase tracking-[0.08em] [overflow-wrap:anywhere] ${c.group}`}>{head}</p>}
                <div className={`grid gap-1.5 rounded-[16px] border p-3 ${c.row}`}>
                  {s.href ? (
                    <Link href={s.href} className={`text-[14px] font-medium leading-snug underline-offset-2 hover:underline [overflow-wrap:anywhere] ${c.title}`}>
                      {s.title}
                    </Link>
                  ) : (
                    <span className={`text-[14px] font-medium leading-snug [overflow-wrap:anywhere] ${c.title}`}>{s.title}</span>
                  )}
                  {s.meta && <span className={`text-[12px] ${c.meta}`}>{s.overdue ? `Overdue · ${s.meta}` : s.meta}</span>}
                  {s.detail && <span className={`whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere] ${c.detail}`}>{s.detail}</span>}
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {s.href && (
                      <Link href={s.href} className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] sm:min-h-8 sm:px-3 sm:text-[12px] ${c.btn}`}>
                        Open
                      </Link>
                    )}
                    <button type="button" onClick={() => close(s.key, "done")} className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] sm:min-h-8 sm:px-3 sm:text-[12px] ${c.done}`}>
                      ✓ Done
                    </button>
                    <button type="button" onClick={() => close(s.key, "dismissed")} className={`inline-flex min-h-11 items-center rounded-full px-3 text-[13px] sm:min-h-8 sm:text-[12px] ${c.meta}`}>
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className={`text-[12.5px] ${dark ? "text-[#ff8a8a]" : "text-bad"}`}>{error}</p>}
    </div>
  );
}
