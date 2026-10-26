"use client";

import { useState, useTransition } from "react";
import type { Freshness } from "@/lib/dates";

const DOT = { ok: "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]", warn: "bg-warn", off: "bg-faint/50" } as const;

/** Under a connection field: a status light, when it last synced, and optionally a Sync now button. */
export function ConnectionStatus({ status, sync, demo = false }: { status: Freshness | null; sync?: () => Promise<{ ok: true } | { ok: false; error: string }>; demo?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!status) return null;
  const shown: Freshness = done ? { label: "Synced just now", tone: "ok" } : status;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal">
      <span className={`h-2 w-2 shrink-0 rounded-full ${pending ? "animate-[ai-pulse_1s_ease-in-out_infinite] bg-brand-text" : DOT[shown.tone]}`} />
      <span className={shown.tone === "ok" ? "text-ok" : shown.tone === "warn" ? "text-warn" : "text-faint"}>{pending ? "Syncing with Meta…" : shown.label}</span>
      {sync && !pending && (
        <button
          type="button"
          onClick={() =>
            start(async () => {
              setError(null);
              const res = demo ? await new Promise<{ ok: true }>((r) => setTimeout(() => r({ ok: true }), 2500)) : await sync();
              if (res.ok) setDone(true);
              else setError(res.error);
            })
          }
          className="text-muted underline-offset-4 hover:text-fg hover:underline max-md:min-h-10 max-md:px-1"
        >
          Sync now
        </button>
      )}
      {error && <span className="w-full text-bad">{error}</span>}
    </span>
  );
}
