"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AiProgressButton } from "@/components/ai-progress";
import { KIND_LABEL, type SuggestionKind } from "@/lib/suggestion-kinds";
import type { Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { StartData } from "@/lib/request-start";
import type { Allotment } from "@/lib/allotment";
import type { Draft } from "./draft";
import type { ClientOption } from "./parts";
import { Spark } from "./parts";
import { ideaDraft, patternPatch, suggestionPatch } from "./actions";

// The new request's first two steps, built like the report builder: pick the client from big cards (recent first,
// filtered as you type), then "How do you want to start?" as one full-width visual page. Everything on it is already
// stored (the briefs written every day, promises from calls, patterns, winners, Motion's market ads) and comes in one
// read, fetched the moment a client is hovered: nothing waits on the AI until a card is picked.

// ─── One read per client, kept for the visit and asked for ahead ──────────────────────────────────────────────

const cache = new Map<string, Promise<StartData>>();

/** Ask for a client's start page ahead (a hover, a focus, a tap): the request goes once and is reused */
export function prefetchStart(clientId: string) {
  if (!cache.has(clientId))
    cache.set(
      clientId,
      fetch(`/api/requests/start?client=${clientId}`)
        .then((r) => (r.ok ? (r.json() as Promise<StartData>) : Promise.reject(new Error(String(r.status)))))
        .catch((e) => {
          cache.delete(clientId);
          throw e;
        }),
    );
  return cache.get(clientId)!;
}

/** Seed the cache with what the server already read (?client= in the address) */
export function seedStart(data: StartData) {
  if (!cache.has(data.clientId)) cache.set(data.clientId, Promise.resolve(data));
}

function useStart(clientId: string) {
  const [data, setData] = useState<{ id: string; d: StartData } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    prefetchStart(clientId)
      .then((d) => live && setData({ id: clientId, d }))
      .catch(() => live && setFailed(clientId));
    return () => {
      live = false;
    };
  }, [clientId]);
  return { data: data?.id === clientId ? data.d : null, failed: failed === clientId };
}

// ─── Recent clients (this browser) ────────────────────────────────────────────────────────────────────────

const RECENT_KEY = "kz:request-recent-clients";
export function rememberClient(id: string) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list.filter((x) => x !== id)].slice(0, 8)));
  } catch {}
}
function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// ─── Step 1: the client ──────────────────────────────────────────────────────────────────────────────────

