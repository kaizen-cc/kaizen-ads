"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Winner, WinnerScope } from "@/lib/industry";
import type { Allotment } from "@/lib/allotment";
import type { AdDetail } from "@/lib/context/meta";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { briefFromWinner, winnerAd } from "./actions";

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
      <header className="grid gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Winners library</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">What&apos;s working across our accounts</h1>
        <p className="max-w-2xl text-sm text-muted">
          Not every running ad: only the ones clearly beating their own account. An ad makes the list when it has at least $100 spent and 3 results, and gets
          its result at least 1.2x cheaper than its account usually does. Ranked against its own account, so a small account&apos;s winner counts as much as a
          big one&apos;s.
        </p>
        <p className="max-w-2xl text-xs text-faint">
          This sync looked at the top {scope.ads.toLocaleString("en-US")} ads by spend across {scope.accounts} ad accounts (the top 20 in each, last 30 days).{" "}
          {scope.eligible.toLocaleString("en-US")} had enough spend and results to judge; {winners.length} beat their account.
          {scope.withoutData > 0 && ` ${scope.withoutData} more ${scope.withoutData === 1 ? "account is" : "accounts are"} linked to Meta but not synced at ad level yet; they fill in over the next syncs.`}
        </p>
        {winners.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Stat value={String(winners.length)} label="winning ads" />
            <Stat value={String(clientCount)} label="clients" />
            <Stat value={String(counts.filter(([k]) => k).length)} label="industries" />
            {best && <Stat value={`${best.ratio}x`} label={`best: ${best.detail ?? label(best.industry)}`} accent />}
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
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={industry === null} onClick={() => setIndustry(null)}>
                All <span className="text-faint">{winners.length}</span>
              </Chip>
              {counts.map(([k, n]) => (
                <Chip key={k || "none"} on={industry === k} onClick={() => setIndustry(industry === k ? null : k)}>
                  {label(k || null)} <span className="text-faint">{n}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search client, headline, copy…"
                className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none placeholder:text-faint focus:border-faint sm:max-w-xs"
              />
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 rounded-full border border-line bg-surface px-3 text-sm">
                {SORTS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setLiveOnly(!liveOnly)}
                className={`h-9 rounded-full border px-3.5 text-sm ${liveOnly ? "border-ok/50 bg-ok/10 text-ok" : "border-line text-muted hover:text-fg"}`}
              >
                Running now
              </button>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Nothing matches. Try another industry or search.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shown.map((w) => (
                <button
                  key={`${w.clientId}:${w.id}`}
                  onClick={() => setOpen(w)}
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

      {open && <WinnerSheet key={open.id} w={open} industryLabel={label(open.industry)} clients={clients} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <span className={`flex items-baseline gap-1.5 rounded-full border px-3 py-1.5 ${accent ? "border-ok/40 bg-ok/10" : "border-line bg-surface"}`}>
      <span className={`tabular text-sm font-semibold ${accent ? "text-ok" : "text-fg"}`}>{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm ${on ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
      {children}
    </button>
  );
}

function WinnerSheet({ w, industryLabel, clients, onClose }: { w: Winner; industryLabel: string; clients: PickClient[]; onClose: () => void }) {
  const [ad, setAd] = useState<AdDetail | null | undefined>(undefined); // undefined: still reading it from Meta
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const synced = new Date(w.syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  useEffect(() => {
    let live = true;
    winnerAd(w.id).then((d) => live && setAd(d));
    return () => {
      live = false;
    };
  }, [w.id]);

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

  const text = ad?.text ?? w.text;
  const headline = ad?.headline ?? w.headline;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[92vh] w-full max-w-[920px] gap-5 overflow-y-auto rounded-[18px] border border-line bg-bg p-4 md:grid-cols-[minmax(0,400px)_1fr] md:p-5">
        <AdPreview ad={ad} text={text} headline={headline} fallback={w.thumbnail} />

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

            <div className="rounded-[14px] border border-ok/30 bg-ok/[0.07] p-4">
              <p className="tabular font-display text-4xl text-ok">{w.ratio}x</p>
              <p className="mt-1 text-sm text-muted">
                better cost per {w.result ?? "result"} than this account usually gets: <span className="tabular text-fg">{money(w.costPerResult)}</span> against{" "}
                <span className="tabular text-fg">{money(w.usual)}</span>.
              </p>
            </div>

            <dl className="grid grid-cols-3 gap-2 text-center text-xs">
              {(
                [
                  ["Spend", money(w.spend)],
                  [w.result ? `${w.result[0].toUpperCase()}${w.result.slice(1)}` : "Results", w.results.toLocaleString("en-US")],
                  ["CTR", w.ctr ? `${w.ctr}%` : "—"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-[10px] bg-surface p-2.5">
                  <dt className="truncate text-faint">{k}</dt>
                  <dd className="tabular text-sm text-fg">{v}</dd>
                </div>
              ))}
            </dl>

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
          <ClientPick w={w} clients={clients} error={error} onBack={() => setStep("ad")} onPick={write} />
        ) : (
          <Writing />
        )}
      </div>
    </div>
  );
}

/** The ad as it runs: Meta's own preview when it plays, else the video file, else the image, with the full copy. */
function AdPreview({ ad, text, headline, fallback }: { ad: AdDetail | null | undefined; text: string | null; headline: string | null; fallback: string | null }) {
  const [frame, setFrame] = useState(false); // Meta's preview, if the video file itself isn't readable
  const video = ad?.video;
  const canPlay = Boolean(video?.source);
  return (
    <div className="grid content-start gap-2">
      <div className="overflow-hidden rounded-[12px] bg-white text-[#050505]">
        {text && <p className="max-h-60 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-[1.35]">{text}</p>}
        {ad === undefined ? (
          <div className="relative aspect-[4/5] animate-pulse bg-[#e9ebee]">
            {fallback && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fallback} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
            )}
          </div>
        ) : canPlay ? (
          <video src={video!.source!} poster={video!.poster ?? fallback ?? undefined} controls playsInline className="block max-h-[70vh] w-full bg-black" />
        ) : frame && ad?.preview ? (
          <iframe src={ad.preview} title="Ad preview" className="block h-[620px] w-full border-0 bg-white" scrolling="no" />
        ) : (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {(ad?.image ?? video?.poster ?? fallback) && <img src={(ad?.image ?? video?.poster ?? fallback)!} alt="" className="block w-full" />}
            {video && ad?.preview && (
              <button onClick={() => setFrame(true)} className="absolute inset-0 grid place-items-center bg-black/25 transition-colors hover:bg-black/35" aria-label="Play the video">
                <span className="grid h-16 w-16 place-items-center rounded-full bg-white/95 shadow-xl">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="#050505" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </button>
            )}
          </div>
        )}
        {headline && !frame && <p className="truncate bg-[#f0f2f5] px-3 py-2.5 text-[14px] font-semibold">{headline}</p>}
      </div>
      {ad === null && <p className="text-center text-[11px] text-faint">Couldn&apos;t reach Meta for the full ad, so this is the last synced version.</p>}
      {video && !canPlay && ad?.preview && !frame && <p className="text-center text-[11px] text-faint">Tap play to watch it in Meta&apos;s preview.</p>}
    </div>
  );
}

function ClientPick({ w, clients, error, onBack, onPick }: { w: Winner; clients: PickClient[]; error: string | null; onBack: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  // Same industry first: that's where a winner travels best
  const list = clients
    .filter((c) => c.id !== w.clientId && (!term || c.name.toLowerCase().includes(term) || c.detail?.toLowerCase().includes(term)))
    .sort((a, b) => Number(b.industry === w.industry && !!w.industry) - Number(a.industry === w.industry && !!w.industry) || a.name.localeCompare(b.name));
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
          const same = w.industry && c.industry === w.industry;
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

const WRITING = ["Reading why this ad works", "Reading the client: brand, offer, memory, allotment", "Translating the angle and the hook", "Writing the concepts", "Fitting formats to what's left this month"];

function Writing() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(WRITING.length - 1, n + 1)), 7000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="grid content-center gap-5 py-10">
      <p className="font-heading text-xl">The strategist is writing the brief</p>
      <ol className="grid gap-2.5">
        {WRITING.map((label, n) => (
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
