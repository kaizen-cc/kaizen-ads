"use client";

import { ActionForm } from "@/components/action-form";
import { field, label } from "@/components/ui";

type Result = { ok: true } | { ok: false; error: string };
export type BillingDayChange = { at: string; oldDay: number | null; newDay: number | null; source: string | null; by: string | null; note: string | null };

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const SOURCE: Record<string, string> = { stripe: "From Stripe (the Creative Package bill)", track: "From Kaizen Track (when their first service started)", enrolled: "The day they enrolled", set: "Set by hand" };

/**
 * The day the client's creative is billed, which is when their creative allotment starts again. It comes from Stripe on
 * its own (the bill with the Creative Package on it); an exec can set it by hand, with a note, and every change is kept.
 */
export function BillingDayPanel({ day, source, start, end, history, canEdit, save }: { day: number | null; source: string | null; start: string | null; end: string | null; history: BillingDayChange[]; canEdit: boolean; save: (form: FormData) => Promise<Result> }) {
  const fmt = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="font-heading text-[22px] leading-none">{day ? `The ${ordinal(day)}` : "Calendar month"}</p>
        <p className="text-[13px] text-muted">{source ? (SOURCE[source] ?? source) : "Not set yet"}</p>
        {start && end && <p className="text-[13px] text-faint">This cycle {fmt(start)} → {fmt(end)}</p>}
      </div>

      {canEdit && (
        <ActionForm action={save} submitLabel="Save" className="grid gap-3 border-t border-line pt-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
            <label className={label}>
              Creative billed on
              <select name="day" defaultValue={source === "set" && day ? String(day) : "auto"} className={field}>
                <option value="auto">Follow Stripe (automatic)</option>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    The {ordinal(d)} of each month
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              Why (kept in the history)
              <input name="note" placeholder="e.g. creative moved to the 4th on the new invoice" className={field} />
            </label>
          </div>
          <p className="text-[11.5px] text-faint">A day set by hand is never overwritten by Stripe. Pick &ldquo;Follow Stripe&rdquo; to hand it back.</p>
        </ActionForm>
      )}

      {history.length > 0 && (
        <div className="grid gap-1.5 border-t border-line pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">History</p>
          <ul className="grid gap-1.5">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="tabular text-faint">{new Date(h.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                <span>
                  {h.oldDay ? ordinal(h.oldDay) : "calendar month"} → <b className="font-medium">{h.newDay ? ordinal(h.newDay) : "calendar month"}</b>
                </span>
                <span className="text-muted">· {h.source === "set" ? `set by ${h.by ?? "an exec"}` : h.source ? (SOURCE[h.source] ?? h.source).toLowerCase() : "handed back to Stripe"}</span>
                {h.note && <span className="w-full text-[12.5px] text-muted md:w-auto">&ldquo;{h.note}&rdquo;</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
