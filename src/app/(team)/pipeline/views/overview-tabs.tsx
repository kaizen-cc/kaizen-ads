"use client";

import { useEffect, useState } from "react";
import { tintFor } from "@/lib/colors";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { Blocks } from "./exec-home";
import { BLOCK_TONE } from "./exec-blocks";

/** What each panel block holds, in one line */
const PANEL_BLURB: Record<string, string> = {
  clients: "Your clients, worst first",
  accounts: "Your ad accounts against target",
  ideas: "Ideas and briefs for your clients",
  audits: "Audits and sprints",
  setup: "Clients still to connect",
  team: "Every teammate's plate",
  tracking: "Every paid-ads client's tracking health",
  desk: "Your board: what's waiting on you",
  plates: "Who's on what",
};

// The Overview in a few tabs (Today, Clients, Ideas, Audits and sprints, Setup: what fits the role), so each part is a
// short, actionable page instead of one endless scroll. The open tab lives in the address (?tab=), so back returns to
// the tab you were on and a link lands on it. Today's section cards (the exec Overview's look) jump to a tab.

type Tone = "bad" | "warn" | "ok" | "brand" | "quiet";
const COUNT: Record<Tone, string> = { bad: "bg-bad-soft text-bad", warn: "bg-warn-soft text-warn", ok: "bg-ok-soft text-ok", brand: "bg-brand-soft text-brand-text", quiet: "bg-ink/[0.06] text-muted" };
const ACCENT: Record<Tone, string> = { bad: "var(--color-bad)", warn: "var(--color-warn)", ok: "var(--color-ok)", brand: "var(--color-brand-text)", quiet: "var(--color-muted)" };

/** The tab strip and the open tab's panel. `follow`: a param that belongs to a tab (an open theme), so it opens there */
export function OverviewTabs({ tabs, panels, follow, initial, asBlocks = false, skip = [] }: { tabs: { id: string; label: string; count?: number; tone?: Tone }[]; panels: Record<string, React.ReactNode>; follow?: Record<string, string>; initial?: string; /** Everyone's Overview (Nov 23 2026): each tab as a designed block that opens in place */ asBlocks?: boolean; skip?: string[] }) {
  const asked = useParam("tab");
  const followed = useFollowed(follow);
  // `initial`: the tab it opens on without ?tab= (an exec's: the one holding the most critical thing)
  const home = tabs.find((t) => t.id === initial)?.id ?? tabs[0]?.id;
  const current = tabs.find((t) => t.id === asked)?.id ?? followed ?? home;
  // Older links point at /pipeline#next (Next for me): open the tab that holds it
  const hasWork = tabs.some((t) => t.id === "work");
  useEffect(() => {
    if (hasWork && window.location.hash === "#next" && !new URLSearchParams(window.location.search).get("tab")) replaceParams({ tab: "work" });
  }, [hasWork]);
  if (asBlocks)
    return (
      <Blocks
        blocks={tabs
          .filter((t) => !skip.includes(t.id) && panels[t.id] != null)
          .map((t) => ({ id: `p-${t.id}`, label: t.label, blurb: PANEL_BLURB[t.id] ?? "Open it here", tone: BLOCK_TONE[t.id] ?? BLOCK_TONE.panel, panel: panels[t.id], ...(t.count ? { count: t.count } : {}) }))}
      />
    );
  return (
    <div className="grid gap-6">
      <nav role="tablist" aria-label="Overview" className="no-scrollbar sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 flex gap-1 overflow-x-auto border-b border-line bg-bg/85 px-4 py-2 backdrop-blur-md md:mx-0 md:rounded-full md:border md:top-3 md:w-fit md:max-w-full md:bg-surface/80 md:p-1">
        {tabs.map((t) => {
          const on = t.id === current;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                pushParams({ tab: t.id === home ? null : t.id, theme: null, ideas: null });
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] transition-colors md:min-h-9 ${on ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.count != null && t.count > 0 && <span className={`tabular rounded-full px-1.5 py-px text-[11px] ${on ? "bg-bg/20 text-bg" : COUNT[t.tone ?? "quiet"]}`}>{t.count}</span>}
            </button>
          );
        })}
      </nav>
      <div key={current} role="tabpanel" className="grid gap-6" style={{ animation: "ov-tab-in .3s cubic-bezier(.2,.8,.2,1) both" }}>
        <style>{`@keyframes ov-tab-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }`}</style>
        {panels[current ?? ""] ?? null}
      </div>
    </div>
  );
}

