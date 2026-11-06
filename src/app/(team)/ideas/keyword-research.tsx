"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@/components/combobox";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { KeywordList, ListKeyword, Research, ResearchIdea } from "@/lib/keyword-research";
import { addKeywordsToClient, deleteKeywordList, keywordTargets, researchKeywords, saveKeywordList } from "./google-actions";
import { Competition, Trend, big, bid } from "./market-bits";

// Keyword research, on top of Google in the market: pick a client (or just type seed keywords), and Keyword Planner's
// ideas come back for the places they advertise, sorted for relevance into themes, other businesses' names kept apart.
// Pick keywords (match type, or as negatives), keep them as a named list on the client, or add them to an ad group in
// their Google Ads: paused, and straight away when live changes are on for them, else saved to their Ideas to use.

type Match = ListKeyword["match"];
export type ResearchClient = { id: string; name: string; google: boolean; vertical: string | null };
type Pick = { match: Match; negative: boolean };
type Row = { text: string; searches: number; competition: string; bidLow: number; bidHigh: number; months: number[]; theme: string; inAccount: boolean; seeded: boolean };

const COMPETITORS = "__competitors";
const MATCHES: [Match, string][] = [
  ["phrase", "Phrase"],
  ["exact", "Exact"],
  ["broad", "Broad"],
];

/** The bar on top: a client, seed keywords, and a page of their site */
export function ResearchBar({ clients }: { clients: ResearchClient[] }) {
  const client = useParam("client");
  const q = useParam("q") ?? "";
  const site = useParam("site") ?? "";
  const [seeds, setSeeds] = useState(q);
  const [page, setPage] = useState(site);
  const [withPage, setWithPage] = useState(Boolean(site));
  // Back and forward bring the typed seeds along
  const [seen, setSeen] = useState(`${q}|${site}`);
  if (seen !== `${q}|${site}`) {
    setSeen(`${q}|${site}`);
    setSeeds(q);
    setPage(site);
  }
  const options = useMemo(
    () => [...clients].sort((a, b) => Number(b.google) - Number(a.google) || a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name, hint: c.google ? (c.vertical ?? "Google client") : (c.vertical ?? undefined), dot: c.google ? "bg-[#4285f4]" : undefined })),
    [clients],
  );
  return (
    <form
      className="grid gap-3 rounded-[22px] border border-line bg-surface p-3.5 md:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        pushParams({ q: seeds.trim() || null, site: withPage && page.trim() ? page.trim() : null, theme: null, list: null });
      }}
    >
      <div className="grid gap-2.5 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto]">
        <Combobox label="Client" placeholder="Pick a client" allLabel="By industry (no client)" options={options} value={client} onChange={(v) => pushParams({ client: v, list: null, theme: null })} />
        <input
          value={seeds}
          onChange={(e) => setSeeds(e.target.value)}
          placeholder={client ? "Seed keywords (optional): bbq catering, smoked brisket" : "Seed keywords: bbq catering, smoked brisket"}
          aria-label="Seed keywords"
          className="h-12 min-w-0 rounded-[14px] border border-line bg-bg px-4 text-[16px] outline-none placeholder:text-faint focus:border-brand-text/60 md:h-11 md:text-[15px]"
        />
        <button type="submit" className="h-12 rounded-full bg-brand px-5 text-[15px] font-medium text-white hover:bg-brand-hover md:h-11">
          Find keywords
        </button>
      </div>
      {withPage ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={page}
            onChange={(e) => setPage(e.target.value)}
            placeholder="A page of their site to search around: https://…"
            aria-label="Page to search around"
            inputMode="url"
            className="h-11 min-w-0 flex-1 rounded-[14px] border border-line bg-bg px-4 text-[16px] outline-none placeholder:text-faint focus:border-brand-text/60 md:h-10 md:text-[14px]"
          />
          <button type="button" onClick={() => (setWithPage(false), setPage(""))} className="min-h-11 px-2 text-[13px] text-muted hover:text-fg md:min-h-9">
            Remove
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setWithPage(true)} className="justify-self-start text-[13px] text-muted hover:text-fg max-md:min-h-11">
          + Search around a page of their site
        </button>
      )}
    </form>
  );
}

