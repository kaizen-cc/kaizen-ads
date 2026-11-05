"use client";

import type { ReactNode } from "react";
import { pushParams, useParam } from "@/lib/url-state";

// Settings › AI agents › Knowledge: what the agents know at a glance (the hero), what needs someone, then one section
// at a time behind tabs (in the address, so back returns to the tab you were on). Details stay inside each section.

export type KnowledgeTab = "strategy" | "files" | "looms" | "buyer";
export type KnowledgeHero = {
  spineAt: string | null;
  shared: number;
  files: number;
  looms: { read: number; clients: number; method: number; queue: number };
  buyer: { points: number; meta: number; google: number; skillsAt: string | null };
  needs: { decide: number; conflicts: number; failed: number; firstConflict: string | null };
};

const TABS: { key: KnowledgeTab; label: string }[] = [
  { key: "strategy", label: "Strategy" },
  { key: "files", label: "Files" },
  { key: "looms", label: "Loom videos" },
  { key: "buyer", label: "Senior buyer" },
];

const ago = (iso: string | null) => {
  if (!iso) return "not yet";
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const n = (x: number) => x.toLocaleString();

export function KnowledgeShell({ hero, strategy, files, looms, buyer }: { hero: KnowledgeHero; strategy: ReactNode; files: ReactNode; looms: ReactNode; buyer: ReactNode }) {
  const raw = useParam("kn");
  const tab: KnowledgeTab = TABS.some((t) => t.key === raw) ? (raw as KnowledgeTab) : "strategy";
  const go = (k: KnowledgeTab, extra: Record<string, string | null> = {}) => pushParams({ kn: k === "strategy" ? null : k, ...extra });
  const badge: Partial<Record<KnowledgeTab, number>> = { looms: hero.needs.decide, buyer: hero.needs.conflicts };

  const tiles: { key: KnowledgeTab; label: string; value: string; sub: string }[] = [
    { key: "strategy", label: "Strategy", value: n(hero.shared), sub: `shared playbooks · spine ${ago(hero.spineAt)}` },
    { key: "files", label: "Files", value: n(hero.files), sub: "PDFs and docs every agent reads" },
    { key: "looms", label: "Loom videos", value: n(hero.looms.read), sub: `${n(hero.looms.method)} teach the buyers · ${n(hero.looms.clients)} filed to clients` },
    { key: "buyer", label: "Senior buyer", value: n(hero.buyer.points), sub: `buying points · ${n(hero.buyer.meta)} Meta, ${n(hero.buyer.google)} Google` },
  ];
  const needs = [
    hero.needs.conflicts > 0 && { text: `${n(hero.needs.conflicts)} contradiction${hero.needs.conflicts === 1 ? "" : "s"} to settle`, tone: "brand", go: () => go("buyer", { conflict: hero.needs.firstConflict }) },
    hero.needs.decide > 0 && { text: `${n(hero.needs.decide)} Loom${hero.needs.decide === 1 ? "" : "s"} need a decision`, tone: "warn", go: () => go("looms", { lt: "decide" }) },
    hero.needs.failed > 0 && { text: `${n(hero.needs.failed)} couldn't be read`, tone: "bad", go: () => go("looms", { lt: "failed" }) },
  ].filter(Boolean) as { text: string; tone: "brand" | "warn" | "bad"; go: () => void }[];

  return (
    <div className="grid min-w-0 gap-6">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 py-6 md:px-8 md:py-8">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full bg-brand/20 blur-[110px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-36 -left-20 -z-10 h-72 w-72 rounded-full bg-ok/10 blur-[110px]" />
        <div className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">What the agents know</p>
            <h2 className="max-w-3xl font-heading text-[26px] leading-[1.15] md:text-[34px]">
              Kaizen&apos;s strategy, {n(hero.shared + hero.files)} playbooks and files, and the senior buyer&apos;s {n(hero.looms.method)} Looms in {n(hero.buyer.points)} buying points.
            </h2>
            {hero.looms.queue > 0 && (
              <p className="flex items-center gap-2 text-[12.5px] text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
                Reading {n(hero.looms.queue)} more Loom{hero.looms.queue === 1 ? "" : "s"} now
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => go(t.key)}
                aria-current={tab === t.key ? "true" : undefined}
                className={`group grid min-h-[96px] content-between gap-2 rounded-[18px] border p-3.5 text-left transition-colors md:p-4 ${tab === t.key ? "border-faint/50 bg-surface" : "border-line bg-surface/40 hover:bg-surface/70"}`}
              >
                <span className="text-[11.5px] text-faint">{t.label}</span>
                <span className="tabular font-display text-[28px] leading-none md:text-[32px]">{t.value}</span>
                <span className="line-clamp-2 text-[11.5px] leading-snug text-muted">{t.sub}</span>
              </button>
            ))}
          </div>
          {needs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Needs you</span>
              {needs.map((x) => (
                <button
                  key={x.text}
                  type="button"
                  onClick={x.go}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-opacity hover:opacity-85 md:min-h-9 ${x.tone === "brand" ? "bg-brand-soft text-brand-text" : x.tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}
                >
                  {x.text}
                  <span aria-hidden>→</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Knowledge">
        <div className="flex shrink-0 gap-1 rounded-full border border-line bg-surface p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => go(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors md:h-9 ${tab === t.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {badge[t.key] ? <span className={`tabular rounded-full px-1.5 text-[11px] ${tab === t.key ? "bg-bg/20" : "bg-brand-soft text-brand-text"}`}>{badge[t.key]}</span> : null}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0">{tab === "strategy" ? strategy : tab === "files" ? files : tab === "looms" ? looms : buyer}</div>
    </div>
  );
}
