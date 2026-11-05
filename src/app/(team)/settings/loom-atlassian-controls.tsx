"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkAtlassianLoom, pullAtlassianLoomSince } from "@/app/(team)/loom-actions";

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
