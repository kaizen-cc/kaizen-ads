"use client";

import { useEffect, useState, useTransition } from "react";
import { deckForReport, fillTemplateDeck } from "./actions";

// "Fill our PowerPoint template" on a monthly recap: a copy of the team's template in the client's Drive, filled with
// this month's numbers, story, charts and top ads. Then: open it in Google Slides, or download it as PowerPoint.

type Deck = { url: string; pptx: string; notes: string[]; at: string | null } | null;

export function RecapDeckButton({ reportId }: { reportId: string }) {
  const [deck, setDeck] = useState<Deck>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    deckForReport(reportId)
      .then((d) => live && d && setDeck(d))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [reportId]);

  const fill = (remap = false) =>
    start(async () => {
      setError(null);
      const r = await fillTemplateDeck(reportId, remap).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
      if (!r.ok) return setError(r.error);
      setDeck({ url: r.url, pptx: r.pptx, notes: r.notes, at: new Date().toISOString() });
    });

  return (
    <div className="grid w-full gap-2 rounded-[14px] border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending} onClick={() => fill(false)} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13.5px] font-medium text-white disabled:opacity-60 md:min-h-9">
          {pending ? "Filling the template…" : deck ? "Fill it again" : "Fill our PowerPoint template"}
        </button>
        {deck && (
          <>
            <a href={deck.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13.5px] text-fg hover:bg-surface-2 md:min-h-9">
              Open in Google Slides ↗
            </a>
            <a href={deck.pptx} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13.5px] text-fg hover:bg-surface-2 md:min-h-9">
              Download as PPTX
            </a>
          </>
        )}
      </div>
      {pending && <p className="text-[12.5px] text-muted">Copying the template into the client&rsquo;s Drive, drawing the charts and filling every slide. This takes up to a minute.</p>}
      {!pending && deck && deck.notes.length > 0 && (
        <ul className="grid gap-1 text-[12.5px] text-muted">
          {deck.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {!pending && deck && (
        <button type="button" onClick={() => fill(true)} className="w-fit text-[12px] text-faint underline-offset-4 hover:text-fg hover:underline">
          Map the template again
        </button>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}
