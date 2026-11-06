"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { RefThumb } from "@/components/ref-thumb";
import { SaveIdeaStar } from "@/components/save-idea-star";
import { linkPreviews } from "@/app/(team)/requests/new/saved-actions";
import { LINK_LABEL, linkKind, linkSaveInput, linksIn, type LinkPreview } from "@/lib/saved-references";

// Any link as a reference, wherever a brief is made (the quick preview, talk it through, Ready to send): paste a Motion
// share link, a Pinterest pin, an Instagram or TikTok post, an Ad Library ad, a YouTube video or any page, and it shows
// as a card with its title and picture (read on the server), with a star to save it for later for the client.

const cache = new Map<string, LinkPreview>();
const asked = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** A plain card for a link while (or when) its preview can't be read */
export const bareLink = (url: string): LinkPreview => {
  let site = url;
  try {
    site = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const kind = linkKind(url);
  return { url, kind, title: null, subtitle: null, thumbnail: null, site: kind === "link" ? site : LINK_LABEL[kind], adId: null };
};

/** Previews for these links: shown at once as plain cards, filled in when the server has read them */
export function useLinkPreviews(urls: string[]): LinkPreview[] {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const key = urls.join("\n");
  useEffect(() => {
    const missing = key.split("\n").filter((u) => u && !asked.has(u));
    if (!missing.length) return;
    missing.forEach((u) => asked.add(u));
    linkPreviews(missing)
      .then((list) => {
        list.forEach((p) => cache.set(p.url, p));
        emit();
      })
      .catch(() => missing.forEach((u) => asked.delete(u)));
  }, [key]);
  return urls.map((u) => cache.get(u) ?? bareLink(u));
}

/** One link as a card: picture, where it's from, its title; a star saves it for later for the client */
export function LinkCard({ preview, clientId, clientName, onRemove, size = "md" }: { preview: LinkPreview; clientId?: string | null; clientName?: string; onRemove?: () => void; size?: "sm" | "md" }) {
  const w = size === "sm" ? "w-[132px]" : "w-[150px]";
  return (
    <li className={`group relative grid ${w} shrink-0 snap-start content-start overflow-hidden rounded-[14px] border border-line bg-bg`}>
      <a href={preview.url} target="_blank" rel="noreferrer" className="relative block aspect-[4/5] overflow-hidden bg-gradient-to-br from-surface-2 to-surface" aria-label={`Open ${preview.title ?? preview.site}`}>
        {preview.thumbnail ? (
          <RefThumb src={preview.thumbnail} hoverZoom={false} />
        ) : (
          <span className="absolute inset-0 grid place-items-center p-3 text-center">
            <span className="grid gap-1">
              <span className="font-heading text-[15px] leading-tight">{preview.site}</span>
              {preview.adId && <span className="tabular text-[11px] text-faint">Ad {preview.adId}</span>}
            </span>
          </span>
        )}
        <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10.5px] text-white">{LINK_LABEL[preview.kind]}</span>
      </a>
      <span className="grid gap-0.5 p-2">
        <span className="line-clamp-2 text-[12px] font-medium leading-snug">{preview.title ?? preview.site}</span>
        {preview.subtitle && <span className="truncate text-[11px] text-faint">{preview.subtitle}</span>}
      </span>
      {clientId && (
        <span className="absolute bottom-[54px] right-1.5">
          <SaveIdeaStar idea={linkSaveInput(preview)} clientId={clientId} clientName={clientName} variant="overlay" size="sm" />
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${preview.site}`} className="absolute right-1.5 top-1.5 grid h-11 w-11 place-items-center rounded-full bg-black/55 text-white backdrop-blur hover:bg-black/75 md:h-8 md:w-8">
          ✕
        </button>
      )}
    </li>
  );
}

/** The links as cards, side by side (scrolls on a phone) */
export function LinkCards({ urls, clientId, clientName, onRemove, size }: { urls: string[]; clientId?: string | null; clientName?: string; onRemove?: (url: string) => void; size?: "sm" | "md" }) {
  const previews = useLinkPreviews(urls);
  if (!previews.length) return null;
  return (
    <ul className="-mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
      {previews.map((p) => (
        <LinkCard key={p.url} preview={p} clientId={clientId} clientName={clientName} size={size} onRemove={onRemove ? () => onRemove(p.url) : undefined} />
      ))}
    </ul>
  );
}

/** Paste any link (or several): each becomes a reference card. Enter or paste adds it */
export function LinkInput({ onAdd, placeholder = "Paste any link: Motion, Pinterest, Instagram, TikTok, Ad Library, YouTube, a page" }: { onAdd: (urls: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const found = linksIn(text);
  const add = (from = text) => {
    const urls = linksIn(from);
    if (!urls.length) return;
    onAdd(urls);
    setText("");
  };
  return (
    <div className="flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (linksIn(pasted).length) {
            e.preventDefault();
            add(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        inputMode="url"
        placeholder={placeholder}
        aria-label="Add a reference link"
        className="h-11 min-w-0 flex-1 rounded-[12px] border border-line bg-bg/60 px-3.5 text-[16px] outline-none placeholder:text-faint focus:border-brand/60 md:text-[14px]"
      />
      <button type="button" onClick={() => add()} disabled={!found.length} className="min-h-11 shrink-0 rounded-full bg-fg px-4 text-[13.5px] text-bg disabled:opacity-40">
        Add
      </button>
    </div>
  );
}
