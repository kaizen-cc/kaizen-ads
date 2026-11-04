"use client";

import { useState } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { GoogleKeyword, GooglePlaybook } from "@/lib/google-playbooks";
import type { Benchmark } from "@/lib/verticals";
import { GoogleAdsMark } from "@/components/source-logo";
import { SHEET_BACKDROP, SHEET_PANEL, SheetBar } from "../winners/winners-library";
import { rebuildGooglePlaybook } from "./google-actions";

// Google playbooks by sub-vertical: how to win search in each market we serve, from our own Google winners (brand
// searches left out). A card per market; open one (?gpb=) for the intents that convert with their keywords, the copy
// angles with headline patterns, the structures, the landing pages, the benchmarks and what fails.

export type GoogleMarket = { id: string; name: string; parent: string; clients: number; winners: number; benchmarks: Benchmark[]; playbook: GooglePlaybook | null };
type Example = { kind: string; text: string; result: string };

const kw = (k: GoogleKeyword) => (k.match === "exact" ? `[${k.text}]` : k.match === "phrase" ? `"${k.text}"` : k.text);
const TYPE: Record<string, string> = { benefit: "Benefit", proof: "Proof", offer: "Offer", urgency: "Urgency", local: "Local", question: "Question", statistic: "Statistic", other: "Angle" };

