"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { carouselCards, saveCards, writeCards, type CarouselView } from "./copy-actions";

// On a carousel ticket's copy: each card with its own headline and description (the Copywriter writes them looking at
// the cards; copy review edits them here). Saves as it's edited. The launcher puts them on the cards in Meta.

const LIMIT = { headline: 40, description: 20 };

export function CarouselCards({ requestId }: { requestId: string }) {
  const [v, setV] = useState<CarouselView | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const [, start] = useTransition();
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let live = true;
    void carouselCards(requestId).then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, [requestId]);

  if (!v || !v.designs.length) return null;

  const edit = (designId: string, i: number, k: "headline" | "description", value: string) => {
    const d = v.designs.find((x) => x.id === designId)!;
    const list = d.thumbs.map((_, j) => v.cards[designId]?.[j] ?? { headline: "", description: "" });
    list[i] = { ...list[i], [k]: value };
    setV({ ...v, cards: { ...v.cards, [designId]: list } });
    // Autosave a moment after typing stops
    clearTimeout(timers.current[designId]);
    timers.current[designId] = setTimeout(
      () =>
        start(async () => {
          const r = await saveCards(requestId, designId, list);
          if (!r.ok) return setError(r.error);
          setError(null);
          setSaved(designId);
        }),
      700,
    );
  };

  const write = (designId: string) =>
    start(async () => {
      setWriting(designId);
      setError(null);
      const r = await writeCards(requestId, designId);
      if (!r.ok) setError(r.error);
      setV(await carouselCards(requestId));
      setWriting(null);
    });

  return (
    <div className="grid gap-4 rounded-[16px] border border-line bg-surface p-4 md:p-5">
      <div className="grid gap-0.5">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Carousel cards</p>
        <p className="text-xs text-muted">Each card&apos;s headline and description, in order. The primary texts above run on every card; these are what changes card to card.</p>
      </div>
      {v.designs.map((d) => {
        const cards = v.cards[d.id] ?? [];
        const empty = !cards.some((c) => c.headline.trim());
        return (
          <div key={d.id} className="grid gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                D{d.position} · {d.name} <span className="font-normal text-faint">· {d.thumbs.length} cards</span>
              </p>
              <span className="flex items-center gap-3 text-[11px]">
                {saved === d.id && <span className="text-ok">Saved</span>}
                <button type="button" onClick={() => write(d.id)} disabled={writing !== null} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted hover:text-fg disabled:opacity-60 max-md:min-h-11">
                  {writing === d.id ? "Writing…" : empty ? "Have the Copywriter write them" : "Rewrite them"}
                </button>
              </span>
            </div>
            {/* The cards side by side, swiping on phones like the carousel itself */}
            <div className="-mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
              {d.thumbs.map((src, i) => {
                const c = cards[i] ?? { headline: "", description: "" };
                return (
                  <div key={i} className="grid w-[200px] shrink-0 snap-start content-start gap-2 rounded-[12px] border border-line bg-bg/50 p-2">
                    <div className="relative aspect-square overflow-hidden rounded-[8px] bg-surface-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {src && <img src={src} alt={`Card ${i + 1}`} className="h-full w-full object-cover" />}
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">{i + 1}</span>
                    </div>
                    <input value={c.headline} onChange={(e) => edit(d.id, i, "headline", e.target.value)} placeholder="Headline" className="h-9 w-full rounded-[8px] border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-fg/40 max-md:h-11" />
                    <input value={c.description} onChange={(e) => edit(d.id, i, "description", e.target.value)} placeholder="Description (optional)" className="h-8 w-full rounded-[8px] border border-line bg-bg px-2.5 text-xs text-muted outline-none focus:border-fg/40 max-md:h-11" />
                    <span className={`text-right text-[10px] tabular ${c.headline.length > LIMIT.headline || c.description.length > LIMIT.description ? "text-warn" : "text-faint"}`}>
                      {c.headline.length}/{LIMIT.headline} · {c.description.length}/{LIMIT.description}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
