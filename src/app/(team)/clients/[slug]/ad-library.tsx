"use client";

import { useEffect, useMemo, useState } from "react";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { RANGES, STATUS_LABEL, asRange, filterAds, freqBand, isLive, vsTarget, type AdFilters, type AdFormat, type AdPlatform, type AdRow, type AdStatus } from "@/lib/ad-library/core";
import type { AdList, AdSheet } from "@/lib/ad-library/load";
import { clientAdSheet, listClientAds } from "./ad-library-actions";

// The client page's Ads tab: every ad running in the client's accounts (not only the ones wearing out), biggest spend
// first. Each ad's picture, name, campaign › ad set, status, spend, results and cost per result against the KPI target,
// CTR, CPM, frequency with our bands, days running, and the fatigue flag when it's tiring. The window (7/14/30 days),
// filters, search and the open ad live in the address, so back returns to where you were. Cards on a phone, a table
// from tablet up; the ad opens in a sheet (full screen on a phone) with the creative, copy, its last 30 days and a link
// to the ad manager.

const money = (n: number | null | undefined, d = 0) => (n == null ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const pct = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(2)}%`);
const STATUS_TONE: Record<AdStatus, string> = { active: "bg-ok-soft text-ok", learning: "bg-ink/[0.08] text-fg", limited: "bg-warn-soft text-warn", paused: "bg-ink/[0.07] text-muted", rejected: "bg-bad-soft text-bad", ended: "bg-ink/[0.07] text-faint" };
const FORMATS: AdFormat[] = ["image", "video", "carousel", "text"];
const PLATFORM_NAME: Record<AdPlatform, string> = { meta: "Meta", google: "Google", tiktok: "TikTok" };
const field = "min-h-11 rounded-full border border-line bg-surface px-3.5 text-[16px] text-fg outline-none focus:border-faint md:min-h-9 md:text-[13px]";

function useFilters(): AdFilters {
  const status = useParam("ads_status");
  const campaign = useParam("ads_campaign");
  const tiring = useParam("ads_tiring");
  const format = useParam("ads_format");
  const q = useParam("ads_q");
  return {
    status: status === "recent" || status === "all" ? status : "active",
    campaign: campaign || null,
    tiring: tiring === "1",
    format: FORMATS.includes(format as AdFormat) ? (format as AdFormat) : null,
    q: q ?? "",
  };
}

/** initial: a list already read on the server for the default window (the first fetch is skipped) */
export function AdLibrary({ clientId, platform, initial = null }: { clientId: string; platform: AdPlatform; initial?: AdList | null }) {
  const days = asRange(useParam("ads_days") ?? 7);
  const f = useFilters();
  const open = useParam("ad");
  const [list, setList] = useState<AdList | null>(initial && initial.window.days === days ? initial : null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(f.q);
  useEffect(() => {
    if (initial && initial.window.days === days) return;
    let live = true;
    listClientAds(clientId, platform, days).then((r) => {
      if (!live) return;
      if (r.ok) {
        setList(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [clientId, platform, days, initial]);
  const shown = useMemo(() => (list ? filterAds(list.ads, f) : []), [list, f]);
  const liveCount = list?.ads.filter((a) => isLive(a.status)).length ?? 0;
  const tiring = list?.ads.filter((a) => a.fatigue).length ?? 0;
  const selected = open ? (list?.ads.find((a) => a.id === open) ?? null) : null;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[19px] leading-tight">{list ? `${liveCount} ad${liveCount === 1 ? "" : "s"} live${tiring ? `, ${tiring} tiring` : ""}` : "Reading the ads…"}</p>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {list ? `${list.window.from} to ${list.window.to}${list.target ? ` · ${list.target.result}${list.target.value != null ? ` target ${list.target.roas ? `${list.target.value}x` : money(list.target.value, 2)}` : ""}` : ""}` : `${PLATFORM_NAME[platform]}, last ${days} days`}
          </p>
        </div>
        <div role="tablist" aria-label="Window" className="flex gap-1 rounded-full border border-line bg-surface p-1">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={r === days} onClick={() => pushParams({ ads_days: r === 7 ? null : String(r) })} className={`min-h-11 rounded-full px-4 text-[13px] md:min-h-9 md:px-3.5 ${r === days ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {r}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <select aria-label="Status" value={f.status} onChange={(e) => pushParams({ ads_status: e.target.value === "active" ? null : e.target.value })} className={field}>
          <option value="active">Live now</option>
          <option value="recent">Live or spent</option>
          <option value="all">All ads</option>
        </select>
        <select aria-label="Format" value={f.format ?? ""} onChange={(e) => pushParams({ ads_format: e.target.value || null })} className={field}>
          <option value="">Every format</option>
          {FORMATS.map((x) => (
            <option key={x} value={x}>
              {x[0].toUpperCase() + x.slice(1)}
            </option>
          ))}
        </select>
        <select aria-label="Campaign" value={f.campaign ?? ""} onChange={(e) => pushParams({ ads_campaign: e.target.value || null })} className={`${field} col-span-2 min-w-0 sm:max-w-[260px]`}>
          <option value="">Every campaign</option>
          {(list?.campaigns ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" aria-pressed={f.tiring} onClick={() => pushParams({ ads_tiring: f.tiring ? null : "1" })} className={`min-h-11 rounded-full border px-3.5 text-[13px] md:min-h-9 ${f.tiring ? "border-warn bg-warn-soft text-warn" : "border-line text-muted hover:text-fg"}`}>
          Tiring only{tiring ? ` · ${tiring}` : ""}
        </button>
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            replaceParams({ ads_q: e.target.value || null });
          }}
          placeholder="Search ads"
          aria-label="Search ads"
          className={`${field} min-w-0 sm:w-[200px]`}
        />
      </div>

      {error && <p className="rounded-[14px] border border-bad/30 bg-bad-soft px-4 py-3 text-[13px] text-bad">{error}</p>}
      {list?.note && <p className="text-[12.5px] text-muted">{list.note}</p>}
      {!list && !error && <div className="h-40 animate-pulse rounded-[18px] bg-surface" />}
      {list && !shown.length && <p className="rounded-[18px] border border-dashed border-line p-6 text-sm text-muted">{list.ads.length ? "No ads match these filters." : "No ads on record for this window."}</p>}

      {list && shown.length > 0 && (
        <>
          {/* Phones: cards */}
          <ul className="grid gap-2 md:hidden">
            {shown.map((a) => (
              <li key={a.id}>
                <AdCard a={a} list={list} />
              </li>
            ))}
          </ul>
          {/* Tablet up: a table */}
          <div className="hidden overflow-x-auto rounded-[18px] border border-line md:block">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead className="bg-surface text-[11px] uppercase tracking-[0.08em] text-faint">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Ad</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Spend</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Results</th>
                  <th className="px-3 py-2.5 text-right font-semibold">{list.target?.roas ? "ROAS" : "Cost / result"}</th>
                  <th className="px-3 py-2.5 text-right font-semibold">CTR</th>
                  <th className="px-3 py-2.5 text-right font-semibold">CPM</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Freq.</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Days</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <AdTableRow key={a.id} a={a} list={list} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {open && list && <Sheet clientId={clientId} platform={platform} ad={selected} id={open} list={list} />}
    </div>
  );
}

function Thumb({ a, size = 56 }: { a: AdRow; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative grid shrink-0 place-items-center overflow-hidden rounded-[10px] bg-ink/[0.06] text-[10px] uppercase text-faint" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {a.thumbnail && !broken ? <img src={a.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" /> : a.format}
      {a.format === "video" && <span className="absolute bottom-0.5 right-0.5 rounded bg-deep/70 px-1 text-[9px] text-fg">▶</span>}
      {a.format === "carousel" && <span className="absolute bottom-0.5 right-0.5 rounded bg-deep/70 px-1 text-[9px] text-fg">⧉</span>}
    </span>
  );
}