export function GoogleVerticalsView({ markets, examples, canRebuild }: { markets: GoogleMarket[]; examples: Record<string, Example>; canRebuild: boolean }) {
  const open = useParam("gpb");
  const opened = markets.find((m) => m.id === open) ?? null;
  const ready = markets.filter((m) => m.playbook);
  const coming = markets.filter((m) => !m.playbook && m.winners > 0);
  const groups = [...new Set(ready.map((m) => m.parent))];
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-7">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-ink/[0.08] bg-deep p-6 md:p-9">
        <span aria-hidden className="pointer-events-none absolute -left-32 -top-40 -z-10 h-[420px] w-[420px] rounded-full bg-[rgba(66,133,244,0.22)] blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-48 right-[-120px] -z-10 h-[380px] w-[380px] rounded-full bg-[rgba(200,16,46,0.16)] blur-[120px]" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-2">
            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-text">
              <GoogleAdsMark size={13} /> Google playbooks
            </span>
            <h1 className="font-heading text-[34px] leading-[1.05] tracking-tight md:text-[44px]">How we win search, market by market</h1>
            <p className="max-w-xl text-sm text-ink/60">From our own Google winners in each sub-vertical, brand searches left out: the searches that convert, the copy that wins, how the campaigns are built and what to avoid. The Google strategy, audits and &ldquo;Use it on a client&rdquo; all start here.</p>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {[
              [String(ready.length), "playbooks"],
              [String(ready.reduce((n, m) => n + m.playbook!.intents.length, 0)), "intents"],
              [String(markets.reduce((n, m) => n + m.winners, 0)), "winners read"],
            ].map(([n, l]) => (
              <span key={l} className="grid min-w-[96px] gap-0.5 rounded-[18px] border border-ink/10 bg-ink/[0.04] px-4 py-3 backdrop-blur">
                <span className="tabular font-display text-[28px] leading-none">{n}</span>
                <span className="text-[11px] text-ink/50">{l}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {ready.length === 0 && (
        <div className="grid place-items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-heading text-lg">No Google playbooks yet</p>
          <p className="max-w-md text-sm text-muted">Each market gets one once our Google accounts in it have non-brand winners. They&apos;re written from the Hall of Fame and live winners, a couple an hour.</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g} className="grid gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{g}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ready
              .filter((m) => m.parent === g)
              .map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => pushParams({ gpb: m.id })} className="group relative isolate grid h-full w-full content-start gap-3 overflow-hidden rounded-[22px] border border-line bg-surface p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-faint/60">
                    <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px]" style={{ background: "linear-gradient(90deg, #4285f4, #34a853 40%, #fbbc04 70%, #ea4335)" }} />
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-heading text-[19px] leading-snug">{m.name}</span>
                      <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-faint">{m.playbook!.sources.clients} {m.playbook!.sources.clients === 1 ? "account" : "accounts"}</span>
                    </span>
                    <span className="line-clamp-3 text-[13px] leading-relaxed text-muted">{m.playbook!.summary}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {m.playbook!.intents.slice(0, 3).map((i) => (
                        <span key={i.name} className="rounded-full border border-line px-2.5 py-1 text-[11.5px]">
                          {i.name}
                        </span>
                      ))}
                    </span>
                    <span className="text-[12px] text-brand-text">Open the playbook →</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}

      {coming.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Being written</h2>
          <p className="flex flex-wrap gap-1.5 text-[12.5px] text-muted">
            {coming.map((m) => (
              <span key={m.id} className="rounded-full border border-dashed border-line px-3 py-1">
                {m.name} · {m.winners} {m.winners === 1 ? "winner" : "winners"}
              </span>
            ))}
          </p>
        </section>
      )}

      {opened?.playbook && <Sheet m={opened} p={opened.playbook} examples={examples} canRebuild={canRebuild} onClose={() => closeParams("gpb")} />}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{children}</span>;

function Proof({ ids, examples }: { ids: string[]; examples: Record<string, Example> }) {
  const list = ids.map((id) => examples[id]).filter(Boolean);
  if (!list.length) return null;
  return (
    <span className="grid gap-1 border-t border-line/60 pt-2">
      {list.slice(0, 3).map((e, n) => (
        <span key={n} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <span className="text-faint">{e.kind === "ad" ? "Ad" : e.kind === "keyword" ? "Keyword" : "Search"}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{e.text}</span>
          <span className="text-ok">{e.result}</span>
        </span>
      ))}
    </span>
  );
}

function Sheet({ m, p, examples, canRebuild, onClose }: { m: GoogleMarket; p: GooglePlaybook; examples: Record<string, Example>; canRebuild: boolean; onClose: () => void }) {
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  return (
    <div className={SHEET_BACKDROP} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={m.name} className={`${SHEET_PANEL} md:max-w-[880px]`}>
        <SheetBar title={m.name} onClose={onClose} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-faint">
              <GoogleAdsMark size={12} /> {m.parent}
            </span>
            <h2 className="font-heading text-[28px] leading-tight max-md:hidden">{m.name}</h2>
            <span className="text-[12px] text-faint">
              From {p.sources.ads} ads, {p.sources.keywords} keywords and {p.sources.terms} search terms across {p.sources.clients} {p.sources.clients === 1 ? "account" : "accounts"}
              {p.generatedAt ? ` · written ${new Date(p.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
            </span>
          </div>
          <span className="flex gap-2">
            {canRebuild && (
              <button
                type="button"
                disabled={Boolean(rebuilding)}
                onClick={async () => {
                  setRebuilding("Rewriting…");
                  const r = await rebuildGooglePlaybook(m.id);
                  setRebuilding(r.ok ? "Rewriting: back in a minute" : r.error);
                }}
                className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-70"
              >
                {rebuilding ?? "Rebuild"}
              </button>
            )}
            <button onClick={onClose} className="min-h-11 rounded-full px-4 text-sm text-muted hover:bg-surface-2 hover:text-fg max-md:hidden">
              Close
            </button>
          </span>
        </div>

        <p className="text-[15px] leading-relaxed">{p.summary}</p>

        {m.benchmarks.length > 0 && (
          <div className="grid gap-2">
            <Label>Google benchmarks for this market</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {m.benchmarks.slice(0, 8).map((b) => (
                <span key={b.metric} className="grid gap-0.5 rounded-[14px] border border-line bg-surface px-3 py-2.5">
                  <span className="text-[11px] text-faint">{b.metric}</span>
                  <span className="tabular font-heading text-[17px]">
                    {b.good ?? "–"}
                    {b.unit}
                  </span>
                  <span className="text-[10.5px] text-faint">
                    great {b.great ?? "–"}
                    {b.unit} · {b.source} {b.year}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3">
          <Label>Searches that convert</Label>
          <div className="grid gap-3 md:grid-cols-2">
            {p.intents.map((i) => (
              <div key={i.name} className="grid content-start gap-2.5 rounded-[18px] border border-line bg-surface p-4">
                <span className="font-heading text-[17px]">{i.name}</span>
                <span className="text-[13px] leading-relaxed text-muted">{i.why}</span>
                <span className="flex flex-wrap gap-1.5">
                  {i.keywords.map((k) => (
                    <span key={kw(k)} className="rounded-full border border-line bg-bg/60 px-2.5 py-1 font-mono text-[11.5px]">
                      {kw(k)}
                    </span>
                  ))}
                </span>
                <Proof ids={i.examples} examples={examples} />
              </div>
            ))}
          </div>
        </div>

        {p.angles.length > 0 && (
          <div className="grid gap-3">
            <Label>Copy that wins</Label>
            <div className="grid gap-3 md:grid-cols-2">
              {p.angles.map((a) => (
                <div key={a.name} className="grid content-start gap-2.5 rounded-[18px] border border-line bg-surface p-4">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-heading text-[17px]">{a.name}</span>
                    <span className="shrink-0 rounded-full bg-[#4285f4]/15 px-2.5 py-0.5 text-[11px] text-[#4285f4]">{TYPE[a.type] ?? "Angle"}</span>
                  </span>
                  <span className="grid gap-1 rounded-[12px] border border-line/70 bg-bg/60 p-3">
                    <span className="text-[15px] font-medium leading-snug text-[#7aa7ff]">{a.headlines.join(" | ")}</span>
                    <span className="text-[12.5px] text-muted">{a.descriptions.join(" ")}</span>
                  </span>
                  <span className="text-[13px] leading-relaxed text-muted">{a.why}</span>
                  <Proof ids={a.examples} examples={examples} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {p.structures.length > 0 && (
            <div className="grid content-start gap-2">
              <Label>How the campaigns are built</Label>
              {p.structures.map((s) => (
                <div key={s.name} className="grid gap-1 rounded-[14px] border border-line p-3">
                  <span className="text-[14px] font-medium">{s.name}</span>
                  <span className="text-[13px] text-muted">{s.how}</span>
                  <span className="text-[12px] text-faint">{s.why}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid content-start gap-4">
            {p.landing.length > 0 && (
              <div className="grid gap-1.5">
                <Label>Landing pages that convert</Label>
                {p.landing.map((x, n) => (
                  <span key={n} className="flex gap-2 text-[13px]">
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    {x}
                  </span>
                ))}
              </div>
            )}
            {p.watchouts.length > 0 && (
              <div className="grid gap-1.5 rounded-[16px] border border-bad/25 bg-bad-soft/40 p-4">
                <Label>What fails here</Label>
                {p.watchouts.map((x, n) => (
                  <span key={n} className="flex gap-2 text-[13px]">
                    <span className="text-bad">✕</span>
                    {x}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
