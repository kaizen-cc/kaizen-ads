"use client";

import { RefThumb } from "@/components/ref-thumb";
import type { Reference } from "@/lib/ai-tools/motion";

// The live market ads the strategist brought up in Talk it through (from Motion, the client's own market only), as small
// reference cards under its message: the ad's picture, the brand, how long it has run, its hook, and "Add to brief".

export function MarketRefCards({ refs, added, onAdd }: { refs: Reference[]; added: string[]; onAdd: (url: string) => void }) {
  if (!refs.length) return null;
  return (
    <ul className="-mx-1 flex max-w-full snap-x gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]" aria-label="Live ads from their market">
      {refs.map((r) => {
        const has = added.includes(r.url);
        return (
          <li key={r.id} className="grid w-[136px] shrink-0 snap-start content-start overflow-hidden rounded-[14px] border border-line bg-bg">
            <a href={r.url} target="_blank" rel="noreferrer" className="relative block aspect-[4/5] overflow-hidden bg-gradient-to-br from-surface-2 to-surface" aria-label={`Open ${r.brand}'s ad`}>
              {r.thumb ? <RefThumb src={r.thumb} hoverZoom={false} /> : <span className="absolute inset-0 grid place-items-center p-2 text-center font-heading text-[14px]">{r.brand}</span>}
              <span className="absolute left-1.5 top-1.5 rounded-full bg-black/65 px-2 py-0.5 text-[10px] text-white">{r.video ? "Video" : "Motion"}</span>
            </a>
            <span className="grid gap-0.5 px-2 pt-1.5">
              <span className="truncate text-[12px] font-medium">{r.brand}</span>
              <span className="truncate text-[11px] text-faint">{r.days ? `Running ${r.days} days${r.proven ? " · proven" : ""}` : r.proven ? "Proven" : "Live now"}</span>
              {r.hook && <span className="line-clamp-2 text-[11px] leading-snug text-muted">&ldquo;{r.hook}&rdquo;</span>}
            </span>
            <button
              type="button"
              onClick={() => !has && onAdd(r.url)}
              disabled={has}
              className={`m-1.5 min-h-11 rounded-full px-2 text-[12px] font-medium md:min-h-8 ${has ? "text-ok" : "border border-line text-fg hover:border-faint"}`}
            >
              {has ? "Added ✓" : "Add to brief"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
