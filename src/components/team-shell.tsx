"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PersonAvatar } from "@/components/person-avatar";

type Tier = "exec" | "lead" | "member";
type Item = { href: string; label: string; icon: string; tiers?: Tier[] };

const I = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  next: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  clients: "M4 20V8l8-5 8 5v12M9 20v-6h6v6",
  kpis: "M4 19h16M6 15l4-5 3 3 5-7",
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
  const nav = [...groups.flatMap((g) => g.items), ...(settings ? [settings] : [])];
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
        <Link href={home} className="flex items-center gap-2 px-5 pb-6 pt-6">
          <Image src="/kaizen-logo.png" alt="Kaizen" width={110} height={26} priority />
          <span className="mt-1 font-display text-sm tracking-wide text-muted">ads</span>
        </Link>
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

      {/* Phones: compact top bar with the same sections */}
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href={home} className="flex items-center gap-2">
            <Image src="/kaizen-logo.png" alt="Kaizen" width={96} height={22} />
            <span className="mt-1 font-display text-xs tracking-wide text-muted">ads</span>
          </Link>
          <PersonAvatar name={name} size={30} />
        </div>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Main">
          {nav.map((item) => (
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
