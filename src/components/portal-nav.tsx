"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The client portal's sections, the same bar on every page of it: their dashboard, the ads waiting on them, their
// setup (while onboarding) and how we see them (once it's been sent).

export function PortalNav({ slug, setup = false, plan = false }: { slug: string; setup?: boolean; plan?: boolean }) {
  const path = usePathname();
  const items = [
    { href: `/c/${slug}/dashboard`, label: "Dashboard" },
    { href: `/c/${slug}`, label: "Approvals" },
    ...(setup ? [{ href: `/c/${slug}/start`, label: "Setup" }] : []),
    ...(plan ? [{ href: `/c/${slug}/plan`, label: "How we see you" }] : []),
  ];
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]" aria-label="Your portal">
      {items.map((i) => {
        const on = path === i.href;
        return (
          <Link key={i.href} href={i.href} className={`relative inline-flex h-11 shrink-0 items-center px-3 text-[13.5px] transition-colors ${on ? "text-fg" : "text-muted hover:text-fg"}`}>
            {i.label}
            {on && <span className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-brand" />}
          </Link>
        );
      })}
    </nav>
  );
}
