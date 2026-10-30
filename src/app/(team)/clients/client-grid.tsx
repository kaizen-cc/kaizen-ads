"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { setClientService } from "./[slug]/actions";
import { ArchiveControl } from "./[slug]/archive-control";
import { tintFor } from "@/lib/colors";
import type { Freshness } from "@/lib/dates";
import { untilLabel } from "@/lib/allotment";
import { SLOTS, seatNeeded, type SlotRole } from "@/lib/roles";
import { AssignSelect, type Option } from "./assign-select";
import { SERVICES, type ServiceSlug } from "@/lib/services";

export type ClientCard = {
  id: string;
  name: string;
  slug: string;
  status: string;
  whiteLabel: boolean;
  packageLabel: string | null;
  /** ongoing (from the forms), sprint (exec override with an end date) or none */
  pkg: "ongoing" | "sprint" | "none";
  until: string | null;
  images: { used: number; cap: number };
  videos: { used: number; cap: number };
  inFlight: number;
  contacts: number;
  /** team slots (for the services they have) and contacts still empty */
  missing: number;
  services: ServiceSlug[];
  live: { meta: Freshness["tone"] | null; slack: Freshness["tone"] | null; drive: Freshness["tone"] | null };
  assigned: Record<SlotRole, Option | null>;
};

const DOT = { ok: "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]", warn: "bg-warn", off: "bg-faint/50" } as const;

function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const over = used > cap;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-faint">{label}</span>
        <span className="tabular">
          <span className={over ? "text-bad" : "text-fg"}>{used}</span>
          <span className="text-faint"> / {cap}</span>
        </span>
      </div>
      <span className="h-1 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${over ? "bg-bad" : "bg-brand"}`} style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : used ? 100 : 0}%` }} />
      </span>
    </div>
  );
}

function Light({ label, tone }: { label: string; tone: Freshness["tone"] | null }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${tone ? "text-muted" : "text-faint/70"}`} title={tone ? `${label}: ${tone === "ok" ? "live" : tone === "warn" ? "behind" : "not synced yet"}` : `${label}: not linked`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone ? DOT[tone] : "border border-faint/50"}`} />
      {label}
    </span>
  );
}

export const SVC_DOT: Partial<Record<ServiceSlug, string>> = { "facebook-ads": "bg-[#5b8def]", "google-ads": "bg-[#f2b14c]", creative: "bg-brand", "tiktok-ads": "bg-[#36c5f0]" };
const MANAGED: ServiceSlug[] = ["facebook-ads", "google-ads", "creative"];

/** A press on something of its own (a button, a link, a dropdown) isn't a press on the card */
const ownControl = (t: EventTarget | null) => Boolean((t as HTMLElement | null)?.closest("a, button, select, input, textarea, label, [role=dialog], [data-no-open]"));

/**
 * Every client as a card. Folded, it's the name and the services they're on (with the creative tier); a click opens
 * their page. Unfolded (the chevron), each service shows the people it needs, the allotment that applies, and execs
 * and leads can take a service off or archive the client right there. The card unfolded is in the address (?card=).
 */
