"use client";

import { useState, useTransition } from "react";
import { archiveClient, restoreClient } from "./actions";

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
          className="h-9 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-50"
        >
          {busy ? "Restoring…" : "Restore client"}
        </button>
        {error && <p className="w-full text-xs text-bad">{error}</p>}
      </div>
    );

  return (
    <span className="relative">
      <button onClick={() => setOpen(!open)} className="h-7 rounded-full px-3 text-xs text-faint hover:bg-surface-2 hover:text-fg">
        Archive
      </button>
      {open && (
        <span className="absolute right-0 top-9 z-30 grid w-80 gap-3 rounded-[12px] border border-line bg-surface p-4 text-left shadow-2xl">
          <span className="text-sm font-medium">Archive {name}?</span>
          <span className="text-xs text-muted">Nothing is deleted. Open tickets, files, copy, memory and the Brand Bible stay inside, off the board and Home, and all come back if they return.</span>
          <span className="flex flex-wrap gap-1.5">
            {REASONS.map((r) => (
              <button key={r} onClick={() => setReason(r)} className={`h-7 rounded-full px-3 text-xs ${reason === r ? "bg-fg text-bg" : "border border-line text-muted"}`}>
                {r}
              </button>
            ))}
          </span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 rounded-brand border border-line bg-bg px-3 text-sm outline-none" />
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
              className="h-8 rounded-brand bg-fg px-3 text-xs text-bg disabled:opacity-50"
            >
              {busy ? "Archiving…" : "Archive client"}
            </button>
            <button onClick={() => setOpen(false)} className="h-8 px-2 text-xs text-faint">
              Cancel
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
