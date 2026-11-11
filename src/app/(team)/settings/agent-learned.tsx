"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { field } from "@/components/ui";
import type { EvalRow } from "@/lib/agent-evals";
import type { LearningView } from "@/lib/learnings";
import type { LearningScope } from "@/lib/learning-rank";
import { EvalView } from "./agent-test";
import { consolidateNow, editLearning, keepLearning, restoreLearning, retireLearning, setLearningScope } from "./learning-actions";

// "What it has learned": one agent's learnings from the team's pushback, by how far each reaches, with the condition it
// holds under, its evidence and where it came from; conflicts to decide; and the history of changes and their tests.

export type ChangeRow = { at: string; target: string; by: string | null; evalSummary: string | null };

const SCOPES: { key: LearningScope; label: string; hint: string }[] = [
  { key: "everyone", label: "Every client", hint: "Backed by clients across kinds of business" },
  { key: "model", label: "A kind of business", hint: "Backed by three or more clients of that kind" },
  { key: "vertical", label: "A sub-vertical", hint: "Backed by three or more clients in it" },
  { key: "client", label: "One client", hint: "Stays with the client it came from until others back it" },
];

const ago = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
const TARGET = (t: string) => (t === "setup" ? "Brain & instructions" : t === "core" ? "Core" : t === "item:new" ? "A new skill or knowledge item" : t === "learnings" ? "What it has learned" : t.startsWith("item:") ? "A skill or knowledge item" : t);

