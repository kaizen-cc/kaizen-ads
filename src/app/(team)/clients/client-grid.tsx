import Link from "next/link";
import { tintFor } from "@/lib/colors";
import type { Freshness } from "@/lib/dates";
import { untilLabel } from "@/lib/allotment";
import { SLOTS, type SlotRole } from "@/lib/roles";
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

/**
 * Every client as a card, at a glance: the services they're on (with the creative package tier), and for each one only
 * the people it needs. A service they don't have takes no space; an empty seat on one they do is flagged.
 */
export function ClientGrid({ cards, slotOptions, canEdit }: { cards: ClientCard[]; slotOptions: Record<SlotRole, Option[]>; canEdit: boolean }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => {
        const tint = tintFor(c.name);
        const has = (s: ServiceSlug) => c.services.includes(s);
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
        const others = c.services.filter((x) => !MANAGED.includes(x));
        // What's being made for them: with their creative
        const flight = (
          <Link href={`/board?client=${c.slug}`} title="Open on the board" className={`rounded-full px-2 py-0.5 text-[11px] tabular transition-colors ${c.inFlight ? "bg-brand-soft text-brand-text hover:bg-brand/25" : "text-faint hover:text-fg"}`}>
            {c.inFlight ? `${c.inFlight} in flight` : "Nothing in flight"}
          </Link>
        );
        return (
          <li
            key={c.id}
            className={`group relative grid content-start gap-4 overflow-hidden rounded-[14px] border border-line bg-surface p-5 transition-colors hover:border-faint/70 ${c.status === "paused" ? "opacity-60" : ""}`}
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
                </p>
              </div>
            </div>

            {/* The services, at a glance */}
            <div className="relative flex flex-wrap gap-1.5">
              {c.services.length ? (
                c.services.map((x) => {
                  const svc = SERVICES.find((v) => v.slug === x)!;
                  return (
                    <span key={x} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11.5px]">
                      <span className={`h-1.5 w-1.5 rounded-full ${SVC_DOT[x] ?? "bg-muted"}`} />
                      {svc.short}
                      {x === "creative" && c.packageLabel && <span className="text-faint">· {c.packageLabel}</span>}
                      {x === "creative" && c.pkg === "sprint" && c.until && <span className="text-warn">· sprint to {untilLabel(c.until)}</span>}
                    </span>
                  );
                })
              ) : (
                <Link href={`/clients/${c.slug}`} className="rounded-full border border-dashed border-warn/40 px-2.5 py-1 text-[11.5px] text-warn">
                  No services on file
                </Link>
              )}
            </div>

            {/* Each service with the people it needs */}
            {(has("facebook-ads") || has("google-ads") || has("creative") || others.length > 0) && (
              <dl className="relative grid gap-2">
                {has("facebook-ads") && block("Meta Ads", SVC_DOT["facebook-ads"]!, seat("meta_buyer"), <Light label="synced" tone={c.live.meta} />)}
                {has("google-ads") && block("Google Ads", SVC_DOT["google-ads"]!, seat("google_buyer"))}
                {has("creative") &&
                  block(
                    `Creative${c.packageLabel ? ` · ${c.packageLabel}` : ""}`,
                    SVC_DOT.creative!,
                    <>
                      <div className="grid grid-cols-2 gap-4 pb-1">
                        <Meter label="Images" used={c.images.used} cap={c.images.cap} />
                        <Meter label="Videos" used={c.videos.used} cap={c.videos.cap} />
                      </div>
                      {seat("graphic_designer")}
                      {seat("video_editor")}
                    </>,
                    flight,
                  )}
                {others.length > 0 && <p className="px-1 text-[11.5px] text-faint">Also on {others.map((x) => SERVICES.find((v) => v.slug === x)!.short).join(", ")}.</p>}
              </dl>
            )}

            <div className="relative -mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
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
              <Link href={`/clients/${c.slug}`} className="inline-flex min-h-11 items-center text-muted transition-opacity hover:text-fg md:inline md:min-h-0 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100">
                Open →
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