function useFollowed(follow?: Record<string, string>) {
  // Hooks run unconditionally: read every param a tab can be followed by (at most a couple)
  const theme = useParam("theme");
  if (!follow) return null;
  if (theme && follow.theme) return follow.theme;
  return null;
}

/**
 * Today's section cards: one per tab, the exec Overview's lit cards made small. Each is one number, one line and a
 * couple of points; a tap opens that tab.
 */
export function TabCards({ cards }: { cards: { tab: string; title: string; count: number; tone: Tone; headline: string; points?: string[] }[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c, i) => {
        const calm = c.count === 0;
        const accent = calm ? ACCENT.ok : ACCENT[c.tone];
        return (
          <button
            key={`${c.tab}-${i}`}
            type="button"
            onClick={() => {
              pushParams({ tab: c.tab });
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            style={{ ["--accent" as string]: accent, animation: `ov-card-in .45s ${0.05 * i}s cubic-bezier(.2,.8,.2,1) both` }}
            className="group relative isolate grid min-h-[150px] content-between gap-4 overflow-hidden rounded-[22px] border border-ink/[0.07] bg-deep p-5 text-left shadow-[0_24px_60px_-40px_rgba(0,0,0,0.8)] transition duration-300 hover:-translate-y-0.5 hover:border-ink/15"
          >
            <style>{`@keyframes ov-card-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }`}</style>
            <span aria-hidden className={`pointer-events-none absolute -left-14 -top-20 -z-10 h-[200px] w-[200px] rounded-full blur-[70px] transition-opacity duration-500 group-hover:opacity-60 ${calm ? "opacity-20" : "opacity-40"}`} style={{ background: "var(--accent)" }} />
            <span aria-hidden className="pointer-events-none absolute inset-x-5 top-0 -z-10 h-px opacity-60" style={{ background: "linear-gradient(90deg, var(--accent), transparent)" }} />
            <span className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.16em] text-ink/60">{c.title}</span>
              <span className="grid h-8 w-8 place-items-center rounded-full border border-ink/10 text-ink/50 transition duration-300 group-hover:translate-x-0.5 group-hover:border-ink/30 group-hover:text-fg">→</span>
            </span>
            <span className="grid gap-2.5">
              <span className="flex items-end gap-3">
                <span className="tabular font-display text-5xl leading-none tracking-tight" style={{ color: "var(--accent)" }}>
                  {calm ? "✓" : c.count}
                </span>
                <span className="min-w-0 pb-1 text-[14px] leading-snug text-ink/80">{c.headline}</span>
              </span>
              {c.points && c.points.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {c.points.slice(0, 3).map((p) => (
                    <span key={p} className="max-w-full truncate rounded-full bg-ink/[0.06] px-2.5 py-1 text-[11px] text-ink/65">
                      {p}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A client's logo on a chip that keeps it readable in either theme, or their initial in their colour */
export function BrandChip({ name, color, logo, light, size = "md" }: { name: string; color: string | null; logo: string | null; light: boolean; size?: "sm" | "md" }) {
  const [ok, setOk] = useState(Boolean(logo));
  const tint = color ?? tintFor(name);
  const box = size === "sm" ? "h-8 min-w-8 rounded-[8px]" : "h-10 min-w-10 rounded-[10px]";
  if (ok && logo)
    return (
      // A white logo on dark, any other on white: the logo's own colours never disappear into the theme
      <span className={`grid ${box} max-w-[88px] shrink-0 place-items-center overflow-hidden px-1.5 ring-1 ring-line ${light ? "bg-[#111]" : "bg-white"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a small, cached logo from our own address */}
        <img src={logo} alt="" loading="lazy" decoding="async" onError={() => setOk(false)} className={`${size === "sm" ? "max-h-5" : "max-h-6"} w-auto max-w-[76px] object-contain`} />
      </span>
    );
  return (
    <span className={`grid ${box} shrink-0 place-items-center font-heading ${size === "sm" ? "text-sm" : "text-base"}`} style={{ background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint }}>
      {name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "·"}
    </span>
  );
}

/** My work under the day, for the views that keep it in Today instead of its own tab (the ads lines) */
export function WorkUnderToday({ children }: { children: React.ReactNode }) {
  return (
    <section id="my-work" className="grid scroll-mt-24 gap-3">
      <h2 className="font-heading text-xl">My work</h2>
      {children}
    </section>
  );
}
