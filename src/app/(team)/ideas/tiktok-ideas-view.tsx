"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FilterMenu, FilterPill } from "@/components/filters";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { QuickBriefSheet } from "@/components/quick-brief-sheet";
import { BriefJobStatus } from "@/components/brief-jobs";
import { SaveIdeaStar } from "@/components/save-idea-star";
import { TikTokMark } from "@/components/source-logo";
import type { SaveInput } from "@/lib/saved-references";
import type { BriefSource } from "@/lib/quick-brief";
import type { TikTokIdea } from "@/lib/tiktok/ideas";
import { resultLine } from "@/lib/tiktok/winners";
import { ClientPick, SHEET_BACKDROP, SHEET_PANEL, SheetAction, SheetBar, type PeerContext, type PickClient } from "../winners/winners-library";

type Sort = "beat" | "spend" | "days" | "hook";
const SORTS: [Sort, string][] = [
  ["beat", "Beat their target most"],
  ["spend", "Most spend behind it"],
  ["hook", "Highest 6s view rate"],
  ["days", "Longest live"],
];
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const pct = (n: number | null) => (n == null ? "n/a" : `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
const ratio = (a: TikTokIdea) => Math.round((a.roas ? a.value / a.target : a.target / a.value) * 10) / 10;

/** The brief a TikTok winner becomes: its hook, text, numbers and link, labelled TikTok (its background job is found by it) */
export function tiktokBrief(a: TikTokIdea): BriefSource {
  return {
    kind: "winner",
    winner: {
      adId: a.adId,
      client: a.client,
      clientId: a.clientId,
      detail: a.vertical,
      headline: a.hook,
      text: a.text,
      thumbnail: a.thumbnail,
      ratio: ratio(a),
      result: a.conversion.toLowerCase(),
      costPerResult: a.value,
      usual: a.target,
      platform: "tiktok",
      metrics: `${resultLine(a)}, 6s view rate ${pct(a.sixSecRate)}, ${money(a.spend)} spent over ${a.daysLive} days`,
      link: a.link,
    },
  };
}

/** What a star on a TikTok winner saves: the ad and the brief it becomes for the client it's saved for */
function saveTikTok(a: TikTokIdea): SaveInput {
  return {
    source: "winner",
    refId: a.adId,
    url: a.link,
    thumbnail: a.thumbnail,
    title: a.hook ?? a.adName ?? "A TikTok winner",
    subtitle: `TikTok · ${a.client}${a.vertical ? ` · ${a.vertical}` : ""}`,
    format: a.format === "video" ? "video" : null,
    data: { brief: tiktokBrief(a), platform: "tiktok" },
  };
}

/**
 * Ads Lab on TikTok: our own clients' TikTok ads that beat their TikTok KPI target, as the Hall of Fame (30+ days,
 * kept six months) or the live winners (the last 14 days). Filters and the open ad live in the address like Meta's.
 */
export function TikTokIdeasView({ ads, mode, verticals, clients, match }: { ads: TikTokIdea[]; mode: "fame" | "live"; verticals: { id: string; name: string; parent: string }[]; clients: PickClient[]; match: PeerContext }) {
  const vertical = useParam("vertical");
  const setVertical = (v: string | null) => pushParams({ vertical: v });
  const askedSort = useParam("sort");
  const sort: Sort = SORTS.some(([k]) => k === askedSort) ? (askedSort as Sort) : "beat";
  const setSort = (v: Sort) => pushParams({ sort: v === "beat" ? null : v });
  const [q, setQState] = useState(useParam("q") ?? "");
  const setQ = (v: string) => {
    setQState(v);
    replaceParams({ q: v.trim() ? v : null });
  };
  const openId = useParam("ad");
  const open = ads.find((a) => a.adId === openId) ?? null;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of ads) if (a.verticalId) m.set(a.verticalId, (m.get(a.verticalId) ?? 0) + 1);
    return m;
  }, [ads]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ads
      .filter((a) => !vertical || a.verticalId === vertical)
      .filter((a) => !term || [a.client, a.vertical, a.parentVertical, a.hook, a.text, a.adName, a.campaign].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => (sort === "beat" ? b.beatBy - a.beatBy : sort === "spend" ? b.spend - a.spend : sort === "hook" ? (b.sixSecRate ?? -1) - (a.sixSecRate ?? -1) : b.daysLive - a.daysLive));
  }, [ads, vertical, sort, q]);
  const label = (id: string | null) => verticals.find((v) => v.id === id)?.name ?? "Not placed yet";
  const fame = mode === "fame";

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <header className="grid gap-3">
        <p className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-faint">
          <TikTokMark size={14} />
          {fame ? "TikTok Hall of Fame" : "TikTok live winners"}
        </p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">{fame ? "Our best on TikTok" : "Winning on TikTok right now"}</h1>
        <p className="max-w-2xl text-sm text-muted">
          {fame
            ? "Our clients' TikTok ads that ran 30+ days and hit or beat their TikTok KPI target (or their sub-vertical's researched benchmark), with $300+ spent. Each stays six months after it last ran as a winner."
            : "Our clients' TikTok ads running now that beat their TikTok KPI target (or their sub-vertical's benchmark) over the last 14 days, with $100+ spent."}{" "}
          6s view rate: the share of impressions that watched six seconds.
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
          <span>
            <span className="tabular text-fg">{ads.length}</span> {fame ? "in the Hall of Fame" : "live winners"}
          </span>
          <span>
            <span className="tabular text-fg">{new Set(ads.map((a) => a.clientId)).size}</span> clients
          </span>
          <span>
            <span className="tabular text-fg">{counts.size}</span> sub-verticals
          </span>
          {fame && (
            <span>
              <span className="tabular text-ok">{ads.filter((a) => a.stillRunning).length}</span> still running
            </span>
          )}
        </p>
      </header>

      {ads.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">{fame ? "No TikTok ad has earned a place yet" : "Nothing beating its target on TikTok this fortnight"}</p>
          <p className="max-w-md text-sm text-muted">
            {fame ? "Each linked TikTok account's ads are read against its TikTok KPI target; ads that hold up for 30+ days land here." : "Ads running now are read against their TikTok KPI target over the last 14 days; the ones beating it show here."} A client needs a TikTok KPI target, or a sub-vertical with a benchmark.
          </p>
        </div>
      ) : (
        <>
          <div className="relative z-20 grid gap-3 md:sticky md:top-3">
            <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-line bg-surface/90 p-2 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <label className="flex h-11 min-w-[220px] flex-1 items-center gap-2.5 rounded-[12px] bg-bg/60 px-3.5 focus-within:ring-1 focus-within:ring-faint md:h-10">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-faint" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients, verticals, hooks, ad text" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
              </label>
              <div className="w-full md:contents">
                <FilterMenu
                  label={vertical ? label(vertical) : "All verticals"}
                  on={vertical !== null}
                  options={[[null, "All verticals", ads.length] as const, ...verticals.filter((v) => counts.has(v.id)).map((v) => [v.id, `${v.parent} · ${v.name}`, counts.get(v.id) ?? 0] as const)]}
                  value={vertical}
                  onPick={(v) => setVertical(v)}
                />
              </div>
              <div className="w-full md:contents">
                <FilterMenu label={SORTS.find(([k]) => k === sort)?.[1] ?? "Sort"} on={false} options={SORTS.map(([k, l]) => [k, l, null] as const)} value={sort} onPick={(v) => setSort(v)} />
              </div>
            </div>
            {(vertical || q.trim() || sort !== "beat") && (
              <div className="flex flex-wrap items-center gap-1.5">
                {vertical && <FilterPill onClear={() => setVertical(null)}>{label(vertical)}</FilterPill>}
                {sort !== "beat" && <FilterPill onClear={() => setSort("beat")}>{SORTS.find(([k]) => k === sort)?.[1]}</FilterPill>}
                {q.trim() && <FilterPill onClear={() => setQ("")}>&ldquo;{q.trim()}&rdquo;</FilterPill>}
                <button
                  onClick={() => {
                    setQState("");
                    pushParams({ vertical: null, sort: null, q: null });
                  }}
                  className="ml-1 py-2 text-xs text-muted underline-offset-4 hover:text-fg hover:underline md:py-0"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {shown.map((a) => (
              <div key={a.adId} className="relative min-w-0">
                <button
                  onClick={() => pushParams({ ad: a.adId })}
                  className="group grid w-full min-w-0 content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-all hover:border-faint active:scale-[0.98] md:active:scale-100"
                >
                  <Thumb a={a} className="rounded-[10px]" />
                  <span className="grid gap-1 px-1 pb-1">
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug">{a.hook ?? a.adName ?? "Untitled ad"}</span>
                    <span className="truncate text-[11px] text-muted">
                      {a.client} · {a.vertical ?? "Not placed yet"}
                    </span>
                    <span className="truncate text-[11px] text-faint">{resultLine(a)}</span>
                  </span>
                </button>
                <span className="absolute right-3.5 top-3.5 z-10">
                  <SaveIdeaStar idea={saveTikTok(a)} variant="overlay" size="sm" />
                </span>
                <BriefJobStatus source={tiktokBrief(a)} className="mt-1.5 grid min-w-0" />
              </div>
            ))}
          </div>
        </>
      )}

      {open && <TikTokSheet key={open.adId} a={open} clients={clients} match={match} onClose={() => closeParams("ad", "brief")} />}
    </div>
  );
}

/** The ad's cover, cropped vertical (9:16, as it runs), with its result, days and 6s view rate on it */
function Thumb({ a, className = "" }: { a: TikTokIdea; className?: string }) {
  return (
    <span className={`relative block aspect-[9/16] overflow-hidden bg-surface-2 ${className}`}>
      {a.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.thumbnail} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      ) : (
        <span className="absolute inset-0 grid place-items-center gap-2 p-3 text-center text-xs text-faint">
          <TikTokMark size={22} />
        </span>
      )}
      <span className="absolute left-2 top-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-semibold text-white shadow">{a.roas ? `${a.value.toFixed(1)}x` : `${Math.round(a.beatBy * 100)}% under`}</span>
      <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">{a.daysLive}d</span>
      {a.sixSecRate != null && <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">6s {pct(a.sixSecRate)}</span>}
    </span>
  );
}

function TikTokSheet({ a, clients, match, onClose }: { a: TikTokIdea; clients: PickClient[]; match: PeerContext; onClose: () => void }) {
  const [step, setStep] = useState<"ad" | "pick">("ad");
  // A client picked: the quick preview right here (?preview=, so back closes it); the full brief is written in the
  // background only if they choose it
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const preview = useParam("preview");
  const previewKey = `tt-${a.adId}`;
  const source = tiktokBrief(a);
  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${SHEET_PANEL} md:grid-cols-[minmax(0,300px)_1fr]`}>
        <SheetBar title={a.client} onClose={onClose} />
        {previewFor && preview === previewKey && (
          <QuickBriefSheet
            clientId={previewFor}
            source={source}
            from={{ kicker: "TikTok winner", label: a.hook ?? a.client, thumb: a.thumbnail, adId: a.adId, format: a.format }}
            progressLabel="brief from a winner+brief self-review"
            onClose={() => closeParams("preview")}
          />
        )}
        <div className={step === "ad" ? "mx-auto w-full max-w-[300px]" : "hidden md:mx-auto md:block md:w-full md:max-w-[300px]"}>
          <Thumb a={a} className="rounded-[14px] border border-line" />
        </div>
        {step === "ad" ? (
          <div className="grid min-w-0 content-start gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-1">
                <p className="flex items-center gap-1.5 text-xs text-faint">
                  <TikTokMark size={12} />
                  {a.parentVertical ? `${a.parentVertical} · ` : ""}
                  {a.vertical ?? "Not placed yet"}
                </p>
                <p className="font-display text-xl leading-tight">{a.client}</p>
                <p className="truncate text-xs text-faint">{a.adName}</p>
              </div>
              <button onClick={onClose} className="hidden shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg md:block">
                Done
              </button>
            </div>
            {a.hook && (
              <div className="grid gap-1">
                <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Hook</p>
                <p className="font-heading text-lg leading-snug">{a.hook}</p>
              </div>
            )}
            {a.text && a.text !== a.hook && <p className="whitespace-pre-line text-sm text-muted">{a.text}</p>}
            <dl className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-3">
              {(
                [
                  [a.roas ? "ROAS vs target" : `Cost per ${a.conversion.toLowerCase().replace(/s$/, "")}`, a.roas ? `${a.value.toFixed(2)}x vs ${a.target}x` : `${money(a.value)} vs ${money(a.target)}`],
                  ["6s view rate", pct(a.sixSecRate)],
                  ["Spend", money(a.spend)],
                  [a.conversion, a.results.toLocaleString("en-US")],
                  ["CTR", pct(a.ctr)],
                  ["Live", `${a.firstDate.slice(5)} → ${a.stillRunning ? "now" : a.lastDate.slice(5)}`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-[10px] bg-surface p-2.5">
                  <dt className="truncate text-faint">{k}</dt>
                  <dd className="tabular text-sm text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-faint">
              {a.targetSource === "kpi" ? "Judged against the client's TikTok KPI target" : "No TikTok target yet: judged against the sub-vertical's benchmark"}
              {a.cta ? ` · Call to action: ${a.cta.toLowerCase().replace(/_/g, " ")}` : ""}
            </p>
            {a.link && (
              <a href={a.link} target="_blank" rel="noreferrer" className="truncate text-sm text-muted underline underline-offset-4 hover:text-fg">
                {a.link.replace(/^https?:\/\//, "")}
              </a>
            )}
            <BriefJobStatus source={source} client compact={false} />
            <div className="flex flex-wrap items-center gap-2">
              <SaveIdeaStar idea={saveTikTok(a)} />
              <button onClick={() => setStep("pick")} className="hidden h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110 md:block">
                Use in a brief
              </button>
              <Link href={`/clients/${a.clientSlug}`} className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
                Open {a.client}
              </Link>
            </div>
          </div>
        ) : (
          <ClientPick
            match={match}
            exclude={a.clientId}
            clients={clients}
            error={null}
            onBack={() => setStep("ad")}
            onPick={(id) => {
              setPreviewFor(id);
              pushParams({ preview: previewKey });
            }}
          />
        )}
        {step === "ad" && <SheetAction onClick={() => setStep("pick")}>Use in a brief</SheetAction>}
      </div>
    </div>
  );
}
