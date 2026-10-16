"use client";

import { useState, useTransition } from "react";
import { rebuildVerticals } from "./vertical-actions";

export function RebuildVerticals() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {note && <span className="text-[11px] text-muted">{note}</span>}
      <button
        type="button"
        disabled={pending || Boolean(note)}
        onClick={() =>
          start(async () => {
            const r = await rebuildVerticals();
            setNote("error" in r ? r.error : "Rebuilding from paid clients, about 2 minutes. Refresh to see it.");
          })
        }
        className="rounded-full border border-line bg-bg/60 px-3 py-1.5 text-xs text-muted backdrop-blur hover:text-fg disabled:opacity-60"
      >
        Rebuild verticals
      </button>
    </span>
  );
}
