"use client";

import { closeParams, pushParams, useParam } from "@/lib/url-state";

// A section on the Knowledge tab folded down to its title and description; clicking the title opens it. The panel
// inside is the usual one (its header becomes the fold's header), and stays mounted while folded so nothing it's
// doing is lost. One section is open at a time, and which one lives in the address (?fold=), so back closes it.

export function Fold({ id, children }: { id: string; children: React.ReactNode }) {
  const open = useParam("fold") === id;
  const toggle = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // Only the panel's header toggles it, and not its own buttons and links (Refresh now and the like)
    if (!t.closest("section > div:first-of-type") || t.closest("button, a, input, select, textarea, label, summary")) return;
    if (open) closeParams("fold");
    else pushParams({ fold: id });
  };
  return (
    <div
      onClick={toggle}
      className={`relative [&>section>div:first-of-type]:cursor-pointer [&>section>div:first-of-type]:pr-8 ${
        open ? "" : "[&>section>*:not(div:first-of-type):not([aria-hidden])]:hidden [&>section>div:first-of-type_p]:line-clamp-1 [&>section]:transition-colors [&>section]:hover:border-faint/60"
      }`}
    >
      {children}
      <span aria-hidden className={`pointer-events-none absolute right-5 top-6 text-[18px] leading-none text-faint transition-transform md:right-6 ${open ? "rotate-90" : ""}`}>
        ›
      </span>
    </div>
  );
}
