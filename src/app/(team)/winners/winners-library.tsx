"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Winner, WinnerScope } from "@/lib/industry";
import type { Allotment } from "@/lib/allotment";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { briefFromWinner } from "./actions";
import { FilterMenu, FilterPill } from "@/components/filters";
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
  const [industry, setIndustry] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("ratio");
  const [open, setOpen] = useState<Winner | null>(null);
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
            <details className="group relative">
              <summary className="cursor-pointer list-none underline-offset-4 hover:text-fg hover:underline">How winners are picked</summary>
              <div className="absolute left-0 top-6 z-30 w-[360px] rounded-[14px] border border-line bg-surface p-4 text-xs leading-relaxed text-muted shadow-2xl">
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
          <div className="sticky top-3 z-20 grid gap-3">
            <div className="rounded-[18px] border border-line bg-surface/90 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <div className="flex flex-wrap items-center gap-2 p-2">
                <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2.5 rounded-[12px] bg-bg/60 px-3.5 focus-within:ring-1 focus-within:ring-faint">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-faint" aria-hidden>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients, headlines, copy" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
                </label>
                <FilterMenu
                  label={industry === null ? "All industries" : label(industry || null)}
                  on={industry !== null}
                  options={[[null, "All industries", winners.length] as const, ...counts.map(([k, n]) => [k, label(k || null), n] as const)]}
                  value={industry}
                  onPick={(v) => setIndustry(v)}
                />
                <FilterMenu
                  label={SORTS.find(([k]) => k === sort)?.[1] ?? "Sort"}
                  on={false}
                  options={SORTS.map(([k, l]) => [k, l, null] as const)}
                  value={sort}
                  onPick={(v) => setSort(v)}
                />
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
                  {shown.length} {shown.length === 1 ? "ad" : "ads"} · hover one to see it run
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
                    setIndustry(null);
                    setLiveOnly(false);
                    setSort("ratio");
                    setQ("");
                  }}
                  className="ml-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
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
                  className="group grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-colors hover:border-faint"
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
      {open && <WinnerSheet key={open.id} w={open} industryLabel={label(open.industry)} clients={clients} onClose={() => setOpen(null)} />}
    </div>
  );
}

function WinnerSheet({ w, industryLabel, clients, onClose }: { w: Winner; industryLabel: string; clients: PickClient[]; onClose: () => void }) {
  const ad = useAd(w.id); // undefined: still reading it from Meta
  const insight = useInsight(w, ad);
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
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
    setBrief(r.suggestion);
  };

  if (brief) return <SuggestionSheet s={brief} onClose={onClose} />;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[92vh] w-full max-w-[920px] gap-5 overflow-y-auto rounded-[18px] border border-line bg-bg p-4 md:grid-cols-[minmax(0,400px)_1fr] md:p-5">
        <div className="grid content-start gap-2">
          <FbPreview ad={ad} w={w} />
          {ad === null && <p className="text-center text-[11px] text-faint">Couldn&apos;t reach Meta for the full ad, so this is the last synced version.</p>}
        </div>

        {step === "ad" ? (
          <div className="grid content-start gap-4">
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
              <button onClick={onClose} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
                Done
              </button>
            </div>

            <InsightPanel w={w} insight={insight} />

            <p className="text-xs text-faint">
              {w.live === true ? "Running now" : w.live === false ? "Not delivering right now" : "Delivery status not known yet"} · Meta sync of {synced}
            </p>

            <div className="flex flex-wrap gap-2">
              <button onClick={() => setStep("pick")} className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110">
                Brief a client on this
              </button>
              <Link href={`/clients/${w.clientSlug}`} className="grid h-10 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
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
        <button onClick={onBack} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
          Back
        </button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Find a client" className="h-10 rounded-brand border border-line bg-surface px-3 text-sm outline-none placeholder:text-faint focus:border-faint" />
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="grid max-h-[56vh] gap-1 overflow-y-auto pr-1">
        {list.map((c) => {
          const a = c.allotment;
          const img = leftOf(a.images, a.imagesUsed);
          const vid = leftOf(a.videos, a.videosUsed);
          const none = (img ?? 0) === 0 && (vid ?? 0) === 0;
          const same = industry && c.industry === industry;
          return (
            <button key={c.id} onClick={() => onPick(c.id)} className="group flex items-center gap-3 rounded-[12px] border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-faint">
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

export function Writing({ steps = WINNER_STEPS }: { steps?: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(steps.length - 1, n + 1)), 7000);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <div className="grid content-center gap-5 py-10">
      <p className="font-heading text-xl">The strategist is writing the brief</p>
      <ol className="grid gap-2.5">
        {steps.map((label, n) => (
          <li key={label} className={`flex items-center gap-3 text-sm transition-colors ${n < i ? "text-muted" : n === i ? "text-fg" : "text-faint/60"}`}>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] ${n < i ? "border-ok bg-ok text-white" : n === i ? "border-brand" : "border-line"}`}>
              {n < i ? "✓" : n === i ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> : null}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <p className="text-xs text-faint">Usually under a minute. You&apos;ll be able to edit it, talk it through, or send it straight to production.</p>
    </div>
  );
}

/**
 * Hovering a winner (with a mouse) opens it as it runs in the feed, playing if it's a video, with the AI's read beside
 * it. It stays open while the pointer is on the card or on it; a click opens the full view.
 */
function HoverCard({ w, rect, industryLabel, onEnter, onLeave, onOpen }: { w: Winner; rect: DOMRect; industryLabel: string; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
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
