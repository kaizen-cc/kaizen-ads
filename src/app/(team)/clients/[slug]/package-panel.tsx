"use client";

import { Section } from "@/components/ui";
import { allotmentPool, untilLabel } from "@/lib/allotment";
import type { CreativeDb } from "@/lib/creative-db";

type Result = { ok: true } | { ok: false; error: string };
export type PackageOption = { key: string; label: string; images: number; videos: number };
/** The billing cycle the allotment counts in: the day they're billed (null: the calendar month), where that day came from, and this cycle's first day and reset day */
export type Cycle = { billingDay: number | null; source: string | null; start: string | null; end: string | null; /** A paid period with nothing made, or this one far along with nothing started */ gap?: { missed: { start: string; end: string } | null; atRisk: { start: string; end: string; elapsed: number } | null } | null };

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86400000);

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const both = (images: number, videos: number) => [images ? n(images, "image", "images") : null, videos ? n(videos, "video", "videos") : null].filter(Boolean).join(" and ");

/** The client's Creative Database (finished work, ready for the client) beside the count, which follows work in motion. */
function DbCheck({ db, imagesUsed, videosUsed }: { db: CreativeDb; imagesUsed: number; videosUsed: number }) {
  if (db.error)
    return (
      <p className="text-[11px] text-faint">
        Couldn&apos;t read the{" "}
        <a href={db.url} target="_blank" rel="noreferrer" className="underline hover:text-fg">
          Creative Database
        </a>
        : {db.error}
      </p>
    );
  const ahead = db.month.newImages > imagesUsed || db.month.newVideos > videosUsed;
  return (
    <div className="grid gap-1 rounded-[10px] border border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
      <a href={db.url} target="_blank" rel="noreferrer" className="font-medium text-fg hover:underline">
        Creative Database ↗
      </a>
      <span>
        Delivered this month: {n(db.month.newImages, "new image", "new images")}, {n(db.month.newVideos, "new video", "new videos")}.
      </span>
      <span>
        Last 45 days: {n(db.last45.newImages + db.last45.newVideos, "new creative", "new creatives")} ({db.last45.newImages} images, {db.last45.newVideos} videos),{" "}
        {db.last45.allImages + db.last45.allVideos} with variations.
      </span>
      {ahead && <span className="text-warn">The database shows more delivered this month than is counted above. A request may be missing from Kaizen OS and Asana.</span>}
    </div>
  );
}

function Meter({ name, cap, used }: { name: string; cap: number; used: number }) {
  // The shared allotment helper: per pool, and an overage shown as one, never clamped
  const p = allotmentPool(name === "Videos" ? "videos" : "images", cap, used);
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">{name}</span>
        <span className="tabular">
          {used} <span className="text-faint">of {cap}</span>
          {p.over > 0 && <span className="text-bad"> · {p.over} over</span>}
        </span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${used > cap ? "bg-bad" : "bg-brand"}`} style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : used ? 100 : 0}%` }} />
      </span>
    </div>
  );
}

/**
 * The client's creative package: what they're on and this month's use. The package itself (a package, Custom numbers,
 * a sprint, or strategy only) is set in one place: Services, on Team & setup (owner, Nov 19 2026).
 */
