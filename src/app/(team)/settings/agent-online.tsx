"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAgentOnline } from "./agent-online-actions";

/** An offline agent's badge, and (execs) the switch that brings it online once its skills are written */
export function AgentOnline({ roleKey, offline, isExec }: { roleKey: string; offline: boolean; isExec: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!offline && !isExec) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {offline && <span className="rounded-full border border-dashed border-warn/60 bg-warn-soft px-2.5 py-1 text-[11px] font-medium text-warn">Offline: never called until it&apos;s brought online</span>}
      {isExec && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!confirm(offline ? "Bring this agent online? Its skills start running in the app." : "Take this agent offline? Its skills stop running.")) return;
            start(async () => {
              const r = await setAgentOnline(roleKey, offline).catch(() => ({ ok: false as const, error: "Couldn't save." }));
              setError(r.ok ? null : r.error);
              router.refresh();
            });
          }}
          className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9"
        >
          {busy ? "Saving…" : offline ? "Bring online" : "Take offline"}
        </button>
      )}
      {error && <span className="text-[12px] text-bad">{error}</span>}
    </div>
  );
}
