"use client";

import { useState } from "react";
import { refreshPatterns } from "@/app/(team)/pipeline/pattern-actions";
import type { Pattern, PatternsState } from "@/lib/patterns";
import { QuickBriefSheet } from "@/components/quick-brief-sheet";
import { BriefJobSlot } from "@/components/brief-jobs";
import { SaveIdeaStar } from "@/components/save-idea-star";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// Patterns across clients, as cards: what works (or fails) for a whole kind of business, how many clients prove it,
// and the clients not using it yet, each a click from a brief.

const KIND: Record<Pattern["kind"], string> = { angle: "Angle", concept: "Concept", offer: "Offer", format: "Format", audience: "Audience", moment: "Moment", google: "Google" };
const CONF: Record<Pattern["confidence"], string> = { high: "Strong", medium: "Good", low: "Early" };

function Card({ p, names, canBrief, uses, briefFor = null }: { p: Pattern; names?: Record<string, string>; canBrief?: boolean; uses?: "yes" | "no" | null; /** The client page: brief it for this client */ briefFor?: string | null }) {
  const [open, setOpen] = useState(false);
  const works = p.verdict === "works";
  const share = p.evidence.of ? Math.round((p.evidence.clients / p.evidence.of) * 100) : 0;
  // A client picked: the quick preview right here (?preview=, so back closes it). The full brief is written in the
  // background only if they choose it (its progress in place of its button), and opens in Ready to send
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const previewKey = previewFor ? `pt-${p.id}-${previewFor}` : null;
  const previewing = useParam("preview") === previewKey && previewKey !== null;
  return (
    <article className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${works ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{works ? "Works" : "Fails"}</span>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">{KIND[p.kind]}</span>
        <span className="text-[11.5px] text-faint">{p.group}</span>
        {uses === "yes" && <span className="ml-auto rounded-full bg-ok-soft px-2.5 py-1 text-[11px] text-ok">They use it</span>}
        {uses === "no" && <span className="ml-auto rounded-full bg-brand/15 px-2.5 py-1 text-[11px] text-brand-text">Not using it yet</span>}
      </div>
      <div className="grid gap-1.5">
        <h3 className="font-heading text-[16.5px] leading-snug">{p.title}</h3>
        <p className="text-[13.5px] leading-relaxed text-muted">{p.detail}</p>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">
            <b className="tabular text-fg">{p.evidence.clients}</b> of {p.evidence.of} clients · {CONF[p.confidence]}
          </span>
          {p.evidence.items.length > 0 && (
            <button type="button" onClick={() => setOpen(!open)} className="min-h-9 max-md:h-11 px-1 text-faint hover:text-fg">
              {open ? "Hide the proof" : "The proof"}
            </button>
          )}
        </div>
        <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <span className={`block h-full rounded-full ${works ? "bg-ok" : "bg-bad"}`} style={{ width: `${Math.min(100, Math.max(6, share))}%` }} />
        </span>
        {open && (
          <ul className="mt-1 grid gap-1 text-[12.5px] text-muted">
            {p.evidence.items.map((e) => (
              <li key={e}>• {e}</li>
            ))}
          </ul>
        )}
      </div>
      {names && works && p.missing.length > 0 && (
        <div className="grid gap-2 border-t border-line pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Not using it yet</p>
          <div className="flex flex-wrap gap-2">
            {p.missing
              .filter((id) => names[id])
              .map((id) =>
                canBrief ? (
                  // Its brief being written in the background: the progress in its place, then "Brief ready · Open"
                  <BriefJobSlot key={id} source={{ kind: "pattern", patternId: p.id }} clientId={id} client className="grid w-full min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewFor(id);
                        pushParams({ preview: `pt-${p.id}-${id}` });
                      }}
                      className="min-h-11 rounded-full border border-line px-3.5 text-[12.5px] transition-colors hover:border-brand/50 hover:text-fg md:min-h-10"
                    >
                      {`Brief it for ${names[id]} →`}
                    </button>
                  </BriefJobSlot>
                ) : (
                  <span key={id} className="rounded-full border border-line px-3 py-1.5 text-[12.5px] text-muted">
                    {names[id]}
                  </span>
                ),
              )}
          </div>
        </div>
      )}
      {briefFor ? (
        <BriefJobSlot source={{ kind: "pattern", patternId: p.id }} clientId={briefFor}>
        <span className="inline-flex items-center gap-2 justify-self-start">
          <button
            type="button"
            onClick={() => {
              setPreviewFor(briefFor);
              pushParams({ preview: `pt-${p.id}-${briefFor}` });
            }}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] transition-colors hover:border-brand/50 hover:text-fg md:min-h-9"
          >
            Brief it for them →
          </button>
          <SaveIdeaStar source={{ kind: "pattern", patternId: p.id }} from={{ kicker: `Works for ${p.evidence.clients} of ${p.evidence.of}`, label: p.title }} clientId={briefFor} size="sm" />
        </span>
        </BriefJobSlot>
      ) : (
        works &&
        canBrief && (
          <span className="inline-flex items-center gap-2 justify-self-start text-[12px] text-faint">
            <SaveIdeaStar source={{ kind: "pattern", patternId: p.id }} from={{ kicker: `Works for ${p.evidence.clients} of ${p.evidence.of}`, label: p.title }} size="sm" />
            Save it for a client
          </span>
        )
      )}
      {previewing && previewFor && (
        <QuickBriefSheet
          clientId={previewFor}
          source={{ kind: "pattern", patternId: p.id }}
          from={{ kicker: `Works for ${p.evidence.clients} of ${p.evidence.of}`, label: names?.[previewFor] ? `${p.title} · ${names[previewFor]}` : p.title }}
          progressLabel="brief from a pattern"
          onClose={() => closeParams("preview")}
        />
      )}
    </article>
  );
}

