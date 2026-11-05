"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkAtlassianLoom, pullAtlassianLoomSince, setAtlassianTokenExpiry } from "@/app/(team)/loom-actions";
import { TOKEN_STEPS, TOKEN_URL, countdown } from "@/lib/atlassian-token";

// The Loom (Atlassian) card's buttons: check now, and for execs, pull everything since a date (empty: everything).

type Note = { tone: "ok" | "bad"; text: string };

const said = (r: { found: number; added: number; done: boolean }) =>
  `${r.found} video${r.found === 1 ? "" : "s"} found, ${r.added} new in the queue.${r.done ? "" : " More to go: it keeps going every 15 minutes."}`;

export function LoomAtlassianControls({ isExec }: { isExec: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"check" | "pull" | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [pulling, setPulling] = useState(false);
  const [date, setDate] = useState("");

  const run = async (kind: "check" | "pull") => {
    setBusy(kind);
    setNote(null);
    const r = kind === "check" ? await checkAtlassianLoom() : await pullAtlassianLoomSince(date || null);
    setBusy(null);
    setNote(r.ok ? { tone: "ok", text: said(r) } : { tone: "bad", text: r.error });
    if (r.ok && kind === "pull") setPulling(false);
    router.refresh();
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("check")} className="inline-flex h-11 items-center rounded-full bg-fg px-4 text-xs font-medium text-bg disabled:opacity-50 md:h-9">
          {busy === "check" ? "Checking…" : "Check now"}
        </button>
        {isExec && (
          <button type="button" disabled={Boolean(busy)} aria-expanded={pulling} onClick={() => setPulling((p) => !p)} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-xs text-muted hover:text-fg disabled:opacity-50 md:h-9">
            Pull everything since…
          </button>
        )}
      </div>
      {isExec && pulling && (
        <div className="grid gap-2 rounded-[14px] border border-line bg-bg/50 p-3">
          <label className="grid gap-1 text-[11.5px] text-muted">
            Since (leave empty for every Loom ever)
            <input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[14px] text-fg focus:border-brand focus:outline-none md:h-9" />
          </label>
          <button type="button" disabled={Boolean(busy)} onClick={() => void run("pull")} className="inline-flex h-11 items-center justify-self-start rounded-full bg-fg px-4 text-xs font-medium text-bg disabled:opacity-50 md:h-9">
            {busy === "pull" ? "Pulling…" : date ? `Pull since ${new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "Pull everything"}
          </button>
          <p className="text-[11px] leading-relaxed text-faint">Videos already in are skipped. A big pull continues on its own every 15 minutes until it reaches the end.</p>
        </div>
      )}
      {note && <p className={`text-xs leading-relaxed ${note.tone === "ok" ? "text-ok" : "text-bad"}`}>{note.text}</p>}
    </div>
  );
}

// ─── The token's expiry ─────────────────────────────────────────────────────

type Expiry = { date: string; from: "set" | "env"; daysLeft: number } | null;

const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Token expires on" (execs set it, saved on change), the countdown, and how to make a new token */
export function TokenExpiry({ expiry, isExec, refused }: { expiry: Expiry; isExec: boolean; refused: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(expiry?.date ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = refused || (expiry && expiry.daysLeft <= 7) ? "text-bad" : expiry && expiry.daysLeft <= 30 ? "text-warn" : "text-muted";
  const urgent = refused || (expiry !== null && expiry.daysLeft <= 30);

  const save = async (d: string) => {
    setValue(d);
    setBusy(true);
    setError(null);
    const r = await setAtlassianTokenExpiry(d || null);
    setBusy(false);
    if (!r.ok) setError(r.error);
    router.refresh();
  };

  return (
    <div className={`grid gap-2.5 rounded-[14px] border p-3 ${urgent ? "border-bad/30 bg-bad/[0.04]" : "border-line bg-bg/50"}`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-[11.5px] text-faint">Token</span>
          <span className={`text-[13.5px] font-medium ${tone}`}>
            {refused ? "Refused by Atlassian: expired or revoked" : expiry ? `${countdown(expiry.daysLeft)} · ${longDay(expiry.date)}` : "Expiry date not set"}
          </span>
          {expiry?.from === "env" && <span className="text-[11px] text-faint">From ATLASSIAN_TOKEN_EXPIRES_AT</span>}
        </div>
        {isExec && (
          <label className="grid gap-1 text-[11.5px] text-muted">
            Token expires on
            <input
              type="date"
              value={value}
              disabled={busy}
              onChange={(e) => void save(e.target.value)}
              className="h-11 rounded-[10px] border border-line bg-surface px-3 text-[14px] text-fg focus:border-brand focus:outline-none disabled:opacity-60 md:h-9"
            />
          </label>
        )}
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      <details className="group" open={urgent}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-muted hover:text-fg md:min-h-8">
          <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
          A new token, when it&apos;s time
        </summary>
        <div className="mt-1 grid gap-2">
          <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center justify-self-start rounded-full bg-fg px-4 text-xs font-medium text-bg md:h-9">
            Make a new token ↗
          </a>
          <ol className="grid list-decimal gap-1 pl-4 text-[11.5px] leading-relaxed text-muted">
            {TOKEN_STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="text-[11px] leading-relaxed text-faint">Tokens last a year at most. Execs get a notice 30, 14, 7 and 1 days before, and at once if Atlassian starts refusing it.</p>
        </div>
      </details>
    </div>
  );
}