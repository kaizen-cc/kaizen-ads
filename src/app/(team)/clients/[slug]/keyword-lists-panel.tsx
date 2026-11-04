"use client";

import Link from "next/link";
import { useState } from "react";
import type { KeywordList } from "@/lib/keyword-research";
import { deleteKeywordList } from "../../ideas/google-actions";

// The client's saved keyword lists (from keyword research in Ideas › Google › In the market), to open and add later.

const kwText = (k: KeywordList["keywords"][number]) => (k.negative ? `−${k.text}` : k.match === "exact" ? `[${k.text}]` : k.match === "phrase" ? `"${k.text}"` : k.text);

export function KeywordListsPanel({ clientId, lists: initial, canAct }: { clientId: string; lists: KeywordList[]; canAct: boolean }) {
  const [lists, setLists] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const research = `/ideas?line=google&tab=market&client=${clientId}`;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-heading text-[18px]">Keyword lists</h3>
        <Link href={research} className="inline-flex min-h-11 items-center text-[13px] text-brand-text hover:underline md:min-h-0">
          Find keywords for them →
        </Link>
      </div>
      {lists.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-[13.5px] text-muted">No saved lists yet. Research keywords for them in Ideas › Google › In the market and save the ones worth keeping (&ldquo;BBQ season&rdquo;, &ldquo;Brunch&rdquo;).</p>
      ) : (
        <ul className="grid gap-2.5 md:grid-cols-2">
          {lists.map((l) => {
            const searches = l.keywords.filter((k) => !k.negative).reduce((n, k) => n + (k.searches ?? 0), 0);
            return (
              <li key={l.id} className="grid gap-3 rounded-[18px] border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-heading text-[16px] leading-snug">{l.name}</span>
                    <span className="text-[12px] text-faint">
                      {l.keywords.length} keyword{l.keywords.length === 1 ? "" : "s"}
                      {searches ? ` · about ${searches.toLocaleString("en-US")} searches a month` : ""} · {new Date(l.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </span>
                  {canAct && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(`Delete the list "${l.name}"?`)) return;
                        const r = await deleteKeywordList(l.id);
                        if (!r.ok) return setError(r.error);
                        setLists((x) => x.filter((y) => y.id !== l.id));
                      }}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:text-bad md:h-8 md:w-8"
                      aria-label={`Delete ${l.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {l.keywords.slice(0, 12).map((k) => (
                    <span key={`${k.text}|${k.match}|${k.negative}`} className={`rounded-full px-2.5 py-1 text-[12px] ${k.negative ? "bg-bad-soft text-bad" : "bg-surface-2 text-muted"}`}>
                      {kwText(k)}
                    </span>
                  ))}
                  {l.keywords.length > 12 && <span className="px-1 py-1 text-[12px] text-faint">+{l.keywords.length - 12} more</span>}
                </div>
                <Link href={`${research}&list=${l.id}`} className="inline-flex min-h-11 items-center justify-self-start rounded-full border border-line px-4 text-[13px] hover:border-faint md:min-h-9">
                  Open and add to their account →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </div>
  );
}
