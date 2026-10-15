"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { restoreClient } from "./[slug]/actions";

export type ArchivedClient = { id: string; name: string; slug: string; at: string; reason: string | null; source: string | null };

/** Archived clients, folded away at the bottom of the list. Each keeps everything; restoring brings it back. */
export function ArchivedList({ clients, canRestore }: { clients: ArchivedClient[]; canRestore: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, act] = useTransition();
  const [gone, setGone] = useState<string[]>([]);
  const list = clients.filter((c) => !gone.includes(c.id));
  if (!list.length) return null;
  return (
    <section className="grid gap-3">
      <button onClick={() => setOpen(!open)} className="flex w-fit items-center gap-2 text-sm text-muted hover:text-fg">
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        Archived <span className="text-faint">{list.length}</span>
      </button>
      {open && (
        <div className="grid gap-1.5">
          {list.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-2.5">
              <Link href={`/clients/${c.slug}`} className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.name}</span>
                <span className="block truncate text-[11px] text-faint">
                  {new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {c.reason ?? "No reason"}
                  {c.source === "track" ? " · Kaizen Track" : c.source === "zapier" ? " · offboarding form" : ""}
                </span>
              </Link>
              {canRestore && (
                <button
                  onClick={() =>
                    act(async () => {
                      const r = await restoreClient(c.id, c.slug);
                      if (r.ok) setGone((g) => [...g, c.id]);
                    })
                  }
                  disabled={busy}
                  className="h-8 rounded-brand border border-line px-3 text-xs text-muted hover:text-fg disabled:opacity-50"
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
