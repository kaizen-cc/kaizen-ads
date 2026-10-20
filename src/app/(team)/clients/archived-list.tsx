"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restoreClient } from "./[slug]/actions";

export type ArchivedClient = { id: string; name: string; slug: string; at: string; reason: string | null; source: string | null };
export type ArchiveLog = {
  clientId: string;
  name: string | null;
  slug: string | null;
  action: "archived" | "restored";
  reason: string | null;
  source: string | null;
  at: string;
  by: string | null;
  setAside: { kpi_targets?: string[]; suggestions?: number; fatigue?: number; commitments?: number };
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const whoDid = (e: ArchiveLog) => e.by ?? (e.source === "track" ? "Kaizen Track" : e.source === "zapier" ? "the offboarding form" : e.source === "system" ? "Kaizen Track (came back)" : "someone");

/** What archiving set aside, in words: KPI targets paused, briefs and promises closed, the watch list cleared. */
function setAsideLine(s: ArchiveLog["setAside"]) {
  const parts = [
    s.kpi_targets?.length ? `${s.kpi_targets.length} KPI ${s.kpi_targets.length === 1 ? "target" : "targets"} paused` : null,
    s.suggestions ? `${s.suggestions} open ${s.suggestions === 1 ? "brief" : "briefs"} closed` : null,
    s.commitments ? `${s.commitments} call ${s.commitments === 1 ? "promise" : "promises"} closed` : null,
    s.fatigue ? `${s.fatigue} tiring ${s.fatigue === 1 ? "ad" : "ads"} cleared` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The archive: every archived client with who archived them, when and why, and the history of archives and restores.
 * Their client page stays readable, and restoring brings back their status and the KPI targets that were tracking.
 */
export function ArchivedList({ clients, canRestore, log, startOpen = false }: { clients: ArchivedClient[]; canRestore: boolean; log: ArchiveLog[]; startOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [busy, act] = useTransition();
  const [gone, setGone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const list = clients.filter((c) => !gone.includes(c.id));
  if (!list.length && !log.length) return null;
  const names = new Map(clients.map((c) => [c.id, c]));
  return (
    <section id="archived" className="grid scroll-mt-24 gap-3">
      <button onClick={() => setOpen(!open)} className="flex w-fit items-center gap-2 text-sm text-muted hover:text-fg">
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        Archived clients <span className="text-faint">{list.length}</span>
      </button>
      {open && (
        <div className="grid gap-4">
          <p className="max-w-2xl text-xs text-faint">
            Archiving keeps everything: the client page, requests, creative, calls and history. It closes the client portal, pauses their KPI targets, and closes open
            briefs and promises. Restoring brings back their status and the KPI targets that were tracking.
          </p>
          {error && <p className="text-xs text-bad">{error}</p>}
          <div className="grid gap-1.5">
            {list.map((c) => {
              const last = log.find((e) => e.clientId === c.id && e.action === "archived");
              const aside = last ? setAsideLine(last.setAside) : null;
              const history = log.filter((e) => e.clientId === c.id).length;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3">
                  <Link href={`/clients/${c.slug}`} className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      Archived {day(c.at)}
                      {last && ` by ${whoDid(last)}`} · {c.reason ?? "No reason given"}
                    </span>
                    {(aside || history > 1) && (
                      <span className="block truncate text-[11px] text-faint">
                        {aside}
                        {aside && history > 1 && " · "}
                        {history > 1 && `${history} archive and restore events`}
                      </span>
                    )}
                  </Link>
                  <Link href={`/clients/${c.slug}`} className="h-8 content-center rounded-brand px-3 text-xs text-muted hover:text-fg">
                    Open page
                  </Link>
                  {canRestore && (
                    <button
                      onClick={() =>
                        act(async () => {
                          setError(null);
                          const r = await restoreClient(c.id, c.slug);
                          if (r.ok) {
                            setGone((g) => [...g, c.id]);
                            router.push(`/clients/${c.slug}`);
                          }
                          else setError(r.error);
                        })
                      }
                      disabled={busy}
                      className="h-8 rounded-brand border border-line px-3 text-xs text-muted hover:text-fg disabled:opacity-50"
                    >
                      Restore
                    </button>
                  )}
                </div>
              );
            })}
            {list.length === 0 && <p className="text-sm text-faint">No clients are archived right now.</p>}
          </div>

          {log.length > 0 && (
            <details className="rounded-[12px] border border-line bg-surface">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted hover:text-fg">Archive log · {log.length}</summary>
              <ul className="grid divide-y divide-line border-t border-line">
                {log.map((e, i) => {
                  const c = e.slug ? { name: e.name ?? "A client", slug: e.slug } : names.get(e.clientId);
                  return (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-xs">
                      <span className="tabular w-24 shrink-0 text-faint">{day(e.at)}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${e.action === "archived" ? "bg-surface-2 text-muted" : "bg-ok-soft text-ok"}`}>
                        {e.action === "archived" ? "Archived" : "Restored"}
                      </span>
                      <span className="min-w-0 flex-1 text-muted">
                        {c ? (
                          <Link href={`/clients/${c.slug}`} className="text-fg hover:underline">
                            {c.name}
                          </Link>
                        ) : (
                          <span className="text-fg">A client</span>
                        )}{" "}
                        by {whoDid(e)}
                        {e.reason && ` · ${e.reason}`}
                        {e.action === "archived" && setAsideLine(e.setAside) && <span className="text-faint"> · {setAsideLine(e.setAside)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