const fromIdea = (i: ResearchIdea): Row => ({ text: i.text, searches: i.searches, competition: i.competition, bidLow: i.bidLow, bidHigh: i.bidHigh, months: i.months, theme: i.theme, inAccount: i.inAccount, seeded: i.seeded });
const fromList = (k: ListKeyword): Row => ({ text: k.text, searches: k.searches ?? 0, competition: k.competition ?? "unspecified", bidLow: k.bidLow ?? 0, bidHigh: k.bidHigh ?? 0, months: [], theme: k.theme ?? "", inAccount: false, seeded: false });

/** The results for a client or seeds: themes, rows to pick, saved lists, and the bar to act on what's picked */
export function KeywordResearch({ clients, canAdd, canEnable }: { clients: ResearchClient[]; canAdd: boolean; canEnable: boolean }) {
  const clientId = useParam("client");
  const q = useParam("q") ?? "";
  const site = useParam("site") ?? "";
  const theme = useParam("theme");
  const listId = useParam("list");
  const client = clients.find((c) => c.id === clientId) ?? null;
  const [data, setData] = useState<Research | null>(null);
  const [lists, setLists] = useState<KeywordList[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offTopic, setOffTopic] = useState(false);
  const [picked, setPicked] = useState<Map<string, Pick>>(new Map());
  const [sheet, setSheet] = useState<null | "add" | "save">(null);
  const asked = useRef(0);

  const run = async (fresh = false) => {
    const n = ++asked.current;
    setLoading(true);
    setError(null);
    const seeds = q.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const r = await researchKeywords({ clientId, seeds, url: site || null, fresh });
    if (n !== asked.current) return;
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      setData(null);
      return;
    }
    setData(r.research);
    setLists(r.lists);
  };
  // A new client or new seeds: read again, and start a fresh selection
  const key = `${clientId}|${q}|${site}`;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (lastKey !== key) {
    setLastKey(key);
    setPicked(new Map());
    setData(null);
  }
  useEffect(() => {
    const t = setTimeout(() => void run(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const list = lists.find((l) => l.id === listId) ?? null;
  // A saved list opened: its keywords, picked as they were saved
  const [openedList, setOpenedList] = useState<string | null>(null);
  if (list && openedList !== list.id) {
    setOpenedList(list.id);
    setPicked(new Map(list.keywords.map((k) => [k.text, { match: k.match, negative: k.negative }])));
  }
  if (!list && openedList) setOpenedList(null);

  const ideas = data?.ideas ?? [];
  const relevant = ideas.filter((i) => i.group === "relevant");
  const competitors = ideas.filter((i) => i.group === "competitor");
  const hidden = ideas.filter((i) => i.group === "irrelevant");
  const rows: Row[] = list
    ? list.keywords.map(fromList)
    : theme === COMPETITORS
      ? competitors.map(fromIdea)
      : [...(theme ? relevant.filter((i) => i.theme === theme) : relevant), ...(offTopic && !theme ? hidden : [])].map(fromIdea);
  const byText = new Map([...ideas.map((i) => [i.text, fromIdea(i)] as const), ...(list ? list.keywords.map((k) => [k.text, fromList(k)] as const) : [])]);

  const toggle = (r: Row) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(r.text)) next.delete(r.text);
      // Another business's name is picked as a negative by default (or switched to target it)
      else next.set(r.text, { match: "phrase", negative: theme === COMPETITORS });
      return next;
    });
  const set = (text: string, p: Partial<Pick>) => setPicked((m) => new Map(m).set(text, { ...(m.get(text) ?? { match: "phrase", negative: false }), ...p }));
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.text));
  const selectAll = () =>
    setPicked((m) => {
      const next = new Map(m);
      for (const r of rows) {
        if (allOn) next.delete(r.text);
        else if (!next.has(r.text)) next.set(r.text, { match: "phrase", negative: theme === COMPETITORS });
      }
      return next;
    });
  const chosen: ListKeyword[] = [...picked].map(([text, p]) => {
    const r = byText.get(text);
    return { text, match: p.match, negative: p.negative, ...(r ? { searches: r.searches, competition: r.competition, bidLow: r.bidLow, bidHigh: r.bidHigh, theme: r.theme || undefined } : {}) };
  });
  const searches = chosen.filter((k) => !k.negative).reduce((n, k) => n + (k.searches ?? 0), 0);
  const read = data ? new Date(data.readAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const where = data ? `${data.geo.label}${data.geo.source === "campaigns" ? " (where their campaigns run)" : data.geo.source === "client" ? " (from what they told us)" : ""}` : "";

  return (
    <div className="grid gap-5 pb-28">
      {/* What this is */}
      <section className="relative isolate grid gap-4 overflow-hidden rounded-[26px] border border-ink/[0.08] bg-deep p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:p-7">
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-32 -z-10 h-[320px] w-[320px] rounded-full bg-[rgba(66,133,244,0.22)] blur-[110px]" />
        <div className="grid min-w-0 gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#4285f4]">Keyword research</span>
          <h2 className="font-heading text-[26px] leading-tight md:text-[32px]">{client?.name ?? data?.client ?? "Your seeds"}</h2>
          {data ? (
            <p className="max-w-2xl text-[13.5px] leading-relaxed text-ink/60">
              Searches in {where}
              {data.seeds.length ? `, around ${data.seeds.slice(0, 6).join(", ")}${data.seeds.length > 6 ? "…" : ""}` : ""}
              {data.url ? ` and ${data.url.replace(/^https?:\/\//, "")}` : ""}. From Google&apos;s Keyword Planner, read {read}
              {data.cached ? " (kept from earlier)" : ""}.{!data.sorted ? " Not sorted for relevance this time: check before adding." : ""}
            </p>
          ) : (
            <p className="text-[13.5px] text-ink/60">{loading ? "Asking Google…" : " "}</p>
          )}
        </div>
        {data && (
          <div className="grid grid-cols-3 gap-2 md:flex">
            <Stat n={big(relevant.reduce((s, i) => s + i.searches, 0))} label="searches a month" />
            <Stat n={String(relevant.length)} label="relevant ideas" />
            <button type="button" disabled={loading} onClick={() => void run(true)} className="grid place-items-center rounded-[16px] border border-ink/10 bg-ink/[0.04] px-4 py-3 text-[12.5px] text-ink/70 hover:text-fg disabled:opacity-60">
              {loading ? "Reading…" : "Read again"}
            </button>
          </div>
        )}
      </section>

      {/* Saved lists for this client */}
      {clientId && lists.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Saved lists</p>
          <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
            {lists.map((l) => (
              <button key={l.id} type="button" onClick={() => (list?.id === l.id ? closeParams("list") : pushParams({ list: l.id, theme: null }))} className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] md:min-h-9 ${list?.id === l.id ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                {l.name}
                <span className="tabular opacity-60">{l.keywords.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>}

      {list ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] text-muted">
            The list <span className="text-fg">&ldquo;{list.name}&rdquo;</span>, saved {new Date(list.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Pick what to add.
          </p>
          <span className="flex gap-2">
            <button type="button" onClick={() => closeParams("list")} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
              Back to the research
            </button>
            {canAdd && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm(`Delete the list "${list.name}"?`)) return;
                  const r = await deleteKeywordList(list.id);
                  if (!r.ok) return setError(r.error);
                  setLists((ls) => ls.filter((x) => x.id !== list.id));
                  closeParams("list");
                }}
                className="min-h-11 rounded-full px-3 text-[13px] text-faint hover:text-bad md:min-h-9"
              >
                Delete list
              </button>
            )}
          </span>
        </div>
      ) : (
        data && (
          <div className="grid gap-2">
            <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Themes">
              <Chip on={!theme} onClick={() => closeParams("theme")} label="All relevant" n={relevant.length} />
              {data.themes.map((t) => (
                <Chip key={t.name} on={theme === t.name} onClick={() => pushParams({ theme: t.name })} label={t.name} n={t.count} />
              ))}
              {competitors.length > 0 && <Chip on={theme === COMPETITORS} onClick={() => pushParams({ theme: COMPETITORS })} label="Other businesses' names" n={competitors.length} muted />}
            </div>
            {theme === COMPETITORS ? (
              <p className="text-[12.5px] text-faint">Searches for another business by name. Picked, they go in as negatives so we don&apos;t pay for them; switch one off negative to bid on that name on purpose.</p>
            ) : (
              hidden.length > 0 &&
              !theme && (
                <button type="button" onClick={() => setOffTopic(!offTopic)} className="justify-self-start text-[12.5px] text-faint hover:text-fg max-md:min-h-11">
                  {offTopic ? "Hide" : "Show"} {hidden.length} off-topic idea{hidden.length === 1 ? "" : "s"}
                </button>
              )
            )}
          </div>
        )
      )}

      {/* The ideas */}
      {loading && !data && !list ? (
        <ul className="grid gap-1.5" aria-busy>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="h-[62px] animate-pulse rounded-[14px] bg-surface-2/70" />
          ))}
        </ul>
      ) : rows.length ? (
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={selectAll} className="min-h-11 text-[13px] text-muted hover:text-fg md:min-h-8">
              {allOn ? "Clear these" : `Pick all ${rows.length}`}
            </button>
            <span className="text-[11.5px] text-faint max-md:hidden">Monthly searches · last 12 months · competition · top-of-page bid</span>
          </div>
          <ul className="grid gap-1.5">
            {rows.map((r) => (
              <IdeaRow key={r.text} r={r} pick={picked.get(r.text) ?? null} onToggle={() => toggle(r)} onSet={(p) => set(r.text, p)} offTopic={hidden.some((h) => h.text === r.text)} />
            ))}
          </ul>
        </div>
      ) : (
        data && !loading && <p className="rounded-[14px] border border-dashed border-line px-4 py-6 text-[13.5px] text-muted">Nothing here. Try other seed keywords, or a page of their site.</p>
      )}

      {/* What's picked */}
      {picked.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur md:sticky md:bottom-4 md:mx-auto md:w-full md:max-w-6xl md:rounded-[20px] md:border md:px-5 md:pb-3 md:shadow-[0_20px_50px_-24px_rgba(0,0,0,0.5)]">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="min-w-0 flex-1 text-[14px]">
              <b className="font-medium">{picked.size}</b> picked
              {searches ? <span className="text-muted"> · about {big(searches)} searches a month</span> : null}
              {chosen.some((k) => k.negative) && <span className="text-muted"> · {chosen.filter((k) => k.negative).length} as negatives</span>}
            </span>
            <button type="button" onClick={() => setPicked(new Map())} className="min-h-11 px-2 text-[13px] text-muted hover:text-fg md:min-h-9">
              Clear
            </button>
            {clientId && canAdd ? (
              <>
                <button type="button" onClick={() => setSheet("save")} className="min-h-11 rounded-full border border-line px-4 text-[14px] hover:border-faint md:min-h-10">
                  {list ? "Update list" : "Save as a list"}
                </button>
                <button type="button" onClick={() => setSheet("add")} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover md:min-h-10">
                  Add to {client?.name ?? "the client"}
                </button>
              </>
            ) : (
              <span className="text-[12.5px] text-faint">{clientId ? "The Google team, execs and leads add keywords to clients." : "Pick a client to save or add these."}</span>
            )}
          </div>
        </div>
      )}

      {sheet === "save" && clientId && (
        <SaveSheet
          list={list}
          suggestion={list?.name ?? data?.themes.find((t) => chosen.some((k) => k.theme === t.name))?.name ?? ""}
          onClose={() => setSheet(null)}
          onSave={async (name) => {
            const r = await saveKeywordList({ clientId, name, keywords: chosen, id: list?.id ?? null });
            if (!r.ok) return r.error;
            setLists((ls) => [r.list, ...ls.filter((x) => x.id !== r.list.id)]);
            setSheet(null);
            return null;
          }}
        />
      )}
      {sheet === "add" && clientId && (
        <AddSheet clientId={clientId} clientName={client?.name ?? "the client"} keywords={chosen} canEnable={canEnable} listName={list?.name ?? null} seeds={data?.seeds ?? []} suggestion={list?.name ?? chosen.find((k) => k.theme)?.theme ?? ""} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <span className="grid gap-0.5 rounded-[16px] border border-ink/10 bg-ink/[0.04] px-4 py-3">
      <span className="tabular font-display text-[24px] leading-none md:text-[28px]">{n}</span>
      <span className="text-[11px] text-ink/50">{label}</span>
    </span>
  );
}