/** The Overview's panel: each business model, then its sub-verticals, works first */
export function PatternsPanel({ state, canBrief, canRefresh }: { state: PatternsState; canBrief: boolean; canRefresh: boolean }) {
  const [tab, setTab] = useState(state.groups[0]?.model ?? null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const group = state.groups.find((g) => g.model === tab) ?? state.groups[0];
  const subs = group ? [...new Set(group.patterns.map((p) => p.group))] : [];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="-mx-1 flex max-w-full gap-1.5 overflow-x-auto px-1 pb-1">
          {state.groups.map((g) => (
            <button key={g.model} type="button" onClick={() => setTab(g.model)} className={`min-h-10 shrink-0 rounded-full px-4 text-[13px] transition-colors ${g.model === group?.model ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
              {g.name} <span className="tabular opacity-60">{g.patterns.length}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-3 text-[11.5px] text-faint">
          {state.generatedAt && `Read ${new Date(state.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
          {canRefresh && (
            <button
              type="button"
              disabled={Boolean(refreshing)}
              onClick={async () => {
                setRefreshing("Reading every account…");
                const r = await refreshPatterns();
                setRefreshing(r.ok ? "Reading every account: back in a few minutes" : r.error);
              }}
              className="min-h-9 max-md:h-11 rounded-full border border-line px-3 text-muted hover:text-fg disabled:opacity-70"
            >
              {refreshing ?? "Refresh"}
            </button>
          )}
        </span>
      </div>
      {group &&
        subs.map((sub) => (
          <section key={sub} className="grid gap-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{sub === group.name ? `Across ${group.name.toLowerCase()}` : sub}</h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {group.patterns
                .filter((p) => p.group === sub)
                .map((p) => (
                  <Card key={p.id} p={p} names={state.clients} canBrief={canBrief} />
                ))}
            </div>
          </section>
        ))}
    </div>
  );
}

/** The client page: what works for businesses like this one, and whether this client uses it */
export function ClientPatterns({ patterns, label, clientId = null }: { patterns: (Pattern & { uses: boolean; opportunity: boolean })[]; label: string; /** Brief one they aren't using yet, right here */ clientId?: string | null }) {
  const [all, setAll] = useState(false);
  if (!patterns.length) return null;
  const shown = all ? patterns : patterns.slice(0, 4);
  const missing = patterns.filter((p) => p.opportunity).length;
  return (
    <section className="grid gap-3 rounded-[22px] border border-line bg-deep p-4 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-[18px]">What works for businesses like this</h2>
        <span className="text-[12px] text-faint">
          {label} · {missing ? `${missing} they aren't using yet` : "proven across our clients"}
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {shown.map((p) => (
          <Card key={p.id} p={p} uses={p.verdict === "works" ? (p.uses ? "yes" : p.opportunity ? "no" : null) : null} briefFor={clientId && p.verdict === "works" && !p.uses ? clientId : null} />
        ))}
      </div>
      {patterns.length > 4 && (
        <button type="button" onClick={() => setAll(!all)} className="min-h-10 justify-self-start text-[13px] text-muted hover:text-fg">
          {all ? "Show fewer" : `All ${patterns.length} patterns →`}
        </button>
      )}
    </section>
  );
}
