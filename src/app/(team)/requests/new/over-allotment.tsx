"use client";

import type { Allotment } from "@/lib/allotment";
import type { FormatCounts } from "@/lib/allotment";
import { overAllotment, overText } from "@/lib/allotment-over";

/**
 * Over the allotment on purpose: the disclaimer at the top of the request for a client already at or past their cap
 * (or one this request takes past it). It never blocks: the numbers, what this adds, and an optional reason, kept with
 * the request (on the ticket and the Asana task) and logged with who pushed it through.
 */
export function OverAllotmentBanner({ allotment, formats, reason, onReason }: { allotment: Allotment | undefined; formats: Partial<Record<"image" | "video" | "carousel", FormatCounts>>; reason: string; onReason: (v: string) => void }) {
  const lines = overAllotment(allotment ?? null, formats);
  if (!lines.length) return null;
  return (
    <section role="status" className="grid gap-3 overflow-hidden rounded-[20px] border border-bad/35 bg-bad-soft/60 p-4 md:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-bad text-[15px] font-semibold text-white">!</span>
        <div className="grid min-w-0 gap-1">
          <p className="font-heading text-[17px] leading-snug text-fg">Over allotment</p>
          {lines.map((l) => (
            <p key={l.pool} className="text-[14px] leading-relaxed text-fg/80">
              {overText(l)}
            </p>
          ))}
          <p className="text-[12.5px] leading-relaxed text-muted">You can still send it. It&apos;s marked over the allotment on the ticket and the Asana task, with who sent it and why.</p>
        </div>
      </div>
      {lines.map((l) => {
        const scale = Math.max(l.after, l.cap, 1);
        return (
          <div key={`bar-${l.pool}`} className="relative h-2.5 overflow-hidden rounded-full bg-ink/10" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-full bg-fg/30" style={{ width: `${(Math.min(l.used, l.cap) / scale) * 100}%` }} />
            <span className="absolute inset-y-0 bg-bad/70" style={{ left: `${(l.cap / scale) * 100}%`, width: `${(Math.max(0, l.used - l.cap) / scale) * 100}%` }} />
            <span className="absolute inset-y-0 bg-bad" style={{ left: `${(Math.max(l.used, l.cap) / scale) * 100}%`, width: `${((l.after - Math.max(l.used, l.cap)) / scale) * 100}%` }} />
            <span className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `${(l.cap / scale) * 100}%` }} />
          </div>
        );
      })}
      <label className="grid gap-1.5">
        <span className="text-[12px] text-muted">Why it can&apos;t wait (optional)</span>
        <input value={reason} onChange={(e) => onReason(e.target.value)} maxLength={300} placeholder="e.g. the client's launch moved up, agreed with their media buyer" className="h-11 w-full rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-faint" />
      </label>
    </section>
  );
}
