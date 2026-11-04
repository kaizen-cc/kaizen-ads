"use client";

import { useEffect, useState } from "react";
import { AiProgressButton } from "@/components/ai-progress";
import { KIND_LABEL, type SuggestionKind } from "@/lib/suggestion-kinds";
import type { Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { Draft } from "./draft";
import { clientBriefs, clientPatterns, ideaDraft, ideaPreviews, industryWinnersFor, marketFor, patternPatch, suggestionPatch, type BriefCard, type IdeaPreview, type WinnersResult } from "./actions";
import { Spark } from "./parts";

/**
 * The first thing after picking the client: ready-made briefs, as cards. Briefs the strategist already wrote for them
 * (ads tiring, performance, moments, call promises), what's proven for similar clients (patterns across clients and
 * winning ads from parallel accounts), and what's working in their market. Then "create your own": write it, or talk
 * it through with the strategist. Picking any card fills the whole request and opens it at Review.
 */

type Pattern = Awaited<ReturnType<typeof clientPatterns>>[number];
type Fmt = "image" | "video" | "carousel";
const marketFormat = (a: MarketAd): Fmt => (a.format === "carousel" ? "carousel" : a.format === "video" || (!a.media.some((m) => m.type === "image") && a.media[0]?.type === "video") ? "video" : "image");
const FMT: Record<Fmt, string> = { image: "Image", video: "Video", carousel: "Carousel" };
// A tint per kind of brief, for cards without a picture
const KIND_TINT: Partial<Record<string, string>> = {
  fatigue: "from-warn/30", refresh: "from-warn/30", kpi: "from-bad/30", flop: "from-bad/30", unhappy: "from-bad/30",
  moment: "from-ok/25", pattern: "from-[#5b8def]/30", call: "from-brand/30", offer: "from-brand/30", winner: "from-ok/25", market: "from-[#5b8def]/25",
};

export function StartPanel({ clientId, clientName, aiOn, promises, onBrief, onManual, onTalk }: { clientId: string; clientName: string; aiOn: boolean; promises?: React.ReactNode; onBrief: (patch: Partial<Draft>) => void; onManual: () => void; onTalk: () => void }) {
  const [briefs, setBriefs] = useState<BriefCard[] | null>(null);
  const [patterns, setPatterns] = useState<Pattern[] | null>(null);
  const [winners, setWinners] = useState<WinnersResult | null>(null);
  const [market, setMarket] = useState<{ label: string | null; ads: MarketAd[] } | null>(null);
  const [previews, setPreviews] = useState<Record<string, IdeaPreview>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    clientBriefs(clientId).then((b) => live && setBriefs(b)).catch(() => live && setBriefs([]));
    clientPatterns(clientId).then((p) => live && setPatterns(p)).catch(() => live && setPatterns([]));
    industryWinnersFor(clientId).then((w) => live && setWinners(w)).catch(() => live && setWinners({ industry: null, label: null, detail: null, winners: [] }));
    marketFor(clientId).then((m) => live && setMarket(m)).catch(() => live && setMarket({ label: null, ads: [] }));
    return () => {
      live = false;
    };
  }, [clientId]);

  // Why each winner and market ad suits this client, in a line (one AI call, kept a day)
  useEffect(() => {
    if (!aiOn || !winners || !market) return;
    const sources = [
      ...winners.winners.slice(0, 4).map((w) => ({ key: `w-${w.id}`, kind: "winner" as const, title: w.headline ?? w.name, text: w.text, meta: `${w.format}, ${w.ratio}x better cost per ${w.result ?? "result"} than that account's usual` })),
      ...market.ads.slice(0, 6).map((a) => ({ key: `m-${a.id}`, kind: "market" as const, title: a.angle ?? a.headline ?? "Untitled ad", text: a.body ?? a.why, meta: `${marketFormat(a)}${a.daysActive != null ? `, live ${a.daysActive} days` : ""}` })),
    ];
    if (!sources.length) return;
    let live = true;
    void ideaPreviews(clientId, sources).then((p) => live && setPreviews(p));
    return () => {
      live = false;
    };
  }, [aiOn, clientId, winners, market]);

  const run = async (key: string, get: () => Promise<{ ok: true; patch: Partial<Draft> } | { ok: false; error: string }>) => {
    setError(null);
    setBusy(key);
    const r = await get().catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onBrief(r.patch);
  };

  const similarCount = (patterns?.length ?? 0) + (winners?.winners.length ?? 0);
  return (
    <div className="grid min-w-0 gap-10">
      {error && <p className="rounded-[12px] border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">{error}</p>}
      {promises}

      <Section title="Suggested for this client" sub={`Briefs the strategist already wrote for ${clientName}: ads tiring, numbers off, moments coming up, promises from calls.`} loading={briefs === null} empty="Nothing suggested for them right now." count={briefs?.length ?? 0}>
        {(briefs ?? []).map((b) => (
          <Card
            key={b.id}
            thumb={b.thumb}
            tint={KIND_TINT[b.kind]}
            badge={KIND_LABEL[b.kind as SuggestionKind] ?? b.kind}
            title={b.title || b.signal}
            line={b.signal}
            why={b.why}
            foot={b.formats}
            busy={busy === `s-${b.id}`}
            disabled={Boolean(busy)}
            action="Use this brief"
            label="request from a brief"
            onClick={() => run(`s-${b.id}`, () => suggestionPatch(b.id))}
          />
        ))}
      </Section>

      <Section title="From similar clients to test here" sub="What's proven for businesses like them (never named), and winning ads from parallel accounts. The strategist makes it theirs." loading={patterns === null || winners === null} empty="Nothing proven for similar clients yet." count={similarCount}>
        {(patterns ?? []).map((p) => (
          <Card
            key={`p-${p.id}`}
            thumb={null}
            tint="from-[#5b8def]/30"
            badge={`Works for ${p.clients} of ${p.of}`}
            title={p.title}
            line={p.group}
            why={p.detail}
            foot={p.uses ? "They already use it" : "Not using it yet"}
            busy={busy === `p-${p.id}`}
            disabled={Boolean(busy) || !aiOn}
            action={`Brief it for ${clientName}`}
            label="brief from a pattern+brief self-review"
            onClick={() => run(`p-${p.id}`, () => patternPatch(p.id, clientId))}
          />
        ))}
        {(winners?.winners ?? []).slice(0, 4).map((w: Winner) => (
          <Card
            key={`w-${w.id}`}
            thumb={w.thumbnail}
            badge={`${w.ratio}x their usual`}
            format={w.format}
            title={w.headline ?? w.name}
            line={`${w.client}${winners?.label ? ` · ${winners.label}` : ""}`}
            why={previews[`w-${w.id}`]?.why ?? null}
            foot={previews[`w-${w.id}`]?.formats ?? ""}
            busy={busy === `w-${w.id}`}
            disabled={Boolean(busy) || !aiOn}
            action="Brief from this"
            label="brief from a winner+brief self-review"
            onClick={() => run(`w-${w.id}`, () => ideaDraft({ kind: "winner", winner: w }, clientId, w.format))}
          />
        ))}
      </Section>

      <Section title="In the market" sub={`Live ads from their competitors and brands like them${market?.label ? ` in ${market.label.toLowerCase()}` : ""}, from Motion: the longest running, and new ones live 14+ days.`} loading={market === null} empty="No market ads matched to them yet." count={market?.ads.length ?? 0}>
        {(market?.ads ?? []).slice(0, 6).map((a) => {
          const img = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
          return (
            <Card
              key={`m-${a.id}`}
              thumb={img}
              video={!img ? (a.media[0]?.url ?? null) : null}
              badge={a.daysActive != null ? `Live ${a.daysActive} days` : "Live"}
              format={marketFormat(a)}
              title={a.angle ?? a.headline ?? "Untitled ad"}
              line={a.brand}
              why={previews[`m-${a.id}`]?.why ?? a.why ?? null}
              foot={previews[`m-${a.id}`]?.formats ?? ""}
              busy={busy === `m-${a.id}`}
              disabled={Boolean(busy) || !aiOn}
              action="Brief from this"
              label="brief from a market ad+brief self-review"
              onClick={() => run(`m-${a.id}`, () => ideaDraft({ kind: "market", adId: a.id }, clientId, marketFormat(a)))}
            />
          );
        })}
      </Section>

      <section className="grid gap-4">
        <div>
          <h2 className="font-heading text-[20px] tracking-tight">Create your own</h2>
          <p className="text-sm text-muted">Write the brief yourself, or talk the idea through with the strategist and it writes it with you.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={onManual} className="group grid gap-3 rounded-[18px] border border-line bg-surface p-5 text-left transition-colors hover:border-faint">
            <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-surface-2 text-[20px]">✎</span>
            <span className="grid gap-1">
              <span className="font-heading text-[17px]">Write it myself</span>
              <span className="text-[13.5px] leading-relaxed text-muted">Formats, direction and the brief, step by step. The AI still suggests along the way and reviews it before it goes.</span>
            </span>
            <span className="text-[13px] text-faint group-hover:text-fg">Start writing →</span>
          </button>
          <button type="button" onClick={onTalk} disabled={!aiOn} className="group relative isolate grid gap-3 overflow-hidden rounded-[18px] border border-brand/40 bg-brand-soft/40 p-5 text-left transition-colors hover:border-brand/70 disabled:opacity-50">
            <span aria-hidden className="pointer-events-none absolute -right-10 -top-14 -z-10 h-40 w-40 rounded-full bg-brand/25 blur-[60px]" />
            <span className="grid h-11 w-11 place-items-center rounded-[12px] bg-brand text-white">
              <Spark size={18} />
            </span>
            <span className="grid gap-1">
              <span className="font-heading text-[17px]">Talk it through</span>
              <span className="text-[13.5px] leading-relaxed text-muted">Tell the strategist the idea in your own words. It asks only what it needs and builds the full brief from {clientName}&rsquo;s Bible, numbers and assets as you go.</span>
            </span>
            <span className="text-[13px] text-brand-text">Start the conversation →</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function Section({ title, sub, loading, empty, count, children }: { title: string; sub: string; loading: boolean; empty: string; count: number; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-[20px] tracking-tight">{title}</h2>
          <p className="text-sm text-muted">{sub}</p>
        </div>
        {!loading && count > 0 && <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] tabular text-muted">{count}</span>}
      </div>
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-[260px] animate-pulse rounded-[18px] bg-surface-2" />
          ))}
        </div>
      ) : count ? (
        // Phones: one row that scrolls sideways; larger screens: a grid
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">{children}</div>
      ) : (
        <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-center text-sm text-faint">{empty}</p>
      )}
    </section>
  );
}