export function ClientGrid({ cards, slotOptions, canEdit }: { cards: ClientCard[]; slotOptions: Record<SlotRole, Option[]>; canEdit: boolean }) {
  const open = useParam("card");
  return (
    <ul className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.id} c={c} open={open === c.id} slotOptions={slotOptions} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function Card({ c, open, slotOptions, canEdit }: { c: ClientCard; open: boolean; slotOptions: Record<SlotRole, Option[]>; canEdit: boolean }) {
  const router = useRouter();
  const [services, setServices] = useState(c.services);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const tint = tintFor(c.name);
  const has = (s: ServiceSlug) => services.includes(s);
  const toggleOpen = () => (open ? closeParams("card") : pushParams({ card: c.id }));

  const remove = (x: ServiceSlug) => {
    const label = SERVICES.find((v) => v.slug === x)!.label;
    if (!confirm(`Take ${label} off ${c.name}? It can be added back from their page.`)) return;
    setServices((s) => s.filter((v) => v !== x));
    start(async () => {
      const r = await setClientService(c.id, c.slug, x, false);
      if (!r.ok) {
        setError(r.error);
        setServices(c.services);
      } else router.refresh();
    });
  };

  const seat = (slot: SlotRole) => {
    const s = SLOTS.find((x) => x.value === slot)!;
    const empty = !c.assigned[slot];
    return (
      <div key={slot} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-2 max-md:py-0.5">
        <dt className={`text-xs ${empty ? "text-warn" : "text-faint"}`}>{s.label}</dt>
        <dd className="min-w-0">
          <AssignSelect clientId={c.id} slot={slot} label={s.label} current={c.assigned[slot]} options={slotOptions[slot]} canEdit={canEdit} />
        </dd>
      </div>
    );
  };
  const block = (title: string, dot: string, children: React.ReactNode, note?: React.ReactNode) => (
    <div className="grid gap-2 rounded-[12px] border border-line/80 bg-bg/40 px-3.5 py-3">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {title}
        {note && <span className="ml-auto font-normal normal-case tracking-normal">{note}</span>}
      </p>
      {children}
    </div>
  );
  const others = services.filter((x) => !MANAGED.includes(x));
  const caps = { images: c.images.cap, videos: c.videos.cap };
  // Only the allotments that apply: a video-only package shows no images line
  const meters = [c.images.cap || c.images.used ? <Meter key="i" label="Images" used={c.images.used} cap={c.images.cap} /> : null, c.videos.cap || c.videos.used ? <Meter key="v" label="Videos" used={c.videos.used} cap={c.videos.cap} /> : null].filter(Boolean);
  const flight = (
    <Link href={`/board?client=${c.slug}`} title="Open on the board" className={`rounded-full px-2 py-0.5 text-[11px] tabular transition-colors ${c.inFlight ? "bg-brand-soft text-brand-text hover:bg-brand/25" : "text-faint hover:text-fg"}`}>
      {c.inFlight ? `${c.inFlight} in flight` : "Nothing in flight"}
    </Link>
  );

  return (
    <li
      // Clicks from a sheet drawn elsewhere on the page (the archive confirmation on phones) aren't clicks on the card
      onClick={(e) => e.currentTarget.contains(e.target as Node) && !ownControl(e.target) && router.push(`/clients/${c.slug}`)}
      className={`group relative grid cursor-pointer content-start gap-4 overflow-hidden rounded-[14px] border bg-surface p-5 transition-colors hover:border-faint/70 ${open ? "border-faint/60" : "border-line"} ${c.status === "paused" ? "opacity-60" : ""}`}
    >
      {/* A wash of the client's color along the top */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-[0.10]" style={{ background: `linear-gradient(180deg, ${tint}, transparent)` }} />

      <div className="relative flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] font-heading text-lg" style={{ background: `${tint}26`, color: tint }}>
          {c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <Link href={`/clients/${c.slug}`} className="block truncate font-heading text-[17px] leading-snug hover:text-brand-text">
            {c.name}
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs capitalize text-faint">
            {c.status}
            {c.whiteLabel && <span className="normal-case">· White label</span>}
            {c.missing > 0 && <span className="normal-case text-warn">· {c.missing} to fill</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={open ? "Fold the card" : "Unfold the card"}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-muted transition-colors hover:border-faint hover:text-fg md:h-9 md:w-9"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* The services, at a glance */}
      <div className="relative flex flex-wrap gap-1.5">
        {services.length ? (
          services.map((x) => {
            const svc = SERVICES.find((v) => v.slug === x)!;
            return (
              <span key={x} className="inline-flex items-center gap-1.5 rounded-full border border-line py-1 pl-2.5 pr-2.5 text-[11.5px]">
                <span className={`h-1.5 w-1.5 rounded-full ${SVC_DOT[x] ?? "bg-muted"}`} />
                {svc.short}
                {x === "creative" && c.packageLabel && <span className="text-faint">· {c.packageLabel}</span>}
                {x === "creative" && c.pkg === "sprint" && c.until && <span className="text-warn">· sprint to {untilLabel(c.until)}</span>}
                {open && canEdit && (
                  <button type="button" onClick={() => remove(x)} aria-label={`Take ${svc.label} off`} title={`Take ${svc.label} off`} className="-mr-1 grid h-6 w-6 place-items-center rounded-full text-faint hover:bg-bad-soft hover:text-bad md:h-4 md:w-4">
                    ×
                  </button>
                )}
              </span>
            );
          })
        ) : (
          <span className="rounded-full border border-dashed border-warn/40 px-2.5 py-1 text-[11.5px] text-warn">No services on file</span>
        )}
      </div>
      {error && <p className="relative -mt-2 text-xs text-bad">{error}</p>}

      {open && (
        <div className="relative grid cursor-default gap-4" data-no-open>
          {/* Each service with the people it needs */}
          {(has("facebook-ads") || has("google-ads") || has("creative") || others.length > 0) && (
            <dl className="grid gap-2">
              {has("facebook-ads") && block("Meta Ads", SVC_DOT["facebook-ads"]!, seat("meta_buyer"), <Light label="synced" tone={c.live.meta} />)}
              {has("google-ads") && block("Google Ads", SVC_DOT["google-ads"]!, seat("google_buyer"))}
              {has("creative") &&
                block(
                  `Creative${c.packageLabel ? ` · ${c.packageLabel}` : ""}`,
                  SVC_DOT.creative!,
                  <>
                    {meters.length ? <div className={`grid gap-4 pb-1 ${meters.length === 2 ? "grid-cols-2" : ""}`}>{meters}</div> : <p className="text-xs text-faint">No monthly allotment set</p>}
                    {/* Video only: no designer to assign (one already on stays, so they can be taken off); images only: no editor */}
                    {(seatNeeded("graphic_designer", caps) || c.assigned.graphic_designer) && seat("graphic_designer")}
                    {(seatNeeded("video_editor", caps) || c.assigned.video_editor) && seat("video_editor")}
                  </>,
                  flight,
                )}
              {others.length > 0 && <p className="px-1 text-[11.5px] text-faint">Also on {others.map((x) => SERVICES.find((v) => v.slug === x)!.short).join(", ")}.</p>}
            </dl>
          )}

          <div className="-mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex flex-wrap items-center gap-3">
              {!has("creative") && c.inFlight > 0 && flight}
              <Light label="Slack" tone={c.live.slack} />
              <Light label="Drive" tone={c.live.drive} />
              {c.contacts ? (
                <span className="text-faint">
                  {c.contacts} contact{c.contacts === 1 ? "" : "s"}
                </span>
              ) : (
                <Link href={`/clients/${c.slug}`} className="inline-flex min-h-11 items-center text-warn hover:underline md:inline md:min-h-0">
                  No client contacts
                </Link>
              )}
            </span>
            <span className="flex items-center gap-3">
              {canEdit && <ArchiveControl clientId={c.id} slug={c.slug} name={c.name} archived={null} />}
              <Link href={`/clients/${c.slug}`} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
                Open →
              </Link>
            </span>
          </div>
        </div>
      )}
    </li>
  );
}