function Chip({ on, onClick, label, n, muted = false }: { on: boolean; onClick: () => void; label: string; n: number; muted?: boolean }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick} className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13.5px] transition-colors md:min-h-9 ${on ? "bg-fg text-bg" : muted ? "border border-dashed border-line text-faint hover:text-fg" : "border border-line text-muted hover:text-fg"}`}>
      {label}
      <span className="tabular opacity-60">{n}</span>
    </button>
  );
}

function IdeaRow({ r, pick, onToggle, onSet, offTopic }: { r: Row; pick: Pick | null; onToggle: () => void; onSet: (p: Partial<Pick>) => void; offTopic: boolean }) {
  const on = Boolean(pick);
  return (
    <li className={`overflow-hidden rounded-[14px] border transition-colors ${on ? "border-[#4285f4]/60 bg-[#4285f4]/[0.06]" : "border-line bg-surface hover:border-faint/60"} ${offTopic ? "opacity-60" : ""}`}>
      <label className="grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 md:grid-cols-[28px_minmax(0,1fr)_90px_120px_92px_120px]">
        <input type="checkbox" checked={on} onChange={onToggle} className="h-5 w-5 accent-[#4285f4]" aria-label={`Pick ${r.text}`} />
        <span className="grid min-w-0 gap-1">
          <span className="truncate text-[15px]">{r.text}</span>
          <span className="flex flex-wrap gap-1">
            {r.inAccount && <span className="rounded-full bg-surface-2 px-2 py-px text-[10.5px] text-muted">In their account</span>}
            {r.seeded && <span className="rounded-full bg-ok-soft px-2 py-px text-[10.5px] text-ok">Converts for them</span>}
            {r.theme && <span className="rounded-full border border-line px-2 py-px text-[10.5px] text-faint md:hidden">{r.theme}</span>}
            {offTopic && <span className="rounded-full bg-surface-2 px-2 py-px text-[10.5px] text-faint">Off-topic</span>}
          </span>
        </span>
        <span className="tabular text-right font-heading text-[17px] md:text-left">
          {r.searches ? big(r.searches) : "–"}
          <span className="ml-1 font-sans text-[11px] text-faint">/mo</span>
        </span>
        <span className="max-md:hidden">
          <Trend months={r.months} />
        </span>
        <span className="max-md:hidden">
          <Competition value={r.competition} />
        </span>
        <span className="tabular text-right text-sm text-muted max-md:hidden">{bid(r.bidLow, r.bidHigh)}</span>
      </label>
      {pick && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[#4285f4]/20 px-3.5 py-2.5 md:pl-[54px]">
          <span className="inline-flex rounded-full border border-line bg-bg p-0.5" role="radiogroup" aria-label="Match type">
            {MATCHES.map(([m, l]) => (
              <button key={m} type="button" role="radio" aria-checked={pick.match === m} onClick={() => onSet({ match: m })} className={`min-h-9 rounded-full px-3 text-[12.5px] md:min-h-7 ${pick.match === m ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                {l}
              </button>
            ))}
          </span>
          <button type="button" onClick={() => onSet({ negative: !pick.negative })} aria-pressed={pick.negative} className={`min-h-9 rounded-full px-3 text-[12.5px] md:min-h-7 ${pick.negative ? "bg-bad-soft text-bad" : "border border-line text-muted hover:text-fg"}`}>
            {pick.negative ? "Negative ✓" : "As a negative"}
          </button>
          <span className="text-[11.5px] text-faint max-md:hidden">{pick.negative ? "Blocks this search" : pick.match === "exact" ? `[${r.text}]` : pick.match === "phrase" ? `"${r.text}"` : r.text}</span>
        </div>
      )}
    </li>
  );
}

