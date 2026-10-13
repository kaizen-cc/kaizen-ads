"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/pipeline", label: "Pipeline" },
  { href: "/clients", label: "Clients" },
  { href: "/team", label: "Team" },
];

const LATER: NavItem[] = [
  { href: "#", label: "My work", soon: true },
  { href: "#", label: "Client queue", soon: true },
  { href: "#", label: "Launch queue", soon: true },
  { href: "#", label: "AI instructions", soon: true },
];

export function TeamShell({ name, roles, children }: { name: string; roles: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="pt-safe hidden border-r border-line bg-surface md:flex md:min-h-screen md:flex-col">
        <Link href="/pipeline" className="flex items-center gap-2 px-5 py-5">
          <Image src="/kaizen-logo.png" alt="Kaizen" width={96} height={22} />
          <span className="mt-0.5 font-heading text-xs tracking-wide text-muted">ads</span>
        </Link>
        <nav className="grid gap-0.5 px-3" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active(item.href) ? "page" : undefined}
              className={`rounded-brand px-3 py-2 text-sm ${active(item.href) ? "bg-brand-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
            >
              {item.label}
            </Link>
          ))}
          <p className="mt-5 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Coming next</p>
          {LATER.map((item) => (
            <span key={item.label} className="flex items-center justify-between rounded-brand px-3 py-2 text-sm text-faint">
              {item.label}
            </span>
          ))}
        </nav>
        <div className="mt-auto border-t border-line px-5 py-4">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-faint">{roles}</p>
          <form action="/auth/signout" method="post" className="mt-2">
            <button className="text-xs text-muted hover:text-fg">Sign out</button>
          </form>
        </div>
      </aside>

      {/* Phones: compact top bar with the same sections */}
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-surface md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/pipeline" className="flex items-center gap-2">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={84} height={20} />
            <span className="mt-0.5 font-heading text-xs text-muted">ads</span>
          </Link>
          <form action="/auth/signout" method="post">
            <button className="text-xs text-muted">Sign out</button>
          </form>
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${active(item.href) ? "bg-brand text-white" : "text-muted"}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="min-w-0 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
