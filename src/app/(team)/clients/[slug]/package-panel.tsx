"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Section } from "@/components/ui";
import { linkCreativeDb, readCreativeDbNow } from "./creative-db-actions";
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

/**
 * Where the count comes from, this cycle only: delivered (the client's Creative Database, every version) and in motion
 * (Asana and tickets, not delivered yet). The sheet can be linked or replaced, and read now. No rolling windows.
 */
function UsageBreakdown({ clientId, db, usage, canLink }: { clientId: string | null; db: CreativeDb | null; usage: Usage | null; canLink: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [link, setLink] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | "link" | "read">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (r: { ok: true; name: string } | { ok: false; error: string }) => {
    setBusy(null);
    setMsg(r.ok ? { ok: true, text: `Read ${r.name}.` } : { ok: false, text: r.error });
    if (r.ok) {
      setEditing(false);
      start(() => router.refresh());
    }
  };
  const sheet = usage?.source === "sheet";
  return (
    <div className="grid gap-1.5 rounded-[10px] border border-line px-3 py-2.5 text-[12px] leading-relaxed text-muted">
      {usage && (
        <>
          <span>
            <span className="text-fg">Delivered this cycle:</span> {sheet ? both(usage.delivered.images, usage.delivered.videos) || "nothing yet" : "no Creative Database read, so counted from the briefs"}
            {sheet && <span className="text-faint"> (Creative Database, every version)</span>}
          </span>
          <span>
            <span className="text-fg">In motion:</span> {both(usage.motion.images, usage.motion.videos) || "nothing"} <span className="text-faint">(Asana, not delivered yet)</span>
          </span>
        </>
      )}
      {db?.error && <span className="text-warn">Couldn&apos;t read the Creative Database: {db.error}</span>}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
        {db?.url ? (
          <a href={db.url} target="_blank" rel="noreferrer" className="font-medium text-fg hover:underline">
            {db.name || "Creative Database"} ↗
          </a>
        ) : (
          <span className="text-warn">No Creative Database linked</span>
        )}
        {db?.readAt && <span className="text-faint">read {new Date(db.readAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
        {clientId && db?.url && (
          <button type="button" disabled={busy !== null} onClick={() => { setBusy("read"); void readCreativeDbNow(clientId).then(done); }} className="min-h-10 text-faint underline-offset-2 hover:text-fg hover:underline disabled:opacity-50 md:min-h-0">
            {busy === "read" ? "Reading…" : "Read now"}
          </button>
        )}
        {clientId && canLink && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="min-h-10 text-faint underline-offset-2 hover:text-fg hover:underline md:min-h-0">
            {db?.url ? "Replace link" : "Link it"}
          </button>
        )}
      </span>
      {clientId && editing && (
        <span className="flex flex-wrap items-center gap-2">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" className="h-11 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2.5 text-[16px] outline-none focus:border-brand/60 md:h-8 md:text-xs" />
          <button type="button" disabled={busy !== null || !link.trim()} onClick={() => { setBusy("link"); void linkCreativeDb(clientId, link).then(done); }} className="h-10 rounded-full bg-fg px-4 text-[11px] font-medium text-bg disabled:opacity-50 md:h-7 md:px-3">
            {busy === "link" ? "Reading…" : "Save and read"}
          </button>
          <button type="button" onClick={() => setEditing(false)} className="min-h-10 text-[11px] text-faint hover:text-fg md:min-h-0">
            Cancel
          </button>
        </span>
      )}
      {msg && <span className={msg.ok ? "text-ok" : "text-bad"}>{msg.text}</span>}
    </div>
  );
}

/** This cycle's breakdown of the count (client_allotment_usage) */
export type Usage = { delivered: { images: number; videos: number }; motion: { images: number; videos: number }; source: "sheet" | "briefs"; shared: boolean };

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
  cycle = null,
  creativeDb,
  can,
  setupHref,
  usage = null,
  clientId = null,
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
  /** This cycle's delivered (the sheet) and in motion (Asana) */
  usage?: Usage | null;
  clientId?: string | null;
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
        {usage?.shared && <p className="-mt-1 text-[11px] text-faint">A shared allotment: every location drawing from it counts here.</p>}
        <UsageBreakdown clientId={clientId} db={creativeDb ?? null} usage={usage} canLink={can.exec || can.allot} />
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