/** A panel over the page: a sheet from the bottom on a phone, a centered card on a computer */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid items-end bg-black/50 backdrop-blur-sm md:place-items-center md:p-6" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} onClick={(e) => e.stopPropagation()} className="grid max-h-[92dvh] w-full gap-4 overflow-y-auto rounded-t-[26px] border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-xl md:rounded-[26px] md:p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-heading text-[22px] leading-tight">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:text-fg md:h-9 md:w-9">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const field = "h-12 w-full min-w-0 rounded-[14px] border border-line bg-bg px-4 text-[16px] outline-none focus:border-brand-text/60 md:h-11 md:text-[15px]";

function SaveSheet({ list, suggestion, onClose, onSave }: { list: KeywordList | null; suggestion: string; onClose: () => void; onSave: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={list ? "Update the list" : "Save as a list"} onClose={onClose}>
      <p className="text-[13.5px] text-muted">Kept on the client to come back to and add later (&ldquo;BBQ season&rdquo;, &ldquo;Brunch&rdquo;). It shows here and on their Google Ads tab.</p>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the list" className={field} />
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <button
        type="button"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          const e = await onSave(name);
          setBusy(false);
          setError(e);
        }}
        className="h-12 rounded-full bg-brand text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
      >
        {busy ? "Saving…" : list ? "Update the list" : "Save the list"}
      </button>
    </Sheet>
  );
}