function Vs({ a, list }: { a: AdRow; list: AdList }) {
  const v = vsTarget(a.cpr, list.target?.value ?? null, Boolean(list.target?.roas));
  const val = list.target?.roas ? (a.cpr == null ? "–" : `${a.cpr.toFixed(2)}x`) : money(a.cpr, 2);
  return (
    <span className={v ? (v.good ? "text-ok" : "text-bad") : ""}>
      {val}
      {v && <span className="ml-1 text-[11px]">{v.good ? "▲" : "▼"}{Math.abs(Math.round(v.pct * 100))}%</span>}
    </span>
  );
}

function Freq({ f }: { f: number | null }) {
  const b = freqBand(f);
  return (
    <span title={b?.label} className={b?.tone === "bad" ? "text-bad" : b?.tone === "warn" ? "text-warn" : ""}>
      {f == null ? "–" : f.toFixed(2)}
      {b && <span className="ml-1 text-[10px] uppercase text-faint">{b.band}</span>}
    </span>
  );
}

function StatusPill({ s }: { s: AdStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[s]}`}>{STATUS_LABEL[s]}</span>;
}

function AdCard({ a, list }: { a: AdRow; list: AdList }) {
  return (
    <button type="button" onClick={() => pushParams({ ad: a.id })} className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-[16px] border border-line bg-surface p-3 text-left">
      <Thumb a={a} />
      <span className="grid min-w-0 gap-1.5">
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="line-clamp-2 text-[14px] font-medium leading-snug">{a.name}</span>
            <span className="block truncate text-[11.5px] text-muted">
              {a.campaign ?? "–"} › {a.adset ?? "–"}
            </span>
          </span>
          <StatusPill s={a.status} />
        </span>
        {a.fatigue && (
          <span className="text-[11.5px] text-warn">
            {a.fatigue.severity === "tired" ? "Worn out" : "Tiring"}: {a.fatigue.why}
          </span>
        )}
        <span className="grid grid-cols-3 gap-x-2 gap-y-1 text-[12px]">
          <Metric label="Spend" value={money(a.spend)} />
          <Metric label={list.target?.roas ? "ROAS" : "Cost / result"} value={<Vs a={a} list={list} />} />
          <Metric label="Results" value={a.results.toLocaleString("en-US")} />
          <Metric label="CTR" value={pct(a.ctr)} />
          <Metric label="CPM" value={money(a.cpm, 2)} />
          <Metric label="Frequency" value={<Freq f={a.frequency} />} />
        </span>
        {a.daysRunning != null && <span className="text-[11px] text-faint">{a.daysRunning} days running</span>}
      </span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="grid min-w-0">
      <span className="tabular truncate text-fg">{value}</span>
      <span className="text-[10.5px] text-faint">{label}</span>
    </span>
  );
}

function AdTableRow({ a, list }: { a: AdRow; list: AdList }) {
  return (
    <tr onClick={() => pushParams({ ad: a.id })} className="cursor-pointer border-t border-line hover:bg-surface">
      <td className="max-w-[360px] px-3 py-2.5">
        <span className="flex items-center gap-3">
          <Thumb a={a} size={44} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{a.name}</span>
            <span className="block truncate text-[11.5px] text-muted">
              {a.campaign ?? "–"} › {a.adset ?? "–"}
            </span>
            {a.fatigue && <span className="block truncate text-[11px] text-warn">{a.fatigue.severity === "tired" ? "Worn out" : "Tiring"}: {a.fatigue.why}</span>}
          </span>
        </span>
      </td>
      <td className="px-3 py-2.5">
        <StatusPill s={a.status} />
      </td>
      <td className="tabular px-3 py-2.5 text-right">{money(a.spend)}</td>
      <td className="tabular px-3 py-2.5 text-right">{a.results.toLocaleString("en-US")}</td>
      <td className="tabular px-3 py-2.5 text-right">
        <Vs a={a} list={list} />
      </td>
      <td className="tabular px-3 py-2.5 text-right">{pct(a.ctr)}</td>
      <td className="tabular px-3 py-2.5 text-right">{money(a.cpm, 2)}</td>
      <td className="tabular px-3 py-2.5 text-right">
        <Freq f={a.frequency} />
      </td>
      <td className="tabular px-3 py-2.5 text-right">{a.daysRunning ?? "–"}</td>
    </tr>
  );
}

/** A small line for one series (no axis: the numbers are beside it) */
function Spark({ values, tone }: { values: (number | null)[]; tone: string }) {
  const pts = values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v != null);
  if (pts.length < 2) return <span className="text-[11px] text-faint">Not enough days</span>;
  const max = Math.max(...pts.map((p) => p.v));
  const min = Math.min(...pts.map((p) => p.v));
  const w = 240;
  const h = 44;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * w;
  const y = (v: number) => h - 4 - ((v - min) / Math.max(1e-9, max - min)) * (h - 8);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline fill="none" strokeWidth="2" className={tone} stroke="currentColor" points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")} />
    </svg>
  );
}

function Sheet({ clientId, platform, ad, id, list }: { clientId: string; platform: AdPlatform; ad: AdRow | null; id: string; list: AdList }) {
  const [data, setData] = useState<AdSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    clientAdSheet(clientId, platform, id).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("ad");
    window.addEventListener("keydown", esc);
    return () => {
      live = false;
      window.removeEventListener("keydown", esc);
    };
  }, [clientId, platform, id]);
  const c = data?.creative;
  const s = data?.series ?? [];
  return (
    <div role="dialog" aria-modal="true" aria-label={ad?.name ?? "Ad"} className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={() => closeParams("ad")} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:max-w-[600px] md:border-l md:border-line">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 md:px-6">
          <div className="min-w-0">
            <p className="line-clamp-2 font-heading text-[18px] leading-tight">{ad?.name ?? "Ad"}</p>
            {ad && (
              <p className="mt-0.5 truncate text-[12px] text-muted">
                {ad.campaign ?? "–"} › {ad.adset ?? "–"}
              </p>
            )}
          </div>
          <button type="button" onClick={() => closeParams("ad")} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.06] hover:text-fg">
            ✕
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-5 overflow-y-auto overscroll-contain px-4 py-4 md:px-6">
          {ad && (
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill s={ad.status} />
              {ad.fatigue && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10.5px] text-warn">{ad.fatigue.severity === "tired" ? "Worn out" : "Tiring"}: {ad.fatigue.why}</span>}
              {ad.daysRunning != null && <span className="text-[12px] text-muted">{ad.daysRunning} days running</span>}
            </div>
          )}
          {ad && (
            <div className="grid grid-cols-3 gap-3 rounded-[16px] border border-line bg-surface p-3.5 text-[13px]">
              <Metric label={`Spend, ${list.window.days}d`} value={money(ad.spend)} />
              <Metric label={list.target?.roas ? "ROAS" : "Cost / result"} value={<Vs a={ad} list={list} />} />
              <Metric label={list.target?.result ?? "Results"} value={ad.results.toLocaleString("en-US")} />
              <Metric label="CTR" value={pct(ad.ctr)} />
              <Metric label="CPM" value={money(ad.cpm, 2)} />
              <Metric label="Frequency" value={<Freq f={ad.frequency} />} />
            </div>
          )}
          {error && <p className="text-[13px] text-bad">{error}</p>}
          {!data && !error && <div className="h-48 animate-pulse rounded-[16px] bg-surface" />}
          {c && (
            <div className="grid gap-3">
              <div className="overflow-hidden rounded-[16px] border border-line bg-surface">
                {c.video ? (
                  <video src={c.video} poster={c.poster ?? undefined} controls playsInline className="max-h-[60vh] w-full bg-black object-contain" />
                ) : c.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.image} alt="" className="max-h-[60vh] w-full object-contain" />
                ) : c.preview ? (
                  <iframe src={c.preview} title="Ad preview" className="h-[520px] w-full border-0 bg-surface" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  ad?.thumbnail && <img src={ad.thumbnail} alt="" className="max-h-[60vh] w-full object-contain" />
                )}
              </div>
              {c.headline && <p className="text-[15px] font-medium">{c.headline}</p>}
              {c.text && <p className="whitespace-pre-line text-[14px] leading-relaxed text-fg/90">{c.text}</p>}
              <div className="flex flex-wrap gap-2 text-[12.5px] text-muted">
                {c.cta && <span className="rounded-full border border-line px-2.5 py-1">{c.cta}</span>}
                {c.link && (
                  <a href={c.link} target="_blank" rel="noreferrer" className="truncate rounded-full border border-line px-2.5 py-1 hover:text-fg">
                    {c.link.replace(/^https?:\/\//, "").slice(0, 48)}
                  </a>
                )}
              </div>
            </div>
          )}
          {s.length > 0 && (
            <div className="grid gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Last 30 days, day by day</p>
              {[
                { label: "Spend", vals: s.map((x) => x.spend), tone: "text-brand-text", last: money(s.reduce((n, x) => n + x.spend, 0)) },
                { label: list.target?.roas ? "ROAS" : "Cost per result", vals: s.map((x) => x.cpr), tone: "text-warn", last: s.at(-1)?.cpr == null ? "–" : list.target?.roas ? `${s.at(-1)!.cpr!.toFixed(2)}x` : money(s.at(-1)!.cpr, 2) },
                { label: "CTR", vals: s.map((x) => x.ctr), tone: "text-ok", last: pct(s.at(-1)?.ctr) },
                { label: "Frequency (daily)", vals: s.map((x) => x.freq), tone: "text-muted", last: s.at(-1)?.freq?.toFixed(2) ?? "–" },
              ].map((x) => (
                <div key={x.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px] text-muted">{x.label}</p>
                    <Spark values={x.vals} tone={x.tone} />
                  </div>
                  <span className="tabular text-[13px]">{x.last}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {data?.managerUrl && (
          <div className="border-t border-line px-4 py-3 md:px-6">
            <a href={data.managerUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-fg px-5 text-[14px] font-medium text-bg hover:opacity-90 md:w-auto">
              Open in {PLATFORM_NAME[platform]} Ads Manager ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

