"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reportForRange } from "../../reports/actions";

// A recap on demand, from the client page: when a client asks where things stand. The same report as the weekly and
// monthly ones (the numbers, the work behind them, the buyer's voice, the QA, the PDF), for the dates picked.

type Account = { id: string; label: string };
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function ReportButton({ accounts, today }: { accounts: Account[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(accounts.map((a) => a.id));
  const [range, setRange] = useState<"mtd" | "7d" | "last" | "custom">("mtd");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!accounts.length) return null;

  // The dates for a choice, as of today (New York); data runs through yesterday
  const dates = () => {
    const t = new Date(`${today}T12:00:00Z`);
    const y = new Date(t.getTime() - 86_400_000);
    if (range === "custom") return { start: from, end: to };
    if (range === "7d") return { start: ymd(new Date(y.getTime() - 6 * 86_400_000)), end: ymd(y) };
    if (range === "last") {
      const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1, 12));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0, 12));
      return { start: ymd(first), end: ymd(last) };
    }
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1, 12));
    // On the 1st, "month to date" is the month that just ended
    return today.endsWith("-01") ? { start: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1, 12))), end: ymd(y) } : { start: ymd(first), end: ymd(y) };
  };
  const go = () =>
    start(async () => {
      setError(null);
      const d = dates();
      const r = await reportForRange(picked, d.start, d.end);
      if (!r.ok) return setError(r.error);
      router.push(r.ids.length === 1 ? `/reports/${r.ids[0]}` : "/reports");
    });

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-muted transition-colors hover:border-faint hover:text-fg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4" />
        </svg>
        Get a report
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="grid w-full max-w-md gap-5 rounded-[22px] border border-line bg-surface p-6 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]" onClick={(e) => e.stopPropagation()}>
            <div className="grid gap-1">
              <h2 className="font-heading text-xl">A recap for the client</h2>
              <p className="text-sm text-muted">The same report as the weekly and monthly ones, for the dates you pick: drafted in the buyer&apos;s voice, checked by the QA, with its PDF. You review it before it goes anywhere.</p>
            </div>
            {accounts.length > 1 && (
              <div className="grid gap-2">
                <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Accounts</p>
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2.5 text-sm">
                    <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} className="accent-[#c8102e]" />
                    {a.label}
                  </label>
                ))}
              </div>
            )}
            <div className="grid gap-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Dates</p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["mtd", "Month to date"],
                    ["7d", "Last 7 days"],
                    ["last", "Last month"],
                    ["custom", "Custom"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setRange(k)} className={`h-8 rounded-full px-3 text-xs transition-colors ${range === k ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                    {l}
                  </button>
                ))}
              </div>
              {range === "custom" && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-[11px] text-faint">
                    From
                    <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-[10px] border border-line bg-bg px-2 text-sm text-fg [color-scheme:dark]" />
                  </label>
                  <label className="grid gap-1 text-[11px] text-faint">
                    To
                    <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-[10px] border border-line bg-bg px-2 text-sm text-fg [color-scheme:dark]" />
                  </label>
                </div>
              )}
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="h-9 px-3 text-sm text-faint hover:text-fg">
                Cancel
              </button>
              <button type="button" disabled={pending || !picked.length || (range === "custom" && (!from || !to))} onClick={go} className="h-10 rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50">
                {pending ? "Starting…" : "Draft the recap"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
