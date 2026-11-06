"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HeadChange } from "@/lib/agent-training";
import { revertAgentChange } from "./actions";

// Settings › AI agents › Changes (executives): what the heads of Meta, Google and Creative changed in their line's
// agent, newest first, each with the text before and after and a one-click revert. The execs' daily digest links here.

const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** The fields worth showing for a record: an item's title, kind, state and text; a skill's instructions and brain; a core */
function fields(record: string, s: Record<string, unknown> | null): [string, string][] {
  if (!s) return [];
  if (record.startsWith("role:")) return [["Core", String(s.core ?? "")]];
  if (record.startsWith("agent:")) return [["Brain", `${s.model ?? ""} · ${s.effort ?? ""} effort`], ["Instructions", String(s.instructions ?? "")]];
  return [["Title", String(s.title ?? "")], ["Kind", String(s.kind ?? "")], ["State", s.active === false ? "Off" : "On"], ["Text", String(s.body ?? "")]];
}

function Row({ c }: { c: HeadChange }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const before = fields(c.record, c.before);
  const after = fields(c.record, c.after);
  // Only what changed (a new item shows everything it was added with)
  const changed = after.filter(([k, v]) => !c.before || before.find(([bk]) => bk === k)?.[1] !== v).map(([k]) => k);
  const revert = () => {
    if (!confirm(c.before ? "Put this back as it was before the change?" : "Turn off the item this change added?")) return;
    start(async () => {
      const r = await revertAgentChange(c.id);
      if (r.ok) {
        setError(null);
        router.refresh();
      } else setError(r.error);
    });
  };
  return (
    <li className={`grid gap-2.5 rounded-[14px] border border-line bg-bg p-4 ${c.revertedAt ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug [overflow-wrap:anywhere]">{c.summary || "A change to an agent"}</p>
          <p className="mt-1 text-[11px] text-faint">
            {when(c.at)}
            {c.by && ` · ${c.by}`}
            {c.revertedAt && ` · reverted ${when(c.revertedAt)}${c.revertedBy ? ` by ${c.revertedBy}` : ""}`}
          </p>
        </div>
        {!c.revertedAt && c.record && (
          <button type="button" disabled={busy} onClick={revert} className="h-11 shrink-0 rounded-full border border-line px-4 text-xs text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:h-8">
            {busy ? "Reverting…" : "Revert"}
          </button>
        )}
      </div>
      {changed.length > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="min-h-11 justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
          {open ? "Hide" : "See"} before and after
        </button>
      )}
      {open && (
        <div className="grid gap-3">
          {changed.map((k) => (
            <div key={k} className="grid gap-1.5">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">{k}</p>
              <div className="grid gap-2 md:grid-cols-2">
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[8px] bg-bad-soft/30 p-3 font-sans text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                  <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-faint">Before</span>
                  {before.find(([bk]) => bk === k)?.[1] || "(nothing)"}
                </pre>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[8px] bg-ok-soft/30 p-3 font-sans text-xs leading-relaxed text-fg [overflow-wrap:anywhere]">
                  <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-faint">After</span>
                  {after.find(([ak]) => ak === k)?.[1] || "(nothing)"}
                </pre>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </li>
  );
}

export function HeadChanges({ changes }: { changes: HeadChange[] }) {
  return (
    <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 sm:p-6">
      <div>
        <h2 className="font-heading text-[20px]">What the heads changed</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          The heads of Meta, Google and Creative train their own line&apos;s agent. Every change they apply is here with the text before and after. Revert puts it back as it was; an item they added is turned off, never deleted.
        </p>
      </div>
      {changes.length ? (
        <ul className="grid gap-3">
          {changes.map((c) => (
            <Row key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">No changes by the heads yet.</p>
      )}
    </section>
  );
}
