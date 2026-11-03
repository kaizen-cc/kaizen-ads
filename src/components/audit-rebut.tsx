"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rebutFinding } from "@/app/(team)/kpis/rebuttal-actions";

export type RebutNote = { id: string; reason: string; by: string; at: string };

/**
 * Disagree with one audit finding: a short reason that the next audit of this client reads and client memory keeps.
 * Everyone sees the pushback; only people given the permission can add it.
 */
export function Rebut({ kind, auditId, itemKey, finding, notes = [], can }: { kind: "account" | "business"; auditId: string; itemKey: string; finding: string; notes?: RebutNote[]; can: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!can && !notes.length) return null;
  return (
    <div className="grid gap-2">
      {notes.map((n) => (
        <p key={n.id} className="rounded-[12px] border border-warn/30 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed">
          <span className="font-medium">Pushback</span> <span className="text-faint">· {n.by} · {new Date(n.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="mt-0.5 block text-muted">{n.reason}</span>
        </p>
      ))}
      {can &&
        (open ? (
          <div className="grid gap-2">
            <textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why this is wrong for this account. The next audit reads it, and so does every agent."
              className="w-full rounded-[12px] border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-faint"
            />
            {error && <p className="text-[12px] text-bad">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await rebutFinding({ kind, auditId, itemKey, finding, reason });
                    if (!r.ok) return setError(r.error);
                    setReason("");
                    setOpen(false);
                    router.refresh();
                  })
                }
                className="min-h-10 rounded-full bg-fg px-4 text-[12.5px] text-bg disabled:opacity-60 md:min-h-8"
              >
                {pending ? "Saving…" : "Save pushback"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-full px-3 text-[12.5px] text-muted hover:text-fg md:min-h-8">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="-my-2 justify-self-start py-2 text-[11.5px] text-faint hover:text-fg md:my-0 md:py-0">
            Disagree
          </button>
        ))}
    </div>
  );
}
