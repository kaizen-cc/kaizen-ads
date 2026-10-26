"use client";

import { useState } from "react";
import { ActionButton, ActionForm } from "@/components/action-form";
import { Section, field, label } from "@/components/ui";
import { untilLabel } from "@/lib/allotment";
import type { CreativeDb } from "@/lib/creative-db";

type Result = { ok: true } | { ok: false; error: string };
export type PackageOption = { key: string; label: string; images: number; videos: number };

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (day: string, ahead: number) => {
  const d = new Date(`${day}T12:00:00`);
  return new Date(d.getFullYear(), d.getMonth() + 1 + ahead, 0, 12).toISOString().slice(0, 10);
};
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
      {ahead && <span className="text-warn">The database shows more delivered this month than is counted above. A request may be missing from Kaizen Ads and Asana.</span>}
    </div>
  );
}

function Meter({ name, cap, used }: { name: string; cap: number; used: number }) {
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">{name}</span>
        <span className="tabular">
          {used} <span className="text-faint">of {cap}</span>
        </span>
      </div>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${used > cap ? "bg-bad" : "bg-brand"}`} style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : used ? 100 : 0}%` }} />
      </span>
    </div>
  );
}

/** Exec override: a package (or custom counts) until a set day. */
function SprintForm({ action, packages, today, until, packageKey, images, videos, note, submitLabel }: {
  action: (form: FormData) => Promise<Result>;
  packages: PackageOption[];
  today: string;
  until: string | null;
  packageKey: string | null;
  images: number;
  videos: number;
  note: string | null;
  submitLabel: string;
}) {
  const [pkg, setPkg] = useState(packageKey ?? packages[1]?.key ?? "custom");
  const [day, setDay] = useState(until ?? addDays(today, 30));
  const quick = [
    ["2 weeks", addDays(today, 14)],
    ["30 days", addDays(today, 30)],
    ["End of month", monthEnd(today, 0)],
    ["End of next month", monthEnd(today, 1)],
  ] as const;
  const chosen = packages.find((p) => p.key === pkg);

  return (
    <ActionForm action={action} submitLabel={submitLabel} className="grid gap-4">
      <label className={label}>
        Package
        <select name="package" value={pkg} onChange={(e) => setPkg(e.target.value)} className={field}>
          {packages.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label} · {p.images} images, {p.videos} videos
            </option>
          ))}
          <option value="custom">Custom counts</option>
        </select>
      </label>
      {pkg === "custom" ? (
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            Images / month
            <input name="images" type="number" min={0} max={999} defaultValue={images} className={`${field} tabular`} />
          </label>
          <label className={label}>
            Videos / month
            <input name="videos" type="number" min={0} max={999} defaultValue={videos} className={`${field} tabular`} />
          </label>
        </div>
      ) : (
        chosen && <p className="-mt-1 text-xs text-faint">Sets the allotment to {chosen.images} images and {chosen.videos} videos a month.</p>
      )}
      <div className={label}>
        <span>Runs until</span>
        <input name="until" type="date" required min={today} value={day} onChange={(e) => setDay(e.target.value)} className={`${field} tabular`} />
        <span className="flex flex-wrap gap-1.5 pt-1">
          {quick.map(([text, d]) => (
            <button
              key={text}
              type="button"
              onClick={() => setDay(d)}
              className={`h-10 rounded-full px-3.5 text-xs transition-colors md:h-7 md:px-3 ${day === d ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg"}`}
            >
              {text}
            </button>
          ))}
        </span>
        {day >= today && (
          <span className="text-xs font-normal text-faint">
            Ends after {untilLabel(day)}, {daysBetween(today, day) + 1} days including today. Requests stop the day after.
          </span>
        )}
      </div>
      <label className={label}>
        <span>
          Why <span className="font-normal text-faint">(optional)</span>
        </span>
        <input name="note" defaultValue={note ?? ""} className={field} placeholder="e.g. Holiday push, 6 week test" />
      </label>
    </ActionForm>
  );
}

/**
 * The client's creative package: what they're on and this month's use.
 * Enrollment and upsell forms set ongoing packages. Only an exec can override, and an override is always a sprint with an end date.
 */
