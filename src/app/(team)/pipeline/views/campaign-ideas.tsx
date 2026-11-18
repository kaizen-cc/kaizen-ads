"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setSuggestionStatus } from "../../kpis/email-ops-actions";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { BrandChip } from "./overview-tabs";

// Campaign ideas across the person's clients, critical first: a send gap, a missing core flow, a revenue drop, a holiday
// about to be missed, a launch the client raised (src/lib/overview-desk.ts decides). The critical ones are big cards
// with the client's look, why it matters and one tap to start the request (the email request form opens on that idea,
// the AI writes the brief). The rest fold under "More ideas" (?ideas=more), worth doing before nice to have.

type Tier = "critical" | "worth" | "nice" | "missed";
type Idea = {
  id: string;
  clientName: string;
  slug: string;
  brand: { color: string | null; logo: string | null; light: boolean };
  title: string;
  idea: string;
  why: string | null;
  sendOn: string | null;
  status: "new" | "in_motion" | "done" | "dismissed";
  tier: Tier;
  reason: string;
};

const TIER: Record<Tier, { label: string; chip: string }> = {
  critical: { label: "Critical", chip: "bg-bad-soft text-bad" },
  worth: { label: "Worth doing", chip: "bg-brand-soft text-brand-text" },
  nice: { label: "Nice to have", chip: "bg-ink/[0.06] text-muted" },
  missed: { label: "Send day passed", chip: "bg-warn-soft text-warn" },
};
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const createHref = (i: Idea) => `/board/email/new?client=${encodeURIComponent(i.slug)}&idea=${encodeURIComponent(i.id)}`;

function useStatus() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, status: "in_motion" | "dismissed") =>
    start(async () => {
      setError(null);
      const r = await setSuggestionStatus(id, status);
      if (!r.ok) setError(r.error ?? "That didn't save.");
      else router.refresh();
    });
  return { pending, error, set };
}