function Card({
  thumb,
  video,
  tint,
  badge,
  format,
  title,
  line,
  why,
  foot,
  busy,
  disabled,
  action,
  label,
  onClick,
}: {
  thumb: string | null;
  video?: string | null;
  tint?: string;
  badge: string;
  format?: Fmt;
  title: string;
  line: string;
  why: string | null;
  foot: string;
  busy: boolean;
  disabled: boolean;
  action: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <article className="flex w-[78vw] max-w-[320px] shrink-0 snap-start flex-col overflow-hidden rounded-[18px] border border-line bg-surface transition-colors hover:border-faint sm:w-auto sm:max-w-none">
      <div className={`relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-br ${tint ?? "from-surface-2"} to-surface-2`}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
        ) : video ? (
          <video src={`${video}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center px-6 text-center font-heading text-[17px] leading-snug text-fg/80">{title}</span>
        )}
        <span className="absolute left-3 top-3 max-w-[80%] truncate rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">{badge}</span>
        {format && <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] text-white backdrop-blur">{FMT[format]}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="line-clamp-2 font-heading text-[15.5px] leading-snug">{title}</p>
        <p className="line-clamp-1 text-[12.5px] text-faint">{line}</p>
        {why && <p className="line-clamp-3 text-[13px] leading-relaxed text-muted">{why}</p>}
        <div className="mt-auto grid gap-2 pt-2">
          {foot && <p className="text-[12px] text-faint">{foot}</p>}
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`min-h-11 rounded-full px-4 text-[14px] font-medium transition-colors ${busy ? "bg-brand-soft text-brand-text" : "bg-fg text-bg hover:opacity-90 disabled:opacity-40"}`}
          >
            {busy ? <AiProgressButton label={label} fallbackMs={110_000} /> : action}
          </button>
        </div>
      </div>
    </article>
  );
}
