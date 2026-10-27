"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketAd } from "@/lib/market";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { ClientPick, SHEET_BACKDROP, SHEET_PANEL, SheetAction, SheetBar, Writing, type PickClient } from "../winners/winners-library";
import { briefFromMarket, clientMarket } from "./actions";
import { ClientSearch } from "./client-search";
import { FilterMenu as Menu, FilterPill as Pill } from "@/components/filters";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { MarketHoverCard, MarketPreview, MarketReadPanel, useMarketRead } from "./market-preview";

type View = "all" | "proven" | "fresh" | "testing";
const VIEWS: [View, string, string][] = [
  ["all", "Everything live", ""],
  ["proven", "Proven", "Still running after 30+ days"],
  ["fresh", "New this week", "Launched in the last 7 days"],
  ["testing", "Being tested", "Brands launching 3+ ads in two weeks"],
];
const FORMATS = ["image", "video", "carousel"] as const;
const WRITING = ["Reading why this ad works", "Reading the client: brand, offer, memory, allotment", "Translating the angle and the hook", "Writing the concepts", "Fitting formats to what's left this month"];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);

/**
 * The market: live Meta ads from brands in every industry we serve, pulled from Motion. Filter by industry and by
 * what's proven, new or being tested; open one to watch it, and brief a client on it with the Motion link attached.
 */
