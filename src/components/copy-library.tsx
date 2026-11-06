"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { LogoLoader } from "@/components/logo-loader";
import { makeCopyVariations, starCopyLine } from "@/app/(team)/copy-library-actions";
import { BADGE_LABEL, filterCopy, KIND_LABEL, limitOf, PLATFORM_LABEL, type CopyBadge, type CopyKind, type CopyPlatform } from "@/lib/copy-library-core";
import type { CopyLibrary as Library, LibraryLine } from "@/lib/copy-library";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";

// The Copy library: every primary text, headline and description that ran in Meta, and every Google headline,
// description, sitelink and callout (with Google's own rating), with how it did against the KPI,
// ranked and badged. Search and filters live in the address (back returns to them). Each line copies in one tap, can
// be starred for the team, turned into variations by the Copywriter, or taken into a new request. One client (the
// client page) or every client the person can see, filtered by industry and sub-vertical (Ideas).

type Variation = { text: string; reason: string; chars: number };
type Saved = { id: string; variations: Variation[]; note: string | null; created_at: string; profiles: { full_name: string } | null };

const BADGE_TONE: Record<CopyBadge, string> = { winner: "bg-ok-soft text-ok", solid: "bg-brand/15 text-brand-text", tired: "bg-warn-soft text-warn", unproven: "bg-surface-2 text-muted" };
const SINCE = [
  ["", "Any time"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["180", "Last 6 months"],
  ["365", "Last year"],
] as const;
const money = (x: number) => `$${x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : Math.round(x)}`;
const select = "h-11 shrink-0 rounded-full border border-line bg-surface px-3.5 text-[13px] text-fg outline-none focus:border-faint md:h-9";

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600);
    } catch {
      setCopied(null);
    }
  };
  return { copied, copy };
}