export function PackagePanel({
  active,
  packageLabel,
  packageKey,
  until,
  note,
  today,
  images,
  videos,
  imagesUsed,
  videosUsed,
  fromAsana,
  creativeDb,
  packages,
  can,
  setSprint,
  endPackage,
  saveAllotment,
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
  creativeDb?: CreativeDb | null;
  packages: PackageOption[];
  can: { exec: boolean; allot: boolean };
  setSprint: (form: FormData) => Promise<Result>;
  endPackage: () => Promise<Result>;
  saveAllotment: (form: FormData) => Promise<Result>;
}) {
  const [editing, setEditing] = useState(false);
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
            Creative requests are off for this client. The upsell form turns a package on{can.exec ? ", or you can start a sprint." : ". Only an exec can override it."}
          </p>
          {can.exec && !editing && (
            <button onClick={() => setEditing(true)} className="mt-1 h-11 rounded-full bg-fg px-5 text-sm text-bg transition-opacity hover:opacity-90 md:h-9 md:px-4">
              Start a sprint package
            </button>
          )}
        </div>
        {can.exec && editing && (
          <div className="grid gap-3 border-t border-line pt-5">
            <div className="flex items-center justify-between">
              <p className="text-sm">Sprint package</p>
              <button onClick={() => setEditing(false)} className="min-h-11 px-1 text-xs text-muted hover:text-fg md:min-h-0 md:px-0">
                Cancel
              </button>
            </div>
            <SprintForm action={setSprint} packages={packages} today={today} until={null} packageKey={packageKey} images={images} videos={videos} note={null} submitLabel="Start sprint" />
          </div>
        )}
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

        <p className="-mb-1 text-xs font-medium uppercase tracking-[0.12em] text-faint">This month</p>
        <Meter name="Images & carousels" cap={images} used={imagesUsed} />
        <Meter name="Videos" cap={videos} used={videosUsed} />
        {fromAsana && (fromAsana.images > 0 || fromAsana.videos > 0) && (
          <p className="-mt-1 text-[11px] text-faint">
            Includes {both(fromAsana.images, fromAsana.videos)} in production or delivered in Asana this month
          </p>
        )}
        {fromAsana && ((fromAsana.waitingImages ?? 0) > 0 || (fromAsana.waitingVideos ?? 0) > 0) && (
          <p className="-mt-1 text-[11px] text-warn">
            {both(fromAsana.waitingImages ?? 0, fromAsana.waitingVideos ?? 0)} more briefed in Asana, not started yet: they count once production starts
          </p>
        )}
        {creativeDb && <DbCheck db={creativeDb} imagesUsed={imagesUsed} videosUsed={videosUsed} />}
      </div>

      {can.allot && !editing && (
        <ActionForm action={saveAllotment} submitLabel="Save allotment" autosave className="grid gap-4 border-t border-line pt-5">
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Images / month
              <input name="images" type="number" min={0} defaultValue={images} className={`${field} tabular`} />
            </label>
            <label className={label}>
              Videos / month
              <input name="videos" type="number" min={0} defaultValue={videos} className={`${field} tabular`} />
            </label>
          </div>
        </ActionForm>
      )}

      {can.exec && (
        <div className="grid gap-3 border-t border-line pt-5">
          {editing ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm">{sprint ? "Change the sprint" : "Switch to a sprint"}</p>
                <button onClick={() => setEditing(false)} className="min-h-11 px-1 text-xs text-muted hover:text-fg md:min-h-0 md:px-0">
                  Cancel
                </button>
              </div>
              <SprintForm
                action={setSprint}
                packages={packages}
                today={today}
                until={until}
                packageKey={packageKey}
                images={images}
                videos={videos}
                note={note}
                submitLabel={sprint ? "Save sprint" : "Start sprint"}
              />
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={() => setEditing(true)} className="min-h-11 text-left text-sm text-muted underline-offset-4 hover:text-fg hover:underline md:min-h-0">
                {sprint ? "Extend or change sprint" : "Override with a sprint"}
              </button>
              <ActionButton action={endPackage} label="End package" confirmText="End it now?" />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