export function MarketLibrary({
  ads,
  industries,
  verticals = [],
  clients,
  brands,
  connected,
  lastSync,
  canConnect,
  startClient,
}: {
  ads: MarketAd[];
  industries: readonly (readonly [string, string])[];
  verticals?: { id: string; name: string; parent: string }[];
  clients: PickClient[];
  brands: number;
  connected: boolean;
  lastSync: string | null;
  canConnect: boolean;
  /** The client in a link, found by its slug (the address keeps the slug) */
  startClient: string | null;
}) {
  // For a client: the brands matched to them from their client page (competitors first, then lookalikes from any
  // industry), so the list is what they can actually learn from, not everything in a broad industry
  // The client, filters and the open ad are in the address (?client=&industry=&view=&format=&ad=), so back and
  // forward step through them and a link opens the same list. A client's page links by slug: the server resolved it.
  const wantClient = useParam("client");
  const forId = clients.some((c) => c.id === wantClient) ? wantClient : wantClient ? startClient : null;
  const forClient = clients.find((c) => c.id === forId) ?? null;
  const industry = useParam("industry");
  const setIndustry = (v: string | null) => pushParams({ industry: v });
  const [clientAds, setClientAds] = useState<{ id: string; ads: MarketAd[] } | null>(null);
  const pickClient = (id: string | null) => pushParams({ client: id, industry: null });
  useEffect(() => {
    if (!forId) return;
    let live = true;
    clientMarket(forId).then((list) => live && setClientAds({ id: forId, ads: list }));
    return () => {
      live = false;
    };
  }, [forId]);
  const matching = Boolean(forId) && clientAds?.id !== forId;
  const pool = useMemo(() => (forId ? (clientAds?.id === forId ? clientAds.ads : []) : ads), [forId, clientAds, ads]);
  const askedView = useParam("view");
  const view: View = VIEWS.some(([k]) => k === askedView) ? (askedView as View) : "all";
  const setView = (v: View) => pushParams({ view: v === "all" ? null : v });
  const format = useParam("format");
  const setFormat = (v: string | null) => pushParams({ format: v });
  // Typing keeps the address current without an entry per key
  const [q, setQState] = useState(useParam("q") ?? "");
  const setQ = (v: string) => {
    setQState(v);
    replaceParams({ q: v.trim() ? v : null });
  };
  const openAd = useParam("ad");
  const open = ads.find((a) => a.id === openAd) ?? null;
  const setOpen = (a: MarketAd) => pushParams({ ad: a.id });
  // Hovering a card (mouse only) shows the ad as it runs, with the AI's read
  const [hover, setHover] = useState<{ a: MarketAd; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIn = (a: MarketAd, el: HTMLElement) => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover({ a, rect: el.getBoundingClientRect() }), hover ? 120 : 380);
  };
  const hoverOut = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(null), 220);
  };

  // Sub-verticals once the brands are placed in them; the broad industries until then
  const byVertical = verticals.length > 0 && ads.some((a) => a.verticalId);
  const label = (k: string | null) => (byVertical ? (verticals.find((v) => v.id === k)?.name ?? "Not placed yet") : (industries.find(([i]) => i === k)?.[1] ?? "Not sorted yet"));

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of pool) {
      const g = byVertical ? (a.verticalId ?? "") : (a.industry ?? "");
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [pool, byVertical]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = pool
      .filter((a) => industry === null || (byVertical ? (a.verticalId ?? "") : (a.industry ?? "")) === industry)
      .filter((a) => view === "all" || (view === "proven" ? a.proven : view === "fresh" ? a.fresh : a.testing))
      .filter((a) => !format || a.format === format)
      .filter((a) => !term || [a.brand, a.detail, a.headline, a.body, a.angle, a.hook, a.matchWhy, ...a.tags].some((s) => s?.toLowerCase().includes(term)));
    // A client's matches keep their ranking (most comparable brands first); otherwise by time live or newest
    if (forId) return list;
    return list.sort((a, b) => (view === "fresh" ? Date.parse(b.launchedAt ?? "0") - Date.parse(a.launchedAt ?? "0") : (b.daysActive ?? 0) - (a.daysActive ?? 0)));
  }, [pool, forId, industry, view, format, q, byVertical]);

  const proven = ads.filter((a) => a.proven).length;
  const fresh = ads.filter((a) => a.fresh).length;

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Market · from Motion</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">What&apos;s live in the market</h1>
        <p className="max-w-2xl text-sm text-muted">
          Live Meta ads from our clients&apos; competitors and the standout advertisers in every niche we serve. No numbers for other brands&apos; ads, so time is the
          signal: still paying for it after a month usually means it works.
        </p>
        {connected && (
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
            <span>
              <span className="tabular text-fg">{ads.length.toLocaleString("en-US")}</span> live ads
            </span>
            <span>
              <span className="tabular text-fg">{brands}</span> brands
            </span>
            <span>
              <span className="tabular text-ok">{proven}</span> proven
            </span>
            <span>
              <span className="tabular text-fg">{fresh}</span> new this week
            </span>
            {lastSync && <span>Synced {when(lastSync)}</span>}
          </p>
        )}
      </header>

      {!connected ? (
        <div className="grid place-items-center gap-3 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">Motion isn&apos;t connected yet</p>
          <p className="max-w-sm text-sm text-muted">Once an exec connects Kaizen&apos;s Motion account, the market fills in here every day.</p>
          {canConnect && (
            <a href="/api/motion/connect" className="mt-1 grid h-10 place-items-center rounded-brand bg-brand px-5 text-sm font-medium text-white hover:brightness-110">
              Connect Motion
            </a>
          )}
        </div>
      ) : ads.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">The first sync is running</p>
          <p className="max-w-sm text-sm text-muted">It finds the brands to watch in each industry and pulls their live ads. Give it a few minutes, then refresh.</p>
        </div>
      ) : (
        <>
          {/* Phones: it scrolls away with the page (the app bar is pinned there); wider screens keep it pinned */}
          <div className="relative z-20 grid gap-3 md:sticky md:top-3">
            <div className="rounded-[18px] border border-line bg-surface/90 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <div className="flex flex-wrap items-center gap-2 p-2">
                <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2.5 rounded-[12px] bg-bg/60 px-3.5 focus-within:ring-1 focus-within:ring-faint">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-faint" aria-hidden>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search brands, angles, hooks, copy"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                  />
                </label>
                <ClientSearch clients={clients} value={forClient} onPick={pickClient} />
                {/* Phones: each menu gets the full row, so its list opens on screen */}
                <div className="w-full md:contents">
                  <Menu
                    label={industry === null ? (byVertical ? "All verticals" : "All industries") : label(industry || null)}
                    on={industry !== null}
                    options={[[null, byVertical ? "All verticals" : "All industries", pool.length] as const, ...counts.map(([k, n]) => [k, label(k || null), n] as const)]}
                    value={industry}
                    onPick={(v) => setIndustry(v)}
                  />
                </div>
                <div className="w-full md:contents">
                  <Menu
                    label={format ? `${format[0].toUpperCase()}${format.slice(1)}s` : "Any format"}
                    on={format !== null}
                    options={[[null, "Any format", null] as const, ...FORMATS.map((f) => [f, `${f[0].toUpperCase()}${f.slice(1)}s`, null] as const)]}
                    value={format}
                    onPick={(v) => setFormat(v)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3">
                <nav className="-mb-px flex gap-1 overflow-x-auto">
                  {VIEWS.map(([k, l, hint]) => {
                    const n = k === "all" ? pool.length : pool.filter((a) => (k === "proven" ? a.proven : k === "fresh" ? a.fresh : a.testing)).length;
                    return (
                      <button
                        key={k}
                        title={hint || undefined}
                        onClick={() => setView(k)}
                        className={`flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] transition-colors ${view === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg"}`}
                      >
                        {l}
                        <span className="tabular text-[11px] text-faint">{n}</span>
                      </button>
                    );
                  })}
                </nav>
                <span className="tabular py-2 text-[11px] text-faint">
                  {shown.length.toLocaleString("en-US")} {shown.length === 1 ? "ad" : "ads"}
                </span>
              </div>
            </div>

            {(forClient || industry !== null || format || q.trim() || view !== "all") && (
              <div className="flex flex-wrap items-center gap-1.5">
                {forClient && <Pill onClear={() => pickClient(null)}>For {forClient.name}</Pill>}
                {industry !== null && <Pill onClear={() => setIndustry(null)}>{label(industry || null)}</Pill>}
                {view !== "all" && <Pill onClear={() => setView("all")}>{VIEWS.find(([k]) => k === view)?.[1]}</Pill>}
                {format && <Pill onClear={() => setFormat(null)}>{`${format[0].toUpperCase()}${format.slice(1)}s`}</Pill>}
                {q.trim() && <Pill onClear={() => setQ("")}>&ldquo;{q.trim()}&rdquo;</Pill>}
                <button
                  onClick={() => {
                    setQState("");
                    pushParams({ client: null, industry: null, view: null, format: null, q: null });
                  }}
                  className="ml-1 py-2 text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:py-0"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          {forClient && (
            <p className="-mt-2 text-sm text-muted">
              Brands comparable to <span className="text-fg">{forClient.name}</span>
              {forClient.detail ? ` (${forClient.detail.toLowerCase()})` : ""}, picked from their client page: their competitors first, then the closest lookalikes from
              any industry. Open one to brief them on it.
            </p>
          )}
          {matching ? (
            <div className="grid place-items-center gap-3 py-16 text-center">
              <span className="h-1 w-40 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
              </span>
              <p className="text-sm text-muted">Reading {forClient?.name}&apos;s page and finding the brands most like them…</p>
            </div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">{forClient ? `No live ads from brands like ${forClient.name} yet.` : "Nothing matches. Try another industry or filter."}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shown.slice(0, 240).map((a) => (
                <AdCard
                  key={a.id}
                  a={a}
                  sub={forClient && a.competitorOf.includes(forClient.id) ? `${forClient.name}'s competitor` : forClient && a.matchWhy ? `${a.brand} · ${a.matchWhy}` : (a.detail ?? label(a.industry))}
                  onOpen={() => {
                    setHover(null);
                    setOpen(a);
                  }}
                  onHover={(el) => hoverIn(a, el)}
                  onLeave={hoverOut}
                />
              ))}
            </div>
          )}
        </>
      )}

      {hover && !open && (
        <MarketHoverCard
          key={hover.a.id}
          a={hover.a}
          rect={hover.rect}
          sub={`${hover.a.brand} · ${hover.a.detail ?? label(hover.a.industry)}`}
          onEnter={() => timer.current && clearTimeout(timer.current)}
          onLeave={hoverOut}
          onOpen={() => {
            setOpen(hover.a);
            setHover(null);
          }}
        />
      )}
      {open && <MarketSheet forClient={forId ?? undefined} key={open.id} a={open} industryLabel={label(open.industry)} clients={clients} onClose={() => closeParams("ad", "brief")} />}
    </div>
  );
}

