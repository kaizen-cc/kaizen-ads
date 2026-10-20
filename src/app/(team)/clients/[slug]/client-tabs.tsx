"use client";

import { useEffect, useState } from "react";

// The client page's sections as tabs: the overview a buyer or exec reads in a few minutes first, and everything else
// (creative, what the AI knows, the team and setup) one click away. The open tab is kept in the address (?tab=), so
// a link or a refresh lands on it.

export type ClientTab = { id: string; label: string; hint?: string; count?: number | null; content: React.ReactNode };

const read = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab"));

export function ClientTabs({ tabs }: { tabs: ClientTab[] }) {
  const [open, setOpen] = useState(tabs[0]?.id);
  useEffect(() => {
    const t = setTimeout(() => {
      const want = read();
      if (want && tabs.some((x) => x.id === want)) setOpen(want);
    }, 0);
    const onPop = () => setOpen(read() ?? tabs[0]?.id);
    window.addEventListener("popstate", onPop);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", onPop);
    };
  }, [tabs]);
  const choose = (id: string) => {
    setOpen(id);
    const u = new URL(window.location.href);
    if (id === tabs[0]?.id) u.searchParams.delete("tab");
    else u.searchParams.set("tab", id);
    window.history.pushState(null, "", u);
  };
  const current = tabs.find((t) => t.id === open) ?? tabs[0];
  return (
    <div className="grid gap-6">
      <nav className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-line bg-bg/85 px-1 backdrop-blur-md" role="tablist">
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
              className={`relative flex shrink-0 items-center gap-2 px-3.5 py-3 text-sm transition-colors ${on ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.count ? <span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] text-faint">{t.count}</span> : null}
              {on && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
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
