"use client";

import { useRef, useState } from "react";
import type { StagedFile } from "@/lib/uploads/media";

// A new carousel: a numbered slot for each card. Putting a file in a slot uploads it there and then (the carousel is
// made on the first card), so there's no separate upload step; the carousel then shows with the ticket's other
// designs, where its empty slots, a card's replacement and deleting a card live. Dropping several files on the row
// fills the cards in name order.

type Started = { designId: string; versionId: string; version: number; prefix: string };

export function CarouselBuilder({
  cards,
  next,
  show,
  read,
  onCreate,
  onUpload,
  onDone,
}: {
  cards: number;
  /** The number the next carousel gets (designs already on the ticket + 1) */
  next: number;
  /** Whether the ticket still needs another carousel (otherwise it's offered folded) */
  show: boolean;
  read: (files: File[]) => Promise<StagedFile[]>;
  onCreate: (name: string) => Promise<Started | null>;
  onUpload: (s: Started, card: number, file: StagedFile) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(`Carousel ${next}`);
  const [slots, setSlots] = useState(() => Math.max(2, cards));
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState<number | "row" | null>(null);
  const [open, setOpen] = useState(show);
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<number | null>(null);

  /** Files into slots from `from` on, in name order: the carousel is made, each card goes up as it lands */
  const put = async (from: number, files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    const staged = (await read(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))).slice(0, 10 - from);
    if (staged.length) {
      const s = await onCreate(name.trim() || `Carousel ${next}`);
      if (s) {
        staged.forEach((f, i) => onUpload(s, from + i + 1, f));
        setName(`Carousel ${next + 1}`);
        onDone();
      }
    }
    setBusy(false);
  };

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="h-9 justify-self-start rounded-full border border-dashed border-line px-4 text-sm text-muted hover:text-fg max-md:h-11">
        + Another carousel
      </button>
    );

  return (
    <div
      className={`grid gap-3 rounded-[12px] border p-3.5 transition-colors ${over === "row" ? "border-brand-text bg-brand-soft" : "border-line bg-surface"}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver("row");
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(null);
        void put(0, [...e.dataTransfer.files]);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          void put(target.current ?? 0, list);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Carousel name" className="h-9 min-w-0 flex-1 rounded-brand border border-transparent bg-transparent px-2 text-sm font-medium outline-none hover:border-line focus:border-brand-text/60 max-md:h-11" />
        <span className="text-xs tabular text-faint">{slots} cards</span>
        <span className="flex items-center overflow-hidden rounded-full border border-line text-sm">
          <button type="button" onClick={() => setSlots(Math.max(2, slots - 1))} aria-label="One card fewer" className="grid h-8 w-8 place-items-center text-muted hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11">
            −
          </button>
          <button type="button" onClick={() => setSlots(Math.min(10, slots + 1))} aria-label="One more card" className="grid h-8 w-8 place-items-center text-muted hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11">
            +
          </button>
        </span>
      </div>
      <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
        {Array.from({ length: slots }, (_, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            onClick={() => {
              target.current = i;
              input.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              void put(i, [...e.dataTransfer.files]);
            }}
            className={`grid aspect-[4/5] w-[104px] shrink-0 snap-start place-items-center rounded-[10px] border border-dashed text-center transition-colors disabled:opacity-60 ${over === i ? "border-brand-text bg-brand-soft" : "border-line hover:border-brand-text/60 hover:bg-brand-soft/40"}`}
            aria-label={`Add card ${i + 1}`}
          >
            <span className="grid gap-1 text-faint">
              <span className="text-lg leading-none">+</span>
              <span className="text-[11px]">Card {i + 1}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-faint">{busy ? "Uploading…" : "Pick a card's file, or drop them all on this row to fill the cards in order. Each one uploads as it lands."}</p>
    </div>
  );
}
