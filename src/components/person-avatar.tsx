"use client";

import Link from "next/link";
import { initials } from "@/lib/initials";
import { peopleKey, usePeople } from "@/lib/people-context";

// One avatar for a person everywhere: their picture when they have one (from their profile), else initials on one quiet
// tint picked from their name, so faces are easy to tell apart in lists. `link`: opens their profile.
const TINTS = ["#b21e2c", "#7a4f9a", "#2f6f8f", "#3f7d5a", "#9a6a2f", "#5a5a8f", "#8f3f6a"];

export function PersonAvatar({ name, size = 32, muted = false, src, link = false }: { name: string; size?: number; muted?: boolean; src?: string | null; link?: boolean }) {
  const person = usePeople().get(peopleKey(name));
  const url = src === undefined ? (person?.url ?? null) : src;
  const tint = TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
  const face = url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" style={{ width: size, height: size }} className={`shrink-0 rounded-full object-cover ${muted ? "opacity-60 grayscale" : ""}`} />
  ) : (
    <span
      aria-hidden
      style={{ width: size, height: size, background: muted ? "var(--surface-2)" : tint, fontSize: size * 0.36 }}
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${muted ? "text-faint" : "text-white"}`}
    >
      {initials(name) || "?"}
    </span>
  );
  if (!link || !person) return face;
  return (
    <Link href={`/profile/${person.id}`} aria-label={`${person.display}'s profile`} className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-brand/60">
      {face}
    </Link>
  );
}