export function CopyLibrary({ clientId, slug, title = "Copy library" }: { clientId?: string; slug?: string; title?: string }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [failed, setFailed] = useState(false);
  const [stars, setStars] = useState<Record<string, boolean>>({});
  const platform = useParam("cl_plat") as CopyPlatform | null;
  const kind = useParam("cl_kind") as CopyKind | null;
  const badge = useParam("cl_badge") as CopyBadge | null;
  const angle = useParam("cl_angle");
  const avatar = useParam("cl_avatar");
  const since = useParam("cl_since");
  const industry = useParam("cl_ind");
  const vertical = useParam("cl_vert");
  const open = useParam("cl_line");
  const urlQ = useParam("cl_q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [shown, setShown] = useState(40);

  useEffect(() => {
    let live = true;
    fetch(`/api/copy-library${clientId ? `?client=${clientId}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Library) => live && setLib(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [clientId]);

  const lines = useMemo(() => {
    if (!lib) return [];
    const base = lib.lines.filter((l) => (!industry || l.industryKey === industry) && (!vertical || l.vertical === vertical));
    return filterCopy(base, { platform, kind, badge, angle, avatar, search: urlQ, sinceDays: since ? Number(since) : null }) as LibraryLine[];
  }, [lib, platform, kind, badge, angle, avatar, since, urlQ, industry, vertical]);
  const platforms = useMemo(() => [...new Set((lib?.lines ?? []).map((l) => l.platform))], [lib]);
  const kinds = useMemo(() => [...new Set((lib?.lines ?? []).filter((l) => !platform || l.platform === platform).map((l) => l.kind))], [lib, platform]);

  const counts = useMemo(() => {
    const c: Record<CopyBadge, number> = { winner: 0, solid: 0, tired: 0, unproven: 0 };
    for (const l of lines) c[l.badge]++;
    return c;
  }, [lines]);

  const set = (k: string, v: string | null) => {
    setShown(40);
    pushParams({ [k]: v || null });
  };
  const any = Boolean(platform || kind || badge || angle || avatar || since || urlQ || industry || vertical);

  if (failed) return <p className="rounded-[16px] border border-line bg-surface p-5 text-sm text-muted">The Copy library couldn&apos;t load. Refresh to try again.</p>;

  return (
    <section className="grid min-w-0 gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-2xl tracking-tight md:text-3xl">{title}</h2>
          {lib && (
            <p className="text-[13px] tabular text-muted">
              <span className="text-ok">{counts.winner} winners</span> · {counts.solid} solid · {counts.tired} tired · {lines.length} lines
            </p>
          )}
        </div>
        <p className="max-w-2xl text-[13.5px] text-muted">
          Every primary text, headline and description that ran in Meta, and every Google headline, description, sitelink and callout{clientId ? "" : ", across our clients"}, added up across the ads that used it and judged on the KPI. Reuse what&apos;s proven, or have the Copywriter write variations of it.
        </p>
      </header>

      {/* Search and filters: one row that scrolls sideways on phones */}
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 -mx-4 grid gap-2 border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur-md md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(40);
            replaceParams({ cl_q: e.target.value.trim() || null });
          }}
          placeholder="Search the words, angles, avatars…"
          className="h-11 w-full rounded-full border border-line bg-surface px-4 text-[15px] outline-none focus:border-faint md:h-10 md:text-sm"
          aria-label="Search copy"
        />
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          {platforms.length > 1 && (
            <select aria-label="Platform" className={select} value={platform ?? ""} onChange={(e) => set("cl_plat", e.target.value)}>
              <option value="">Meta and Google</option>
              {platforms.map((x) => (
                <option key={x} value={x}>
                  {PLATFORM_LABEL[x]}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Type" className={select} value={kind ?? ""} onChange={(e) => set("cl_kind", e.target.value)}>
            <option value="">All types</option>
            {(Object.keys(KIND_LABEL) as CopyKind[]).filter((k) => !lib || kinds.includes(k)).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}s
              </option>
            ))}
          </select>
          <select aria-label="Badge" className={select} value={badge ?? ""} onChange={(e) => set("cl_badge", e.target.value)}>
            <option value="">Every result</option>
            {(Object.keys(BADGE_LABEL) as CopyBadge[]).map((b) => (
              <option key={b} value={b}>
                {BADGE_LABEL[b]}
              </option>
            ))}
          </select>
          {(lib?.angles.length ?? 0) > 0 && (
            <select aria-label="Angle" className={select} value={angle ?? ""} onChange={(e) => set("cl_angle", e.target.value)}>
              <option value="">Any angle</option>
              {lib!.angles.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          {(lib?.avatars.length ?? 0) > 0 && (
            <select aria-label="Avatar" className={select} value={avatar ?? ""} onChange={(e) => set("cl_avatar", e.target.value)}>
              <option value="">Any avatar</option>
              {lib!.avatars.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
          <select aria-label="When it ran" className={select} value={since ?? ""} onChange={(e) => set("cl_since", e.target.value)}>
            {SINCE.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {!clientId && (lib?.industries.length ?? 0) > 0 && (
            <select aria-label="Industry" className={select} value={industry ?? ""} onChange={(e) => set("cl_ind", e.target.value)}>
              <option value="">Every industry</option>
              {lib!.industries.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label}
                </option>
              ))}
            </select>
          )}
          {!clientId && (lib?.verticals.length ?? 0) > 0 && (
            <select aria-label="Sub-vertical" className={select} value={vertical ?? ""} onChange={(e) => set("cl_vert", e.target.value)}>
              <option value="">Every sub-vertical</option>
              {lib!.verticals.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          )}
          {any && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                pushParams({ cl_plat: null, cl_kind: null, cl_badge: null, cl_angle: null, cl_avatar: null, cl_since: null, cl_q: null, cl_ind: null, cl_vert: null });
              }}
              className="h-11 shrink-0 rounded-full px-3.5 text-[13px] text-muted hover:text-fg md:h-9"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {!lib ? (
        <div className="grid min-h-[320px] place-items-center" aria-busy>
          <LogoLoader size="md" />
        </div>
      ) : lines.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[20px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading">{lib.lines.length ? "Nothing matches" : "No copy yet"}</p>
          <p className="max-w-sm text-[13px] text-muted">{lib.lines.length ? "Try fewer filters or another search." : "Lines appear here once Meta ads have run and the playbook has read them (after the next sync)."}</p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {lines.slice(0, shown).map((l) => (
            <CopyCard
              key={`${l.clientId}|${l.key}`}
              l={l}
              cross={!clientId}
              slug={slug ?? l.slug}
              starred={stars[`${l.clientId}|${l.key}`] ?? l.starred}
              onStar={(on) => setStars((s) => ({ ...s, [`${l.clientId}|${l.key}`]: on }))}
              open={open === `${l.clientId.slice(0, 8)}.${l.key}`}
              onOpen={(v) => pushParams({ cl_line: v ? `${l.clientId.slice(0, 8)}.${l.key}` : null })}
            />
          ))}
        </ul>
      )}
      {lib && lines.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + 40)} className="h-11 justify-self-center rounded-full border border-line px-5 text-sm text-muted hover:text-fg">
          Show more ({lines.length - shown} left)
        </button>
      )}
    </section>
  );
}

function CopyCard({ l, cross, slug, starred, onStar, open, onOpen }: { l: LibraryLine; cross: boolean; slug: string; starred: boolean; onStar: (on: boolean) => void; open: boolean; onOpen: (open: boolean) => void }) {
  const { copied, copy } = useCopied();
  const [full, setFull] = useState(false);
  const long = l.text.length > 220 || l.text.split("\n").length > 4;
  const kpi = l.roasKpi ? (l.roas != null ? `${l.roas}x ROAS` : "No revenue") : l.cpa != null ? `$${l.cpa} per result` : "No results";
  const vs = l.vsKpi != null && l.badge !== "unproven" ? (l.vsKpi >= 1 ? `${Math.round((l.vsKpi - 1) * 100)}% better than ${l.reference != null ? "KPI" : "average"}` : `${Math.round((1 - l.vsKpi) * 100)}% off`) : null;
  const star = async () => {
    const on = !starred;
    onStar(on); // instant; put back if it didn't save
    const r = await starCopyLine(l.clientId, l.key, l.kind, l.text, on);
    if ("error" in r) onStar(!on);
  };
  return (
    <li className={`grid min-w-0 gap-3 rounded-[18px] border bg-surface p-4 md:p-5 ${l.badge === "winner" ? "border-ok/30" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`rounded-full px-2.5 py-0.5 font-medium ${BADGE_TONE[l.badge]}`} title={l.reason}>
          {BADGE_LABEL[l.badge]}
        </span>
        <span className="rounded-full border border-line px-2 py-0.5 text-muted">
          {l.platform === "google" ? "Google · " : ""}
          {KIND_LABEL[l.kind]}
        </span>
        {l.label && <span className={`rounded-full px-2 py-0.5 ${l.label === "BEST" ? "bg-ok-soft text-ok" : l.label === "LOW" ? "bg-bad-soft text-bad" : "bg-surface-2 text-muted"}`}>Google: {l.label.charAt(0)}{l.label.slice(1).toLowerCase()}</span>}
        {l.pinned && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">Pinned {l.pinned.toLowerCase().replace("_", " ")}</span>}
        {cross && (
          <Link href={`/clients/${l.slug}?service=${l.platform}&tab=copy`} className="rounded-full bg-surface-2 px-2 py-0.5 text-muted hover:text-fg">
            {l.client}
            {l.vertical ? ` · ${l.vertical}` : ""}
          </Link>
        )}
        {l.live && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">Live</span>}
        <span className={`ml-auto tabular ${(limitOf(l.platform, l.kind) ?? Infinity) < l.text.length ? "text-bad" : "text-faint"}`}>
          {l.text.length}
          {limitOf(l.platform, l.kind) ? `/${limitOf(l.platform, l.kind)}` : ""} chars
        </span>
      </div>

      <p className={`whitespace-pre-line [overflow-wrap:anywhere] ${l.kind === "primary" ? "text-[15px] leading-relaxed" : "font-heading text-lg leading-snug"} ${long && !full ? "line-clamp-4" : ""}`}>{l.text}</p>
      {long && (
        <button type="button" onClick={() => setFull((f) => !f)} className="-mt-2 justify-self-start py-1 text-[12px] text-muted hover:text-fg">
          {full ? "Show less" : "Show all"}
        </button>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4">
        {(
          [
            [kpi, vs ?? "against the KPI"],
            [money(l.spend), l.platform === "google" ? `spent · ${l.ads} ${l.ads === 1 ? "ad group" : "ad groups"}` : `spent · ${l.ads} ${l.ads === 1 ? "ad" : "ads"}`],
            [l.ctr != null ? `${l.ctr}%` : "?", "CTR"],
            l.platform === "google" ? [`${Math.round(l.results * 10) / 10}`, "conversions, 90 days"] : [`${l.days}d`, l.lastSeen ? `ran, last ${new Date(`${l.lastSeen}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "ran"],
          ] as const
        ).map(([v, k]) => (
          <div key={k} className="grid min-w-0 gap-0.5">
            <dd className="truncate font-display text-base tabular tracking-tight">{v}</dd>
            <dt className="truncate text-faint">{k}</dt>
          </div>
        ))}
      </dl>

      {(l.angle || l.avatar || l.offer) && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {l.angle && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">Angle: {l.angle}</span>}
          {l.avatar && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">For: {l.avatar}</span>}
          {l.offer && <span className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-muted">Offer: {l.offer}</span>}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <button type="button" onClick={() => copy("line", l.text)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] font-medium hover:border-faint md:min-h-9">
          {copied === "line" ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={star} aria-pressed={starred} className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-[13px] font-medium md:min-h-9 ${starred ? "border-warn/40 bg-warn-soft text-warn" : "border-line hover:border-faint"}`}>
          <span aria-hidden>{starred ? "★" : "☆"}</span>
          {starred ? "Saved" : "Save"}
        </button>
        <button type="button" onClick={() => onOpen(!open)} aria-expanded={open} className={`inline-flex min-h-11 items-center rounded-full px-4 text-[13px] font-medium md:min-h-9 ${open ? "bg-surface-2" : "bg-fg text-bg hover:bg-fg/90"}`}>
          {open ? "Close variations" : "Make variations"}
        </button>
        {l.platform === "meta" && (
          <Link href={`/requests/new?client=${encodeURIComponent(slug)}&copyline=${encodeURIComponent(`${l.clientId}.${l.key}`)}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] font-medium hover:border-faint md:min-h-9">
            Use in a request →
          </Link>
        )}
      </div>
      {open && <Variations l={l} />}
    </li>
  );
}

function Variations({ l }: { l: LibraryLine }) {
  const [n, setN] = useState(5);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Variation[] | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const { copied, copy } = useCopied();
  useEffect(() => {
    let live = true;
    fetch(`/api/copy-library?client=${l.clientId}&variations=${encodeURIComponent(l.key)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { variations: [] }))
      .then((d: { variations: Saved[] }) => live && setSaved(d.variations ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [l.clientId, l.key]);
  const go = () =>
    start(async () => {
      setError(null);
      const r = await makeCopyVariations(l.clientId, l.key, n, note.trim() || null);
      if ("error" in r) setError(r.error ?? "Something went wrong.");
      else setFresh(r.variations);
    });
  const list = (vs: Variation[], tag: string) => (
    <ol className="grid gap-2">
      {vs.map((v, i) => (
        <li key={`${tag}${i}`} className="grid gap-1.5 rounded-[14px] border border-line bg-bg/50 p-3">
          <p className="whitespace-pre-line text-[14px] leading-relaxed [overflow-wrap:anywhere]">{v.text}</p>
          <p className="text-[12px] leading-relaxed text-muted">{v.reason}</p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] tabular text-faint">{v.chars} chars</span>
            <button type="button" onClick={() => copy(`${tag}${i}`, v.text)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12px] hover:border-faint md:min-h-8">
              {copied === `${tag}${i}` ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
  return (
    <div className="grid gap-3 rounded-[16px] bg-surface-2/60 p-3 md:p-4">
      <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <select aria-label="How many" value={n} onChange={(e) => setN(Number(e.target.value))} className={select}>
          {[3, 5, 8].map((x) => (
            <option key={x} value={x}>
              {x} variations
            </option>
          ))}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to aim for? (optional: a new offer, a season, shorter)" className="h-11 min-w-0 rounded-full border border-line bg-surface px-4 text-[14px] outline-none focus:border-faint md:h-9 md:text-[13px]" />
        <button type="button" onClick={go} disabled={pending} className="inline-flex min-h-11 items-center justify-center rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-60 md:min-h-9">
          {pending ? "Writing in the brand voice…" : "Write them"}
        </button>
      </div>
      <p className="text-[11.5px] text-faint">
        The Copywriter keeps what made this line work, in the client&apos;s voice from the Brand Bible, inside {l.platform === "google" ? "Google" : "Meta"}&apos;s limits ({limitOf(l.platform, l.kind) ? `${limitOf(l.platform, l.kind)} characters` : "the hook in the first 125 characters"}
        {l.pinned ? `, still working pinned ${l.pinned.toLowerCase().replace("_", " ")}` : ""}).
      </p>
      {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
      {fresh && list(fresh, "new")}
      {saved.length > 0 && (
        <details className="grid gap-2" open={!fresh}>
          <summary className="cursor-pointer py-1 text-[12px] text-muted">
            Written before ({saved.length} {saved.length === 1 ? "time" : "times"})
          </summary>
          <div className="grid gap-3 pt-2">
            {saved.map((s) => (
              <div key={s.id} className="grid gap-1.5">
                <p className="text-[11px] text-faint">
                  {new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {s.profiles?.full_name ? ` · ${s.profiles.full_name}` : ""}
                  {s.note ? ` · "${s.note}"` : ""}
                </p>
                {list(s.variations, s.id)}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
