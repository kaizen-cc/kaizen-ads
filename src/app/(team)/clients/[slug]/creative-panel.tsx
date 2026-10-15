"use client";

import Link from "next/link";
import { useState } from "react";
import type { ClientCreative, CreativeRow, MetaRow } from "@/lib/client-creative";

// The client's creative, in one place: what's in motion (and where), what we've launched, and what's live or paused
// in their ad account. Tickets open on the board.

type Tab = "moving" | "launched" | "live" | "paused";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function CreativePanel({ data }: { data: ClientCreative }) {
  const [tab, setTab] = useState<Tab>(data.moving.length ? "moving" : "live");
  const [ad, setAd] = useState<MetaRow | null>(null);
  const tabs: [Tab, string, number][] = [
    ["moving", "In motion", data.moving.length],
    ["launched", "Launched", data.launched.length],
    ["live", "Live", data.live.length],
    ["paused", "Paused", data.paused.length],
  ];

  return (
    <section className="grid gap-4 rounded-[14px] border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-[18px]">Creative</h2>
          <p className="text-sm text-muted">Every ticket for this client and where it stands, what we&apos;ve launched, and what&apos;s running in their ad account.</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-full border border-line p-0.5 text-xs">
          {tabs.map(([k, label, n]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1.5 ${tab === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>
              {label} <span className="tabular text-faint">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === "moving" || tab === "launched" ? (
        <Tickets rows={tab === "moving" ? data.moving : data.launched} launched={tab === "launched"} />
      ) : (
        <>
          {data.syncedAt && <p className="-mt-2 text-xs text-faint">From the ad account · synced {ago(data.syncedAt)}</p>}
          <Ads ads={tab === "live" ? data.live : data.paused} paused={tab === "paused"} onOpen={setAd} />
        </>
      )}

      {ad && <AdSheet ad={ad} onClose={() => setAd(null)} />}
    </section>
  );
}

function Tickets({ rows, launched }: { rows: CreativeRow[]; launched: boolean }) {
  if (!rows.length) return <p className="rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-sm text-faint">{launched ? "Nothing launched yet." : "Nothing in motion."}</p>;
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.number}>
          <Link href={`/board?t=${r.number}`} className="flex items-center gap-3 rounded-[10px] border border-line bg-bg/40 p-2.5 transition-colors hover:border-faint">
            <span className="relative h-12 w-10 shrink-0 overflow-hidden rounded-[6px] bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {r.thumbUrl && <img src={r.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{r.title}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-faint">
                <span>#{r.number}</span>
                <span className="capitalize">{r.format}</span>
                {r.internalRounds > 0 && <span>{r.internalRounds} internal rev</span>}
                {r.clientRounds > 0 && <span className={r.clientRounds >= 2 ? "text-warn" : ""}>client round {r.clientRounds}</span>}
              </span>
            </span>
            <span className="grid shrink-0 justify-items-end gap-0.5 text-xs">
              <span className={`rounded-full px-2 py-0.5 ${launched ? "bg-ok/15 text-ok" : r.late ? "bg-bad-soft text-bad" : "bg-surface-2 text-muted"}`}>{r.stageLabel}</span>
              <span className="text-faint">{launched ? day(r.at) : `since ${day(r.at)}`}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Ads({ ads, paused, onOpen }: { ads: MetaRow[]; paused: boolean; onOpen: (a: MetaRow) => void }) {
  if (!ads.length)
    return (
      <p className="rounded-[10px] border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
        {paused ? "No paused ads in the last sync." : "Nothing delivering in the last sync. Is the ad account connected?"}
      </p>
    );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {ads.map((a) => (
        <button key={a.id} onClick={() => onOpen(a)} className="grid gap-2 rounded-[10px] border border-line bg-bg/40 p-2 text-left transition-colors hover:border-faint">
          <span className="relative aspect-[4/5] overflow-hidden rounded-[6px] bg-surface-2">
            {a.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.thumbnail} alt="" className={`absolute inset-0 h-full w-full object-cover ${paused ? "opacity-60 grayscale" : ""}`} />
            ) : (
              <span className="absolute inset-0 grid place-items-center p-2 text-center text-[10px] text-faint">{a.name}</span>
            )}
            <span className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-px text-[9.5px] text-white`}>
              <i className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-white/50" : "bg-[#3fb27f]"}`} />
              {paused ? "Paused" : "Live"}
            </span>
          </span>
          <span className="grid gap-0.5 px-0.5">
            <span className="truncate text-xs font-medium">{a.headline ?? a.name}</span>
            <span className="tabular text-[11px] text-faint">
              {money(a.spend)}
              {a.costPerResult != null ? ` · ${money(a.costPerResult)}/${a.result ?? "result"}` : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function AdSheet({ ad, onClose }: { ad: MetaRow; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[90vh] w-full max-w-[420px] gap-3 overflow-y-auto rounded-[16px] border border-line bg-bg p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{ad.name}</p>
          <button onClick={onClose} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
            Done
          </button>
        </div>
        <div className="overflow-hidden rounded-[12px] bg-white text-[#050505]">
          {ad.text && <p className="whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-[1.35]">{ad.text}</p>}
          {ad.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ad.thumbnail} alt="" className="block w-full" />
          ) : (
            <span className="grid aspect-[4/5] place-items-center text-xs text-[#65676b]">No preview from the ad account yet</span>
          )}
          {ad.headline && <p className="truncate bg-[#f0f2f5] px-3 py-2.5 text-[14px] font-semibold">{ad.headline}</p>}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center text-xs">
          {(
            [
              ["Spend", money(ad.spend)],
              [ad.result ? `${ad.result[0].toUpperCase()}${ad.result.slice(1)}` : "Results", String(ad.results)],
              ["Cost per", ad.costPerResult != null ? money(ad.costPerResult) : "—"],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-[8px] bg-surface p-2">
              <dt className="text-faint">{k}</dt>
              <dd className="tabular text-sm text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-center text-[11px] text-faint">Numbers from the last Meta sync window.</p>
      </div>
    </div>
  );
}
