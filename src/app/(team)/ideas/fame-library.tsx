"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FilterMenu, FilterPill } from "@/components/filters";
import type { FameAd } from "@/lib/hall-of-fame";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "../pipeline/views/suggested-briefs";
import { briefFromWinner } from "../winners/actions";
import { FeedPreview } from "../winners/fb-preview";
import { ClientPick, Writing, type PickClient } from "../winners/winners-library";

type Sort = "beat" | "spend" | "days";
const SORTS: [Sort, string][] = [
  ["beat", "Beat their target most"],
  ["spend", "Most spend behind it"],
  ["days", "Longest live"],
];
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const result = (a: FameAd) => (a.roas ? `${a.value.toFixed(2)}x ROAS vs ${a.target}x target` : `${money(a.value)} vs ${money(a.target)} ${a.targetSource === "kpi" ? "target" : "benchmark"} per ${a.conversion.toLowerCase().replace(/s$/, "")}`);

/**
 * The Hall of Fame: our ads that proved themselves (30+ days live, at or beating the client's KPI target or their
 * sub-vertical's benchmark), kept six months. By vertical and sub-vertical; open one to see it and brief a client on it.
 */
export function FameLibrary({ ads, verticals, clients }: { ads: FameAd[]; verticals: { id: string; name: string; parent: string }[]; clients: PickClient[] }) {
  const [vertical, setVertical] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("beat");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<FameAd | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of ads) if (a.verticalId) m.set(a.verticalId, (m.get(a.verticalId) ?? 0) + 1);
    return m;
  }, [ads]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ads
      .filter((a) => !vertical || a.verticalId === vertical)
      .filter((a) => !term || [a.client, a.vertical, a.parentVertical, a.creative.headline, a.creative.text, a.adName].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => (sort === "beat" ? b.beatBy - a.beatBy : sort === "spend" ? b.spend - a.spend : b.daysLive - a.daysLive));
  }, [ads, vertical, sort, q]);
  const label = (id: string | null) => verticals.find((v) => v.id === id)?.name ?? "Not placed yet";

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <header className="grid gap-3">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Hall of Fame</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Our best, by vertical</h1>
        <p className="max-w-2xl text-sm text-muted">
          Ads that ran 30+ days and hit or beat their client&apos;s KPI target (or their sub-vertical&apos;s researched benchmark), with $300+ spent. Each stays six months
          after it last qualified; new winners join after every Meta sync.
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
          <span>
            <span className="tabular text-fg">{ads.length}</span> in the Hall of Fame
          </span>
          <span>
            <span className="tabular text-fg">{new Set(ads.map((a) => a.clientId)).size}</span> clients
          </span>
          <span>
            <span className="tabular text-fg">{counts.size}</span> sub-verticals
          </span>
          <span>
            <span className="tabular text-ok">{ads.filter((a) => a.stillRunning).length}</span> still running
          </span>
        </p>
      </header>

      {ads.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">Filling up after the next Meta syncs</p>
          <p className="max-w-md text-sm text-muted">Each account&apos;s last six months of ads are read against its KPI target; the ones that proved themselves land here.</p>
        </div>
      ) : (
        <>
          <div className="sticky top-3 z-20 grid gap-3">
            <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-line bg-surface/90 p-2 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2.5 rounded-[12px] bg-bg/60 px-3.5 focus-within:ring-1 focus-within:ring-faint">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-faint" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients, verticals, headlines, copy" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
              </label>
              <FilterMenu
                label={vertical ? label(vertical) : "All verticals"}
                on={vertical !== null}
                options={[[null, "All verticals", ads.length] as const, ...verticals.filter((v) => counts.has(v.id)).map((v) => [v.id, `${v.parent} · ${v.name}`, counts.get(v.id) ?? 0] as const)]}
                value={vertical}
                onPick={(v) => setVertical(v)}
              />
              <FilterMenu label={SORTS.find(([k]) => k === sort)?.[1] ?? "Sort"} on={false} options={SORTS.map(([k, l]) => [k, l, null] as const)} value={sort} onPick={(v) => setSort(v)} />
            </div>
            {(vertical || q.trim() || sort !== "beat") && (
              <div className="flex flex-wrap items-center gap-1.5">
                {vertical && <FilterPill onClear={() => setVertical(null)}>{label(vertical)}</FilterPill>}
                {sort !== "beat" && <FilterPill onClear={() => setSort("beat")}>{SORTS.find(([k]) => k === sort)?.[1]}</FilterPill>}
                {q.trim() && <FilterPill onClear={() => setQ("")}>&ldquo;{q.trim()}&rdquo;</FilterPill>}
                <button
                  onClick={() => {
                    setVertical(null);
                    setSort("beat");
                    setQ("");
                  }}
                  className="ml-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline"
                >
                  Clear all
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((a) => (
              <button key={a.adId} onClick={() => setOpen(a)} className="group grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-colors hover:border-faint">
                <span className="relative aspect-[4/5] overflow-hidden rounded-[10px] bg-surface-2">
                  {a.creative.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.creative.image} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-faint">{a.creative.headline ?? a.adName}</span>
                  )}
                  <span className="absolute left-2 top-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-semibold text-white shadow">
                    {a.roas ? `${a.value.toFixed(1)}x` : `${Math.round(a.beatBy * 100)}% under`}
                  </span>
                  <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">{a.daysLive}d</span>
                </span>
                <span className="grid gap-1 px-1 pb-1">
                  <span className="line-clamp-2 text-[13px] font-medium leading-snug">{a.creative.headline ?? a.adName ?? "Untitled ad"}</span>
                  <span className="truncate text-[11px] text-muted">
                    {a.client} · {a.vertical ?? "Not placed yet"}
                  </span>
                  <span className="truncate text-[11px] text-faint">{result(a)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {open && <FameSheet key={open.adId} a={open} clients={clients} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FameSheet({ a, clients, onClose }: { a: FameAd; clients: PickClient[]; onClose: () => void }) {
  const [step, setStep] = useState<"ad" | "pick" | "writing">("ad");
  const [brief, setBrief] = useState<OpenSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = async (clientId: string) => {
    setError(null);
    setStep("writing");
    const r = await briefFromWinner(
      { adId: a.adId, client: a.client, detail: a.vertical, headline: a.creative.headline ?? null, text: a.creative.text ?? null, thumbnail: a.creative.image ?? null, ratio: Math.round((1 + a.beatBy) * 10) / 10, result: a.conversion.toLowerCase(), costPerResult: a.value, usual: a.target },
      clientId,
    );
    if (!r.ok) {
      setError(r.error);
      return setStep("pick");
    }
    setBrief(r.suggestion);
  };
  if (brief) return <SuggestionSheet s={brief} onClose={onClose} />;
  const c = a.creative;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[92vh] w-full max-w-[920px] gap-5 overflow-y-auto rounded-[18px] border border-line bg-bg p-4 md:grid-cols-[minmax(0,380px)_1fr] md:p-5">
        <FeedPreview
          view={{
            pageName: c.page ?? a.client,
            pagePicture: null,
            text: c.text ?? null,
            headline: c.headline ?? null,
            cta: c.cta ?? null,
            link: c.link ?? null,
            media: c.video ? [{ type: "video", url: c.video, poster: c.image ?? null }] : c.image ? [{ type: "image", url: c.image, poster: null }] : [],
            placeholder: c.image ?? null,
            preview: c.preview ?? null,
          }}
        />
        {step === "ad" ? (
          <div className="grid content-start gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 gap-1">
                <p className="text-xs text-faint">
                  {a.parentVertical ? `${a.parentVertical} · ` : ""}
                  {a.vertical ?? "Not placed yet"}
                </p>
                <p className="font-display text-xl leading-tight">{a.client}</p>
                <p className="truncate text-xs text-faint">{a.adName}</p>
              </div>
              <button onClick={onClose} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
                Done
              </button>
            </div>
            <div className="rounded-[14px] border border-ok/30 bg-ok/[0.07] p-4">
              <p className="tabular font-display text-3xl text-ok">{a.roas ? `${a.value.toFixed(2)}x` : money(a.value)}</p>
              <p className="mt-1 text-sm text-muted">
                {a.roas ? "ROAS" : `per ${a.conversion.toLowerCase().replace(/s$/, "")}`} over {a.daysLive} days, against a {a.roas ? `${a.target}x` : money(a.target)}{" "}
                {a.targetSource === "kpi" ? "KPI target" : "sub-vertical benchmark"}: {Math.round(a.beatBy * 100)}% {a.roas ? "above" : "under"} it.
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center text-xs">
              {(
                [
                  ["Spend", money(a.spend)],
                  [a.conversion, a.results.toLocaleString("en-US")],
                  ["Live", `${a.firstDate.slice(5)} → ${a.stillRunning ? "now" : a.lastDate.slice(5)}`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-[10px] bg-surface p-2.5">
                  <dt className="truncate text-faint">{k}</dt>
                  <dd className="tabular text-sm text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setStep("pick")} className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110">
                Brief a client on this
              </button>
              <Link href={`/clients/${a.clientSlug}`} className="grid h-10 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                Open {a.client}
              </Link>
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
          </div>
        ) : step === "pick" ? (
          <ClientPick industry={null} exclude={a.clientId} clients={clients} error={error} onBack={() => setStep("ad")} onPick={write} />
        ) : (
          <Writing />
        )}
      </div>
    </div>
  );
}
