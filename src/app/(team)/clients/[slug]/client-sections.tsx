"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClientTabs, type ClientTab } from "./client-tabs";

// The client page in two levels: the whole business first (every service they buy, side by side), then one service at
// a time (Meta, Google, Creative…), each with the tabs that matter for it. Both live in the address (?service=&tab=),
// so a link or a refresh lands in the same place.

export type ServiceSection = {
  id: string;
  label: string;
  /** How it's doing, as a dot on the switch */
  tone?: "bad" | "warn" | "ok" | null;
  note?: string | null;
  tabs: ClientTab[];
};

// Links from before services had their own sections (?tab=creative…)
const LEGACY: Record<string, string> = { creative: "creative" };

const read = (ids: string[]) => {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  const s = p.get("service") ?? LEGACY[p.get("tab") ?? ""] ?? null;
  return s && ids.includes(s) ? s : null;
};

const DOT = { bad: "bg-[#ff4d5e]", warn: "bg-[#f2b14c]", ok: "bg-[#5be3a5]" } as const;

export function ClientSections({ sections }: { sections: ServiceSection[] }) {
  const ids = sections.map((s) => s.id);
  const [open, setOpen] = useState(sections[0]?.id);
  // A link on the page to another service (?service=…) switches to it without a reload
  const query = useSearchParams().toString();
  useEffect(() => {
    const list = sections.map((s) => s.id);
    const t = setTimeout(() => {
      setOpen(read(list) ?? list[0]);
    }, 0);
    const onPop = () => setOpen(read(list) ?? list[0]);
    window.addEventListener("popstate", onPop);
    return () => {
      clearTimeout(t);
      window.removeEventListener("popstate", onPop);
    };
  }, [sections, query]);

  /** Open a service (from the switch, or a card on the whole-business view) */
  const choose = (id: string) => {
    if (!ids.includes(id)) return;
    setOpen(id);
    const u = new URL(window.location.href);
    if (id === ids[0]) u.searchParams.delete("service");
    else u.searchParams.set("service", id);
    u.searchParams.delete("tab");
    window.history.pushState(null, "", u);
    document.querySelector("[data-service-switch]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Cards and links anywhere on the page open a service with this event
  useEffect(() => {
    const on = (e: Event) => choose((e as CustomEvent<string>).detail);
    window.addEventListener("kz:service", on);
    return () => window.removeEventListener("kz:service", on);
  });

  const current = sections.find((s) => s.id === open) ?? sections[0];
  if (!current) return null;
  return (
    <div className="grid gap-5">
      <div data-service-switch className="no-scrollbar -mx-4 flex scroll-mt-20 gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Services">
        {sections.map((s, i) => {
          const on = s.id === current.id;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => choose(s.id)}
              className={`flex min-h-12 shrink-0 items-center gap-2.5 rounded-[14px] border px-4 text-left transition-colors md:min-h-11 ${
                on ? "border-fg bg-fg text-bg" : "border-line bg-surface/60 text-muted hover:border-faint hover:text-fg"
              } ${i === 0 ? "font-medium" : ""}`}
            >
              {s.tone && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.tone]}`} />}
              <span className="grid">
                <span className="text-sm leading-tight">{s.label}</span>
                {s.note && <span className={`text-[11px] leading-tight ${on ? "text-bg/60" : "text-faint"}`}>{s.note}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <ClientTabs key={current.id} tabs={current.tabs} />
    </div>
  );
}

/** Opens a service section from anywhere on the page (a card on the whole-business view) */
export function OpenService({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("kz:service", { detail: id }))} className={className}>
      {children}
    </button>
  );
}