export function AdCard({ a, sub, onOpen, onHover, onLeave }: { a: MarketAd; sub: string; onOpen: () => void; onHover?: (el: HTMLElement) => void; onLeave?: () => void }) {
  const cover = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
  const video = !cover && a.media.find((m) => m.type === "video");
  return (
    <button onClick={onOpen} onMouseEnter={onHover ? (e) => onHover(e.currentTarget) : undefined} onMouseLeave={onLeave} className="group grid min-w-0 content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-all hover:border-faint active:scale-[0.98] md:active:scale-100">
      <span className="relative aspect-[4/5] overflow-hidden rounded-[10px] bg-surface-2">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        ) : video ? (
          <video src={`${video.url}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-faint">{a.headline ?? a.angle ?? a.brand}</span>
        )}
        <span className="absolute left-2 top-2 flex flex-wrap gap-1">
          {a.proven && <span className="rounded-full bg-ok px-2 py-0.5 text-[10px] font-semibold text-white shadow">{a.daysActive}d live</span>}
          {a.fresh && <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold text-white shadow">New</span>}
          {a.testing && !a.proven && <span className="rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">Testing</span>}
        </span>
        {a.format === "video" && (
          <span className="absolute bottom-2 right-2 grid h-7 w-7 place-items-center rounded-full bg-black/60 backdrop-blur">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#fff" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        )}
      </span>
      <span className="grid gap-1 px-1 pb-1">
        <span className="line-clamp-2 text-[13px] font-medium leading-snug">{a.angle ?? a.headline ?? "Untitled ad"}</span>
        <span className="truncate text-[11px] text-muted">
          {a.brand} · {sub}
        </span>
        {a.hook && <span className="line-clamp-1 text-[11px] text-faint">&ldquo;{a.hook}&rdquo;</span>}
      </span>
    </button>
  );
}


export function MarketSheet({ a, industryLabel, clients, onClose, forClient }: { a: MarketAd; industryLabel: string; clients: PickClient[]; onClose: () => void; forClient?: string }) {
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  // The written brief is a place of its own (?brief=id): back returns to the ad, forward to the brief
  const [written, setWritten] = useState<OpenSuggestion | null>(null);
  const briefId = useParam("brief");
  const brief = written && written.id === briefId ? written : null;
  const [error, setError] = useState<string | null>(null);
  const read = useMarketRead(a);

  const write = async (clientId: string) => {
    setError(null);
    setStep("writing");
    const r = await briefFromMarket(a.id, clientId);
    if (!r.ok) {
      setError(r.error);
      return setStep(forClient ? "ad" : "pick");
    }
    // Back from the brief lands on the ad again, not on the writing screen
    setStep(forClient ? "ad" : "pick");
    setWritten(r.suggestion);
    pushParams({ brief: r.suggestion.id });
  };

  if (brief) return <SuggestionSheet s={brief} onClose={onClose} />;

  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${SHEET_PANEL} md:grid-cols-[minmax(0,400px)_1fr]`}>
        <SheetBar title={a.pageName ?? a.brand} onClose={onClose} />
        {/* Phones: once a client is being picked, the ad steps aside so the list is right there */}
        <div className={`grid content-start gap-2 ${step === "ad" ? "" : "hidden md:grid"}`}>
          <MarketPreview a={a} />
        </div>

        {step === "ad" ? (
          <div className="grid min-w-0 content-start gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-1">
                <p className="text-xs text-faint">
                  {a.detail ?? industryLabel}
                  {a.detail && ` · ${industryLabel}`}
                </p>
                <p className="font-display text-xl leading-tight">{a.pageName ?? a.brand}</p>
                <p className="text-xs text-faint">
                  {a.brand}
                  {a.brandDomain && ` · ${a.brandDomain}`}
                </p>
              </div>
              <button onClick={onClose} className="hidden shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg md:block">
                Done
              </button>
            </div>

            <MarketReadPanel a={a} read={read} />

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => (forClient ? write(forClient) : setStep("pick"))}
                className="hidden h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110 md:block"
              >
                {forClient ? "Brief this client on it" : "Brief a client on this"}
              </button>
              {a.motionUrl && (
                <a href={a.motionUrl} target="_blank" rel="noreferrer" className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
                  Open in Motion ↗
                </a>
              )}
              {a.libraryUrl && (
                <a href={a.libraryUrl} target="_blank" rel="noreferrer" className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
                  Ad Library ↗
                </a>
              )}
              {a.landingUrl && (
                <a href={a.landingUrl} target="_blank" rel="noreferrer" className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
                  Landing page ↗
                </a>
              )}
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            <p className="text-[11px] text-faint">
              The strategist writes the whole request from what makes this ad work, fitted to the client. The {a.motionUrl ? "Motion link" : a.libraryUrl ? "Ad Library link" : "ad"} goes in the request&apos;s references so the creative
              team sees the idea.
            </p>
          </div>
        ) : step === "pick" ? (
          <ClientPick industry={a.industry} clients={clients} error={error} onBack={() => setStep("ad")} onPick={write} />
        ) : (
          <Writing steps={WRITING} label="brief from a market ad+brief self-review" />
        )}
        {step === "ad" && <SheetAction onClick={() => (forClient ? write(forClient) : setStep("pick"))}>{forClient ? "Brief this client on it" : "Brief a client on this"}</SheetAction>}
      </div>
    </div>
  );
}
