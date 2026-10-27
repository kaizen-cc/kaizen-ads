"use client";

import { useState, useTransition } from "react";
import { archiveClient, restoreClient } from "./actions";
import { Layer } from "./layer";

const REASONS = ["Offboarded", "Paused indefinitely", "Never started", "Duplicate"];

/** Archive (execs and leads), or the banner on an archived client with Restore. */
export function ArchiveControl({ clientId, slug, name, archived }: { clientId: string; slug: string; name: string; archived: { at: string; reason: string | null; source: string | null } | null }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("Offboarded");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (archived)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Archived {new Date(archived.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
          <p className="text-xs text-muted">
            {archived.reason ?? "No reason given"}
            {archived.source === "track" ? " · from Kaizen Track" : archived.source === "zapier" ? " · from the offboarding form" : ""}. Everything is kept here: tickets, files,
            copy, memory and briefings. It&apos;s off the board, Home and every list until it&apos;s restored or the client enrolls again.
          </p>
        </div>
        <button
          onClick={() =>
            act(async () => {
              const r = await restoreClient(clientId, slug);
              if (!r.ok) setError(r.error);
            })
          }
          disabled={busy}
          className="h-11 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-50 max-md:w-full md:h-9"
        >
          {busy ? "Restoring…" : "Restore client"}
        </button>
        {error && <p className="w-full text-xs text-bad">{error}</p>}
      </div>
    );

  const confirm = (
    <>
      <span className="text-sm font-medium [overflow-wrap:anywhere]">Archive {name}?</span>
      <span className="text-xs text-muted">Nothing is deleted. Open tickets, files, copy, memory and the Brand Bible stay inside, off the board and Home, and all come back if they return.</span>
      <span className="flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button key={r} onClick={() => setReason(r)} className={`h-11 rounded-full px-3.5 text-xs md:h-7 md:px-3 ${reason === r ? "bg-fg text-bg" : "border border-line text-muted"}`}>
            {r}
          </button>
        ))}
      </span>
      <input value={reason} onChange={(e) => setReason(e.target.value)} className="h-11 rounded-brand border border-line bg-bg px-3 text-sm outline-none md:h-9" />
      {error && <span className="text-xs text-bad">{error}</span>}
      <span className="flex gap-2">
        <button
          onClick={() =>
            act(async () => {
              const r = await archiveClient(clientId, slug, reason);
              if (!r.ok) return setError(r.error);
              setOpen(false);
            })
          }
          disabled={busy}
          className="h-11 flex-1 rounded-brand bg-fg px-3 text-sm text-bg disabled:opacity-50 md:h-8 md:flex-none md:text-xs"
        >
          {busy ? "Archiving…" : "Archive client"}
        </button>
        <button onClick={() => setOpen(false)} className="h-11 px-3 text-sm text-faint md:h-8 md:px-2 md:text-xs">
          Cancel
        </button>
      </span>
    </>
  );

  return (
    <span className="relative">
      <button onClick={() => setOpen(!open)} className="h-11 rounded-full px-3 text-xs text-faint hover:bg-surface-2 hover:text-fg md:h-7">
        Archive
      </button>
      {open && (
        <span className="absolute right-0 top-9 z-30 hidden w-80 gap-3 rounded-[12px] border border-line bg-surface p-4 text-left shadow-2xl md:grid">
          {confirm}
        </span>
      )}
      {/* Phones: the same confirmation as a sheet from the bottom */}
      {open && (
        <Layer>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] md:hidden" />
          <div
            role="dialog"
            aria-label={`Archive ${name}`}
            className="fixed inset-x-0 bottom-0 z-50 grid gap-3 rounded-t-[22px] border-t border-line bg-surface px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 text-left shadow-2xl md:hidden"
          >
            <span aria-hidden className="mx-auto mb-1 h-1 w-10 rounded-full bg-ink/15" />
            {confirm}
          </div>
        </Layer>
      )}
    </span>
  );
}