type Targets = Extract<Awaited<ReturnType<typeof keywordTargets>>, { ok: true }>;

function AddSheet({ clientId, clientName, keywords, canEnable, listName, seeds, suggestion, onClose }: { clientId: string; clientName: string; keywords: ListKeyword[]; canEnable: boolean; listName: string | null; seeds: string[]; suggestion: string; onClose: () => void }) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "new" | "later">("existing");
  const [campaignId, setCampaignId] = useState("");
  const [adGroupId, setAdGroupId] = useState("");
  const [newName, setNewName] = useState(suggestion);
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Extract<Awaited<ReturnType<typeof addKeywordsToClient>>, { ok: true }> | null>(null);

  useEffect(() => {
    let live = true;
    void keywordTargets(clientId).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoadError(r.error);
      setTargets(r);
      if (r.website) setUrl((u) => u || r.website!);
      if (!r.campaigns.length) setMode("later");
    });
    return () => {
      live = false;
    };
  }, [clientId]);

  const groups = targets?.adGroups.filter((g) => g.campaignId === campaignId) ?? [];
  const campaign = targets?.campaigns.find((c) => c.id === campaignId) ?? null;
  const group = targets?.adGroups.find((g) => g.id === adGroupId) ?? null;
  const positives = keywords.filter((k) => !k.negative).length;
  const negatives = keywords.length - positives;
  const ready = mode === "later" || (mode === "existing" ? Boolean(group) || (positives === 0 && Boolean(campaign)) : Boolean(campaign && newName.trim()));

  const submit = async (push: boolean) => {
    setBusy(true);
    setError(null);
    const r = await addKeywordsToClient({
      clientId,
      keywords,
      finalUrl: url,
      push,
      listName,
      seeds,
      target: {
        campaignId: mode === "later" ? null : campaignId || null,
        campaign: mode === "later" ? null : (campaign?.name ?? null),
        adGroupId: mode === "existing" ? adGroupId || null : null,
        adGroup: mode === "existing" ? (group?.name ?? null) : null,
        newAdGroup: mode === "new" ? newName.trim() : null,
        status: enabled ? "ENABLED" : "PAUSED",
      },
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(r);
  };

  if (done)
    return (
      <Sheet title={done.status === "applied" ? "Added to Google Ads" : done.status === "partial" ? "Partly added" : done.status === "failed" ? "Google refused it" : "Saved to their Ideas to use"} onClose={onClose}>
        {done.results.length > 0 && (
          <ul className="grid gap-1.5">
            {done.results.map((x, i) => (
              <li key={i} className={`text-[13.5px] ${x.ok ? "text-ok" : "text-bad"}`}>
                {x.ok ? "✓" : "✕"} {x.what}
                {x.error ? `: ${x.error}` : ""}
              </li>
            ))}
          </ul>
        )}
        {done.error && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[13px] text-warn">Saved, but not pushed: {done.error}</p>}
        {done.status === "approved" && !done.error && <p className="text-[13.5px] text-muted">It&apos;s in their Ideas to use with a checklist, to apply by hand or push once live changes are on for {clientName}.</p>}
        <div className="flex flex-wrap gap-2">
          <Link href={`/clients/${done.slug}?service=google&tab=ideas&deploy=${done.id}`} className="inline-flex h-12 items-center rounded-full bg-fg px-5 text-[14px] font-medium text-bg">
            Open in their Ideas to use →
          </Link>
          <button type="button" onClick={onClose} className="h-12 rounded-full border border-line px-5 text-[14px] text-muted hover:text-fg">
            Keep researching
          </button>
        </div>
      </Sheet>
    );

  return (
    <Sheet title={`Add to ${clientName}`} onClose={onClose}>
      <p className="text-[13.5px] text-muted">
        {positives} keyword{positives === 1 ? "" : "s"}
        {negatives ? ` and ${negatives} negative${negatives === 1 ? "" : "s"}` : ""}. Where should they go?
      </p>
      {loadError && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{loadError}</p>}
      {!targets && !loadError ? (
        <div className="grid gap-2" aria-busy>
          <span className="h-12 animate-pulse rounded-[14px] bg-surface-2" />
          <span className="h-12 animate-pulse rounded-[14px] bg-surface-2" />
        </div>
      ) : targets ? (
        <>
          {!targets.account && <p className="rounded-[12px] bg-warn-soft px-3 py-2 text-[13px] text-warn">No Google Ads account is linked to {clientName} on the KPI board, so this is saved as a checklist.</p>}
          <div className="grid gap-2" role="radiogroup" aria-label="Where">
            {(
              [
                ["existing", "An ad group they have", "Into an existing ad group in a search campaign"],
                ["new", "A new ad group", "Made in one of their search campaigns, for these keywords"],
                ["later", "Decide later", "Saved to their Ideas to use with a checklist"],
              ] as const
            )
              .filter(([m]) => m === "later" || targets.campaigns.length > 0)
              .map(([m, l, hint]) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`grid gap-0.5 rounded-[16px] border px-4 py-3 text-left transition-colors ${mode === m ? "border-[#4285f4]/70 bg-[#4285f4]/[0.07]" : "border-line hover:border-faint"}`}>
                  <span className="text-[14.5px] font-medium">{l}</span>
                  <span className="text-[12.5px] text-muted">{hint}</span>
                </button>
              ))}
          </div>
          {mode !== "later" && (
            <div className="grid gap-2.5">
              <label className="grid gap-1.5 text-[12.5px] text-muted">
                Campaign
                <select value={campaignId} onChange={(e) => (setCampaignId(e.target.value), setAdGroupId(""))} className={field}>
                  <option value="">Pick a search campaign</option>
                  {targets.campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.status !== "ENABLED" ? ` (${c.status.toLowerCase()})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "existing" ? (
                <label className="grid gap-1.5 text-[12.5px] text-muted">
                  Ad group
                  <select value={adGroupId} onChange={(e) => setAdGroupId(e.target.value)} disabled={!campaignId} className={field}>
                    <option value="">{campaignId ? (groups.length ? "Pick an ad group" : "No ad groups in it") : "Pick the campaign first"}</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                        {g.status !== "ENABLED" ? ` (${g.status.toLowerCase()})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="grid gap-1.5 text-[12.5px] text-muted">
                  New ad group&apos;s name
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. BBQ catering" className={field} />
                </label>
              )}
            </div>
          )}
          <label className="grid gap-1.5 text-[12.5px] text-muted">
            Landing page for these keywords
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" className={field} />
            <span className="text-[11.5px] text-faint">Set on each keyword, so clicks on them land here (over the ad&apos;s own page).</span>
          </label>
          {mode !== "later" && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex rounded-full border border-line bg-bg p-0.5" role="radiogroup" aria-label="Status">
                <button type="button" role="radio" aria-checked={!enabled} onClick={() => setEnabled(false)} className={`min-h-10 rounded-full px-4 text-[13px] md:min-h-8 ${!enabled ? "bg-fg text-bg" : "text-muted"}`}>
                  Paused
                </button>
                <button type="button" role="radio" aria-checked={enabled} disabled={!canEnable} onClick={() => setEnabled(true)} className={`min-h-10 rounded-full px-4 text-[13px] disabled:opacity-40 md:min-h-8 ${enabled ? "bg-ok text-white" : "text-muted"}`}>
                  Enabled
                </button>
              </span>
              <span className="text-[11.5px] text-faint">{canEnable ? "Paused is safest; turn them on in Google Ads when ready." : "They go in paused (execs and leads can add them enabled)."}</span>
            </div>
          )}
          {negatives > 0 && mode !== "later" && <p className="text-[12.5px] text-faint">Negatives go on the campaign.</p>}
          {mode === "new" && <p className="text-[12.5px] text-faint">A new ad group needs an ad before it can run: write one for it in Google Ads (it&apos;s on the checklist).</p>}
          {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
          <div className="grid gap-2">
            {targets.writes && mode !== "later" ? (
              <>
                <button type="button" disabled={busy || !ready} onClick={() => void submit(true)} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-60">
                  {busy ? "Adding to Google Ads…" : "Add to Google Ads now"}
                </button>
                <button type="button" disabled={busy || !ready} onClick={() => void submit(false)} className="h-11 rounded-full border border-line text-[14px] text-muted hover:text-fg disabled:opacity-60">
                  Save to their Ideas to use instead
                </button>
              </>
            ) : (
              <>
                {mode !== "later" && <p className="text-[12.5px] text-muted">Live changes in Google Ads are off for {clientName}: it&apos;s saved with a checklist, to push once an exec switches them on in their Team &amp; setup.</p>}
                <button type="button" disabled={busy || !ready} onClick={() => void submit(false)} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-60">
                  {busy ? "Saving…" : "Save to their Ideas to use"}
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
