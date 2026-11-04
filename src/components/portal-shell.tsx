"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandSwitcher, type BrandLink } from "@/components/brand-switcher";

// The client portal's frame, on every page of it. On a computer: a sidebar (the brand, every section, who's signed in)
// and a wide page beside it. On a phone: a slim bar on top and the sections as an app's tab bar along the bottom.

type Item = { href: string; label: string; icon: string; badge?: number | null };

const ICONS: Record<string, string> = {
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z",
  chart: "M4 19h16 M7 16V10 M12 16V6 M17 16v-4",
  approve: "M5 12l4 4 10-10",
  setup: "M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.7 7.1 18.2l.9-5.5-4-3.9 5.5-.8z",
  plan: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8v4l3 2",
  report: "M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h6",
  chat: "M4 5h16v11H9l-5 4z M8 10h8 M8 13h5",
};

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

export function PortalShell({
  slug,
  brand,
  brands,
  who,
  team,
  live,
  waiting,
  setup,
  plan,
  chat = null,
  children,
}: {
  slug: string;
  brand: string;
  brands: BrandLink[];
  who: string | null;
  team: boolean;
  live: boolean;
  /** Ads waiting on them (the badge on Home) */
  waiting: number;
  setup: boolean;
  plan: boolean;
  /** Their team chat (their Slack channel with us), when it's set up: messages from us they haven't read */
  chat?: { unread: number } | null;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const items: Item[] = [
    { href: `/c/${slug}`, label: "Home", icon: "home", badge: waiting || null },
    ...(chat ? [{ href: `/c/${slug}/chat`, label: "Chat", icon: "chat", badge: path.endsWith("/chat") ? null : chat.unread || null }] : []),
    { href: `/c/${slug}/dashboard`, label: "Dashboard", icon: "chart" },
    { href: `/c/${slug}/reports`, label: "Reports", icon: "report" },
    ...(setup ? [{ href: `/c/${slug}/start`, label: "Setup", icon: "setup" }] : []),
    ...(plan ? [{ href: `/c/${slug}/plan`, label: "How we see you", icon: "plan" }] : []),
  ];
  const on = (href: string) => path === href;

  return (
    <div className="min-h-screen bg-bg lg:pl-[264px]">
      {team && (
        <div className="sticky top-0 z-40 bg-brand px-4 py-2 text-center text-[12px] leading-relaxed text-white lg:ml-0">
          {live ? "You're seeing the portal as the client does." : `${brand}'s portal isn't live: they can't sign in or see any of this, and nothing is sent to them.`} <b>What you do here is real.</b>{" "}
          <Link href={`/clients/${slug}`} className="underline underline-offset-2">
            Back to the client
          </Link>
        </div>
      )}

      {/* Computer: the sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-r border-line bg-surface/60 px-4 pb-5 pt-6 backdrop-blur-xl lg:flex">
        <div className="flex items-center gap-2 px-2">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-brand font-heading text-[15px] text-white">K</span>
          <span className="font-heading text-[15px]">Kaizen</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted">Client portal</span>
        </div>
        <div className="mt-6 rounded-[16px] border border-line bg-bg px-3 py-2.5">
          <BrandSwitcher current={{ name: brand, slug }} brands={brands} />
        </div>
        <nav className="mt-5 grid gap-1" aria-label="Your portal">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className={`flex h-11 items-center gap-3 rounded-[12px] px-3 text-[14px] transition-colors ${on(i.href) ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
              <Icon name={i.icon} />
              <span className="flex-1">{i.label}</span>
              {i.badge ? <span className={`tabular grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold ${on(i.href) ? "bg-brand text-white" : "bg-brand text-white"}`}>{i.badge}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-2 border-t border-line pt-4">
          {who && <p className="truncate px-2 text-[13px] text-muted">{who}</p>}
          {team ? (
            <Link href={`/clients/${slug}`} className="px-2 text-[12.5px] text-faint hover:text-fg">
              ← Back to Kaizen Ads
            </Link>
          ) : (
            <form action="/auth/signout" method="post">
              <button className="px-2 text-[12.5px] text-faint hover:text-fg">Sign out</button>
            </form>
          )}
        </div>
      </aside>

      {/* Phone: the bar on top */}
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-xl lg:hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <BrandSwitcher current={{ name: brand, slug }} brands={brands} />
          {team ? (
            <Link href={`/clients/${slug}`} className="inline-flex min-h-11 items-center text-[12.5px] text-muted">
              Kaizen Ads
            </Link>
          ) : (
            <form action="/auth/signout" method="post">
              <button className="min-h-11 text-[12.5px] text-muted">Sign out</button>
            </form>
          )}
        </div>
      </header>

      {/* The dashboard takes the whole width (its conversation docks beside it) */}
      {/* The chat fills the screen between the bars, like a messaging app */}
      <div
        className={`mx-auto w-full px-4 md:px-8 ${path.endsWith("/chat") ? "max-w-[1400px] pb-[calc(58px+env(safe-area-inset-bottom))] pt-0 lg:py-6" : `pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 lg:pb-16 ${path.endsWith("/dashboard") ? "max-w-[1680px] lg:pt-6" : "max-w-6xl lg:pt-10"}`}`}
      >
        {children}
      </div>

      {/* Phone: the tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden" aria-label="Your portal">
        <div className="mx-auto flex max-w-md">
          {items.map((i) => (
            <Link key={i.href} href={i.href} className={`relative flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] ${on(i.href) ? "text-fg" : "text-faint"}`}>
              <Icon name={i.icon} className={on(i.href) ? "text-brand-text" : ""} />
              <span className="max-w-full truncate px-1">{i.label === "How we see you" ? "Your plan" : i.label}</span>
              {i.badge ? <span className="tabular absolute right-[calc(50%-20px)] top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[9.5px] font-semibold text-white">{i.badge}</span> : null}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
