"use client";

import type { ReactNode } from "react";
import { accessCounts, MetaAccessProvider, useMetaAccess } from "@/components/audience-terms";
import { pushParams, useParam } from "@/lib/url-state";

// Settings › Sync health: health at a glance (the hero), then one section at a time behind a segmented control (in the
// address, so back returns to the section you were on). Meta access is checked once for the hero and its section.

export type SyncView = "syncs" | "meta" | "google" | "writes";
export type SyncHero = { healthy: number; behind: number; failing: number; total: number; latest: string | null; metaSandbox: boolean; googleOn: boolean };

const VIEWS: { key: SyncView; label: string }[] = [
  { key: "syncs", label: "Syncs" },
  { key: "meta", label: "Meta access" },
  { key: "google", label: "Google" },
  { key: "writes", label: "Writes settings" },
];

export function SyncShell(props: { hero: SyncHero; syncs: ReactNode; meta: ReactNode; google: ReactNode; writes: ReactNode }) {
  return (
    <MetaAccessProvider>
      <Shell {...props} />
    </MetaAccessProvider>
  );
}

function Shell({ hero, syncs, meta, google, writes }: { hero: SyncHero; syncs: ReactNode; meta: ReactNode; google: ReactNode; writes: ReactNode }) {
  const raw = useParam("view");
  const view: SyncView = VIEWS.some((v) => v.key === raw) ? (raw as SyncView) : "syncs";
  const go = (k: SyncView, extra: Record<string, string | null> = {}) => pushParams({ view: k === "syncs" ? null : k, ...extra });
  const access = useMetaAccess();
  const data = access?.data ?? null;
  const counts = data ? accessCounts(data.rows) : null;
  const tokenMissing = data?.tokenMissing ?? [];

  const needs = [
    hero.failing > 0 && { text: `${hero.failing} ${hero.failing === 1 ? "sync" : "syncs"} failing`, tone: "bad", go: () => go("syncs") },
    hero.behind > 0 && { text: `${hero.behind} ${hero.behind === 1 ? "sync" : "syncs"} behind`, tone: "warn", go: () => go("syncs") },
    tokenMissing.length > 0 && { text: `Token missing ${tokenMissing.length} ${tokenMissing.length === 1 ? "permission" : "permissions"}`, tone: "bad", go: () => go("meta") },
    counts && counts.problems > 0 && { text: `${counts.problems} Meta ${counts.problems === 1 ? "account" : "accounts"} can't take every change`, tone: "warn", go: () => go("meta", { groups: null, q: null, live: null }) },
  ].filter(Boolean) as { text: string; tone: "bad" | "warn"; go: () => void }[];
  const calm = !needs.length && Boolean(data);

  const tiles: { key: SyncView; label: string; value: ReactNode; sub: string; tone: "ok" | "warn" | "bad" | "muted" }[] = [
    {
      key: "syncs",
      label: "Syncs",
      value: (
        <>
          {hero.healthy}
          <span className="text-faint">/{hero.total}</span>
        </>
      ),
      sub: hero.failing || hero.behind ? `${hero.behind} behind · ${hero.failing} failing` : "all on schedule",
      tone: hero.failing ? "bad" : hero.behind ? "warn" : "ok",
    },
    {
      key: "meta",
      label: "Meta access",
      value: counts ? (
        <>
          {counts.ready}
          <span className="text-faint">/{counts.total}</span>
        </>
      ) : (
        <span className="inline-block h-7 w-16 animate-pulse rounded-md bg-surface-2 align-middle" />
      ),
      sub: counts ? (counts.problems ? `ready · ${counts.problems} need a fix` : "ready for changes") : access?.error ? "couldn't check" : "checking with Meta…",
      tone: !counts ? "muted" : counts.by.none ? "bad" : counts.problems ? "warn" : "ok",
    },
    {
      key: "google",
      label: "Google writes",
      value: hero.googleOn ? "On" : "Off",
      sub: hero.googleOn ? "confirmed changes go in" : "planned and checked only",
      tone: "muted",
    },
    {
      key: "writes",
      label: "Meta writes",
      value: hero.metaSandbox ? "Sandbox" : "Live",
      sub: !data ? "token: checking…" : tokenMissing.length ? `token missing ${tokenMissing.join(", ")}` : "token has every permission",
      tone: tokenMissing.length ? "bad" : "muted",
    },
  ];
  const dot = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", muted: "bg-faint" } as const;
  const badge: Partial<Record<SyncView, number>> = { syncs: hero.failing + hero.behind, meta: counts?.problems ?? 0 };

  return (
    <div className="grid min-w-0 gap-6">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 py-6 md:px-8 md:py-8">
        <span aria-hidden className={`pointer-events-none absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full blur-[110px] ${hero.failing ? "bg-bad/15" : needs.length ? "bg-warn/15" : "bg-ok/15"}`} />
        <span aria-hidden className="pointer-events-none absolute -bottom-36 -left-20 -z-10 h-72 w-72 rounded-full bg-brand/10 blur-[110px]" />
        <div className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Sync health</p>
            <h2 className="max-w-3xl font-heading text-[26px] leading-[1.15] md:text-[34px]">
              {calm ? "Everything's syncing, and every account is ready." : needs.length ? `${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you.` : "Everything's syncing."}
            </h2>
            <p className="text-[13px] text-muted">{hero.latest ? `Last activity ${hero.latest}.` : "Nothing has run yet."} Each source runs on its own schedule; Sync now runs one right away.</p>
          </div>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => go(t.key)}
                aria-current={view === t.key ? "true" : undefined}
                className={`grid min-h-[104px] min-w-0 content-between gap-2 rounded-[18px] border p-3.5 text-left transition-colors md:p-4 ${view === t.key ? "border-faint/50 bg-surface" : "border-line bg-surface/40 hover:bg-surface/70"}`}
              >
                <span className="flex items-center gap-2 text-[11.5px] text-faint">
                  <span className={`h-1.5 w-1.5 rounded-full ${dot[t.tone]}`} aria-hidden />
                  {t.label}
                </span>
                <span className="tabular font-display text-[26px] leading-none md:text-[30px]">{t.value}</span>
                <span className="line-clamp-2 text-[11.5px] leading-snug text-muted [overflow-wrap:anywhere]">{t.sub}</span>
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
                  className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-opacity hover:opacity-85 md:min-h-9 ${x.tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}
                >
                  {x.text}
                  <span aria-hidden>→</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <nav className="no-scrollbar -mx-4 flex overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Sync health">
        <div className="flex shrink-0 gap-1 rounded-full border border-line bg-surface p-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => go(v.key)}
              aria-current={view === v.key ? "page" : undefined}
              className={`inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm transition-colors md:h-9 ${view === v.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {v.label}
              {badge[v.key] ? <span className={`tabular rounded-full px-1.5 text-[11px] ${view === v.key ? "bg-bg/20" : "bg-warn-soft text-warn"}`}>{badge[v.key]}</span> : null}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0">{view === "syncs" ? syncs : view === "meta" ? meta : view === "google" ? google : writes}</div>
    </div>
  );
}
