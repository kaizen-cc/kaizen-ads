"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

// The client page's sections as tabs: the overview a buyer or exec reads in a few minutes first, and everything else
// (creative, what the AI knows, the team and setup) one click away. The open tab is kept in the address (?tab=), so
// a link or a refresh lands on it.

export type ClientTab = { id: string; label: string; hint?: string; count?: number | null; content: React.ReactNode };

const read = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab"));

export function ClientTabs({ tabs }: { tabs: ClientTab[] }) {
  const [open, setOpen] = useState(tabs[0]?.id);
  const query = useSearchParams().toString();
  useEffect(() => {
    const t = setTimeout(() => {
      const want = read();
      setOpen(want && tabs.some((x) => x.id === want) ? want : tabs[0]?.id);
    }, 0);
    const onPop = () => setOpen(read() ?? tabs[0]?.id);
    window.addEventListener("popstate", onPop);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", onPop);
    };
  }, [tabs, query]);
  const choose = (id: string) => {
    setOpen(id);
    const u = new URL(window.location.href);
    if (id === tabs[0]?.id) u.searchParams.delete("tab");
    else u.searchParams.set("tab", id);
    window.history.pushState(null, "", u);
  };
  const current = tabs.find((t) => t.id === open) ?? tabs[0];
  // Phones: the tabs are a row of pills that scrolls sideways; keep the open one in view
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = strip.current;
    const on = nav?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!nav || !on || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
  }, [current?.id]);
  return (
    <div className="grid gap-6">
      <nav
        ref={strip}
        className="no-scrollbar sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto border-b border-line bg-bg/85 px-4 py-2 backdrop-blur-md md:top-0 md:-mx-1 md:snap-none md:gap-1 md:px-1 md:py-0"
        role="tablist"
      >
        {tabs.map((t) => {
          const on = t.id === current?.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => choose(t.id)}
              title={t.hint}
              className={`relative flex h-11 shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-auto md:rounded-none md:bg-transparent md:px-3.5 md:py-3 ${on ? "bg-fg text-bg md:text-fg" : "bg-surface-2/70 text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.count ? <span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] text-faint">{t.count}</span> : null}
              {on && <span className="absolute inset-x-2 -bottom-px hidden h-0.5 rounded-full bg-brand md:block" />}
            </button>
          );
        })}
      </nav>
      <div key={current?.id} role="tabpanel" style={{ animation: "tab-in .25s ease-out both" }}>
        <style>{`@keyframes tab-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }`}</style>
        {current?.content}
      </div>
    </div>
  );
}
