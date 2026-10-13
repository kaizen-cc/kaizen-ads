"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PersonAvatar } from "@/components/person-avatar";

const NAV = [
  { href: "/pipeline", label: "Home", icon: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { href: "/clients", label: "Clients", icon: "M4 20V8l8-5 8 5v12M9 20v-6h6v6" },
  { href: "/team", label: "Team", icon: "M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6m10 9v-1a4 4 0 0 0-3-3.9M15 4.1a3 3 0 0 1 0 5.8" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function TeamShell({ name, roles, children }: { name: string; roles: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="pt-safe hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <Link href="/pipeline" className="flex items-center gap-2 px-5 pb-6 pt-6">
          <Image src="/kaizen-logo.png" alt="Kaizen" width={110} height={26} priority />
          <span className="mt-1 font-display text-sm tracking-wide text-muted">ads</span>
        </Link>
        <nav className="grid gap-0.5 px-3" aria-label="Main">
          {NAV.map((item) => {
            const on = active(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={`relative flex items-center gap-3 rounded-brand px-3 py-2.5 text-sm transition-colors ${
                  on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg"
                }`}
              >
                {on && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
                <Icon d={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex items-center gap-3 border-t border-line px-4 py-4">
          <PersonAvatar name={name} size={34} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-faint">{roles}</p>
          </div>
          <form action="/auth/signout" method="post">
            <button className="rounded-brand px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">Sign out</button>
          </form>
        </div>
      </aside>

      {/* Phones: compact top bar with the same sections */}
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/pipeline" className="flex items-center gap-2">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={96} height={22} />
            <span className="mt-1 font-display text-xs tracking-wide text-muted">ads</span>
          </Link>
          <PersonAvatar name={name} size={30} />
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${active(item.href) ? "bg-fg text-bg" : "text-muted"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      {/* A faint brand glow behind the top of every page */}
      <main className="relative isolate min-w-0 overflow-x-clip px-4 py-8 md:px-10">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(60%_100%_at_15%_0%,rgba(178,30,44,0.16),transparent_70%)]" />
        {children}
      </main>
    </div>
  );
}
