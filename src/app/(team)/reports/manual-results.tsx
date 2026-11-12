"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_SOURCE, MANUAL_SUGGESTIONS, type ManualLine } from "@/lib/reports/manual";
import { regenerate, saveManualResults } from "./actions";

// Offline results (bookings, sales and the like that live only in the client's CRM) for the report's period. A line is
// what was counted, how many, the revenue if any, and where it came from; saved as it changes. The numbers for the
// period before are optional: without them the report shows no change for that line, never a made-up one.

export type ManualEntered = { lines: ManualLine[]; start: string | null; end: string | null; byName: string | null; at: string | null };

const blank = (): ManualLine => ({ id: `m${Math.random().toString(36).slice(2, 8)}`, label: "", count: NaN, revenue: null, priorCount: null, priorRevenue: null, source: DEFAULT_SOURCE, note: null, main: false });
const field = "h-11 w-full min-w-0 rounded-[10px] border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60 md:h-10";
const toNum = (v: string): number | null => (v.trim() === "" ? null : Number.isFinite(Number(v.replace(/[$,]/g, ""))) ? Number(v.replace(/[$,]/g, "")) : null);
const show = (n: number | null) => (n == null || Number.isNaN(n) ? "" : String(n));
const when = (at: string | null) => (at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "");

export function ManualResults({ reportId, entered, period, locked }: { reportId: string; entered: ManualEntered | null; period: { start: string; end: string; label: string }; locked: boolean }) {
  const router = useRouter();
  const listId = useId();
  const [lines, setLines] = useState<ManualLine[]>(entered?.lines ?? []);
  const [open, setOpen] = useState(Boolean(entered?.lines.length));
  const [state, setState] = useState<"idle" | "saving" | "saved" | { error: string }>("idle");
  const [changed, setChanged] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // Numbers entered for other dates than the report's now (its period moved): not counted until confirmed here
  const stale = Boolean(entered?.lines.length && entered.start && (entered.start !== period.start || entered.end !== period.end));

  const persist = (next: ManualLine[], now = false) => {
    if (timer.current) clearTimeout(timer.current);
    const run = async () => {
      setState("saving");
      const r = await saveManualResults(reportId, next.map((l) => ({ ...l, count: Number.isNaN(l.count) ? (null as unknown as number) : l.count })));
      if (!r.ok) return setState({ error: r.error });
      setState("saved");
      setChanged(true);
      router.refresh();
    };
    if (now) void run();
    else timer.current = setTimeout(() => void run(), 700);
  };
  const edit = (id: string, patch: Partial<ManualLine>, now = false) => {
    const next = lines.map((l) => (l.id === id ? { ...l, ...patch } : l));
    // One main result at most
    const fixed = patch.main ? next.map((l) => (l.id === id ? l : { ...l, main: false })) : next;
    setLines(fixed);
    persist(fixed, now);
  };
  const remove = (id: string) => {
    const next = lines.filter((l) => l.id !== id);
    setLines(next);
    persist(next, true);
  };

  if (locked && !lines.length) return null;
  if (!open && !lines.length)
    return (
      <button type="button" disabled={locked} onClick={() => (setOpen(true), setLines([blank()]))} className="flex min-h-11 w-fit items-center gap-2 rounded-full border border-line bg-surface px-4 text-[13px] text-muted hover:text-fg md:min-h-9">
        <span aria-hidden className="text-base leading-none">+</span> Add results from the client&rsquo;s CRM
      </button>
    );

  return (
    <section className="grid gap-3 rounded-[14px] border border-line bg-surface p-4 md:p-5" aria-label="Results from the client's CRM">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="font-heading text-lg leading-tight">Results from the client&rsquo;s CRM</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-muted">
            Bookings, sales and other results the ad platform can&rsquo;t see, for {period.label}. They show in the report marked as entered by the team.
          </p>
        </div>
        <p aria-live="polite" className="text-xs text-faint">
          {typeof state === "object" ? <span className="text-bad">{state.error}</span> : state === "saving" ? "Saving…" : state === "saved" ? "Saved" : entered?.byName ? `Entered by ${entered.byName}${entered.at ? ` · ${when(entered.at)}` : ""}` : ""}
        </p>
      </header>

      {stale && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
          <span className="min-w-0 flex-1 basis-60">These were entered for other dates, so the report isn&rsquo;t using them yet.</span>
          <button type="button" disabled={locked} onClick={() => persist(lines, true)} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9">
            Use for {period.label}
          </button>
        </div>
      )}

      <datalist id={listId}>
        {MANUAL_SUGGESTIONS.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>

      <div className="grid gap-3">
        {lines.map((l) => (
          <fieldset key={l.id} disabled={locked} className="grid gap-2.5 rounded-[12px] border border-line bg-bg p-3">
            <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
              <label className="grid gap-1 text-xs text-muted">
                What was counted
                <input list={listId} value={l.label} onChange={(e) => edit(l.id, { label: e.target.value })} placeholder="Bookings" maxLength={60} className={field} />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Count
                <input inputMode="decimal" value={show(l.count)} onChange={(e) => edit(l.id, { count: toNum(e.target.value) ?? NaN })} placeholder="2" className={field} />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Revenue (optional)
                <input inputMode="decimal" value={show(l.revenue)} onChange={(e) => edit(l.id, { revenue: toNum(e.target.value) })} placeholder="$0" className={field} />
              </label>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <label className="grid gap-1 text-xs text-muted">
                Source
                <input value={l.source} onChange={(e) => edit(l.id, { source: e.target.value })} maxLength={80} className={field} />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Note (optional)
                <input value={l.note ?? ""} onChange={(e) => edit(l.id, { note: e.target.value })} maxLength={300} placeholder="Anything the client should know" className={field} />
              </label>
            </div>
            <details className="text-xs text-muted" open={l.priorCount != null || l.priorRevenue != null}>
              <summary className="flex min-h-11 w-fit cursor-pointer items-center hover:text-fg md:min-h-8">The period before (to show a change)</summary>
              <div className="mt-1 grid gap-2.5 sm:grid-cols-2">
                <label className="grid gap-1">
                  Count before
                  <input inputMode="decimal" value={show(l.priorCount)} onChange={(e) => edit(l.id, { priorCount: toNum(e.target.value) })} className={field} />
                </label>
                <label className="grid gap-1">
                  Revenue before
                  <input inputMode="decimal" value={show(l.priorRevenue)} onChange={(e) => edit(l.id, { priorRevenue: toNum(e.target.value) })} className={field} />
                </label>
              </div>
              <p className="mt-1.5 leading-snug text-faint">Leave it empty and the report shows no change for this line.</p>
            </details>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] md:min-h-9">
                <input type="checkbox" checked={l.main} onChange={(e) => edit(l.id, { main: e.target.checked }, true)} className="h-4 w-4 shrink-0 accent-[var(--brand)]" />
                <span>
                  Use as the main result <span className="text-faint">(cost per result and ROAS follow it)</span>
                </span>
              </label>
              <button type="button" onClick={() => remove(l.id)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-bad md:min-h-9">
                Remove
              </button>
            </div>
          </fieldset>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" disabled={locked || lines.length >= 12} onClick={() => setLines([...lines, blank()])} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
          + Add another result
        </button>
        {changed && !locked && (
          <>
            <span className="text-xs text-faint">The numbers are in the report now. The written note picks them up when it&rsquo;s rewritten.</span>
            <button type="button" disabled={pending} onClick={() => start(async () => void (await regenerate(reportId), router.refresh()))} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
              {pending ? "Starting…" : "Rewrite the report with these"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
