"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NotificationBell } from "./notification-bell";
import { PersonAvatar } from "@/components/person-avatar";

type Tier = "exec" | "lead" | "member";
type Item = { href: string; label: string; icon: string; tiers?: Tier[] };

const I = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  next: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  clients: "M4 20V8l8-5 8 5v12M9 20v-6h6v6",
  kpis: "M4 19h16M6 15l4-5 3 3 5-7",
  reports: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4",
  ideas: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2h5c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z",
  lab: "M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10",
};

// Two groups: the day-to-day work, and where ideas come from. Settings sits at the bottom, by your name.
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Work",
    items: [
      { href: "/pipeline", label: "Overview", icon: I.home, tiers: ["exec", "lead"] },
      { href: "/next", label: "Next for me", icon: I.next, tiers: ["lead", "member"] },
      { href: "/board", label: "Board", icon: I.board },
      { href: "/clients", label: "Clients", icon: I.clients },
      { href: "/kpis", label: "KPIs", icon: I.kpis },
      { href: "/reports", label: "Reports", icon: I.reports },
    ],
  },
  {
    title: "Ideas",
    items: [
      { href: "/ideas", label: "Ideas", icon: I.ideas },
      { href: "/lab", label: "Ads Lab", icon: I.lab, tiers: ["exec", "lead"] },
    ],
  },
];
// Execs and leads: AI agents, the team, sync health, errors and the data under the hood
const SETTINGS: Item = { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", tiers: ["exec", "lead"] };

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function TeamShell({ name, roles, tier, children }: { name: string; roles: string; tier: Tier; children: React.ReactNode }) {
  const path = usePathname();
  const can = (i: Item) => !i.tiers || i.tiers.includes(tier);
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(can) }));
  const settings = can(SETTINGS) ? SETTINGS : null;
  // The tab bar on phones: home (Overview or Next for me), the board, clients and KPIs; everything else is in the menu
  const all = groups.flatMap((g) => g.items);
  const tabs = [all.find((i) => i.href === "/pipeline" || i.href === "/next"), ...["/board", "/clients", "/kpis"].map((h) => all.find((i) => i.href === h))].filter((i): i is Item => Boolean(i)).slice(0, 4);
  const [menu, setMenu] = useState(false);
  // The menu closes on its own when the page changes, and the page behind doesn't scroll while it's open
  const [seenPath, setSeenPath] = useState(path);
  if (seenPath !== path) {
    setSeenPath(path);
    setMenu(false);
  }
  useEffect(() => {
    if (!menu) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const home = tier === "member" ? "/next" : "/pipeline";
  // Winners and Market live under Ideas; Team under Settings
  const active = (href: string) =>
    path === href || path.startsWith(`${href}/`) || (href === "/ideas" && (path.startsWith("/winners") || path.startsWith("/market"))) || (href === "/settings" && path.startsWith("/team"));
  const link = (item: Item) => {
    const on = active(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={on ? "page" : undefined}
        className={`relative flex items-center gap-3 rounded-brand px-3 py-2.5 text-sm transition-colors ${on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg"}`}
      >
        {on && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" />}
        <Icon d={item.icon} />
        {item.label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="pt-safe hidden border-r border-line bg-surface md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="flex items-center justify-between gap-2 pb-6 pl-5 pr-3 pt-6">
          <Link href={home} className="flex items-center gap-2">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={110} height={26} priority />
            <span className="mt-1 font-display text-sm tracking-wide text-muted">ads</span>
          </Link>
          <NotificationBell placement="side" />
        </div>
        <nav className="grid gap-5 px-3" aria-label="Main">
          {groups.map((g) => (
            <div key={g.title} className="grid gap-0.5">
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{g.title}</p>
              {g.items.map(link)}
            </div>
          ))}
        </nav>
        {settings && <div className="mt-auto px-3 pb-2">{link(settings)}</div>}
        <div className={`${settings ? "" : "mt-auto "}flex items-center gap-3 border-t border-line px-4 py-4`}>
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

      {/* Phones: an app's top bar (menu, logo, notifications) */}
      <header className="pt-safe sticky top-0 z-30 border-b border-line/70 bg-bg/85 backdrop-blur-xl md:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-2">
          <button type="button" onClick={() => setMenu(true)} aria-label="Open the menu" aria-expanded={menu} className="grid h-11 w-11 place-items-center rounded-full text-fg active:bg-surface-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h10" />
            </svg>
          </button>
          <Link href={home} className="flex items-center gap-1.5">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={92} height={21} priority />
            <span className="mt-1 font-display text-xs tracking-wide text-muted">ads</span>
          </Link>
          <span className="flex h-11 w-11 items-center justify-center">
            <NotificationBell placement="top" />
          </span>
        </div>
      </header>

      {/* Phones: the menu, sliding in from the left like an app's */}
      {menu && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close the menu" onClick={() => setMenu(false)} className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[sheet-fade_.2s_ease-out]" />
          <aside className="pt-safe pb-safe absolute inset-y-0 left-0 flex w-[84%] max-w-[320px] flex-col border-r border-line bg-surface shadow-2xl animate-[drawer-left_.25s_cubic-bezier(.2,.8,.2,1)]">
            <div className="flex items-center justify-between gap-2 px-5 pb-5 pt-5">
              <Link href={home} className="flex items-center gap-2" onClick={() => setMenu(false)}>
                <Image src="/kaizen-logo.png" alt="Kaizen" width={104} height={24} />
                <span className="mt-1 font-display text-sm tracking-wide text-muted">ads</span>
              </Link>
              <button type="button" onClick={() => setMenu(false)} aria-label="Close the menu" className="grid h-10 w-10 place-items-center rounded-full text-muted active:bg-surface-2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <nav className="grid flex-1 content-start gap-6 overflow-y-auto px-3" aria-label="Main">
              {groups.map((g) => (
                <div key={g.title} className="grid gap-1">
                  <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">{g.title}</p>
                  {g.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMenu(false)}
                      aria-current={active(item.href) ? "page" : undefined}
                      className={`flex min-h-12 items-center gap-3.5 rounded-[12px] px-3 text-[15px] transition-colors ${active(item.href) ? "bg-surface-2 text-fg" : "text-muted active:bg-surface-2/60"}`}
                    >
                      <span className={active(item.href) ? "text-brand-text" : ""}>
                        <Icon d={item.icon} />
                      </span>
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
              {settings && (
                <Link
                  href={settings.href}
                  onClick={() => setMenu(false)}
                  className={`flex min-h-12 items-center gap-3.5 rounded-[12px] px-3 text-[15px] ${active(settings.href) ? "bg-surface-2 text-fg" : "text-muted active:bg-surface-2/60"}`}
                >
                  <Icon d={settings.icon} />
                  {settings.label}
                </Link>
              )}
            </nav>
            <div className="flex items-center gap-3 border-t border-line px-5 py-4">
              <PersonAvatar name={name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="truncate text-xs text-faint">{roles}</p>
              </div>
              <form action="/auth/signout" method="post">
                <button className="min-h-10 rounded-full border border-line px-3 text-xs text-muted active:bg-surface-2">Sign out</button>
              </form>
            </div>
          </aside>
        </div>
      )}

      {/* Phones: the tab bar, the places used most, always under the thumb */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line/70 bg-bg/90 backdrop-blur-xl md:hidden" aria-label="Tabs">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((item) => {
            const on = active(item.href);
            return (
              <Link key={item.href} href={item.href} aria-current={on ? "page" : undefined} className={`flex h-[58px] flex-col items-center justify-center gap-1 text-[10.5px] ${on ? "text-fg" : "text-faint active:text-muted"}`}>
                <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${on ? "bg-brand/15 text-brand-text" : ""}`}>
                  <Icon d={item.icon} />
                </span>
                {item.label}
              </Link>
            );
          })}
          <button type="button" onClick={() => setMenu(true)} className="flex h-[58px] flex-col items-center justify-center gap-1 text-[10.5px] text-faint active:text-muted">
            <span className="grid h-7 w-12 place-items-center rounded-full">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                <path d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </span>
            More
          </button>
        </div>
      </nav>

      {/* A faint brand glow behind the top of every page */}
      <main className="relative isolate min-w-0 overflow-x-clip px-4 pb-[calc(88px+env(safe-area-inset-bottom))] pt-6 md:px-10 md:py-8">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(60%_100%_at_15%_0%,rgba(178,30,44,0.16),transparent_70%)]" />
        {children}
      </main>
    </div>
  );
}
