"use client";

import { useRef, useState } from "react";

export type Box = { x: number; y: number; w: number; h: number };
export type CanvasPin = { id: string; box: Box; n: number; tone: "ai" | "team" | "client" | "fix" | "watch"; label: string; active?: boolean };
export type CanvasLink = { label: string; url: string; box: Box | null };

const TONE: Record<CanvasPin["tone"], string> = {
  ai: "border-[#8b9cf7] bg-[#8b9cf7]/15",
  fix: "border-bad bg-bad/15",
  watch: "border-warn bg-warn/15",
  team: "border-fg/70 bg-fg/10",
  client: "border-brand-text bg-brand/15",
};
const DOT: Record<CanvasPin["tone"], string> = { ai: "bg-[#8b9cf7] text-white", fix: "bg-bad text-white", watch: "bg-warn text-black", team: "bg-fg text-bg", client: "bg-brand text-white" };

/**
 * An email design with what sits on it: the notes pinned to an area (numbered), and the buttons' links drawn where the
 * buttons are. Drawing on it (drag a box, or tap for a small one) hands the area back, to pin a note or place a link.
 * The links are live for the client: tapping a button's area opens where that button goes.
 */
export function EmailDesignCanvas({
  src,
  alt,
  pins = [],
  links = [],
  drawing = false,
  onDraw,
  onPin,
  openLinks = false,
  className = "",
}: {
  src: string;
  alt: string;
  pins?: CanvasPin[];
  links?: CanvasLink[];
  /** Taps and drags draw an area instead of opening things */
  drawing?: boolean;
  onDraw?: (box: Box) => void;
  onPin?: (id: string) => void;
  /** The buttons open their links (the client's view) */
  openLinks?: boolean;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) };
  };
  const box = draft ? { x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) } : null;
  return (
    <div
      ref={wrap}
      className={`relative select-none overflow-hidden rounded-[14px] border border-line bg-surface-2 ${drawing ? "cursor-crosshair touch-none" : ""} ${className}`}
      onPointerDown={(e) => {
        if (!drawing) return;
        const p = at(e);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!draft) return;
        const p = at(e);
        setDraft({ ...draft, x1: p.x, y1: p.y });
      }}
      onPointerUp={() => {
        if (!draft || !box) return;
        setDraft(null);
        // A tap makes a small area around the spot
        const b = box.w < 2 && box.h < 1 ? { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 1.5), w: 8, h: 3 } : box;
        onDraw?.(b);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage link at its own size */}
      <img src={src} alt={alt} className="block h-auto w-full" draggable={false} />
      {links.map((l, i) =>
        l.box ? (
          openLinks && l.url && !drawing ? (
            <a
              key={`l${i}`}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${l.label}: ${l.url}`}
              style={{ left: `${l.box.x}%`, top: `${l.box.y}%`, width: `${l.box.w}%`, height: `${l.box.h}%` }}
              className="absolute rounded-[6px] outline outline-2 outline-offset-2 outline-transparent transition hover:outline-ok/70 focus-visible:outline-ok"
            >
              <span className="sr-only">{l.label}</span>
            </a>
          ) : (
            <span key={`l${i}`} style={{ left: `${l.box.x}%`, top: `${l.box.y}%`, width: `${l.box.w}%`, height: `${l.box.h}%` }} className="pointer-events-none absolute rounded-[6px] border-2 border-dashed border-ok bg-ok/10">
              <span className="absolute -top-5 left-0 max-w-[160px] truncate rounded-full bg-ok px-1.5 text-[10px] font-semibold leading-4 text-white">{l.label}</span>
            </span>
          )
        ) : null,
      )}
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPin?.(p.id);
          }}
          onPointerDown={(e) => drawing || e.stopPropagation()}
          title={p.label}
          style={{ left: `${p.box.x}%`, top: `${p.box.y}%`, width: `${Math.max(p.box.w, 2)}%`, height: `${Math.max(p.box.h, 1)}%` }}
          className={`absolute rounded-[6px] border-2 transition ${TONE[p.tone]} ${p.active ? "ring-2 ring-fg/60" : ""} ${drawing ? "pointer-events-none" : ""}`}
        >
          <span className={`absolute -left-2.5 -top-2.5 grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold shadow ${DOT[p.tone]}`}>{p.n}</span>
        </button>
      ))}
      {box && <span style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }} className="pointer-events-none absolute rounded-[6px] border-2 border-brand-text bg-brand/10" />}
    </div>
  );
}
