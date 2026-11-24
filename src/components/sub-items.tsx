"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SubItem } from "@/lib/exec-overview-core";
import { closeSubItem } from "@/app/today/actions";
import { pushParams, useParam } from "@/lib/url-state";

// A group card's own items, each reviewed on its own (owner, Nov 24 2026: "4 call safety reviews" should open to each
// call): who, when, what, the first moment, its own page, and Done or Dismiss for that one alone. Opening the list
// lives in the URL (?sub=<card key>), so Back closes it.

export function SubItems({ id, subs, dark = false, noun = "items" }: { id: string; subs: SubItem[]; dark?: boolean; noun?: string }) {
  const router = useRouter();
  const open = useParam("sub") === id;
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const left = subs.filter((s) => !gone.has(s.key));
  if (!left.length) return null;
  const c = dark
    ? { row: "border-white/10 bg-white/[0.05]", title: "text-white", meta: "text-white/55", detail: "text-white/80", btn: "border-white/25 text-white/85 hover:bg-white/10", done: "border-[#5be3a5]/50 text-[#5be3a5] hover:bg-[#5be3a5]/10", toggle: "border-white/25 text-white/85 hover:bg-white/10" }
    : { row: "border-line bg-ink/[0.02]", title: "text-fg", meta: "text-muted", detail: "text-ink/80", btn: "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg", done: "border-ok/40 text-ok hover:bg-ok-soft", toggle: "border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg" };
  const close = (key: string, how: "done" | "dismissed") => {
    setError(null);
    setBusy(key);
    start(async () => {
      const r = await closeSubItem(key, how);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setGone((g) => new Set(g).add(key));
      router.refresh();
    });
  };
  return (
    <div className="grid gap-2">
      <button type="button" onClick={() => pushParams({ sub: open ? null : id })} aria-expanded={open} className={`inline-flex min-h-11 items-center justify-self-start rounded-full border px-4 text-[13px] sm:min-h-8 sm:text-[12px] ${c.toggle}`}>
        {open ? "Hide the list" : `Show each of the ${left.length} ${noun}`}
      </button>
      {open && (
        <ul className="grid gap-2">
          {left.map((s) => (
            <li key={s.key} className={`grid gap-1.5 rounded-[16px] border p-3 ${c.row}`}>
              {s.href ? (
                <Link href={s.href} className={`text-[14px] font-medium leading-snug underline-offset-2 hover:underline [overflow-wrap:anywhere] ${c.title}`}>
                  {s.title}
                </Link>
              ) : (
                <span className={`text-[14px] font-medium leading-snug [overflow-wrap:anywhere] ${c.title}`}>{s.title}</span>
              )}
              {s.meta && <span className={`text-[12px] ${c.meta}`}>{s.meta}</span>}
              {s.detail && <span className={`whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere] ${c.detail}`}>{s.detail}</span>}
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {s.href && (
                  <Link href={s.href} className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] sm:min-h-8 sm:px-3 sm:text-[12px] ${c.btn}`}>
                    Open
                  </Link>
                )}
                <button type="button" disabled={pending && busy === s.key} onClick={() => close(s.key, "done")} className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] disabled:opacity-50 sm:min-h-8 sm:px-3 sm:text-[12px] ${c.done}`}>
                  ✓ Done
                </button>
                <button type="button" disabled={pending && busy === s.key} onClick={() => close(s.key, "dismissed")} className={`inline-flex min-h-11 items-center rounded-full px-3 text-[13px] disabled:opacity-50 sm:min-h-8 sm:text-[12px] ${c.meta}`}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={`text-[12.5px] ${dark ? "text-[#ff8a8a]" : "text-bad"}`}>{error}</p>}
    </div>
  );
}
