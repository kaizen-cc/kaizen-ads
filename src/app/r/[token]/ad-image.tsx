"use client";

import { useState } from "react";

/** An ad's image; ad CDN links expire, so a broken one quietly leaves the placeholder. */
export function AdImage({ src, top = false }: { src: string | null; /** Keep the top of a tall picture (an email) in view */ top?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`absolute inset-0 h-full w-full object-cover ${top ? "object-top" : ""}`} />;
}