export function PackagePanel({
  active,
  packageLabel,
  until,
  note,
  today,
  images,
  videos,
  imagesUsed,
  videosUsed,
  fromAsana,
  cycle = null,
  creativeDb,
  can,
  setupHref,
}: {
  active: boolean;
  packageLabel: string | null;
  packageKey: string | null;
  until: string | null;
  note: string | null;
  today: string;
  images: number;
  videos: number;
  imagesUsed: number;
  videosUsed: number;
  fromAsana?: { images: number; videos: number; waitingImages?: number; waitingVideos?: number };
  cycle?: Cycle | null;
  creativeDb?: CreativeDb | null;
  packages: PackageOption[];
  can: { exec: boolean; allot: boolean };
  setSprint?: (form: FormData) => Promise<Result>;
  endPackage?: () => Promise<Result>;
  saveAllotment?: (form: FormData) => Promise<Result>;
  /** Team & setup, where Services sets the package */
  setupHref?: string;
}) {
  const sprint = active && until;
  const left = sprint ? daysBetween(today, until) + 1 : 0;

  if (!active)
    return (
      <Section title="Creative package">
        <div className="relative grid justify-items-center gap-3 overflow-hidden rounded-[12px] border border-dashed border-line px-6 py-7 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-faint">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <p className="font-heading text-[17px]">Not on a creative package</p>
          <p className="max-w-[260px] text-xs leading-relaxed text-muted">
            Creative requests are off for this client. {can.exec ? "Set their package, custom numbers, a sprint, or strategy only in Services." : "An exec sets the package in Services."}
          </p>
          {can.exec && setupHref && (
            <a href={setupHref} className="mt-1 grid h-11 place-items-center rounded-full bg-fg px-5 text-sm text-bg transition-opacity hover:opacity-90 md:h-9 md:px-4">
              Set it in Services
            </a>
          )}
        </div>
      </Section>
    );

  return (
    <Section title="Creative package">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-brand-soft px-2.5 py-1 text-xs text-brand-text">{packageLabel ?? "Custom"}</span>
          {sprint ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-1 text-xs text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              Sprint until {untilLabel(until)} · {left === 1 ? "last day" : `${left} days left`}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">Ongoing</span>
          )}
        </div>
        {sprint && note && <p className="-mt-2 text-xs leading-relaxed text-muted">{note}</p>}

        {cycle?.gap?.missed && (
          <p className="rounded-[12px] border border-bad/40 bg-bad-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-bad">
            Nothing was made for them from {untilLabel(cycle.gap.missed.start)} to {untilLabel(cycle.gap.missed.end)}, a period they paid for. Make it up this cycle, or talk to them before they ask for a refund.
          </p>
        )}
        {!cycle?.gap?.missed && cycle?.gap?.atRisk && (
          <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn">
            {cycle.gap.atRisk.elapsed}% through this billing period and nothing has been made yet.
          </p>
        )}
        <p className="-mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs font-medium uppercase tracking-[0.12em] text-faint">
          <span>{cycle?.billingDay ? "This billing cycle" : "This month"}</span>
          {cycle?.start && cycle.end && <span className="normal-case tracking-normal">{untilLabel(cycle.start)} · resets {untilLabel(cycle.end)}</span>}
        </p>
        <Meter name="Images & carousels" cap={images} used={imagesUsed} />
        <Meter name="Videos" cap={videos} used={videosUsed} />
        {fromAsana && (fromAsana.images > 0 || fromAsana.videos > 0) && (
          <p className="-mt-1 text-[11px] text-faint">
            Includes {both(fromAsana.images, fromAsana.videos)} in production or delivered in Asana this {cycle?.billingDay ? "cycle" : "month"}
          </p>
        )}
        {fromAsana && ((fromAsana.waitingImages ?? 0) > 0 || (fromAsana.waitingVideos ?? 0) > 0) && (
          <p className="-mt-1 text-[11px] text-warn">
            {both(fromAsana.waitingImages ?? 0, fromAsana.waitingVideos ?? 0)} of these briefed in Asana and not started yet: they count from the moment they&apos;re briefed
          </p>
        )}
        {creativeDb && <DbCheck db={creativeDb} imagesUsed={imagesUsed} videosUsed={videosUsed} />}
      </div>

      {cycle?.billingDay ? (
        <p className="border-t border-line pt-4 text-[12px] text-faint">The allotment starts again on the {ordinal(cycle.billingDay)}{cycle.source === "stripe" ? ", from their Stripe Creative Package bill" : cycle.source === "set" ? ", set by an exec" : ""}. Execs change it in Team &amp; setup.</p>
      ) : null}

      {(can.exec || can.allot) && setupHref && (
        <p className="border-t border-line pt-4 text-[12px] text-faint">
          The package, custom numbers, a sprint or strategy only are set in one place:{" "}
          <a href={setupHref} className="text-muted underline-offset-2 hover:text-fg hover:underline">
            Services on Team &amp; setup
          </a>
          .
        </p>
      )}
    </Section>
  );
}
