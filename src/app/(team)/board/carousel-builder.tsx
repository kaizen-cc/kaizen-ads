"use client";

import { useRef, useState } from "react";
import type { StagedDesign, StagedFile } from "@/lib/uploads/media";

// A carousel ticket's upload: one row per carousel with a numbered slot for each card (as many as the request asked
// for, more or fewer if the brief changed). Click a slot to pick its file, drop a file on it, or drop several on the
// row to fill the empty slots in name order. Ready carousels go to the same check and upload as any design.

type Board = { key: string; name: string; slots: (StagedFile | null)[] };

export function CarouselBuilder({
  cards,
  next,
  asked,
  read,
  onReady,
}: {
  cards: number;
  /** The number the next carousel gets (designs already on the ticket + 1) */
  next: number;
  asked: number;
  read: (files: File[]) => Promise<StagedFile[]>;
  onReady: (designs: StagedDesign[]) => void;
}) {
  const make = (n: number): Board => ({ key: crypto.randomUUID(), name: `Carousel ${n}`, slots: Array.from({ length: cards }, () => null) });
  const [boards, setBoards] = useState<Board[]>(() => [make(next)]);
  const [reading, setReading] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<{ board: string; slot: number | null } | null>(null);

  const put = async (boardKey: string, slot: number | null, files: File[]) => {
    if (!files.length) return;
    setReading(boardKey);
    const staged = (await read(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))).filter(Boolean);
    setReading(null);
    setBoards((bs) =>
      bs.map((b) => {
        if (b.key !== boardKey) return b;
        const slots = [...b.slots];
        if (slot != null && staged.length === 1) slots[slot] = staged[0];
        else {
          // Several files: into the empty slots in order (from the slot dropped on), adding cards past the end up to 10
          let at = slot ?? 0;
          for (const f of staged) {
            while (at < slots.length && slots[at]) at++;
            if (at >= 10) break;
            if (at >= slots.length) slots.push(null);
            slots[at] = f;
          }
        }
        return { ...b, slots };
      }),
    );
  };

  const setSlots = (key: string, n: number) => setBoards((bs) => bs.map((b) => (b.key !== key ? b : { ...b, slots: n > b.slots.length ? [...b.slots, ...Array.from({ length: n - b.slots.length }, () => null)] : b.slots.slice(0, n) })));
  const ready = boards.filter((b) => b.slots.filter(Boolean).length >= 2);

  return (
    <div className="grid gap-3">
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          const t = target.current;
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (t) void put(t.board, t.slot, list);
        }}
      />
      {boards.map((b, bi) => {
        const filled = b.slots.filter(Boolean).length;
        return (
          <div
            key={b.key}
            className={`grid gap-3 rounded-[12px] border p-3.5 transition-colors ${over === b.key ? "border-brand-text bg-brand-soft" : "border-line bg-surface"}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(b.key);
            }}
            onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              void put(b.key, null, [...e.dataTransfer.files]);
            }}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={b.name}
                onChange={(e) => setBoards((bs) => bs.map((x) => (x.key === b.key ? { ...x, name: e.target.value } : x)))}
                aria-label="Carousel name"
                className="h-9 min-w-0 flex-1 rounded-brand border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-line focus:border-brand-text/60 max-md:h-11"
              />
              <span className={`text-xs tabular ${filled >= b.slots.length ? "text-ok" : "text-faint"}`}>
                {filled} of {b.slots.length} cards
              </span>
              <span className="flex items-center overflow-hidden rounded-full border border-line text-sm">
                <button type="button" onClick={() => setSlots(b.key, Math.max(2, b.slots.length - 1))} aria-label="One card fewer" className="grid h-8 w-8 place-items-center text-muted hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11">
                  −
                </button>
                <button type="button" onClick={() => setSlots(b.key, Math.min(10, b.slots.length + 1))} aria-label="One more card" className="grid h-8 w-8 place-items-center text-muted hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11">
                  +
                </button>
              </span>
              {boards.length > 1 && (
                <button type="button" onClick={() => setBoards((bs) => bs.filter((x) => x.key !== b.key))} className="text-xs text-faint hover:text-fg max-md:min-h-11 max-md:px-2">
                  Remove
                </button>
              )}
            </div>
            {/* The cards in order, swiping sideways like the carousel itself */}
            <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
              {b.slots.map((f, i) => (
                <div
                  key={i}
                  className="relative w-[104px] shrink-0 snap-start"
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOver(null);
                    void put(b.key, i, [...e.dataTransfer.files]);
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      target.current = { board: b.key, slot: i };
                      input.current?.click();
                    }}
                    className={`grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-[10px] border text-center transition-colors ${f ? "border-line" : "border-dashed border-line hover:border-brand-text/60 hover:bg-brand-soft/40"}`}
                    aria-label={f ? `Replace card ${i + 1}` : `Add card ${i + 1}`}
                  >
                    {f?.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.preview} alt={`Card ${i + 1}`} className="h-full w-full object-cover" />
                    ) : f ? (
                      <span className="px-2 text-[11px] text-muted">{f.file.name}</span>
                    ) : (
                      <span className="grid gap-1 text-faint">
                        <span className="text-lg leading-none">+</span>
                        <span className="text-[11px]">Card {i + 1}</span>
                      </span>
                    )}
                  </button>
                  {f && (
                    <>
                      <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 text-[10px] font-medium text-white">{i + 1}</span>
                      <button
                        type="button"
                        onClick={() => setBoards((bs) => bs.map((x) => (x.key === b.key ? { ...x, slots: x.slots.map((s, j) => (j === i ? null : s)) } : x)))}
                        aria-label={`Clear card ${i + 1}`}
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/65 text-xs text-white hover:bg-black/85 max-md:h-8 max-md:w-8"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {reading === b.key && <p className="text-xs text-muted">Reading files…</p>}
            {bi === boards.length - 1 && <p className="text-[11px] text-faint max-md:hidden">Click a card to pick its file, or drop several on this carousel to fill the cards in order.</p>}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        {boards.length < Math.max(1, asked) + 5 && (
          <button type="button" onClick={() => setBoards((bs) => [...bs, make(next + bs.length)])} className="h-9 rounded-full border border-dashed border-line px-4 text-sm text-muted hover:text-fg max-md:h-11">
            + Another carousel
          </button>
        )}
        <button
          type="button"
          disabled={!ready.length}
          onClick={() => onReady(ready.map((b) => ({ key: b.key, name: b.name.trim() || "Carousel", files: b.slots.filter((s): s is StagedFile => Boolean(s)), variationOf: null })))}
          className="ml-auto h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40 max-md:h-11 max-md:w-full"
        >
          {ready.length > 1 ? `Continue with ${ready.length} carousels` : "Continue"}
        </button>
      </div>
    </div>
  );
}