export function ClientPicker({ clients, allotments, onPick }: { clients: ClientOption[]; allotments: Record<string, Allotment>; onPick: (c: ClientOption) => void }) {
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // localStorage is read after mount (the server can't)
    void Promise.resolve().then(() => setRecent(readRecent()));
  }, []);
  const term = q.trim().toLowerCase();
  const creative = useMemo(() => clients.filter((c) => c.creative), [clients]);
  const recentClients = useMemo(() => recent.map((id) => creative.find((c) => c.id === id)).filter((c): c is ClientOption => Boolean(c)).slice(0, 4), [recent, creative]);
  const matches = useMemo(() => {
    if (!term) return creative;
    return clients
      .map((c) => {
        const n = c.name.toLowerCase();
        const i = n.indexOf(term);
        return i < 0 ? null : { c, rank: i === 0 ? 0 : /\s|[-&.]/.test(n[i - 1]) ? 1 : 2 };
      })
      .filter((x): x is { c: ClientOption; rank: number } => x !== null)
      .sort((a, b) => Number(b.c.creative) - Number(a.c.creative) || a.rank - b.rank || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c);
  }, [clients, creative, term]);
  const pickable = matches.filter((c) => c.creative);

  const pick = (c: ClientOption) => {
    if (!c.creative) return;
    rememberClient(c.id);
    onPick(c);
  };
  const left = (c: ClientOption) => {
    const a = allotments[c.id];
    if (!a) return null;
    const total = (a.images ?? 0) + (a.videos ?? 0);
    return total ? `${Math.max(0, total - a.imagesUsed - a.videosUsed)} of ${total} left this cycle` : null;
  };

  return (
    <div className="grid gap-6">
      <div className="relative">
        <svg className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-faint" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={input}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, pickable.length - 1));
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (pickable[active]) pick(pickable[active]);
            }
          }}
          placeholder={`Search ${creative.length} clients on a creative package`}
          aria-label="Search clients"
          className="h-16 w-full rounded-[20px] border border-line bg-surface pl-14 pr-5 text-[17px] outline-none transition-colors placeholder:text-faint focus:border-brand/60"
        />
      </div>

      {!term && recentClients.length > 0 && (
        <section className="grid gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Recent</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {recentClients.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                onPointerEnter={() => void prefetchStart(c.id).catch(() => {})}
                onFocus={() => void prefetchStart(c.id).catch(() => {})}
                className="group relative grid gap-4 overflow-hidden rounded-[20px] border border-line bg-gradient-to-br from-surface to-surface-2 p-5 text-left transition hover:-translate-y-0.5 hover:border-brand/50 hover:shadow-[0_16px_40px_-20px_rgba(200,16,46,0.7)]"
              >
                <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-gradient-to-br from-brand to-[#7a0a1c] font-heading text-[15px] text-white">{initials(c.name)}</span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-heading text-[17px]">{c.name}</span>
                  <span className="text-[12px] text-faint">{left(c) ?? "On a creative package"}</span>
                </span>
                <span className="absolute right-5 top-5 text-faint transition group-hover:translate-x-0.5 group-hover:text-fg">→</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{term ? `${pickable.length} ${pickable.length === 1 ? "match" : "matches"}` : "All clients"}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((c) => {
            const on = c.creative && pickable[active]?.id === c.id && Boolean(term);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                disabled={!c.creative}
                onPointerEnter={() => c.creative && void prefetchStart(c.id).catch(() => {})}
                onFocus={() => c.creative && void prefetchStart(c.id).catch(() => {})}
                className={`group flex min-h-[64px] items-center gap-3 rounded-[16px] border px-3.5 py-3 text-left transition ${c.creative ? `hover:-translate-y-px hover:border-faint hover:bg-surface-2 ${on ? "border-brand/60 bg-surface-2" : "border-line bg-surface"}` : "cursor-not-allowed border-line/60 bg-transparent opacity-50"}`}
              >
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[11px] text-[12px] font-semibold ${c.creative ? "bg-surface-2 text-fg group-hover:bg-brand group-hover:text-white" : "bg-surface-2 text-faint"}`}>{initials(c.name)}</span>
                <span className="grid min-w-0">
                  <span className="truncate text-[14.5px]">{c.name}</span>
                  <span className="truncate text-[11.5px] text-faint">{c.creative ? (left(c) ?? "On a creative package") : "No creative package"}</span>
                </span>
              </button>
            );
          })}
        </div>
        {term && !matches.length && <p className="px-1 text-sm text-faint">No client by that name.</p>}
      </section>
    </div>
  );
}

// ─── Step 2: how do you want to start? ───────────────────────────────────────────────────────────────────

type Fmt = "image" | "video" | "carousel";
const FMT: Record<Fmt, string> = { image: "Image", video: "Video", carousel: "Carousel" };
const marketFormat = (a: MarketAd): Fmt => (a.format === "carousel" ? "carousel" : a.format === "video" || (!a.media.some((m) => m.type === "image") && a.media[0]?.type === "video") ? "video" : "image");
// A tint per kind of brief, for cards without a picture
const KIND_TINT: Partial<Record<string, string>> = {
  fatigue: "from-warn/35", refresh: "from-warn/35", kpi: "from-bad/35", flop: "from-bad/35", unhappy: "from-bad/35", pacing: "from-bad/30",
  moment: "from-ok/30", pattern: "from-[#5b8def]/35", call: "from-brand/35", offer: "from-brand/35",
};

export function StartPage({
  clientId,
  clientName,
  aiOn,
  promises,
  onBrief,
  onManual,
  onTalk,
}: {
  clientId: string;
  clientName: string;
  aiOn: boolean;
  /** The promises strip, given what was already read */
  promises: (list: StartData["promises"]) => React.ReactNode;
  onBrief: (patch: Partial<Draft>) => void;
  onManual: () => void;
  onTalk: () => void;
}) {
  const { data, failed } = useStart(clientId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, get: () => Promise<{ ok: true; patch: Partial<Draft> } | { ok: false; error: string }>) => {
    setError(null);
    setBusy(key);
    const r = await get().catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onBrief(r.patch);
  };

  const loading = !data && !failed;
  const similar = (data?.patterns.length ?? 0) + (data?.winners.length ?? 0);

  return (
    <div className="grid min-w-0 gap-12">
      {error && <p className="rounded-[14px] border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">{error}</p>}
      {failed && <p className="rounded-[14px] border border-line px-4 py-3 text-sm text-muted">Couldn&rsquo;t load the ready-made briefs. You can still create your own below.</p>}

      <Section n="01" title="Fix what's wearing out or off" sub={`Briefs the strategist already wrote for ${clientName}: ads tiring, numbers off, moments coming up.`} loading={loading} empty="Nothing wearing out or off for them right now." count={data?.briefs.length ?? 0}>
        {(data?.briefs ?? []).map((b) => (
          <Card
            key={b.id}
            thumb={b.thumb}
            tint={KIND_TINT[b.kind]}
            fallback={b.signal}
            chip={KIND_LABEL[b.kind as SuggestionKind] ?? b.kind}
            tone={["fatigue", "refresh"].includes(b.kind) ? "warn" : ["kpi", "flop", "unhappy", "pacing"].includes(b.kind) ? "bad" : "brand"}
            title={b.title || b.signal}
            signal={b.title ? b.signal : null}
            why={b.why}
            foot={b.formats}
            busy={busy === `s-${b.id}`}
            disabled={Boolean(busy)}
            action="Use this brief"
            onClick={() => run(`s-${b.id}`, () => suggestionPatch(b.id))}
          />
        ))}
      </Section>

      {data && data.promises.length > 0 && <div className="-mt-4">{promises(data.promises)}</div>}

      <Section n="02" title="Working for similar clients" sub="What's proven for businesses like them (never named) and winning ads from parallel accounts. Pick one and the strategist makes it theirs." loading={loading} empty="Nothing proven for similar clients yet." count={similar}>
        {(data?.patterns ?? []).map((p) => (
          <Card
            key={`p-${p.id}`}
            thumb={null}
            tint="from-[#5b8def]/35"
            fallback={p.title}
            chip={`Works for ${p.clients} of ${p.of}`}
            tone="ok"
            title={p.title}
            signal={p.group}
            why={p.detail}
            foot={p.uses ? "They already use it" : "Not using it yet"}
            busy={busy === `p-${p.id}`}
            disabled={Boolean(busy) || !aiOn}
            action={`Brief it for ${clientName}`}
            label="brief from a pattern+brief self-review"
            onClick={() => run(`p-${p.id}`, () => patternPatch(p.id, clientId))}
          />
        ))}
        {(data?.winners ?? []).map((w: Winner) => (
          <Card
            key={`w-${w.id}`}
            thumb={w.thumbnail}
            ratio="4/5"
            chip={`${w.ratio}x their usual`}
            tone="ok"
            format={w.format}
            title={w.headline ?? w.name}
            signal={`${w.client}${data?.winnersLabel ? ` · ${data.winnersLabel}` : ""}`}
            why={w.text ? w.text.slice(0, 180) : null}
            foot={w.result ? `Beat their usual cost per ${w.result}` : ""}
            busy={busy === `w-${w.id}`}
            disabled={Boolean(busy) || !aiOn}
            action="Brief from this"
            label="brief from a winner+brief self-review"
            onClick={() => run(`w-${w.id}`, () => ideaDraft({ kind: "winner", winner: w }, clientId, w.format))}
          />
        ))}
      </Section>

      <Section n="03" title="In the market" sub={`Live ads from their competitors and brands like them${data?.marketLabel ? ` in ${data.marketLabel.toLowerCase()}` : ""}, from Motion: the longest running, and new ones live 14+ days.`} loading={loading} empty="No market ads matched to them yet." count={data?.market.length ?? 0}>
        {(data?.market ?? []).map((a) => {
          const img = a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null;
          return (
            <Card
              key={`m-${a.id}`}
              thumb={img}
              video={!img ? (a.media[0]?.url ?? null) : null}
              ratio="4/5"
              chip={a.daysActive != null ? `Live ${a.daysActive} days` : "Live"}
              tone="neutral"
              format={marketFormat(a)}
              title={a.angle ?? a.headline ?? "Untitled ad"}
              signal={a.brand}
              why={a.why ?? null}
              foot=""
              busy={busy === `m-${a.id}`}
              disabled={Boolean(busy) || !aiOn}
              action="Brief from this"
              label="brief from a market ad+brief self-review"
              onClick={() => run(`m-${a.id}`, () => ideaDraft({ kind: "market", adId: a.id }, clientId, marketFormat(a)))}
            />
          );
        })}
      </Section>

      <section className="grid gap-5">
        <SectionHead n="04" title="Create your own" sub="Write the brief yourself, or talk the idea through with the strategist and it writes it with you." />
        <div className="grid gap-4 md:grid-cols-2">
          <button type="button" onClick={onManual} className="group grid min-h-[200px] content-between gap-6 rounded-[24px] border border-line bg-surface p-6 text-left transition hover:-translate-y-0.5 hover:border-faint md:p-7">
            <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-surface-2 text-[22px]">✎</span>
            <span className="grid gap-1.5">
              <span className="font-heading text-[22px] leading-tight">Write it myself</span>
              <span className="text-[14px] leading-relaxed text-muted">Formats, direction and the brief, step by step. The AI suggests along the way and reviews it before it goes.</span>
              <span className="pt-2 text-[13px] text-faint group-hover:text-fg">Start writing →</span>
            </span>
          </button>
          <button type="button" onClick={onTalk} disabled={!aiOn} className="group relative isolate grid min-h-[200px] content-between gap-6 overflow-hidden rounded-[24px] border border-brand/40 bg-brand-soft/40 p-6 text-left transition hover:-translate-y-0.5 hover:border-brand/70 disabled:opacity-50 md:p-7">
            <span aria-hidden className="pointer-events-none absolute -right-12 -top-16 -z-10 h-48 w-48 rounded-full bg-brand/25 blur-[70px]" />
            <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-brand text-white">
              <Spark size={20} />
            </span>
            <span className="grid gap-1.5">
              <span className="font-heading text-[22px] leading-tight">Talk it through</span>
              <span className="text-[14px] leading-relaxed text-muted">Tell the strategist the idea in your own words. It asks only what it needs and builds the full brief from {clientName}&rsquo;s Bible, numbers and assets as you go.</span>
              <span className="pt-2 text-[13px] text-brand-text">Start the conversation →</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

function SectionHead({ n, title, sub, count }: { n: string; title: string; sub: string; count?: number }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="grid min-w-0 gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">{n}</span>
        <h2 className="font-heading text-[24px] leading-tight tracking-tight md:text-[26px]">{title}</h2>
        <p className="max-w-2xl text-[14px] text-muted">{sub}</p>
      </div>
      {count != null && count > 0 && <span className="shrink-0 rounded-full bg-surface-2 px-3 py-1 text-[12px] tabular text-muted">{count}</span>}
    </div>
  );
}

function Section({ n, title, sub, loading, empty, count, children }: { n: string; title: string; sub: string; loading: boolean; empty: string; count: number; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-5">
      <SectionHead n={n} title={title} sub={sub} count={loading ? undefined : count} />
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <span key={i} className="aspect-[4/5] animate-pulse rounded-[22px] bg-surface-2" />
          ))}
        </div>
      ) : count ? (
        // Phones: one row that scrolls sideways; larger screens: a grid
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">{children}</div>
      ) : (
        <p className="rounded-[18px] border border-dashed border-line px-4 py-8 text-center text-sm text-faint">{empty}</p>
      )}
    </section>
  );
}

const TONE = { warn: "bg-warn text-white", bad: "bg-bad text-white", ok: "bg-ok text-white", brand: "bg-brand text-white", neutral: "bg-black/70 text-white" } as const;

function Card({
  thumb,
  video,
  ratio = "16/11",
  tint,
  fallback,
  chip,
  tone,
  format,
  title,
  signal,
  why,
  foot,
  busy,
  disabled,
  action,
  label = "request from a brief",
  onClick,
}: {
  thumb: string | null;
  video?: string | null;
  ratio?: "16/11" | "4/5";
  tint?: string;
  fallback?: string;
  chip: string;
  tone: keyof typeof TONE;
  format?: Fmt;
  title: string;
  signal: string | null;
  why: string | null;
  foot: string;
  busy: boolean;
  disabled: boolean;
  action: string;
  label?: string;
  onClick: () => void;
}) {
  const media = thumb || video;
  return (
    <article className="group flex w-[80vw] max-w-[340px] shrink-0 snap-start flex-col overflow-hidden rounded-[22px] border border-line bg-surface transition hover:-translate-y-0.5 hover:border-faint sm:w-auto sm:max-w-none">
      <div className={`relative w-full overflow-hidden bg-gradient-to-br ${tint ?? "from-surface-2"} to-surface-2 ${media && ratio === "4/5" ? "aspect-[4/5]" : "aspect-[16/11]"}`}>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
        ) : video ? (
          <video src={`${video}#t=0.5`} muted playsInline preload="none" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 grid place-items-center px-7 text-center font-heading text-[19px] leading-snug text-fg/85">{fallback ?? title}</span>
        )}
        <span className={`absolute left-3 top-3 max-w-[78%] truncate rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE[tone]}`}>{chip}</span>
        {format && <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] text-white backdrop-blur">{FMT[format]}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <p className="line-clamp-2 font-heading text-[16.5px] leading-snug">{title}</p>
        {signal && <p className="line-clamp-2 text-[13px] font-medium text-fg/80">{signal}</p>}
        {why && <p className="line-clamp-3 text-[13px] leading-relaxed text-muted">{why}</p>}
        <div className="mt-auto grid gap-2 pt-3">
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
