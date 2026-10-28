"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type BrandLink = { name: string; slug: string };

import { initials } from "@/lib/initials";
export { initials };

export function BrandAvatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

/** The client name in the header. With several brands it opens a menu to switch. */
export function BrandSwitcher({ current, brands }: { current: BrandLink; brands: BrandLink[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  if (brands.length <= 1) {
    return (
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <BrandAvatar name={current.name} />
        <span className="truncate">{current.name}</span>
      </span>
    );
  }

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 font-medium"
      >
        <BrandAvatar name={current.name} />
        <span className="truncate">{current.name}</span>
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0 text-faint"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-10 z-30 w-64 rounded-brand border border-line bg-surface-2 p-1.5 shadow-2xl">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Your brands</p>
          {brands.map((b) => (
            <Link
              key={b.slug}
              role="menuitem"
              href={`/c/${b.slug}`}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2 rounded-brand px-2 py-2 text-sm hover:bg-surface ${b.slug === current.slug ? "text-fg" : "text-muted"}`}
            >
              <BrandAvatar name={b.name} size={24} />
              <span className="truncate">{b.name}</span>
              {b.slug === current.slug && <span className="ml-auto text-xs text-brand-text">●</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
