"use client";

import { useState } from "react";

/** Where an ad's picture is kept for good (Meta's own links expire): /api/ad-media/<ad id> */
export const adMediaUrl = (adId: string | null | undefined) => (adId && /^\d{5,25}$/.test(adId) ? `/api/ad-media/${adId}` : null);

/**
 * An ad's picture that never shows broken: the link we have first, and when it fails to load (an expired Meta link) or
 * there's none, the kept copy of the ad's current picture. Lazy, so a long list doesn't fetch everything at once.
 */
export function AdImg({ src, adId, className = "", alt = "" }: { src: string | null | undefined; adId?: string | null; className?: string; alt?: string }) {
  const kept = adMediaUrl(adId);
  const [failed, setFailed] = useState(false);
  const url = !src || failed ? kept : src;
  if (!url) return <span className={`block bg-ink/10 ${className}`} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => !failed && kept && setFailed(true)} className={className} />
  );
}
