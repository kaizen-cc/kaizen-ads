"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Winner } from "@/lib/industry";
import { INSPIRE_KEY, inspireLine } from "../requests/new/draft";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
type Sort = "ratio" | "spend" | "results";
const SORTS: [Sort, string][] = [
  ["ratio", "Beating their account most"],
  ["spend", "Most spend behind it"],
  ["results", "Most results"],
];

/**
 * The winners library: every ad across our accounts getting a clearly better cost per result than its own account's
 * usual, from the last Meta sync. Filter by industry, open one to see it as it runs, and start a request from it.
 */
export function WinnersLibrary({ winners, industries }: { winners: Winner[]; industries: readonly (readonly [string, string])[] }) {
  const router = useRouter();
  const [industry, setIndustry] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [liveOnly, setLiveOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("ratio");
  const [open, setOpen] = useState<Winner | null>(null);

  const label = (k: string | null) => industries.find(([i]) => i === k)?.[1] ?? "Not sorted yet";
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of winners) m.set(w.industry ?? "", (m.get(w.industry ?? "") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [winners]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return winners
      .filter((w) => industry === null || (w.industry ?? "") === industry)
      .filter((w) => !liveOnly || w.live)
      .filter((w) => !term || [w.client, w.detail, w.headline, w.text, w.name].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => (sort === "ratio" ? b.ratio - a.ratio : sort === "spend" ? b.spend - a.spend : b.results - a.results));
  }, [winners, industry, liveOnly, q, sort]);

  const clients = new Set(winners.map((w) => w.clientId)).size;
  const best = winners[0];

  const briefFrom = (w: Winner) => {
    try {
      sessionStorage.setItem(INSPIRE_KEY, inspireLine(w));
    } catch {}
    router.push("/requests/new");
  };

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Winners library</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">What&apos;s working across our accounts</h1>
        <p className="max-w-2xl text-sm text-muted">
          Ads getting a clearly better cost per result than their own account&apos;s usual (at least 1.2x, with $100 and 3 results behind them). Pulled from
          the last Meta sync of every client.
        </p>
        {winners.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Stat value={String(winners.length)} label="winning ads" />
            <Stat value={String(clients)} label="clients" />
            <Stat value={String(counts.filter(([k]) => k).length)} label="industries" />
            {best && <Stat value={`${best.ratio}x`} label={`best: ${best.detail ?? label(best.industry)}`} accent />}
          </div>
        )}
      </header>

      {winners.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">No winners yet</p>
          <p className="max-w-sm text-sm text-muted">They show up once Meta has synced and an account has a few ads with enough spend to compare.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <Chip on={industry === null} onClick={() => setIndustry(null)}>
                All <span className="text-faint">{winners.length}</span>
              </Chip>
              {counts.map(([k, n]) => (
                <Chip key={k || "none"} on={industry === k} onClick={() => setIndustry(industry === k ? null : k)}>
                  {label(k || null)} <span className="text-faint">{n}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search client, headline, copy…"
                className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-sm outline-none placeholder:text-faint focus:border-faint sm:max-w-xs"
              />
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 rounded-full border border-line bg-surface px-3 text-sm">
                {SORTS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setLiveOnly(!liveOnly)}
                className={`h-9 rounded-full border px-3.5 text-sm ${liveOnly ? "border-ok/50 bg-ok/10 text-ok" : "border-line text-muted hover:text-fg"}`}
              >
                Running now
              </button>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Nothing matches. Try another industry or search.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {shown.map((w) => (
                <button
                  key={`${w.clientId}:${w.id}`}
                  onClick={() => setOpen(w)}
                  className="group grid content-start gap-2.5 rounded-[14px] border border-line bg-surface p-2 text-left transition-colors hover:border-faint"
                >
                  <span className="relative aspect-[4/5] overflow-hidden rounded-[10px] bg-surface-2">
                    {w.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={w.thumbnail} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                    ) : (
                      <span className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-faint">{w.headline ?? w.name}</span>
                    )}
                    <span className="absolute left-2 top-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-semibold text-white shadow">{w.ratio}x</span>
                    {w.live && (
                      <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white backdrop-blur">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                        Live
                      </span>
                    )}
                  </span>
                  <span className="grid gap-1 px-1 pb-1">
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug">{w.headline ?? w.name}</span>
                    <span className="truncate text-[11px] text-muted">
                      {w.client} · {w.detail ?? label(w.industry)}
                    </span>
                    <span className="tabular text-[11px] text-faint">
                      {money(w.costPerResult)} vs {money(w.usual)} per {w.result ?? "result"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {open && <WinnerSheet w={open} industryLabel={label(open.industry)} onClose={() => setOpen(null)} onBrief={() => briefFrom(open)} />}
    </div>
  );
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <span className={`flex items-baseline gap-1.5 rounded-full border px-3 py-1.5 ${accent ? "border-ok/40 bg-ok/10" : "border-line bg-surface"}`}>
      <span className={`tabular text-sm font-semibold ${accent ? "text-ok" : "text-fg"}`}>{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm ${on ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
      {children}
    </button>
  );
}

function WinnerSheet({ w, industryLabel, onClose, onBrief }: { w: Winner; industryLabel: string; onClose: () => void; onBrief: () => void }) {
  const synced = new Date(w.syncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grid max-h-[92vh] w-full max-w-[880px] gap-5 overflow-y-auto rounded-[18px] border border-line bg-bg p-4 md:grid-cols-[minmax(0,380px)_1fr] md:p-5">
        <div className="overflow-hidden rounded-[12px] bg-white text-[#050505]">
          {w.text && <p className="whitespace-pre-wrap px-3 py-2.5 text-[13px] leading-[1.35]">{w.text}</p>}
          {w.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={w.thumbnail} alt="" className="block w-full" />
          ) : (
            <span className="grid aspect-[4/5] place-items-center text-xs text-[#65676b]">No preview from the ad account yet</span>
          )}
          {w.headline && <p className="truncate bg-[#f0f2f5] px-3 py-2.5 text-[14px] font-semibold">{w.headline}</p>}
        </div>

        <div className="grid content-start gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <p className="text-xs text-faint">
                {w.detail ?? industryLabel}
                {w.detail && ` · ${industryLabel}`}
              </p>
              <p className="font-display text-xl leading-tight">{w.client}</p>
              <p className="truncate text-xs text-faint" title={w.name}>
                {w.name}
              </p>
            </div>
            <button onClick={onClose} className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
              Done
            </button>
          </div>

          <div className="rounded-[14px] border border-ok/30 bg-ok/[0.07] p-4">
            <p className="tabular font-display text-4xl text-ok">{w.ratio}x</p>
            <p className="mt-1 text-sm text-muted">
              better cost per {w.result ?? "result"} than this account usually gets: <span className="tabular text-fg">{money(w.costPerResult)}</span> against{" "}
              <span className="tabular text-fg">{money(w.usual)}</span>.
            </p>
          </div>

          <dl className="grid grid-cols-3 gap-2 text-center text-xs">
            {(
              [
                ["Spend", money(w.spend)],
                [w.result ? `${w.result[0].toUpperCase()}${w.result.slice(1)}` : "Results", w.results.toLocaleString("en-US")],
                ["CTR", w.ctr ? `${w.ctr}%` : "—"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-[10px] bg-surface p-2.5">
                <dt className="truncate text-faint">{k}</dt>
                <dd className="tabular text-sm text-fg">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="text-xs text-faint">
            {w.live === true ? "Running now" : w.live === false ? "Not delivering right now" : "Delivery status not known yet"} · Meta sync of {synced}
          </p>

          <div className="flex flex-wrap gap-2">
            <button onClick={onBrief} className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:brightness-110">
              Start a request from this
            </button>
            <Link href={`/clients/${w.clientSlug}`} className="grid h-10 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
              Open {w.client}
            </Link>
          </div>
          <p className="text-[11px] text-faint">The request gets this ad as a reference in its brief. The AI learns the angle and structure, never names the other client.</p>
        </div>
      </div>
    </div>
  );
}
