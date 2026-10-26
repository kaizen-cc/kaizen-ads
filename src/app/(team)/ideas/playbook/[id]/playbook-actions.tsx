"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rebuildPlaybook, sharePlaybook } from "./actions";

export function PlaybookActions({ subId, canRebuild, canShare = true }: { subId: string; canRebuild: boolean; canShare?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const share = () =>
    start(async () => {
      const r = await sharePlaybook(subId);
      if ("error" in r) return setNote(r.error);
      await navigator.clipboard.writeText(r.url).catch(() => null);
      setNote("Share link copied. No client or brand names on it.");
    });
  const rebuild = () =>
    start(async () => {
      setNote("Rebuilding, about a minute…");
      const r = await rebuildPlaybook(subId);
      setNote("error" in r ? r.error : "Rebuilt");
      router.refresh();
    });
  return (
    <div className="grid justify-items-end gap-1.5">
      <div className="flex gap-2">
        {canRebuild && (
          <button type="button" onClick={rebuild} disabled={pending} className="min-h-11 rounded-full border border-line px-4 py-2 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-0">
            {canShare ? "Rebuild" : "Write it now"}
          </button>
        )}
        {canShare && (
          <button type="button" onClick={share} disabled={pending} className="min-h-11 rounded-full bg-fg px-4 py-2 text-sm text-bg disabled:opacity-50 md:min-h-0">
            Share for sales
          </button>
        )}
      </div>
      {note && <p className="text-[11px] text-muted">{note}</p>}
    </div>
  );
}
