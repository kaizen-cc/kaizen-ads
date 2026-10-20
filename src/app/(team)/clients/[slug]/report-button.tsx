"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { reportForRange } from "../../reports/actions";

// A recap on demand, from the client page: when a client asks where things stand. The same report as the weekly and
// monthly ones (the numbers, the work behind them, the buyer's voice, the QA, the PDF), for the dates picked.

/** client: set on the Reports page, where the accounts span clients (the client is picked first) */
type Account = { id: string; label: string; client?: string };
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function ReportButton({ accounts: all, today, label = "Get a report", primary = false }: { accounts: Account[]; today: string; label?: string; primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const clients = [...new Set(all.map((a) => a.client).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b));
  const [client, setClient] = useState<string>(clients.length === 1 ? clients[0] : "");
  const accounts = clients.length ? all.filter((a) => a.client === client) : all;
  const [picked, setPicked] = useState<string[]>(accounts.map((a) => a.id));
  const [range, setRange] = useState<"mtd" | "7d" | "last" | "custom">("mtd");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!all.length) return null;

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={primary ? "inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(200,16,46,0.9)] hover:brightness-110" : "inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-muted transition-colors hover:border-faint hover:text-fg"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4" />
        </svg>
        {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="grid w-full max-w-md gap-5 rounded-[22px] border border-line bg-surface p-6 shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]" onClick={(e) => e.stopPropagation()}>
            <div className="grid gap-1">
              <h2 className="font-heading text-xl">A recap for the client</h2>
              <p className="text-sm text-muted">The same report as the weekly and monthly ones, for the dates you pick: drafted in the buyer&apos;s voice, checked by the QA, with its PDF. You review it before it goes anywhere.</p>
            </div>
            {clients.length > 0 && (
              <ClientSearch
                clients={clients}
                all={all}
                value={client}
                onPick={(c) => {
                  setClient(c);
                  setPicked(all.filter((a) => a.client === c).map((a) => a.id));
                }}
              />
            )}
            {accounts.length > 1 && (
              <div className="grid gap-2">
                <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Accounts</p>
                <div className="flex flex-wrap gap-1.5">
                  {accounts.map((a) => {
                    const on = picked.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPicked((p) => (on ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                        className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs transition-all ${on ? "border border-brand/50 bg-brand/15 text-fg" : "border border-line text-faint hover:text-muted"}`}
                      >
                        <span className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${on ? "border-brand bg-brand" : "border-faint"}`}>
                          {on && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M5 12l5 5L19 7" />
                            </svg>
                          )}
                        </span>
                        {a.label}
                      </button>
                    );
                  })}
                </div>
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

/** Initials for the client monogram */
const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** The search term in bold inside a name */
function Match({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold text-fg">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * Find a client by typing: results show from the second letter, best matches first (names that start with it, then
 * words that start with it, then anywhere), arrow keys and Enter to pick. Once picked it sits as a card with its accounts.
 */
function ClientSearch({ clients, all, value, onPick }: { clients: string[]; all: Account[]; value: string; onPick: (c: string) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(!value);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const rank = (c: string) => {
      const n = c.toLowerCase();
      if (n.startsWith(t)) return 0;
      if (n.split(/[\s/&.-]+/).some((w) => w.startsWith(t))) return 1;
      return n.includes(t) ? 2 : -1;
    };
    return clients
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.c.localeCompare(b.c))
      .slice(0, 8)
      .map((x) => x.c);
  }, [q, clients]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (c: string) => {
    onPick(c);
    setQ("");
    setEditing(false);
  };
  const platforms = (c: string) => all.filter((a) => a.client === c).map((a) => a.label);

  if (value && !editing) {
    return (
      <div className="grid gap-1.5">
        <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Client</p>
        <div className="flex items-center gap-3 rounded-[14px] border border-line bg-gradient-to-br from-white/[0.04] to-transparent p-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-gradient-to-br from-brand to-[#5a0a16] font-heading text-sm text-white shadow-[0_8px_20px_-10px_rgba(200,16,46,0.9)]">{initials(value)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">{value}</p>
            <p className="truncate text-xs text-faint">{platforms(value).join(" · ")}</p>
          </div>
          <button type="button" onClick={() => setEditing(true)} className="h-8 rounded-full border border-line px-3 text-xs text-muted transition-colors hover:border-faint hover:text-fg">
            Change
          </button>
        </div>
      </div>
    );
  }

  const t = q.trim();
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Client</p>
      <div className="relative">
        <div className="flex h-11 items-center gap-2.5 rounded-[12px] border border-line bg-bg px-3.5 transition-colors focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_rgba(200,16,46,0.12)]">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-faint" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={input}
            value={q}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="client-results"
            placeholder={`Search ${clients.length} clients`}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && results[active]) {
                e.preventDefault();
                pick(results[active]);
              } else if (e.key === "Escape" && value) {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
          />
          {value && (
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-faint hover:text-fg">
              Cancel
            </button>
          )}
        </div>
        {t.length > 0 && (
          <div id="client-results" ref={list} role="listbox" className="absolute inset-x-0 top-[calc(100%+6px)] z-10 max-h-72 overflow-y-auto rounded-[14px] border border-line bg-surface/95 p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl">
            {t.length < 2 ? (
              <p className="px-3 py-2.5 text-xs text-faint">Keep typing…</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-faint">No client matches &ldquo;{t}&rdquo;</p>
            ) : (
              results.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-i={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c)}
                  className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors ${i === active ? "bg-white/[0.06]" : ""}`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-[11px] font-medium transition-colors ${i === active ? "bg-brand text-white" : "bg-white/[0.06] text-muted"}`}>{initials(c)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-muted">
                      <Match text={c} q={t} />
                    </span>
                    <span className="block truncate text-[11px] text-faint">{platforms(c).join(" · ")}</span>
                  </span>
                  {i === active && <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Enter</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
