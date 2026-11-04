"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motionReferences } from "@/app/(team)/media-actions";
import type { Reference } from "@/lib/ai-tools/motion";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// "References from Motion": the market ads Motion's sync keeps (the client's competitors and comparable brands
// first, proven runs first), searchable by words and format. Picking one adds it to the brief's references or a
// shot. A sheet (bottom sheet on phones) that lives in the URL, so Back closes it.

export function MotionReferences({ clientId, name, onPick, picked = [], label = "References from Motion", compact = false }: { clientId: string; name: string; onPick: (r: Reference) => Promise<{ ok: true } | { ok: false; error: string }>; picked?: string[]; label?: string; compact?: boolean }) {
  const open = useParam("refs") === name;
  return (
    <>
      <button
        type="button"
        onClick={() => pushParams({ refs: name })}
        className={compact ? "text-[11px] text-faint hover:text-fg max-md:py-2" : "inline-flex h-9 items-center gap-2 rounded-full border border-line px-3.5 text-xs text-muted transition-colors hover:text-fg max-md:h-11"}
      >
        {!compact && <span aria-hidden className="h-2 w-2 rounded-full bg-[#8b7cf6]" />}
        {label}
      </button>
      {open && <Sheet clientId={clientId} onPick={onPick} picked={picked} onClose={() => closeParams("refs")} />}
    </>
  );
}

function Sheet({ clientId, onPick, picked, onClose }: { clientId: string; onPick: (r: Reference) => Promise<{ ok: true } | { ok: false; error: string }>; picked: string[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<"image" | "video" | null>(null);
  const [refs, setRefs] = useState<Reference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(() => new Set(picked));
  const [adding, setAdding] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        void motionReferences(clientId, { search: query, format }).then((r) => {
          if (!live) return;
          if (r.ok) {
            setRefs(r.refs);
            setError(null);
          } else setError(r.error);
        }),
      query ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [clientId, query, format]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus();
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const pick = async (r: Reference) => {
    setAdding(r.id);
    const res = await onPick(r);
    setAdding(null);
    if (!res.ok) return setError(res.error);
    setAdded((s) => new Set(s).add(r.url));
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 backdrop-blur-[2px] md:items-center md:p-6" onClick={onClose}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="References from Motion"
        onClick={(e) => e.stopPropagation()}
        className="grid max-h-[88dvh] w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-[20px] border border-line bg-bg shadow-2xl outline-none md:max-w-[880px] md:rounded-[18px]"
      >
        <div className="grid gap-3 border-b border-line px-4 pb-3 pt-3 md:px-6 md:pt-5">
          <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-line md:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <h2 className="font-heading text-[18px]">References from Motion</h2>
              <p className="text-xs text-muted">US ads running in their market: competitors and comparable brands first, the longest-running first.</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:bg-surface hover:text-fg md:h-9 md:w-9">
              ×
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search: testimonial, unboxing, before and after…"
              className="h-11 min-w-0 flex-1 basis-60 rounded-full border border-line bg-surface px-4 text-sm outline-none focus:border-brand-text/60 md:h-10"
            />
            <div className="flex rounded-full bg-surface-2 p-1">
              {([null, "image", "video"] as const).map((f) => (
                <button key={f ?? "all"} type="button" onClick={() => setFormat(f)} className={`h-9 rounded-full px-3.5 text-xs transition-colors md:h-8 ${format === f ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {f === null ? "All" : f === "image" ? "Images" : "Videos"}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-xs text-bad">{error}</p>}
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 py-4 md:px-6">
          {refs === null ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <li key={i} className="aspect-[4/5] animate-pulse rounded-[12px] bg-surface-2" />
              ))}
            </ul>
          ) : !refs.length ? (
            <p className="py-10 text-center text-sm text-muted">{query || format ? "Nothing matches. Try other words." : "No market ads for this client yet. Motion's sync fills this in (Settings › Sync health)."}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {refs.map((r) => {
                const on = added.has(r.url);
                return (
                  <li key={r.id} className="grid content-start overflow-hidden rounded-[12px] border border-line bg-surface">
                    <a href={r.url} target="_blank" rel="noreferrer" className="relative block aspect-[4/5] bg-surface-2">
                      {r.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element -- an ad thumbnail from Meta's CDN
                        <img src={r.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <span className="grid h-full place-items-center text-xs text-faint">{r.video ? "Video" : "Ad"}</span>
                      )}
                      <span className="absolute left-2 top-2 flex gap-1">
                        {r.video && <span className="rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">Video</span>}
                        {r.days != null && <span className={`rounded-full px-2 py-0.5 text-[10px] text-white ${r.proven ? "bg-ok/90" : "bg-black/60"}`}>{r.days}d live</span>}
                      </span>
                    </a>
                    <div className="grid gap-1 p-2.5">
                      <p className="truncate text-[12.5px] font-medium">{r.brand}</p>
                      {(r.hook || r.headline) && <p className="line-clamp-2 text-[11.5px] leading-snug text-muted">{r.hook ?? r.headline}</p>}
                      {r.angle && <p className="truncate text-[10.5px] text-faint">{r.angle}</p>}
                      <button
                        type="button"
                        disabled={on || adding === r.id}
                        onClick={() => void pick(r)}
                        className={`mt-1 h-9 rounded-full text-xs transition-colors max-md:h-11 ${on ? "bg-ok-soft text-ok" : "bg-fg text-bg hover:opacity-90 disabled:opacity-60"}`}
                      >
                        {on ? "Added" : adding === r.id ? "Adding…" : "Add"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
