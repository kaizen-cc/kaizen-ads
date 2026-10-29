"use client";

import { AiProgress } from "@/components/ai-progress";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { Winner, WinnerScope } from "@/lib/industry";
import type { Allotment } from "@/lib/allotment";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { briefFromWinner } from "./actions";
import { FilterMenu, FilterPill } from "@/components/filters";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { FbPreview, InsightPanel, useAd, useInsight } from "./fb-preview";

export type PickClient = { id: string; name: string; industry: string | null; detail: string | null; allotment: Allotment };

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
type Sort = "ratio" | "spend" | "results";
const SORTS: [Sort, string][] = [
  ["ratio", "Beating their account most"],
  ["spend", "Most spend behind it"],
  ["results", "Most results"],
];

/**
 * The winners library: every ad across our accounts getting a clearly better cost per result than its own account's
 * usual, from the last Meta sync. Filter by industry, open one to see it as it runs, and start a request from it.
 */
export function WinnersLibrary({ winners, industries, clients, scope }: { winners: Winner[]; industries: readonly (readonly [string, string])[]; clients: PickClient[]; scope: WinnerScope }) {
  // Filters and the open ad are in the address (?industry=&live=&sort=&ad=), so back and forward step through them;
  // typing a search replaces the entry instead of adding one per key
  const industry = useParam("industry");
  const setIndustry = (v: string | null) => pushParams({ industry: v });
  const liveOnly = useParam("live") === "1";
  const setLiveOnly = (v: boolean) => pushParams({ live: v ? "1" : null });
  const askedSort = useParam("sort");
  const sort: Sort = SORTS.some(([k]) => k === askedSort) ? (askedSort as Sort) : "ratio";
  const setSort = (v: Sort) => pushParams({ sort: v === "ratio" ? null : v });
  const [q, setQState] = useState(useParam("q") ?? "");
  const setQ = (v: string) => {
    setQState(v);
    replaceParams({ q: v.trim() ? v : null });
  };
  const openId = useParam("ad");
  const open = winners.find((w) => w.id === openId) ?? null;
  const setOpen = (w: Winner) => pushParams({ ad: w.id });
  // Hovering a card (mouse only) shows the ad as it runs, with the AI's read
  const [hover, setHover] = useState<{ w: Winner; rect: DOMRect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const hoverIn = (w: Winner, el: HTMLElement) => {
    if (!canHover()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover({ w, rect: el.getBoundingClientRect() }), hover ? 120 : 380);
  };
  const hoverOut = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(null), 220);
  };
  const keep = () => timer.current && clearTimeout(timer.current);

  const label = (k: string | null) => industries.find(([i]) => i === k)?.[1] ?? "Not sorted yet";
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of winners) m.set(w.industry ?? "", (m.get(w.industry ?? "") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [winners]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return winners
      .filter((w) => industry === null || (w.industry ?? "") === industry)
      .filter((w) => !liveOnly || w.live)
      .filter((w) => !term || [w.client, w.detail, industries.find(([i]) => i === w.industry)?.[1], w.headline, w.text, w.name].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => (sort === "ratio" ? b.ratio - a.ratio : sort === "spend" ? b.spend - a.spend : b.results - a.results));
  }, [winners, industries, industry, liveOnly, q, sort]);

  const clientCount = new Set(winners.map((w) => w.clientId)).size;
  const best = winners[0];

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Winners library</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">What&apos;s working across our accounts</h1>
        <p className="max-w-2xl text-sm text-muted">The ads clearly beating their own account, ranked against that account so a small client&apos;s winner counts as much as a big one&apos;s.</p>
        {winners.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
            <span>
              <span className="tabular text-fg">{winners.length}</span> winning ads
            </span>
            <span>
              <span className="tabular text-fg">{clientCount}</span> clients
            </span>
            <span>
              <span className="tabular text-fg">{counts.filter(([k]) => k).length}</span> industries
            </span>
            {best && (
              <span>
                best <span className="tabular text-ok">{best.ratio}x</span> · {best.detail ?? label(best.industry)}
              </span>
            )}
            <details className="group relative open:basis-full md:open:basis-auto">
              <summary className="-my-2 cursor-pointer list-none py-2 underline-offset-4 hover:text-fg hover:underline md:my-0 md:py-0">How winners are picked</summary>
              <div className="mt-2 rounded-[14px] md:absolute md:left-0 md:top-6 md:z-30 md:mt-0 md:w-[360px] border border-line bg-surface p-4 text-xs leading-relaxed text-muted shadow-2xl">
                An ad makes the list with at least $100 spent and 3 results, getting its result at least 1.2x cheaper than its account usually does. This sync looked at the
                top {scope.ads.toLocaleString("en-US")} ads by spend across {scope.accounts} ad accounts (the top 20 in each, last 30 days);{" "}
                {scope.eligible.toLocaleString("en-US")} had enough to judge and {winners.length} beat their account.
                {scope.withoutData > 0 && ` ${scope.withoutData} more accounts are linked to Meta and fill in over the next syncs.`}
              </div>
            </details>
          </div>
        )}
      </header>

      {winners.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">No winners yet</p>
          <p className="max-w-sm text-sm text-muted">They show up once Meta has synced and an account has a few ads with enough spend to compare.</p>
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
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients, headlines, copy" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
                </label>
                {/* Phones: each menu gets the full row, so its list opens on screen */}
                <div className="w-full md:contents">
                  <FilterMenu
                    label={industry === null ? "All industries" : label(industry || null)}
                    on={industry !== null}
                    options={[[null, "All industries", winners.length] as const, ...counts.map(([k, n]) => [k, label(k || null), n] as const)]}
                    value={industry}
                    onPick={(v) => setIndustry(v)}
                  />
                </div>
                <div className="w-full md:contents">
                  <FilterMenu
                    label={SORTS.find(([k]) => k === sort)?.[1] ?? "Sort"}
                    on={false}
                    options={SORTS.map(([k, l]) => [k, l, null] as const)}
                    value={sort}
                    onPick={(v) => setSort(v)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3">
                <nav className="-mb-px flex gap-1">
                  {(
                    [
                      [false, "All winners", winners.length],
                      [true, "Running now", winners.filter((w) => w.live).length],
                    ] as const
                  ).map(([k, l, n]) => (
                    <button
                      key={String(k)}
                      onClick={() => setLiveOnly(k)}
                      className={`flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[13px] transition-colors ${liveOnly === k ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg"}`}
                    >
                      {l}
                      <span className="tabular text-[11px] text-faint">{n}</span>
                    </button>
                  ))}
                </nav>
                <span className="tabular py-2 text-[11px] text-faint">
                  {shown.length} {shown.length === 1 ? "ad" : "ads"} · <span className="md:hidden">tap</span>
                  <span className="hidden md:inline">hover</span> one to see it run
                </span>
              </div>
            </div>
            {(industry !== null || liveOnly || q.trim() || sort !== "ratio") && (
              <div className="flex flex-wrap items-center gap-1.5">
                {industry !== null && <FilterPill onClear={() => setIndustry(null)}>{label(industry || null)}</FilterPill>}
                {liveOnly && <FilterPill onClear={() => setLiveOnly(false)}>Running now</FilterPill>}
                {sort !== "ratio" && <FilterPill onClear={() => setSort("ratio")}>{SORTS.find(([k]) => k === sort)?.[1]}</FilterPill>}
                {q.trim() && <FilterPill onClear={() => setQ("")}>&ldquo;{q.trim()}&rdquo;</FilterPill>}
                <button
                  onClick={() => {
                    setQState("");
                    pushParams({ industry: null, live: null, sort: null, q: null });
                  }}
                  className="ml-1 py-2 text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:py-0"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Nothing matches. Try another industry or search.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shown.map((w) => (
                <button
                  key={`${w.clientId}:${w.id}`}
                  onClick={() => {
                    setHover(null);
                    setOpen(w);
                  }}
                  onMouseEnter={(e) => hoverIn(w, e.currentTarget)}
                  onMouseLeave={hoverOut}
                  className="group grid min-w-0 content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-all hover:border-faint active:scale-[0.98] md:active:scale-100"
                >
                  <span className="relative aspect-[4/5] overflow-hidden rounded-[10px] bg-surface-2">
                    {w.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={w.thumbnail} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                    ) : (
                      <span className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-faint">{w.headline ?? w.name}</span>
                    )}
                    <span className="absolute left-2 top-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-semibold text-white shadow">{w.ratio}x</span>
                    {w.live && (
                      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                        Live
                      </span>
                    )}
                  </span>
                  <span className="grid gap-1 px-1 pb-1">
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug">{w.headline ?? w.name}</span>
                    <span className="truncate text-[11px] text-muted">
                      {w.client} · {w.detail ?? label(w.industry)}
                    </span>
                    <span className="tabular text-[11px] text-faint">
                      {money(w.costPerResult)} vs {money(w.usual)} per {w.result ?? "result"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {hover && !open && (
        <HoverCard
          key={hover.w.id}
          w={hover.w}
          rect={hover.rect}
          industryLabel={label(hover.w.industry)}
          onEnter={keep}
          onLeave={hoverOut}
          onOpen={() => {
            setOpen(hover.w);
            setHover(null);
          }}
        />
      )}
      {open && <WinnerSheet key={open.id} w={open} industryLabel={label(open.industry)} clients={clients} onClose={() => closeParams("ad", "brief")} />}
    </div>
  );
}

// The full view of an ad (winners, Hall of Fame, market): a centred dialog on wider screens, the whole screen on a
// phone, with Close pinned at the top and the main action pinned at the bottom
export const SHEET_BACKDROP = "fixed inset-0 z-50 grid bg-black/70 backdrop-blur-sm md:place-items-center md:p-4";
export const SHEET_PANEL =
  "grid w-full min-w-0 content-start gap-5 overflow-y-auto overscroll-contain bg-bg px-4 pb-[calc(16px+env(safe-area-inset-bottom))] animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)] md:max-h-[92vh] md:max-w-[920px] md:animate-none md:rounded-[18px] md:border md:border-line md:p-5";

/** Phones: the sheet's title and Close, pinned at the top under the notch. */
export function SheetBar({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="sticky top-0 z-10 -mx-4 flex items-center gap-3 border-b border-line bg-bg/95 pb-1 pl-4 pr-2 pt-[calc(4px+env(safe-area-inset-top))] backdrop-blur-xl md:hidden">
      <p className="min-w-0 flex-1 truncate font-heading text-[15px]">{title}</p>
      <button onClick={onClose} className="h-11 shrink-0 rounded-full px-3 text-sm text-muted active:bg-surface-2">
        Close
      </button>
    </div>
  );
}

/** Phones: the sheet's main action, pinned at the bottom within thumb reach. */
export function SheetAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-[calc(16px+env(safe-area-inset-bottom))] border-t border-line bg-bg/95 px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:hidden">
      <button onClick={onClick} className="h-12 w-full rounded-brand bg-brand text-sm font-medium text-white active:brightness-110">
        {children}
      </button>
    </div>
  );
}

function WinnerSheet({ w, industryLabel, clients, onClose }: { w: Winner; industryLabel: string; clients: PickClient[]; onClose: () => void }) {
  const ad = useAd(w.id); // undefined: still reading it from Meta
  const insight = useInsight(w, ad);
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  // The written brief is a place of its own (?brief=id): back returns to the ad, forward to the brief
  const [written, setWritten] = useState<OpenSuggestion | null>(null);
  const briefId = useParam("brief");
  const brief = written && written.id === briefId ? written : null;
  const [error, setError] = useState<string | null>(null);
  const synced = new Date(w.syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const write = async (clientId: string) => {
    setError(null);
    setStep("writing");
    const r = await briefFromWinner(
      { adId: w.id, client: w.client, detail: w.detail, headline: ad?.headline ?? w.headline, text: ad?.text ?? w.text, thumbnail: w.thumbnail, ratio: w.ratio, result: w.result, costPerResult: w.costPerResult, usual: w.usual },
      clientId,
    );
    if (!r.ok) {
      setError(r.error);
      return setStep("pick");
    }
    // Back from the brief lands on the ad again, not on the writing screen
    setStep("pick");
    setWritten(r.suggestion);
    pushParams({ brief: r.suggestion.id });
  };

  if (brief) return <SuggestionSheet s={brief} onClose={onClose} />;

  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${SHEET_PANEL} md:grid-cols-[minmax(0,400px)_1fr]`}>
        <SheetBar title={w.client} onClose={onClose} />
        {/* Phones: once a client is being picked, the ad steps aside so the list is right there */}
        <div className={`grid content-start gap-2 ${step === "ad" ? "" : "hidden md:grid"}`}>
          <FbPreview ad={ad} w={w} />
          {ad === null && <p className="text-center text-[11px] text-faint">Couldn&apos;t reach Meta for the full ad, so this is the last synced version.</p>}
        </div>

        {step === "ad" ? (
          <div className="grid min-w-0 content-start gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-1">
                <p className="text-xs text-faint">
                  {w.detail ?? industryLabel}
                  {w.detail && ` · ${industryLabel}`}
                </p>
                <p className="font-display text-xl leading-tight">{w.client}</p>
                <p className="truncate text-xs text-faint" title={w.name}>
                  {w.name}
                </p>
              </div>
              <button onClick={onClose} className="hidden shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg md:block">
                Done
              </button>
            </div>

            <InsightPanel w={w} insight={insight} />

            <p className="text-xs text-faint">
              {w.live === true ? "Running now" : w.live === false ? "Not delivering right now" : "Delivery status not known yet"} · Meta sync of {synced}
            </p>

            <div className="flex flex-wrap gap-2">
              <button onClick={() => setStep("pick")} className="hidden h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110 md:block">
                Brief a client on this
              </button>
              <Link href={`/clients/${w.clientSlug}`} className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
                Open {w.client}
              </Link>
            </div>
            <p className="text-[11px] text-faint">Pick a client and the strategist writes the whole request from what makes this ad work. You edit it, talk it through, and send it to production right here.</p>
          </div>
        ) : step === "pick" ? (
          <ClientPick industry={w.industry} exclude={w.clientId} clients={clients} error={error} onBack={() => setStep("ad")} onPick={write} />
        ) : (
          <Writing />
        )}
        {step === "ad" && <SheetAction onClick={() => setStep("pick")}>Brief a client on this</SheetAction>}
      </div>
    </div>
  );
}

export function ClientPick({
  industry,
  exclude,
  clients,
  error,
  onBack,
  onPick,
}: {
  industry: string | null;
  exclude?: string;
  clients: PickClient[];
  error: string | null;
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // Same industry first: that's where a winner travels best
  const list = clients
    .filter((c) => c.id !== exclude && (!term || c.name.toLowerCase().includes(term) || c.detail?.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.industry === industry && !!industry) - Number(a.industry === industry && !!industry) || a.name.localeCompare(b.name));
  const leftOf = (cap: number | null, used: number) => (cap === null ? null : Math.max(0, cap - used));
  return (
    <div className="grid min-h-0 content-start gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-heading text-lg">Which client is this for?</p>
          <p className="text-xs text-faint">Same industry first. What&apos;s left of their month shows on each.</p>
        </div>
        <button onClick={onBack} className="shrink-0 rounded-full border border-line px-3.5 py-2.5 text-xs text-muted hover:text-fg md:px-3 md:py-1">
          Back
        </button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Find a client" className="h-11 rounded-brand border border-line bg-surface px-3 text-sm outline-none placeholder:text-faint focus:border-faint md:h-10" />
      {error && <p className="text-sm text-bad">{error}</p>}
      {/* Phones: the list scrolls with the sheet rather than in a box of its own */}
      <div className="flex flex-col gap-1 md:max-h-[56vh] md:overflow-y-auto md:pr-1">
        {list.map((c) => {
          const a = c.allotment;
          const img = leftOf(a.images, a.imagesUsed);
          const vid = leftOf(a.videos, a.videosUsed);
          const none = (img ?? 0) === 0 && (vid ?? 0) === 0;
          const same = industry && c.industry === industry;
          return (
            <button key={c.id} onClick={() => onPick(c.id)} className="group flex min-h-14 shrink-0 items-center gap-3 rounded-[12px] border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-faint active:bg-surface-2 md:min-h-0 md:active:bg-surface">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  {same && <span className="shrink-0 rounded-full bg-ok-soft px-1.5 py-px text-[10px] text-ok">Same industry</span>}
                </span>
                <span className="block truncate text-[11px] text-faint">{c.detail ?? "Industry not set"}</span>
              </span>
              <span className={`tabular shrink-0 text-right text-[11px] ${none ? "text-bad" : "text-muted"}`}>
                {img !== null && (
                  <span className="block">
                    {img} of {a.images} images left
                  </span>
                )}
                {vid !== null && (a.videos ?? 0) > 0 && (
                  <span className="block">
                    {vid} of {a.videos} videos left
                  </span>
                )}
                {img === null && vid === null && <span className="block text-faint">No allotment set</span>}
              </span>
              <span className="text-faint transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          );
        })}
        {list.length === 0 && <p className="py-6 text-center text-sm text-muted">No client with a creative package matches.</p>}
      </div>
    </div>
  );
}

const WINNER_STEPS = ["Reading why this ad works", "Reading the client: brand, offer, memory, allotment", "Translating the angle and the hook", "Writing the concepts", "Fitting formats to what's left this month"];

/** While the strategist writes a brief from an ad: a real progress bar, timed from how long these briefs take. */
export function Writing({ steps = WINNER_STEPS, label = "brief from a winner+brief self-review" }: { steps?: string[]; label?: string }) {
  return (
    <AiProgress
      label={label}
      fallbackMs={70_000}
      title="The strategist is writing the brief"
      steps={steps}
      note="You can edit it when it's ready, talk it through, or send it straight to production."
    />
  );
}

/**
 * Hovering a winner (with a mouse) opens it as it runs in the feed, playing if it's a video, with the AI's read beside
 * it. It stays open while the pointer is on the card or on it; a click opens the full view.
 */
export function HoverCard({ w, rect, industryLabel, onEnter, onLeave, onOpen }: { w: Winner; rect: DOMRect; industryLabel: string; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const ad = useAd(w.id);
  const insight = useInsight(w, ad);
  // Always fully on screen: a fixed height that fits the window, centred on the card, beside it when there's room
  const width = Math.min(780, window.innerWidth - 32);
  const height = Math.min(640, window.innerHeight - 32);
  const left = window.innerWidth - rect.right - 16 >= width ? rect.right + 12 : rect.left - 12 - width >= 16 ? rect.left - 12 - width : Math.max(16, (window.innerWidth - width) / 2);
  const top = Math.min(Math.max(16, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 16);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ left, top, width, height }}
      className="fixed z-40 grid grid-cols-[minmax(0,330px)_minmax(0,1fr)] gap-4 overflow-hidden rounded-[18px] border border-line bg-bg/95 p-3 shadow-2xl backdrop-blur-xl"
    >
      {/* Each side scrolls on its own, so See more or a long read never pushes anything off screen */}
      <div className="min-h-0 overflow-y-auto overscroll-contain rounded-[12px] [scrollbar-width:thin]">
        <FbPreview ad={ad} w={w} autoPlay compact />
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex shrink-0 items-start justify-between gap-2 pt-1">
          <div className="min-w-0">
            <p className="truncate font-heading text-[15px] leading-tight">{w.client}</p>
            <p className="truncate text-[11px] text-faint">
              {w.detail ?? industryLabel}
              {w.live ? " · running now" : ""}
            </p>
          </div>
          <button onClick={onOpen} className="shrink-0 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
            Brief a client
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1.5 [scrollbar-width:thin]">
          <InsightPanel w={w} insight={insight} dense />
        </div>
      </div>
    </div>
  );
}
