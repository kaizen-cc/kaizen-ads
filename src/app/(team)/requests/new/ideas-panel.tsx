"use client";

import { AiProgressButton } from "@/components/ai-progress";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Winner } from "@/lib/industry";
import type { MarketAd } from "@/lib/market";
import type { Draft } from "./draft";
import { ideaDraft, ideaPreviews, industryWinnersFor, marketFor, type IdeaPreview, type IdeaSource, type WinnersResult } from "./actions";

/**
 * Beside the request: what's winning in our accounts for clients like this one, and what's live from the brands most
 * like them in the market, matched to the format being requested (one at a time when it's several). Each says in a
 * line why it suits this client; hover (or tap) for the gist of the brief, and "View suggested brief" has the
 * strategist write the whole request from that ad, for that format, and drops it into the form.
 */

type Fmt = "image" | "video" | "carousel";
const NAME: Record<Fmt, string> = { image: "Image", video: "Video", carousel: "Carousel" };
const marketFormat = (a: MarketAd): Fmt => (a.format === "carousel" ? "carousel" : a.format === "video" || (!a.media.some((m) => m.type === "image") && a.media[0]?.type === "video") ? "video" : "image");

export function IdeasPanel({ clientId, formats, onBrief }: { clientId: string; formats: Fmt[]; onBrief: (patch: Partial<Draft>) => void }) {
  const [winners, setWinners] = useState<WinnersResult | null>(null);
  const [market, setMarket] = useState<{ label: string | null; ads: MarketAd[] } | null>(null);
  const [previews, setPreviews] = useState<Record<string, IdeaPreview>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Fmt | null>(null);
  const [applied, setApplied] = useState<{ format: Fmt; aside: Fmt[] } | null>(null);
  // The format the suggestions are for: the one picked here, else the first the request asks for
  const format: Fmt | null = pick && formats.includes(pick) ? pick : (formats[0] ?? null);

  useEffect(() => {
    let live = true;
    industryWinnersFor(clientId).then((w) => live && setWinners(w));
    marketFor(clientId).then((m) => live && setMarket(m));
    return () => {
      live = false;
    };
  }, [clientId]);

  // Matching the format first; when nothing matches, the closest ideas (the brief is still written for the format)
  const match = <T,>(xs: T[], fmt: (x: T) => Fmt) => {
    if (!format) return { list: xs.slice(0, 4), exact: true };
    const same = xs.filter((x) => fmt(x) === format);
    return same.length ? { list: same.slice(0, 4), exact: true } : { list: xs.slice(0, 3), exact: false };
  };
  const ws = useMemo(() => match(winners?.winners ?? [], (w) => w.format), [winners, format]); // eslint-disable-line react-hooks/exhaustive-deps
  const ms = useMemo(() => match(market?.ads ?? [], marketFormat), [market, format]); // eslint-disable-line react-hooks/exhaustive-deps

  // Why each suits this client, and its brief in short: one AI call for what's shown, kept a day
  const shownKey = [...ws.list.map((w) => `w-${w.id}`), ...ms.list.map((a) => `m-${a.id}`)].join(",");
  useEffect(() => {
    if (!winners || !market) return;
    const sources: IdeaSource[] = [
      ...ws.list.map((w): IdeaSource => ({ key: `w-${w.id}`, kind: "winner", title: w.headline ?? w.name, text: w.text, meta: `${w.format}, ${w.ratio}x better cost per ${w.result ?? "result"} than that account's usual` })),
      ...ms.list.map((a): IdeaSource => ({ key: `m-${a.id}`, kind: "market", title: a.angle ?? a.headline ?? "Untitled ad", text: a.body ?? a.why, meta: `${marketFormat(a)}${a.daysActive != null ? `, live ${a.daysActive} days` : ""}` })),
    ].filter((x) => !previews[x.key]);
    if (!sources.length) return;
    let live = true;
    void ideaPreviews(clientId, sources).then((p) => live && setPreviews((x) => ({ ...x, ...p })));
    return () => {
      live = false;
    };
  }, [shownKey, clientId, winners, market]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (key: string, source: Parameters<typeof ideaDraft>[0]) => {
    setError(null);
    setBusy(key);
    const r = await ideaDraft(source, clientId, format ?? undefined);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    if (format) setApplied({ format, aside: formats.filter((f) => f !== format) });
    onBrief(r.patch);
  };

  const loadingPreviews = (key: string) => Boolean(winners && market) && !previews[key];
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      {error && <p className="rounded-[10px] border border-bad/30 bg-bad-soft px-3 py-2 text-xs text-bad">{error}</p>}
      {applied && applied.aside.length > 0 && (
        <p className="rounded-[10px] border border-warn/30 bg-warn-soft px-3 py-2 text-xs leading-relaxed">
          The brief is for the {NAME[applied.format].toLowerCase()}, so this request is now {NAME[applied.format].toLowerCase()} only. Submit it, then start a request for the {applied.aside.map((f) => NAME[f].toLowerCase()).join(" and ")} with its own brief.
        </p>
      )}
      {formats.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-faint">Ideas for</span>
          {formats.map((f) => (
            <button key={f} type="button" onClick={() => setPick(f)} className={`h-8 rounded-full px-3 text-xs transition-colors max-md:h-10 ${f === format ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
              {NAME[f]}
            </button>
          ))}
        </div>
      )}
      <Widget
        title="From our winners"
        sub={`${format && ws.exact ? `${NAME[format]} ads beating` : "Beating"} their own account${winners?.label ? `, in ${winners.label.toLowerCase()}` : ""}`}
        note={format && !ws.exact && ws.list.length ? `No ${NAME[format].toLowerCase()} winners yet: these are the closest, and the brief is written as a ${NAME[format].toLowerCase()}.` : null}
        loading={winners === null}
        empty="No winners in their industry yet."
        more="/ideas?tab=winners"
      >
        {ws.list.map((w: Winner) => (
          <Item
            key={w.id}
            thumb={w.thumbnail}
            title={w.headline ?? w.name}
            meta={`${w.client} · ${w.ratio}x their usual`}
            format={w.format}
            preview={previews[`w-${w.id}`]}
            previewLoading={loadingPreviews(`w-${w.id}`)}
            busy={busy === `w-${w.id}`}
            disabled={Boolean(busy)}
            onCreate={() => create(`w-${w.id}`, { kind: "winner", winner: w })}
            label="brief from a winner+brief self-review"
          />
        ))}
      </Widget>
      <Widget
        title="From the market"
        sub={`${format && ms.exact ? `Live ${NAME[format].toLowerCase()} ads` : "Live ads"} from the brands most like them, from Motion`}
        note={format && !ms.exact && ms.list.length ? `No live ${NAME[format].toLowerCase()} ads from these brands yet: these are the closest, and the brief is written as a ${NAME[format].toLowerCase()}.` : null}
        loading={market === null}
        empty="No market ads matched to them yet."
        more={`/ideas?tab=market&client=${clientId}`}
      >
        {ms.list.map((a) => (
          <Item
            key={a.id}
            thumb={a.media.find((m) => m.type === "image")?.url ?? a.media[0]?.thumb ?? null}
            video={!a.media.some((m) => m.type === "image") && !a.media[0]?.thumb ? (a.media[0]?.url ?? null) : null}
            title={a.angle ?? a.headline ?? "Untitled ad"}
            meta={`${a.brand}${a.daysActive != null ? ` · live ${a.daysActive} days` : ""}`}
            format={marketFormat(a)}
            preview={previews[`m-${a.id}`]}
            previewLoading={loadingPreviews(`m-${a.id}`)}
            busy={busy === `m-${a.id}`}
            disabled={Boolean(busy)}
            onCreate={() => create(`m-${a.id}`, { kind: "market", adId: a.id })}
            label="brief from a market ad+brief self-review"
          />
        ))}
      </Widget>
    </div>
  );
}

function Widget({ title, sub, note, loading, empty, more, children }: { title: string; sub: string; note: string | null; loading: boolean; empty: string; more: string; children: React.ReactNode[] }) {
  return (
    <section className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px] leading-snug text-faint">{sub}</p>
        </div>
        <Link href={more} className="-my-2 shrink-0 py-2 pl-2 text-[11px] text-muted hover:text-fg md:my-0 md:py-0 md:pl-0">
          More →
        </Link>
      </div>
      {note && <p className="text-[11px] leading-relaxed text-warn">{note}</p>}
      {loading ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-12 animate-pulse rounded-[10px] bg-surface-2" />
          ))}
        </div>
      ) : children.length ? (
        <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">{children}</ul>
      ) : (
        <p className="text-xs text-faint">{empty}</p>
      )}
    </section>
  );
}

function Item({
  thumb,
  video,
  title,
  meta,
  format,
  preview,
  previewLoading,
  busy,
  disabled,
  onCreate,
  label,
}: {
  thumb: string | null;
  video?: string | null;
  title: string;
  meta: string;
  format: Fmt;
  preview: IdeaPreview | undefined;
  previewLoading: boolean;
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-[10px] p-1.5 transition-colors hover:bg-surface-2/60" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-start gap-3 text-left">
        <span className="relative mt-0.5 h-12 w-12 shrink-0 overflow-hidden rounded-[8px] bg-surface-2">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : video ? (
            <video src={`${video}#t=0.5`} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" />
          ) : null}
          <span className="absolute bottom-0.5 left-0.5 rounded-full bg-black/65 px-1.5 text-[9px] font-medium text-white">{NAME[format]}</span>
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="line-clamp-2 break-words text-[12.5px] leading-snug">{title}</span>
          <span className="truncate text-[11px] text-faint">{meta}</span>
          {/* Why it suits this client, in a line */}
          {preview ? (
            <span className="line-clamp-2 text-[11.5px] leading-snug text-ok">{preview.why}</span>
          ) : previewLoading ? (
            <span className="mt-0.5 h-3 w-4/5 animate-pulse rounded bg-surface-2" />
          ) : null}
        </span>
      </button>

      {/* The brief in short: opens in place on hover (a tap on phones) */}
      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${open && preview ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
        <div className="overflow-hidden">
          {preview && (
            <dl className="grid gap-1.5 rounded-[10px] border border-line bg-bg/50 p-3 text-[11.5px] leading-relaxed">
              <div>
                <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Angle</dt>
                <dd>{preview.angle}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">Hook</dt>
                <dd>&ldquo;{preview.hook}&rdquo;</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">The creative</dt>
                <dd className="text-muted">{preview.concept}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">What we&apos;d make</dt>
                <dd className="text-muted">{preview.formats}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onCreate}
        disabled={disabled}
        className={`h-10 rounded-full text-xs font-medium transition-colors md:h-8 ${busy ? "bg-brand-soft text-brand-text" : "border border-line text-muted hover:border-brand/50 hover:text-fg disabled:opacity-50"}`}
      >
        {busy ? <AiProgressButton label={label} fallbackMs={70_000} /> : "View suggested brief"}
      </button>
    </li>
  );
}
