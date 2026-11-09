"use client";

import { useState, useTransition } from "react";
import { setTikTokSeparate } from "./tiktok-report-actions";

/** Report settings: Meta and TikTok as one weekly report (on by default) or two. Saved on change. */
export function TikTokReportToggle({ clientId, slug, separate }: { clientId: string; slug: string; separate: boolean }) {
  const [on, setOn] = useState(!separate);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[14px] border border-line bg-surface px-4 py-3">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          start(async () => {
            const r = await setTikTokSeparate(clientId, slug, !next).catch(() => ({ ok: false as const, error: "Couldn't save." }));
            if (!r.ok) {
              setOn(!next);
              setError(r.error);
            } else setError(null);
          });
        }}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]"
      />
      <span className="grid gap-0.5">
        <span className="text-sm">Send Meta and TikTok as one weekly report</span>
        <span className="text-[12px] leading-relaxed text-faint">The Meta buyer reviews both parts and sends them once: one PDF, one message. Off, TikTok goes out as its own report. Takes effect from the next week&apos;s reports.</span>
        {error && <span className="text-[12px] text-bad">{error}</span>}
      </span>
    </label>
  );
}
