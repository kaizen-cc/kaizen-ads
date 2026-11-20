"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteBriefDraftAction } from "@/app/(team)/requests/new/draft-store";

// "Unfinished brief: pick up where you left off" (src/lib/brief-drafts.ts): the briefs someone started and didn't send,
// kept in the database as they typed, on the request screen and on their Overview. The newest leads; the rest are a
// short list under it. Resume opens it exactly as it was; Start fresh opens an empty request (the draft stays here);
// Delete removes it for good.

export type UnfinishedBrief = { id: string; client: string | null; title: string | null; updatedAt: string };

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

export function UnfinishedBriefs({ drafts, compact = false }: { drafts: UnfinishedBrief[]; compact?: boolean }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, act] = useTransition();
  const shown = drafts.filter((d) => !gone.has(d.id));
  if (!shown.length) return null;
  const [first, ...rest] = shown;
  const remove = (id: string) =>
    act(async () => {
      setGone((g) => new Set(g).add(id));
      await deleteBriefDraftAction(id);
      router.refresh();
    });
  return (
    <section aria-label="Unfinished briefs" className="relative overflow-hidden rounded-[22px] border border-line bg-surface">
      <span aria-hidden className="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full opacity-60 blur-3xl" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--warn) 22%, transparent), transparent 70%)" }} />
      <div className={`relative grid gap-4 ${compact ? "p-4 md:p-5" : "p-5 md:p-6"}`}>
        <div className="grid gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-warn">Unfinished brief</p>
          <p className="font-heading text-[19px] leading-snug md:text-[21px]">Pick up where you left off</p>
        </div>
        <div className="grid gap-3 rounded-[16px] border border-line bg-bg/60 p-4 sm:flex sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-0.5">
            <span className="truncate text-[15px] font-medium text-fg">{first.title || "Untitled brief"}</span>
            <span className="text-[12.5px] text-muted">
              {first.client ?? "No client yet"} · edited {ago(first.updatedAt)}
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 sm:flex sm:shrink-0">
            <Link href={`/requests/new?resume=${first.id}`} className="inline-flex min-h-11 items-center justify-center rounded-full bg-fg px-5 text-[13.5px] font-medium text-bg transition-opacity hover:opacity-90 sm:min-h-9">
              Resume
            </Link>
            <Link href="/requests/new?own=1&fresh=1" className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg sm:min-h-9">
              Start fresh
            </Link>
            <button type="button" onClick={() => remove(first.id)} disabled={busy} className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-[13px] text-muted hover:text-bad disabled:opacity-50 sm:min-h-9">
              Delete
            </button>
          </div>
        </div>
        {rest.length > 0 && (
          <ul className="grid gap-1">
            {rest.slice(0, compact ? 3 : 8).map((d) => (
              <li key={d.id} className="flex min-h-11 items-center gap-3 rounded-[12px] px-2 hover:bg-ink/[0.04]">
                <Link href={`/requests/new?resume=${d.id}`} className="grid min-w-0 flex-1 py-2">
                  <span className="truncate text-[14px] text-fg">{d.title || "Untitled brief"}</span>
                  <span className="text-[12px] text-faint">
                    {d.client ?? "No client yet"} · {ago(d.updatedAt)}
                  </span>
                </Link>
                <button type="button" onClick={() => remove(d.id)} disabled={busy} aria-label={`Delete ${d.title || "this draft"}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:text-bad md:h-8 md:w-8">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
