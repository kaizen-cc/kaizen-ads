"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { Draft } from "./draft";
import { ideaDraft, industryWinnersFor, marketFor, type WinnersResult } from "./actions";

/**
 * Beside the request: what's winning in our accounts for clients like this one, and what's live from the brands most
 * like them in the market. "Create brief" has the strategist write the whole request from that ad, fitted to this
 * client, and drops it into the form (with where it came from, which stays on the tickets).
 */
export function IdeasPanel({ clientId, onBrief }: { clientId: string; onBrief: (patch: Partial<Draft>) => void }) {
  const [winners, setWinners] = useState<WinnersResult | null>(null);
  const [market, setMarket] = useState<{ label: string | null; ads: MarketAd[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    industryWinnersFor(clientId).then((w) => live && setWinners(w));
    marketFor(clientId).then((m) => live && setMarket(m));
    return () => {
      live = false;
    };
  }, [clientId]);

  const create = async (key: string, source: Parameters<typeof ideaDraft>[0]) => {
    setError(null);
    setBusy(key);
    const r = await ideaDraft(source, clientId);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onBrief(r.patch);
  };

  const ws = (winners?.winners ?? []).slice(0, 4);
  const ms = (market?.ads ?? []).slice(0, 4);
  return (
    <div className="grid gap-4">
      {error && <p className="rounded-[10px] border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}
      <Widget
        title="From our winners"
        sub={winners?.label ? `Beating their own account, in ${winners.label.toLowerCase()}` : "Beating their own account"}
        loading={winners === null}
        empty="No winners in their industry yet."
        more="/ideas?tab=winners"
      >
        {ws.map((w: Winner) => (
          <Item
            key={w.id}
            thumb={w.thumbnail}
            title={w.headline ?? w.name}
            meta={`${w.client} · ${w.ratio}x their usual`}
            busy={busy === `w-${w.id}`}
            disabled={Boolean(busy)}
            onCreate={() => create(`w-${w.id}`, { kind: "winner", winner: w })}
          />
        ))}
      </Widget>
      <Widget title="From the market" sub="Live ads from the brands most like them, from Motion" loading={market === null} empty="No market ads matched to them yet." more={`/ideas?tab=market&client=${clientId}`}>
        {ms.map((a) => (
          <Item
            key={a.id}
            thumb={a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null}
            video={!a.media.some((m) => m.type === "image") && !a.media[0]?.thumb ? (a.media[0]?.url ?? null) : null}
            title={a.angle ?? a.headline ?? "Untitled ad"}
            meta={`${a.brand}${a.daysActive != null ? ` · live ${a.daysActive} days` : ""}`}
            busy={busy === `m-${a.id}`}
            disabled={Boolean(busy)}
            onCreate={() => create(`m-${a.id}`, { kind: "market", adId: a.id })}
          />
        ))}
      </Widget>
    </div>
  );
}

function Widget({ title, sub, loading, empty, more, children }: { title: string; sub: string; loading: boolean; empty: string; more: string; children: React.ReactNode[] }) {
  return (
    <section className="grid gap-3 rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="truncate text-[11px] text-faint">{sub}</p>
        </div>
        <Link href={more} className="shrink-0 text-[11px] text-muted hover:text-fg">
          More →
        </Link>
      </div>
      {loading ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-12 animate-pulse rounded-[10px] bg-surface-2" />
          ))}
        </div>
      ) : children.length ? (
        <ul className="grid gap-1">{children}</ul>
      ) : (
        <p className="text-xs text-faint">{empty}</p>
      )}
    </section>
  );
}

function Item({ thumb, video, title, meta, busy, disabled, onCreate }: { thumb: string | null; video?: string | null; title: string; meta: string; busy: boolean; disabled: boolean; onCreate: () => void }) {
  return (
    <li className="grid gap-2 rounded-[10px] p-1.5 transition-colors hover:bg-surface-2/60">
      <div className="flex items-center gap-3">
        <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[8px] bg-surface-2">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : video ? (
            <video src={`${video}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12.5px] leading-snug">{title}</span>
          <span className="block truncate text-[11px] text-faint">{meta}</span>
        </span>
      </div>
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled}
        className={`h-8 rounded-full text-xs font-medium transition-colors ${busy ? "bg-brand-soft text-brand-text" : "border border-line text-muted hover:border-brand/50 hover:text-fg disabled:opacity-50"}`}
      >
        {busy ? "Writing the brief… about a minute" : "Create brief"}
      </button>
    </li>
  );
}