function Card({ l, others }: { l: LearningView; others: LearningView[] }) {
  const [editing, setEditing] = useState(false);
  const [lesson, setLesson] = useState(l.lesson);
  const [condition, setCondition] = useState(l.condition ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setEditing(false);
        setError(null);
        router.refresh();
      } else setError(r.error);
    });
  const rival = l.conflictWith ? others.find((o) => o.id === l.conflictWith) : null;
  return (
    <li className={`grid gap-2.5 rounded-[14px] border p-4 ${l.status === "conflict" ? "border-warn/50 bg-warn-soft/20" : "border-line bg-bg"} ${l.status === "retired" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {l.kind === "exception" && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">One-off</span>}
        {l.clientName && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">{l.clientName}</span>}
        <span className="tabular text-faint">
          seen {l.evidence}× · {l.clients} {l.clients === 1 ? "client" : "clients"} · {Math.round(l.confidence * 100)}% sure · last {ago(l.lastSeen)}
        </span>
      </div>
      {editing ? (
        <div className="grid gap-2">
          <input value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="When it holds (leave empty if always)" className={field} />
          <textarea data-chat value={lesson} onChange={(e) => setLesson(e.target.value)} rows={3} className={`${field} h-auto py-3 text-[13px] font-normal`} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => editLearning(l.id, { lesson, condition }))} className="min-h-11 rounded-full bg-brand px-4 text-[13px] font-medium text-white disabled:opacity-50 md:min-h-9">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[14px] leading-relaxed [overflow-wrap:anywhere]">
          {l.condition && <span className="text-muted">When {l.condition.replace(/^when\s+/i, "")}: </span>}
          {l.lesson}
        </p>
      )}
      {l.note && <p className="text-[12px] text-faint">{l.note}</p>}
      {rival && (
        <div className="grid gap-1 rounded-[10px] border border-line bg-surface p-3 text-[13px]">
          <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Contradicts</p>
          <p className="text-muted">
            {rival.condition && <span>When {rival.condition.replace(/^when\s+/i, "")}: </span>}
            {rival.lesson}
          </p>
        </div>
      )}
      {l.sources.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          {l.sources.map((s, i) =>
            s.href ? (
              <Link key={i} href={s.href} className="text-brand-text hover:underline">
                {s.label}
              </Link>
            ) : (
              <span key={i} className="text-faint">
                {s.label}
              </span>
            ),
          )}
        </div>
      )}
      {!editing && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
          {l.status === "conflict" && (
            <button type="button" disabled={busy} onClick={() => run(() => keepLearning(l.id))} className="min-h-11 rounded-full bg-fg px-3.5 text-[12px] font-medium text-bg disabled:opacity-50 md:min-h-8">
              Keep this one
            </button>
          )}
          {l.status === "retired" ? (
            <button type="button" disabled={busy} onClick={() => run(() => restoreLearning(l.id))} className="min-h-11 rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg md:min-h-8">
              Bring back
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg md:min-h-8">
                Edit
              </button>
              <select
                aria-label="Who it applies to"
                value={l.scope}
                disabled={busy}
                onChange={(e) => run(() => setLearningScope(l.id, e.target.value as LearningScope))}
                className="min-h-11 rounded-full border border-line bg-surface px-3 text-[12px] text-muted md:min-h-8"
              >
                {SCOPES.map((s) => (
                  <option key={s.key} value={s.key}>
                    Applies to: {s.label.toLowerCase()}
                  </option>
                ))}
              </select>
              <button type="button" disabled={busy} onClick={() => run(() => retireLearning(l.id))} className="ml-auto min-h-11 rounded-full px-3 text-[12px] text-faint hover:text-bad md:min-h-8">
                Retire
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </li>
  );
}

export function LearnedView({ agentKey, learnings, changes, evals }: { agentKey: string; learnings: LearningView[]; changes: ChangeRow[]; evals: EvalRow[] }) {
  const [tidying, setTidying] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [openEval, setOpenEval] = useState<string | null>(null);
  const active = learnings.filter((l) => l.status === "active");
  const conflicts = learnings.filter((l) => l.status === "conflict");
  const retired = learnings.filter((l) => l.status === "retired");
  return (
    <div className="grid gap-5">
      <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-heading text-[18px]">What it has learned</h3>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Every time the team pushes back on its work, it becomes one learning with the condition it holds under. A learning stays with its client until three clients back it. Each run reads only the few (at most 8) that fit it, so it doesn&apos;t get more rigid as these grow. Tidied every night: duplicates merged, contradictions settled (or put to you below), nothing new in 120 days retired.
            </p>
          </div>
          <button
            type="button"
            disabled={tidying}
            onClick={async () => {
              setTidying(true);
              await consolidateNow(agentKey);
            }}
            className="min-h-11 shrink-0 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9"
          >
            {tidying ? "Tidying: refresh in a minute" : "Tidy now"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 text-[12px]">
          <span className="tabular rounded-full bg-ok-soft px-2.5 py-1 text-ok">{active.length} active</span>
          {conflicts.length > 0 && <span className="tabular rounded-full bg-warn-soft px-2.5 py-1 text-warn">{conflicts.length} to decide</span>}
          <span className="tabular rounded-full bg-surface-2 px-2.5 py-1 text-muted">{retired.length} retired</span>
        </div>
      </section>

      {conflicts.length > 0 && (
        <section className="grid gap-3">
          <h4 className="font-heading text-[16px]">Contradictions to decide</h4>
          <ul className="grid gap-3 md:grid-cols-2">
            {conflicts.map((l) => (
              <Card key={l.id} l={l} others={learnings} />
            ))}
          </ul>
        </section>
      )}

      {active.length === 0 && conflicts.length === 0 ? (
        <p className="rounded-[18px] border border-dashed border-line px-5 py-10 text-center text-sm text-faint">Nothing learned yet. It learns when the team disagrees with its work, with a reason.</p>
      ) : (
        SCOPES.map((s) => {
          const list = active.filter((l) => l.scope === s.key);
          if (!list.length) return null;
          return (
            <section key={s.key} className="grid gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h4 className="font-heading text-[16px]">{s.label}</h4>
                <span className="text-[12px] text-faint">{s.hint}</span>
              </div>
              <ul className="grid gap-3 md:grid-cols-2">
                {list.map((l) => (
                  <Card key={l.id} l={l} others={learnings} />
                ))}
              </ul>
            </section>
          );
        })
      )}

      {retired.length > 0 && (
        <section className="grid gap-3">
          <button type="button" onClick={() => setShowRetired((v) => !v)} className="min-h-11 justify-self-start text-[13px] text-muted hover:text-fg md:min-h-0">
            {showRetired ? "Hide" : "Show"} {retired.length} retired
          </button>
          {showRetired && (
            <ul className="grid gap-3 md:grid-cols-2">
              {retired.map((l) => (
                <Card key={l.id} l={l} others={learnings} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-6">
        <h3 className="font-heading text-[18px]">Changes and their tests</h3>
        {changes.length === 0 && evals.length === 0 ? (
          <p className="text-sm text-faint">No changes or tests yet.</p>
        ) : (
          <ul className="grid gap-1.5">
            {changes.map((c, i) => (
              <li key={`c${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-[10px] px-2 py-2 text-[13px] odd:bg-bg/60">
                <span className="tabular text-[12px] text-faint">{ago(c.at)}</span>
                <span>{TARGET(c.target)} changed</span>
                {c.by && <span className="text-muted">by {c.by}</span>}
                <span className={`w-full text-[12px] md:w-auto ${c.evalSummary ? "text-muted" : "text-faint"}`}>{c.evalSummary ? `Tested first: ${c.evalSummary}` : "Not tested first"}</span>
              </li>
            ))}
          </ul>
        )}
        {evals.length > 0 && (
          <div className="grid gap-2 border-t border-line pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Tests</p>
            <ul className="grid gap-2">
              {evals.map((e) => (
                <li key={e.id} className="grid gap-2 rounded-[12px] border border-line bg-bg p-3">
                  <button type="button" onClick={() => setOpenEval(openEval === e.id ? null : e.id)} className="flex min-h-11 flex-wrap items-baseline gap-x-3 text-left text-[13px] md:min-h-0">
                    <span className="tabular text-[12px] text-faint">{ago(e.createdAt)}</span>
                    <span>{e.kind === "drift" ? "Weekly drift check" : TARGET(e.target)}</span>
                    {e.by && <span className="text-muted">by {e.by}</span>}
                    <span className="text-[12px] text-muted">{e.status === "running" ? "running…" : (e.summary ?? e.error ?? "")}</span>
                    {e.appliedAt && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">Saved after</span>}
                  </button>
                  {openEval === e.id && <EvalView e={e} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
