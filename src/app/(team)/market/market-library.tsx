"use client";

import { useMemo, useState } from "react";
import type { MarketAd } from "@/lib/market";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { ClientPick, Writing, type PickClient } from "../winners/winners-library";
import { briefFromMarket } from "./actions";

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
  clients,
  brands,
  connected,
  lastSync,
  canConnect,
  openId,
  startIndustry,
}: {
  ads: MarketAd[];
  industries: readonly (readonly [string, string])[];
  clients: PickClient[];
  brands: number;
  connected: boolean;
  lastSync: string | null;
  canConnect: boolean;
  openId: string | null;
  startIndustry: string | null;
}) {
  const [industry, setIndustry] = useState<string | null>(startIndustry);
  const [view, setView] = useState<View>("all");
  const [format, setFormat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<MarketAd | null>(() => ads.find((a) => a.id === openId) ?? null);

  const label = (k: string | null) => industries.find(([i]) => i === k)?.[1] ?? "Not sorted yet";
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of ads) m.set(a.industry ?? "", (m.get(a.industry ?? "") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [ads]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ads
      .filter((a) => industry === null || (a.industry ?? "") === industry)
      .filter((a) => view === "all" || (view === "proven" ? a.proven : view === "fresh" ? a.fresh : a.testing))
      .filter((a) => !format || a.format === format)
      .filter((a) => !term || [a.brand, a.detail, a.headline, a.body, a.angle, a.hook, ...a.tags].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => (view === "fresh" ? Date.parse(b.launchedAt ?? "0") - Date.parse(a.launchedAt ?? "0") : (b.daysActive ?? 0) - (a.daysActive ?? 0)));
  }, [ads, industry, view, format, q]);

  const proven = ads.filter((a) => a.proven).length;
  const fresh = ads.filter((a) => a.fresh).length;

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Market · from Motion</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">What&apos;s live in the market</h1>
        <p className="max-w-2xl text-sm text-muted">
          Live Meta ads from brands in every industry we serve: the competitors our clients named, the ones we track in Motion, and standout advertisers in each niche.
          There are no numbers for other brands&apos; ads, so time is the signal: a brand still paying for an ad after a month usually has a winner.
        </p>
        {connected && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Stat value={ads.length.toLocaleString("en-US")} label="live ads" />
            <Stat value={String(brands)} label="brands watched" />
            <Stat value={String(proven)} label="proven (30+ days)" accent />
            <Stat value={String(fresh)} label="new this week" />
            {lastSync && <span className="self-center text-faint">Synced {when(lastSync)}</span>}
          </div>
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
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={industry === null} onClick={() => setIndustry(null)}>
                All <span className="text-faint">{ads.length}</span>
              </Chip>
              {counts.map(([k, n]) => (
                <Chip key={k || "none"} on={industry === k} onClick={() => setIndustry(industry === k ? null : k)}>
                  {label(k || null)} <span className="text-faint">{n}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1 rounded-full border border-line bg-surface p-1">
                {VIEWS.map(([k, l, hint]) => (
                  <button key={k} title={hint || undefined} onClick={() => setView(k)} className={`h-7 rounded-full px-3 text-xs ${view === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                    {l}
                  </button>
                ))}
              </div>
              <select value={format ?? ""} onChange={(e) => setFormat(e.target.value || null)} className="h-9 rounded-full border border-line bg-surface px-3 text-sm">
                <option value="">Any format</option>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f[0].toUpperCase() + f.slice(1)}s
                  </option>
                ))}
              </select>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search brand, angle, hook, copy…"
                className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none placeholder:text-faint focus:border-faint sm:max-w-xs"
              />
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Nothing matches. Try another industry or filter.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shown.slice(0, 240).map((a) => (
                <AdCard key={a.id} a={a} sub={a.detail ?? label(a.industry)} onOpen={() => setOpen(a)} />
              ))}
            </div>
          )}
        </>
      )}

      {open && <MarketSheet key={open.id} a={open} industryLabel={label(open.industry)} clients={clients} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function AdCard({ a, sub, onOpen }: { a: MarketAd; sub: string; onOpen: () => void }) {
  const cover = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
  const video = !cover && a.media.find((m) => m.type === "video");
  return (
    <button onClick={onOpen} className="group grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-colors hover:border-faint">
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

export function MarketSheet({ a, industryLabel, clients, onClose, forClient }: { a: MarketAd; industryLabel: string; clients: PickClient[]; onClose: () => void; forClient?: string }) {
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);

  const write = async (clientId: string) => {
    setError(null);
    setStep("writing");
    const r = await briefFromMarket(a.id, clientId);
    if (!r.ok) {
      setError(r.error);
      return setStep(forClient ? "ad" : "pick");
    }
    setBrief(r.suggestion);
  };

  if (brief) return <SuggestionSheet s={brief} onClose={onClose} />;

  const m = a.media[slide] ?? null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[92vh] w-full max-w-[920px] gap-5 overflow-y-auto rounded-[18px] border border-line bg-bg p-4 md:grid-cols-[minmax(0,400px)_1fr] md:p-5">
        <div className="grid content-start gap-2">
          <div className="overflow-hidden rounded-[12px] bg-white text-[#050505]">
            <div className="flex items-center gap-2 px-3 pt-2.5">
              {a.brandLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.brandLogo} alt="" className="h-7 w-7 rounded-full object-cover" />
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-[#e4e6eb] text-[11px] font-semibold">{a.brand[0]}</span>
              )}
              <span className="text-[13px] font-semibold">{a.brand}</span>
            </div>
            {a.body && <p className="max-h-60 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-[1.35]">{a.body}</p>}
            {m ? (
              m.type === "video" ? (
                <video src={m.url} poster={m.thumb ?? undefined} controls playsInline className="block max-h-[70vh] w-full bg-black" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt="" className="block w-full" />
              )
            ) : (
              <div className="grid aspect-[4/5] place-items-center bg-[#e9ebee] p-6 text-center text-xs text-[#65676b]">No media came through for this ad.</div>
            )}
            {(a.headline || a.cta) && (
              <div className="flex items-center justify-between gap-3 bg-[#f0f2f5] px-3 py-2.5">
                <p className="truncate text-[14px] font-semibold">{a.headline}</p>
                {a.cta && <span className="shrink-0 rounded-md bg-[#e4e6eb] px-3 py-1.5 text-[12px] font-semibold">{a.cta}</span>}
              </div>
            )}
          </div>
          {a.media.length > 1 && (
            <div className="flex justify-center gap-1.5">
              {a.media.map((_, i) => (
                <button key={i} onClick={() => setSlide(i)} aria-label={`Card ${i + 1}`} className={`h-1.5 rounded-full transition-all ${i === slide ? "w-5 bg-fg" : "w-1.5 bg-line"}`} />
              ))}
            </div>
          )}
        </div>

        {step === "ad" ? (
          <div className="grid content-start gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-1">
                <p className="text-xs text-faint">
                  {a.detail ?? industryLabel}
                  {a.detail && ` · ${industryLabel}`}
                </p>
                <p className="font-display text-xl leading-tight">{a.angle ?? a.headline ?? a.brand}</p>
                <p className="text-xs text-faint">
                  {a.brand}
                  {a.brandDomain && ` · ${a.brandDomain}`}
                </p>
              </div>
              <button onClick={onClose} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
                Done
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px]">
              {a.daysActive != null && <span className={`rounded-full px-2.5 py-1 ${a.proven ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>Running {a.daysActive} days</span>}
              {a.launchedAt && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Launched {when(a.launchedAt)}</span>}
              {a.testing && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Brand is testing a lot</span>}
              {a.format && <span className="rounded-full bg-surface-2 px-2.5 py-1 capitalize text-muted">{a.format}</span>}
              {a.tags.map((t) => (
                <span key={t} className="rounded-full border border-line px-2.5 py-1 text-faint">
                  {t}
                </span>
              ))}
            </div>

            {(a.hook || a.why) && (
              <div className="grid gap-2 rounded-[14px] border border-line bg-surface p-4 text-sm">
                {a.hook && (
                  <p>
                    <span className="text-faint">Hook </span>&ldquo;{a.hook}&rdquo;
                  </p>
                )}
                {a.why && (
                  <p className="text-muted">
                    <span className="text-faint">Why it works </span>
                    {a.why}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => (forClient ? write(forClient) : setStep("pick"))}
                className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110"
              >
                {forClient ? "Brief this client on it" : "Brief a client on this"}
              </button>
              {a.motionUrl && (
                <a href={a.motionUrl} target="_blank" rel="noreferrer" className="grid h-10 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                  Open in Motion ↗
                </a>
              )}
              {a.landingUrl && (
                <a href={a.landingUrl} target="_blank" rel="noreferrer" className="grid h-10 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                  Landing page ↗
                </a>
              )}
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            <p className="text-[11px] text-faint">
              The strategist writes the whole request from what makes this ad work, fitted to the client. The {a.motionUrl ? "Motion link" : "ad"} goes in the request&apos;s references so the creative
              team sees the idea.
            </p>
          </div>
        ) : step === "pick" ? (
          <ClientPick industry={a.industry} clients={clients} error={error} onBack={() => setStep("ad")} onPick={write} />
        ) : (
          <Writing steps={WRITING} />
        )}
      </div>
    </div>
  );
}
