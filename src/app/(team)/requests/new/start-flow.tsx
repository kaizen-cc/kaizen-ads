"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABEL, type SuggestionKind } from "@/lib/suggestion-kinds";
import type { Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { StartData } from "@/lib/request-start";
import { allotmentPools, cycleElapsed, type Allotment } from "@/lib/allotment";
import { AllotmentPools } from "@/components/allotment-pools";
import type { Draft } from "./draft";
import type { ClientOption } from "./parts";
import { Spark } from "./parts";
import { moreMarket } from "./actions";
import type { BriefSource, QuickBrief } from "@/lib/quick-brief";
import { BriefJobSlot } from "@/components/brief-jobs";
import type { WinnerSource } from "@/lib/suggestions";
import { isTikTokWinner, winnerChip, winnerFoot, winnerMetaAdId, winnerSourceOf } from "@/lib/winner-source";
import { RefThumb } from "@/components/ref-thumb";
import { useCreativeFormats } from "@/components/creative-formats-provider";
import { fitsFormat, marketFormatOf } from "@/lib/creative-formats";
import { dismissSave, findSave, InMotionNote, SaveIdeaStar, seedSaves, useSaves, refreshSaves } from "@/components/save-idea-star";
import { EmptyState } from "@/components/empty-state";
import { metaAdId, savedHref, SOURCE_LABEL, type SaveInput, type SavedRef, type SavedSource } from "@/lib/saved-references";

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

/** Read the client's start page again next time (a saved reference was just used up) */
export function forgetStart(clientId: string) {
  cache.delete(clientId);
  refreshSaves();
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

// ─── The quick preview: every way into a brief opens it first ──────────────────────────────────────────────

/** A brief about to be previewed (serializable: it's kept with the request in progress, for a split's next briefs) */
export type PreviewItem = {
  key: string;
  source: BriefSource;
  from: { kicker: string; label: string; thumb?: string | null; adId?: string | null; format?: Fmt | null };
  /** The AI label the full write is timed by */
  progressLabel: string;
  /** Already agreed (the next brief of a split) */
  given?: QuickBrief | null;
  /** A saved reference it's built on: used up once sent */
  savedRefId?: string | null;
  /** A promise from a call it delivers */
  promiseId?: string | null;
  /** Where it came from, for ideas in words */
  origin?: Draft["origin"];
};

// A Meta winner, or one of our own TikTok winners (labelled TikTok, with its numbers and link, its picture from the TikTok sync)
const winnerSource = (w: Winner): WinnerSource => winnerSourceOf(w);

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
  // Pace through the billing cycle: the pool furthest behind (used share vs how far into the cycle we are), overages last
  const paceOf = (c: ClientOption): { group: "behind" | "pace" | "over" | "none"; score: number } => {
    const a = allotments[c.id];
    const pools = allotmentPools(a);
    if (!pools.length) return { group: "none", score: 1e9 };
    const over = pools.filter((p) => p.over > 0);
    if (over.length) return { group: "over", score: 1e6 + Math.max(...over.map((p) => p.over / Math.max(1, p.cap))) };
    const elapsed = Math.max(0.05, cycleElapsed(a?.cycle));
    const ratio = Math.min(...pools.map((p) => p.used / Math.max(1, p.cap) / elapsed));
    return { group: ratio < 0.7 ? "behind" : "pace", score: ratio };
  };
  const matches = useMemo(() => {
    if (!term) return [...creative].sort((a, b) => paceOf(a).score - paceOf(b).score || a.name.localeCompare(b.name));
    return clients
      .map((c) => {
        const n = c.name.toLowerCase();
        const i = n.indexOf(term);
        return i < 0 ? null : { c, rank: i === 0 ? 0 : /\s|[-&.]/.test(n[i - 1]) ? 1 : 2 };
      })
      .filter((x): x is { c: ClientOption; rank: number } => x !== null)
      .sort((a, b) => Number(b.c.creative) - Number(a.c.creative) || a.rank - b.rank || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, creative, term, allotments]);
  const pickable = matches.filter((c) => c.creative);

  const pick = (c: ClientOption) => {
    if (!c.creative) return;
    rememberClient(c.id);
    onPick(c);
  };
  // Per pool, the overage in red (never summed, never clamped): one helper for every screen
  // With what's in progress for them (board and Asana, not delivered yet), so "0 of 25 used" never reads as room for 25
  const left = (c: ClientOption) => <AllotmentPools allotment={allotments[c.id]} empty={null} progress />;
  const hasPools = (c: ClientOption) => allotmentPools(allotments[c.id]).length > 0;

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
                  <span className="text-[12px] text-faint">{hasPools(c) ? left(c) : "On a creative package"}</span>
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
          {matches.map((c, i) => {
            const on = c.creative && pickable[active]?.id === c.id && Boolean(term);
            const g = term ? null : paceOf(c).group;
            const head = g && (i === 0 || paceOf(matches[i - 1]).group !== g) ? { behind: "Behind pace", pace: "On pace", over: "Over their allotment", none: "No allotment set" }[g] : null;
            return (
              <Fragment key={c.id}>
              {head && <p className={`col-span-full mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${g === "over" ? "text-bad" : g === "behind" ? "text-warn" : g === "pace" ? "text-ok" : "text-faint"}`}>{head}</p>}
              <button
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
                  <span className="truncate text-[11.5px] text-faint">{c.creative ? (hasPools(c) ? left(c) : "On a creative package") : "No creative package"}</span>
                </span>
              </button>
              </Fragment>
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
const marketFormat = (a: MarketAd): Fmt => marketFormatOf(a);
const marketStill = (a: MarketAd) => a.media.find((m) => m.type === "image")?.url ?? a.media.find((m) => m.thumb)?.thumb ?? null;
const marketVideo = (a: MarketAd) => a.media.find((m) => m.type === "video")?.url ?? null;
// A tint per kind of brief, for cards without a picture
const KIND_TINT: Partial<Record<string, string>> = {
  fatigue: "from-warn/35", refresh: "from-warn/35", kpi: "from-bad/35", flop: "from-bad/35", unhappy: "from-bad/35", pacing: "from-bad/30",
  moment: "from-ok/30", pattern: "from-[#5b8def]/35", call: "from-brand/35", offer: "from-brand/35",
};

// What a star saves, per kind of card (each carries the brief source, so a saved one briefs the same way later)
const saveMarket = (a: MarketAd): SaveInput => ({ source: "market", refId: a.id, url: a.motionUrl ?? a.libraryUrl ?? a.landingUrl, thumbnail: marketStill(a), title: a.angle ?? a.headline ?? "Untitled ad", subtitle: a.brand, format: marketFormat(a), data: { video: marketVideo(a), days: a.daysActive, brief: { kind: "market", adId: a.id, format: marketFormat(a) } } });
const saveWinner = (w: Winner): SaveInput => ({
  source: "winner",
  refId: w.id,
  url: isTikTokWinner(w) ? (w.link ?? null) : null,
  thumbnail: w.thumbnail,
  title: w.headline ?? w.name,
  subtitle: `${isTikTokWinner(w) ? "TikTok · " : ""}${w.client}${w.detail ? ` · ${w.detail}` : ""}`,
  format: w.format,
  data: { winner: w, why: w.match?.why ?? null, brief: { kind: "winner", winner: winnerSource(w), format: w.format }, ...(isTikTokWinner(w) ? { platform: "tiktok" } : {}) },
});
const savePattern = (p: StartData["patterns"][number]): SaveInput => ({ source: "pattern", refId: p.id, url: null, thumbnail: null, title: p.title, subtitle: p.group, format: null, data: { detail: p.detail, brief: { kind: "pattern", patternId: p.id } } });
const saveBrief = (b: StartData["briefs"][number]): SaveInput => ({ source: "brief", refId: b.id, url: null, thumbnail: b.thumb, title: b.title || b.signal, subtitle: b.title ? b.signal : null, format: null, data: { adId: b.adId, brief: { kind: "suggestion", id: b.id } } });

/** The AI label a brief from each kind of source is timed by */
const PROGRESS: Partial<Record<BriefSource["kind"], string>> = {
  winner: "brief from a winner+brief self-review",
  market: "brief from a market ad+brief self-review",
  pattern: "brief from a pattern+brief self-review",
  suggestion: "brief rewrite from a preview+brief self-review",
  promise: "brief from a call+brief self-review",
  idea: "brief from an idea+brief self-review",
};

/** The brief a saved idea is briefed from here (a tiring ad's refresh becomes an idea in words: the form writes ideas) */
function savedSource(s: SavedRef): BriefSource | null {
  const b = s.data.brief as BriefSource | undefined;
  if (b && typeof b === "object" && "kind" in b) {
    if (b.kind === "refresh") return { kind: "idea", label: `A refresh for a tiring ad: ${s.title ?? "an ad"}`.slice(0, 200), text: `Refresh this tiring ad with a new hook or visual, same idea: ${s.title ?? ""}` };
    return b.kind === "talk" ? null : b;
  }
  // Saved before stars carried their brief
  if (s.source === "market") return { kind: "market", adId: s.refId, format: s.format ?? undefined };
  if (s.source === "winner" && s.data.winner) return { kind: "winner", winner: winnerSource(s.data.winner as Winner), format: s.format ?? undefined };
  if (s.source === "pattern") return { kind: "pattern", patternId: s.refId };
  if (s.source === "brief") return { kind: "suggestion", id: s.refId };
  if (s.source === "promise") return { kind: "promise", commitmentId: s.refId };
  // A link saved for later (Motion, Pinterest, Instagram, TikTok, the Ads Library, YouTube, any page): an idea built on it
  if (s.source === "link" && s.url)
    return { kind: "idea", label: `A saved reference: ${s.title ?? s.url}`.slice(0, 200), text: `Build this client's version of what this reference does well (keep the link in the brief's references and say what to take from it): ${s.url}${s.subtitle ? ` (${s.subtitle})` : ""}` };
  return null;
}

export function StartPage({
  clientId,
  clientName,
  aiOn,
  promises,
  onPreview,
  onManual,
  onTalk,
}: {
  clientId: string;
  clientName: string;
  aiOn: boolean;
  /** The promises strip, given what was already read */
  promises: (list: StartData["promises"]) => React.ReactNode;
  /** Open the quick preview for a card */
  onPreview: (item: PreviewItem) => void;
  onManual: () => void;
  onTalk: () => void;
}) {
  const { data, failed } = useStart(clientId);
  // This person's saves (every star on the page shares them); what the server read shows until they're in
  const everything = useSaves();
  useEffect(() => {
    if (data?.saved) seedSaves(clientId, data.saved);
  }, [data, clientId]);
  const mine = everything ?? data?.saved ?? [];
  // Read for this person's formats on the server already; a star added here keeps to them too
  const allowed = useCreativeFormats();
  const saved = mine.filter((s) => s.clientId === clientId && fitsFormat(allowed, s.format));
  const find = (source: SavedSource, refId: string) => findSave(mine, clientId, { source, refId });
  const star = (input: SaveInput) => <SaveIdeaStar idea={input} clientId={clientId} clientName={clientName} variant="overlay" />;
  // A brief from a card: its quick preview first. When the card is saved, the request it becomes uses it up
  const savedId = (from: SavedRef | null) => (from && !from.id.startsWith("tmp-") && !from.motion ? from.id : null);

  const briefFromSaved = (s: SavedRef) => {
    const source = savedSource(s);
    if (!source) return;
    onPreview({
      key: `sv-${s.id}`,
      source,
      from: { kicker: SOURCE_LABEL[s.source], label: s.title ?? "Saved idea", thumb: s.thumbnail, adId: metaAdId(s), format: s.format ?? null },
      progressLabel: PROGRESS[source.kind] ?? "brief from an idea+brief self-review",
      savedRefId: savedId(s),
    });
  };

  // In the market: a page at a time, "See more" brings the next
  const [extra, setExtra] = useState<{ id: string; ads: MarketAd[]; more: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const market = [...(data?.market ?? []), ...(extra?.id === clientId ? extra.ads : [])].filter((a) => allowed.has(marketFormat(a)));
  const marketMore = extra?.id === clientId ? extra.more : (data?.marketMore ?? false);
  const seeMore = async () => {
    setLoadingMore(true);
    const r = await moreMarket(clientId, market.length).catch(() => ({ ads: [] as MarketAd[], more: false }));
    setLoadingMore(false);
    const seen = new Set(market.map((a) => a.id));
    setExtra({ id: clientId, ads: [...(extra?.id === clientId ? extra.ads : []), ...r.ads.filter((a) => !seen.has(a.id))], more: r.more });
  };

  const loading = !data && !failed;
  const similar = (data?.patterns.length ?? 0) + (data?.winners.length ?? 0);
  const what = data?.detail ? data.detail.toLowerCase() : null;
  const similarSub =
    (data?.winners.length ?? 1) > 0
      ? `What's proven for businesses like them and winning ads from accounts selling the same thing or in the same niche${what ? ` as ${what}` : ""}. Each card says why it matched.`
      : `What's proven across businesses like them. No winning ads yet from clients selling what ${clientName} sells${what ? ` (${what})` : ""} or in the same niche, so none are shown.`;
  const marketHref = `/market?client=${clientId}`;

  // The owner's rule: winners only from clients selling the same thing or in the same niche. When there are none, no
  // winners section: lead with what we promised instead (patterns stay, they're proven across the group). Either way
  // the critical ones come first (promises, what's wearing out), then what this person saved, then ideas to browse
  const winnersHere = loading || (data?.winners.length ?? 0) > 0;
  const showSimilar = winnersHere || (data?.patterns.length ?? 0) > 0;
  const order: ("fix" | "promises" | "saved" | "similar" | "market")[] = winnersHere ? ["fix", "promises", "saved", "similar", "market"] : ["promises", "fix", "saved", "market", "similar"];
  const numbered = order.filter((k) => k !== "promises" && (k !== "similar" || showSimilar));
  const num = (k: (typeof order)[number]) => String(numbered.indexOf(k) + 1).padStart(2, "0");

  const fixSection = (
    <Section
      n={num("fix")}
      title="Fix what's wearing out or off"
      sub={`Briefs the strategist already wrote for ${clientName}: ads tiring, numbers off, moments coming up.`}
      loading={loading}
      empty={<EmptyState title="All clear" line={`nothing tiring or off for ${clientName} right now`} />}
      count={data?.briefs.length ?? 0}
    >
      {(data?.briefs ?? []).map((b) => (
        <Card
          key={b.id}
          thumb={b.thumb}
          adId={b.adId}
          tint={KIND_TINT[b.kind]}
          fallback={b.signal}
          chip={KIND_LABEL[b.kind as SuggestionKind] ?? b.kind}
          tone={["fatigue", "refresh"].includes(b.kind) ? "warn" : ["kpi", "flop", "unhappy", "pacing"].includes(b.kind) ? "bad" : "brand"}
          title={b.title || b.signal}
          signal={b.title ? b.signal : null}
          why={b.why}
          foot={b.formats}
          busy={false}
          disabled={false}
          action="Brief on this"
          onClick={() => onPreview({ key: `s-${b.id}`, source: { kind: "suggestion", id: b.id }, from: { kicker: KIND_LABEL[b.kind as SuggestionKind] ?? "Suggested brief", label: b.signal, thumb: b.thumb, adId: b.adId }, progressLabel: "brief rewrite from a preview+brief self-review", savedRefId: savedId(find("brief", b.id)) })}
          star={star(saveBrief(b))}
          brief={{ source: { kind: "suggestion", id: b.id }, clientId }}
        />
      ))}
    </Section>
  );
  const promisesStrip = !data ? null : (
    <div className={order[0] === "promises" ? "" : "-mt-4"}>
      {data.promises.length > 0 ? promises(data.promises) : <EmptyState title="Nothing promised and waiting" line={`every promise from ${clientName}'s calls is in motion`} />}
    </div>
  );
  const savedSection = (
    <section className="grid min-w-0 gap-5">
      <SectionHead n={num("saved")} title="Things you've saved" sub={`Ideas you starred for ${clientName} anywhere in the app, not briefed yet. When someone else briefs one, it says who has it.`} count={saved.length} />
      {saved.length ? (
        <Carousel label="Things you've saved">
          {saved.map((s) => {
            const source = savedSource(s);
            const canBrief = Boolean(source) && (aiOn || source?.kind === "suggestion");
            return (
              <Card
                key={`sv-${s.id}`}
                fixed
                thumb={s.thumbnail}
                adId={metaAdId(s)}
                video={typeof s.data.video === "string" ? s.data.video : null}
                ratio={s.thumbnail || metaAdId(s) || s.data.video ? "4/5" : "16/11"}
                tint={s.source === "pattern" ? "from-[#5b8def]/35" : s.source === "fatigue" ? "from-warn/35" : s.source === "audit_idea" || s.source === "ai" ? "from-brand/30" : undefined}
                fallback={s.title ?? undefined}
                chip={SOURCE_LABEL[s.source]}
                tone={s.motion ? "ok" : "neutral"}
                format={s.format ?? undefined}
                title={s.title ?? "Untitled"}
                signal={s.subtitle}
                why={typeof s.data.why === "string" ? s.data.why : typeof s.data.detail === "string" ? s.data.detail : null}
                foot={s.motion ? "" : `Saved ${new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                busy={false}
                disabled={!canBrief || s.id.startsWith("tmp-")}
                action="Brief on this"
                onClick={() => briefFromSaved(s)}
                notice={s.motion ? <InMotionNote s={s} onDismiss={() => void dismissSave(s.id)} /> : null}
                star={s.motion ? null : star(s)}
                brief={source ? { source, clientId } : null}
                link={savedHref(s)}
              />
            );
          })}
        </Carousel>
      ) : (
        <EmptyState tone="neutral" icon="star" title="Nothing saved yet" line={`star an idea anywhere (the market, winners, audits) and it waits here for ${clientName}`} action={{ label: "Browse in the market", href: marketHref }} />
      )}
    </section>
  );
  const similarSection = showSimilar ? (
    <Section
      n={num("similar")}
      title={winnersHere ? "Working for similar clients" : "Proven for businesses like them"}
      sub={similarSub}
      loading={loading}
      empty={<EmptyState tone="neutral" icon="spark" title="Nothing proven yet" line={`for businesses like ${clientName}; their market has fresh ideas meanwhile`} action={{ label: "Browse in the market", href: marketHref }} />}
      count={similar}
    >
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
          busy={false}
          disabled={!aiOn}
          action="Brief on this"
          onClick={() => onPreview({ key: `p-${p.id}`, source: { kind: "pattern", patternId: p.id }, from: { kicker: `Works for ${p.clients} of ${p.of}`, label: p.title }, progressLabel: "brief from a pattern+brief self-review", savedRefId: savedId(find("pattern", p.id)) })}
          star={star(savePattern(p))}
          brief={{ source: { kind: "pattern", patternId: p.id }, clientId }}
        />
      ))}
      {(data?.winners ?? []).map((w: Winner) => (
        <Card
          key={`w-${w.platform ?? "meta"}-${w.id}`}
          thumb={w.thumbnail}
          adId={winnerMetaAdId(w)}
          ratio="4/5"
          chip={winnerChip(w)}
          tone="ok"
          format={w.format}
          title={w.headline ?? w.name}
          signal={isTikTokWinner(w) ? `TikTok · ${w.client}` : w.client}
          match={w.match ? { text: w.match.why, close: true } : null}
          why={w.text ? w.text.slice(0, 180) : null}
          foot={winnerFoot(w)}
          link={isTikTokWinner(w) ? (w.link ?? null) : null}
          busy={false}
          disabled={!aiOn}
          action="Brief on this"
          onClick={() => onPreview({ key: `w-${w.id}`, source: { kind: "winner", winner: winnerSource(w), format: w.format }, from: { kicker: isTikTokWinner(w) ? `A TikTok winner · ${winnerChip(w).replace(/^TikTok · /, "")}` : `A winner · ${w.ratio}x their usual`, label: w.headline ?? w.name, thumb: w.thumbnail, adId: winnerMetaAdId(w), format: w.format }, progressLabel: "brief from a winner+brief self-review", savedRefId: savedId(find("winner", w.id)) })}
          star={star(saveWinner(w))}
          brief={{ source: { kind: "winner", winner: winnerSource(w), format: w.format }, clientId }}
        />
      ))}
    </Section>
  ) : null;
  const marketSection = (
    <section className="grid min-w-0 gap-5">
      <SectionHead
        n={num("market")}
        title="In the market"
        sub={`Live ads from their competitors and brands like them${data?.marketLabel ? ` in ${data.marketLabel.toLowerCase()}` : ""}, from Motion: the longest running, and new ones live 14+ days. Star one to save it for ${clientName}.`}
        count={loading ? undefined : market.length}
      />
      {loading ? (
        <Skeleton />
      ) : market.length ? (
        <Carousel label="Market ads">
          {market.map((a) => (
            <Card
              key={`m-${a.id}`}
              fixed
              thumb={marketStill(a)}
              video={marketVideo(a)}
              ratio="4/5"
              chip={a.daysActive != null ? `Live ${a.daysActive} days` : "Live"}
              tone="neutral"
              format={marketFormat(a)}
              title={a.angle ?? a.headline ?? "Untitled ad"}
              signal={a.brand}
              match={a.matchWhy ? { text: a.matchWhy, close: (a.matchScore ?? 0) >= 7 } : null}
              why={a.why ?? null}
              foot=""
              busy={false}
              disabled={!aiOn}
              action="Brief on this"
              onClick={() => onPreview({ key: `m-${a.id}`, source: { kind: "market", adId: a.id, format: marketFormat(a) }, from: { kicker: `In the market · ${a.brand}`, label: a.angle ?? a.headline ?? "A live ad", thumb: marketStill(a), format: marketFormat(a) }, progressLabel: "brief from a market ad+brief self-review", savedRefId: savedId(find("market", a.id)) })}
              star={star(saveMarket(a))}
              brief={{ source: { kind: "market", adId: a.id, format: marketFormat(a) }, clientId }}
              link={a.motionUrl ?? a.libraryUrl}
            />
          ))}
          {marketMore && (
            <button
              type="button"
              onClick={() => void seeMore()}
              disabled={loadingMore}
              className="grid w-[60vw] max-w-[220px] shrink-0 snap-start place-items-center rounded-[22px] border border-line bg-surface text-[14px] text-muted transition hover:border-faint hover:text-fg sm:w-[220px]"
            >
              <span className="grid justify-items-center gap-2">
                <span className={`grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-[18px] ${loadingMore ? "animate-pulse" : ""}`}>+</span>
                {loadingMore ? "Loading more…" : "See more"}
              </span>
            </button>
          )}
        </Carousel>
      ) : (
        <EmptyState tone="neutral" icon="calm" title="No market ads matched yet" line="Motion is still finding brands like them" action={{ label: "Browse the whole market", href: "/market" }} />
      )}
    </section>
  );
  const sections = { fix: fixSection, promises: promisesStrip, saved: savedSection, similar: similarSection, market: marketSection };

  return (
    <div className="grid min-w-0 gap-12">
      {failed && <p className="rounded-[14px] border border-line px-4 py-3 text-sm text-muted">Couldn&rsquo;t load the ready-made briefs. You can still create your own below.</p>}

      {order.map((k) => (
        <Fragment key={k}>{sections[k]}</Fragment>
      ))}

      <section className="grid gap-5">
        <SectionHead n={String(numbered.length + 1).padStart(2, "0")} title="Create your own" sub="Write the brief yourself, or talk the idea through with the strategist and it writes it with you." />
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

function Skeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <span key={i} className="aspect-[4/5] animate-pulse rounded-[22px] bg-surface-2" />
      ))}
    </div>
  );
}

function Section({ n, title, sub, loading, empty, count, children }: { n: string; title: string; sub: string; loading: boolean; empty: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-5">
      <SectionHead n={n} title={title} sub={sub} count={loading ? undefined : count} />
      {loading ? (
        <Skeleton />
      ) : count ? (
        // Phones: one row that scrolls sideways; larger screens: a grid
        <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">{children}</div>
      ) : (
        empty
      )}
    </section>
  );
}

/** One row that scrolls sideways: swipe on phones, arrows on larger screens (shown only when there's more that way) */
function Carousel({ label, children }: { label: string; children: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);
  const by = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * Math.max(280, (row.current?.clientWidth ?? 600) * 0.85), behavior: "smooth" });
  const arrow = "absolute top-[38%] z-10 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/95 text-[20px] text-fg shadow-[0_10px_30px_-12px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-faint md:grid";
  return (
    <div className="relative min-w-0" role="region" aria-label={label}>
      <div ref={row} onScroll={measure} className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-4 px-4 pb-2 [scrollbar-width:none] md:mx-0 md:scroll-px-0 md:px-0 [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      {!edge.start && (
        <button type="button" aria-label="Previous" onClick={() => by(-1)} className={`${arrow} -left-5`}>
          ‹
        </button>
      )}
      {!edge.end && (
        <button type="button" aria-label="Next" onClick={() => by(1)} className={`${arrow} -right-5`}>
          ›
        </button>
      )}
    </div>
  );
}

const TONE = { warn: "bg-warn text-white", bad: "bg-bad text-white", ok: "bg-ok text-white", brand: "bg-brand text-white", neutral: "bg-black/70 text-white" } as const;

function Card({
  thumb,
  adId,
  video,
  ratio = "16/11",
  tint,
  fallback,
  chip,
  tone,
  format,
  title,
  signal,
  match,
  why,
  foot,
  busy,
  disabled,
  action,
  onClick,
  star,
  notice,
  link,
  fixed = false,
  brief = null,
}: {
  thumb: string | null;
  /** A Meta ad behind it: its kept picture when the link we have has expired */
  adId?: string | null;
  video?: string | null;
  ratio?: "16/11" | "4/5";
  tint?: string;
  fallback?: string;
  chip: string;
  tone: keyof typeof TONE;
  format?: Fmt;
  title: string;
  signal: string | null;
  /** Why it counts as similar, said plainly; close = same product or niche */
  match?: { text: string; close: boolean } | null;
  why: string | null;
  foot: string;
  busy: boolean;
  disabled: boolean;
  action: string;
  onClick: () => void;
  /** Save for later (a SaveIdeaStar), top right of the picture */
  star?: React.ReactNode;
  /** In place of the action: "already in motion by ..." */
  notice?: React.ReactNode;
  /** Where to see it full size (Motion, the Ad Library) */
  link?: string | null;
  /** A set width, for a sideways row */
  fixed?: boolean;
  /** What its brief is written from: its background job shows here in place of the action */
  brief?: { source: BriefSource; clientId: string } | null;
}) {
  const media = thumb || adId || video;
  return (
    <article className={`group flex shrink-0 snap-start flex-col overflow-hidden rounded-[22px] border border-line bg-surface transition hover:-translate-y-0.5 hover:border-faint ${fixed ? "w-[78vw] max-w-[300px] sm:w-[290px]" : "w-[80vw] max-w-[340px] sm:w-auto sm:max-w-none"}`}>
      <div className={`relative w-full overflow-hidden bg-gradient-to-br ${tint ?? "from-surface-2"} to-surface-2 ${media && ratio === "4/5" ? "aspect-[4/5]" : "aspect-[16/11]"}`}>
        {media ? <RefThumb src={thumb} adId={adId} video={video} format={format} /> : <span className="absolute inset-0 grid place-items-center px-7 text-center font-heading text-[19px] leading-snug text-fg/85">{fallback ?? title}</span>}
        <span className={`absolute left-3 top-3 max-w-[64%] truncate rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE[tone]}`}>{chip}</span>
        {star && <span className="absolute right-2 top-2">{star}</span>}
        {format && <span className="absolute bottom-3 left-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] text-white backdrop-blur">{FMT[format]}</span>}
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="absolute bottom-2 right-2 grid h-11 min-w-11 place-items-center rounded-full bg-black/55 px-3 text-[12px] text-white opacity-100 backdrop-blur transition hover:bg-black/75 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100">
            Open ↗
          </a>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <p className="line-clamp-2 font-heading text-[16.5px] leading-snug">{title}</p>
        {signal && <p className="line-clamp-2 text-[13px] font-medium text-fg/80">{signal}</p>}
        {match && (
          <p className={`flex items-start gap-1.5 text-[12.5px] leading-snug ${match.close ? "text-ok" : "text-warn"}`}>
            <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            <span className="line-clamp-2">{match.text}</span>
          </p>
        )}
        {why && <p className="line-clamp-3 text-[13px] leading-relaxed text-muted">{why}</p>}
        <div className="mt-auto grid gap-2 pt-3">
          {foot && <p className="text-[12px] text-faint">{foot}</p>}
          {notice ?? (
            // Its brief being written in the background: the progress here, then "Brief ready · Open"
            <BriefJobSlot source={brief?.source} clientId={brief?.clientId ?? null}>
              <button
                type="button"
                onClick={onClick}
                disabled={disabled}
                className={`min-h-11 rounded-full px-4 text-[14px] font-medium transition-colors ${busy ? "bg-brand-soft text-brand-text" : "bg-fg text-bg hover:opacity-90 disabled:opacity-40"}`}
              >
                {action}
              </button>
            </BriefJobSlot>
          )}
        </div>
      </div>
    </article>
  );
}
