"use client";

import { useState } from "react";
import { adMediaUrl } from "@/components/ad-img";

// A reference's picture that never shows broken. In order: the link we have (Motion keeps its own copies; Meta's
// fbcdn links expire within days), then the app's kept copy of a Meta ad (/api/ad-media/<ad id>), then a video's first
// frame, and when there's truly nothing, a quiet placeholder that says what it is. Fills its (relative) parent.

type Fmt = "image" | "video" | "carousel";

export function RefThumb({ src, adId, video, format, hoverZoom = true }: { src: string | null | undefined; adId?: string | null; video?: string | null; format?: Fmt | null; hoverZoom?: boolean }) {
  const kept = adMediaUrl(adId);
  const tries = [src, kept && `${kept}?strict=1`].filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);
  const [at, setAt] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  const url = tries[at];
  const zoom = hoverZoom ? "transition duration-500 group-hover:scale-[1.03]" : "";
  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- ad pictures from Motion, Meta or the kept copy
      <img src={url} alt="" loading="lazy" decoding="async" onError={() => setAt((i) => i + 1)} className={`absolute inset-0 h-full w-full object-cover ${zoom}`} />
    );
  if (video && !videoFailed) return <video src={`${video}#t=0.5`} muted playsInline preload="metadata" onError={() => setVideoFailed(true)} className="absolute inset-0 h-full w-full object-cover" />;
  return (
    <span className="absolute inset-0 grid place-items-center bg-gradient-to-br from-surface-2 to-surface">
      <span className="grid justify-items-center gap-2 text-faint">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {format === "video" ? (
            <>
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="m10 9.5 4.5 2.5-4.5 2.5z" />
            </>
          ) : (
            <>
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="m21 16-5-5-8 8" />
            </>
          )}
        </svg>
        <span className="text-[11.5px]">No preview</span>
      </span>
    </span>
  );
}