/** One critical idea: the client's look along the top, why it matters, and the way to act on it */
function Big({ i }: { i: Idea }) {
  const { pending, error, set } = useStatus();
  const tint = i.brand.color ?? "var(--color-bad)";
  return (
    <article className={`relative isolate grid min-w-0 content-start gap-3 overflow-hidden rounded-[20px] border border-line bg-surface p-4 md:p-5 ${pending ? "opacity-70" : ""}`}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-24 opacity-[0.16]" style={{ background: `linear-gradient(180deg, ${tint}, transparent)` }} />
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: tint }} />
      <div className="flex min-w-0 items-center gap-3">
        <BrandChip name={i.clientName} color={i.brand.color} logo={i.brand.logo} light={i.brand.light} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] text-muted">{i.clientName}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={`rounded-full px-2 py-0.5 font-medium ${TIER[i.tier].chip}`}>{TIER[i.tier].label}</span>
            {i.status === "in_motion" && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">In motion</span>}
          </p>
        </div>
        {i.sendOn && (
          <span className="grid shrink-0 justify-items-end leading-tight">
            <span className="text-[10.5px] uppercase tracking-[0.12em] text-faint">Send by</span>
            <span className="tabular font-heading text-[15px]">{day(i.sendOn)}</span>
          </span>
        )}
      </div>
      <h3 className="font-heading text-[18px] leading-snug">{i.title}</h3>
      <p className="line-clamp-3 text-[13.5px] leading-relaxed text-muted">{i.idea}</p>
      <div className="grid gap-1 rounded-[12px] bg-bad-soft/50 px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-bad">Why it matters</p>
        <p className="text-[13px] leading-snug text-fg">
          {i.reason}
          {i.why ? `. ${i.why}` : ""}
        </p>
      </div>
      {error && <p className="text-[12px] text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={createHref(i)} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
          Create the request
        </Link>
        {i.status === "new" && (
          <>
            <button type="button" disabled={pending} onClick={() => set(i.id, "in_motion")} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
              We&apos;re on it
            </button>
            <button type="button" disabled={pending} onClick={() => set(i.id, "dismissed")} className="min-h-11 rounded-full px-3 text-[13px] text-faint hover:text-fg disabled:opacity-60 md:min-h-9">
              Dismiss
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** One of the rest, as a row: the client, the idea, why, and the same way in */
function Row({ i }: { i: Idea }) {
  const { pending, error, set } = useStatus();
  return (
    <li className={`grid min-w-0 gap-2 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4 md:px-4 ${pending ? "opacity-70" : ""}`}>
      <div className="flex min-w-0 items-start gap-3">
        <BrandChip name={i.clientName} color={i.brand.color} logo={i.brand.logo} light={i.brand.light} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium">{i.title}</p>
          <p className="truncate text-[12px] text-muted">
            {i.clientName} · <span className={i.tier === "missed" ? "text-warn" : ""}>{i.reason}</span>
            {i.sendOn ? ` · ${day(i.sendOn)}` : ""}
          </p>
          {error && <p className="text-[12px] text-bad">{error}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pl-11 md:pl-0">
        <Link href={createHref(i)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
          Create
        </Link>
        {i.status === "new" && (
          <button type="button" disabled={pending} onClick={() => set(i.id, "dismissed")} aria-label={`Dismiss ${i.title}`} className="grid h-11 w-11 place-items-center rounded-full text-faint hover:text-fg disabled:opacity-60 md:h-8 md:w-8">
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

/** Critical first as cards; the rest folded, worth doing before nice to have, in a contained list */
export function IdeaDeck({ ideas }: { ideas: Idea[] }) {
  const more = useParam("ideas") === "more";
  const critical = ideas.filter((i) => i.tier === "critical");
  const rest = ideas.filter((i) => i.tier !== "critical");
  const groups: { tier: Tier; items: Idea[] }[] = (["worth", "nice", "missed"] as Tier[]).map((tier) => ({ tier, items: rest.filter((i) => i.tier === tier) })).filter((g) => g.items.length);
  if (!ideas.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">No open campaign ideas</p>
        <p className="max-w-prose text-sm text-muted">They are written every week from past sends, the calendar and what clients mention. A client&apos;s sheet can ask for more.</p>
      </section>
    );
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-xl">{critical.length ? "Critical now" : "Nothing critical"}</h2>
          <span className="text-xs text-faint">Send gaps, missing core flows, revenue drops and holidays about to be missed</span>
        </div>
        {critical.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {critical.map((i) => (
              <Big key={i.id} i={i} />
            ))}
          </div>
        ) : (
          <p className="rounded-[16px] border border-line bg-surface px-4 py-3 text-sm text-muted">No idea is urgent today. The rest are below when there&apos;s room for them.</p>
        )}
      </section>

      {rest.length > 0 && (
        <section className="grid gap-3">
          <button
            type="button"
            aria-expanded={more}
            onClick={() => (more ? closeParams("ideas") : pushParams({ ideas: "more" }))}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[16px] border border-line bg-surface px-4 text-left hover:border-faint"
          >
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-heading text-[16px]">More ideas</span>
              <span className="text-[12px] text-faint">{groups.map((g) => `${g.items.length} ${TIER[g.tier].label.toLowerCase()}`).join(" · ")}</span>
            </span>
            <span aria-hidden className={`text-faint transition-transform ${more ? "rotate-180" : ""}`}>
              ⌄
            </span>
          </button>
          {more && (
            <div className="max-h-[min(70vh,640px)] overflow-y-auto overscroll-contain rounded-[16px] border border-line bg-surface">
              {groups.map((g) => (
                <div key={g.tier}>
                  <p className="sticky top-0 z-10 border-b border-line bg-surface/95 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted backdrop-blur">
                    {TIER[g.tier].label} <span className="tabular font-normal text-faint">{g.items.length}</span>
                  </p>
                  <ul className="divide-y divide-line">
                    {g.items.map((i) => (
                      <Row key={i.id} i={i} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
