"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setSuppliesContent } from "./email-scope-actions";

// Client supplies the content: their team provides each email's images, copy and CTA links in a Google Sheet, so their
// requests skip the strategy, brief and copy steps and go straight to the designer. Email leads switch it per client.

export function SuppliesToggle({ clientId, on, sheet, canEdit }: { clientId: string; on: boolean; sheet: string | null; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const flip = (next: boolean) =>
    start(async () => {
      setError(null);
      setValue(next);
      const r = await setSuppliesContent(clientId, next);
      if (!r.ok) {
        setValue(!next);
        return setError(r.error);
      }
      router.refresh();
    });
  return (
    <section className="flex flex-wrap items-start justify-between gap-3 rounded-[20px] border border-line bg-surface p-5 md:p-6">
      <div className="grid max-w-xl gap-1">
        <p className="text-[15px] font-medium text-fg">Client supplies the content</p>
        <p className="text-[13px] leading-relaxed text-muted">
          Their team provides the images, copy and CTA links in a Google Sheet. Their requests skip the strategy, brief and copy steps: link the sheet and it goes straight to the designer, still counting against the allotment.
        </p>
        {value && sheet && (
          <a href={sheet} target="_blank" rel="noopener noreferrer" className="justify-self-start text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline">
            Their last sheet ↗
          </a>
        )}
        {error && <p className="text-[12.5px] text-bad">{error}</p>}
      </div>
      <label className={`inline-flex min-h-11 items-center gap-2 text-[13px] ${canEdit ? "cursor-pointer" : "opacity-60"}`}>
        <input type="checkbox" checked={value} disabled={!canEdit || pending} onChange={(e) => flip(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand,#c8102e)]" />
        {value ? "On" : "Off"}
      </label>
    </section>
  );
}
