"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { LINE_LABEL, type KpiLine } from "@/lib/clients-kpi/core";
import { STEPS, asStep, progress, shortReason, stepIndex, type ItemState, type Marks, type StepKey } from "@/lib/csuite/core";
import type { Meeting, Review, TodoRow } from "@/lib/csuite/load";
import { SERVICES, type ServiceSlug } from "@/lib/services";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { BoardSwitch } from "../kpis/channel-board";
import { KpiSwitch } from "../kpis/kpi-switch";
import { addReviewTodo, closeReviewTodo, draftUpsellEmail, finishReview, goToStep, markReviewItem, startReview } from "./actions";

// The account review, step by step: a rail of the six steps with how far each has got, the step's items with Discuss,
// Done and Assign on each, and Back / Next. Marks save as they're pressed; a to-do goes to the person's Overview.

type Person = { id: string; name: string };
type Past = { id: string; title: string; started_at: string; done: number };

const pct = (x: number | null) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const money = (x: number | null | undefined) => (x == null ? "–" : x >= 1000 ? `$${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : `$${Math.round(x)}`);
const svc = (s: ServiceSlug) => SERVICES.find((x) => x.slug === s)?.short ?? s;
const TONE_DOT: Record<string, string> = { good: "bg-ok", watch: "bg-warn", bad: "bg-bad", none: "bg-faint" };
const SEV: Record<string, string> = { critical: "bg-bad", warn: "bg-warn", info: "bg-faint" };

export function ReviewRunner({ me, review, meeting, past, todos, people, switcher }: { me: string; review: Review; meeting: Meeting | null; past: Past[]; todos: TodoRow[]; people: Person[]; switcher: BoardSwitch[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [marks, setMarks] = useState<Marks>(meeting?.items ?? {});
  const [error, setError] = useState<string | null>(null);
  const step = asStep(useParam("step") ?? (meeting ? STEPS[meeting.step]?.key : null));
  const at = stepIndex(step);
  const prog = progress(review.items, marks);
  const assigning = useParam("assign");

  const go = (k: StepKey) => {
    pushParams({ step: k, assign: null });
    if (meeting) void goToStep(meeting.id, stepIndex(k));
  };
  const run = (f: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await f();
      if (!r.ok) setError(r.error ?? "It didn't save.");
      else router.refresh();
    });
  const setMark = (key: string, state: ItemState) => {
    if (!meeting) return;
    const next = { ...marks };
    if (next[key]?.state === state) delete next[key];
    else next[key] = { state, at: new Date().toISOString() };
    setMarks(next);
    void markReviewItem(meeting.id, key, next[key]?.state ?? null);
  };

  const actions = (key: string, ctx: { clientId?: string | null; title: string }) => (
    <ItemActions
      key={key}
      state={marks[key]?.state ?? null}
      live={Boolean(meeting)}
      onMark={(s) => setMark(key, s)}
      open={assigning === key}
      onAssign={() => (assigning === key ? closeParams("assign") : pushParams({ assign: key }))}
      form={
        <TodoForm
          people={people}
          me={me}
          defaultTitle={ctx.title}
          pending={pending}
          onSave={(t) =>
            run(async () => {
              const r = await addReviewTodo({ meetingId: meeting?.id ?? null, title: t.title, assigneeId: t.assigneeId, dueOn: t.dueOn, clientId: ctx.clientId ?? null, itemKey: key });
              if (r.ok) {
                closeParams("assign");
                setMarks((m) => ({ ...m, [key]: { state: "discuss", note: `Assigned: ${t.title}` } }));
              }
              return r;
            })
          }
        />
      }
    />
  );

  return (
    <div className="grid gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[32px] leading-tight">KPIs</h1>
          <p className="mt-1.5 text-sm text-muted">The weekly account review, step by step: the numbers, what&apos;s critical, what to fix, what to sell, what it&apos;s worth, who does what.</p>
        </div>
        <div className="flex w-full items-center gap-2 md:w-auto">
          <KpiSwitch tabs={switcher} />
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-[18px] border border-line bg-surface px-4 py-3.5 md:px-5">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Executives · weekly</p>
          <p className="truncate text-sm font-medium">{meeting ? meeting.title : "No review running"}</p>
          {meeting && (
            <p suppressHydrationWarning className="text-xs text-muted">
              Started {new Date(meeting.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </p>
          )}
        </div>
        {meeting ? (
          <div className="grid w-full gap-1.5 sm:w-56">
            <div className="tabular flex justify-between text-xs text-muted">
              <span>Progress</span>
              <span>
                {prog.done} of {prog.total}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} />
            </div>
          </div>
        ) : (
          <button type="button" disabled={pending} onClick={() => run(startReview)} className="inline-flex h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50 md:h-10">
            {pending ? "Starting…" : "Start this week's review"}
          </button>
        )}
      </div>

      {error && <p className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">{error}</p>}

      <nav aria-label="Agenda" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:grid md:grid-cols-6 md:overflow-visible md:px-0">
        {STEPS.map((s, i) => {
          const on = s.key === step;
          const p = prog.byStep[s.key];
          const complete = p.total > 0 && p.done === p.total;
          return (
            <button key={s.key} type="button" onClick={() => go(s.key)} aria-current={on ? "step" : undefined} className={`group grid min-h-11 min-w-44 shrink-0 gap-1 rounded-2xl border px-3.5 py-3 text-left transition-colors md:min-w-0 ${on ? "border-fg/50 bg-surface-2" : "border-line bg-surface hover:border-faint/60"}`}>
              <span className="flex items-center gap-2">
                <span className={`tabular grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${complete ? "bg-ok text-bg" : on ? "bg-fg text-bg" : "bg-surface-2 text-muted"}`}>{complete ? "✓" : i + 1}</span>
                <span className="truncate text-sm font-medium">{s.title}</span>
              </span>
              <span className="tabular text-[11px] text-faint">{p.total ? `${p.done}/${p.total} done` : s.blurb}</span>
            </button>
          );
        })}
      </nav>

      <section className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-2xl">
            <span className="text-faint">{at + 1}.</span> {STEPS[at].title}
          </h2>
          <p className="text-sm text-muted">{STEPS[at].blurb}</p>
        </div>
        {!meeting && <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">Start the review to mark items as discussed or done and to assign to-dos. Everything below is live.</p>}

        {step === "scorecard" && <ScorecardStep review={review} actions={actions} onCritical={() => go("critical")} />}
        {step === "critical" && (
          <List empty="Nothing critical right now.">
            {review.criticalRows.map((c, i) => (
              <Row key={c.key} state={marks[c.key]?.state} actions={actions(c.key, { clientId: c.id, title: `${c.name}: ` })}>
                <span className="tabular grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bad-soft text-xs font-semibold text-bad">{i + 1}</span>
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/clients/${c.slug}`} className="font-medium hover:text-brand-text">
                      {c.name}
                    </Link>
                    {c.atRisk && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">at risk of leaving</span>}
                    {c.lines.map((l) => (
                      <span key={l.line} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                        <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[l.tone]}`} />
                        {LINE_LABEL[l.line as KpiLine]} {l.shown}
                      </span>
                    ))}
                  </div>
                  <ul className="grid gap-0.5 text-[13px] text-muted">
                    {c.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              </Row>
            ))}
          </List>
        )}
        {step === "issues" && (
          <>
            {!review.watchOn && <p className="text-xs text-faint">Account watch alerts (billed but idle, neglected accounts, unrecognized people in an account) show here once the watch is running.</p>}
            <List empty="No open issues.">
              {review.issues.map((x) => (
                <Row key={x.key} state={marks[x.key]?.state} actions={actions(x.key, { clientId: x.clientId, title: `${x.client}: ${x.title}` })}>
                  <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${SEV[x.severity]}`} />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/clients/${x.slug}`} className="font-medium hover:text-brand-text">
                        {x.client}
                      </Link>
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{x.source === "watch" ? "Account watch" : x.source === "risk" ? "Retention" : "KPI"}</span>
                    </div>
                    <p className="text-sm">{x.title}</p>
                    {x.detail && <p className="text-[13px] text-muted">{x.detail}</p>}
                  </div>
                </Row>
              ))}
            </List>
          </>
        )}
        {step === "upsell" && (
          <List empty="No upsell stands out this week.">
            {review.upsells.map((u) => (
              <Row key={u.key} state={marks[u.key]?.state} actions={actions(u.key, { clientId: u.clientId, title: `Offer ${svc(u.service)} to ${u.client}` })}>
                <span className="mt-0.5 shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand-text">{svc(u.service)}</span>
                <div className="grid min-w-0 flex-1 gap-1">
                  <Link href={`/clients/${u.slug}`} className="font-medium hover:text-brand-text">
                    {u.client}
                  </Link>
                  <p className="text-sm">{u.offer}</p>
                  <ul className="grid gap-0.5 text-[13px] text-muted">
                    {u.why.slice(0, 3).map((w) => (
                      <li key={w}>· {w}</li>
                    ))}
                  </ul>
                  <div>
                    <button type="button" disabled={pending} onClick={() => run(() => draftUpsellEmail(u.clientId, u.service))} className="mt-1 inline-flex h-11 items-center rounded-full border border-line px-3 text-xs text-muted hover:border-faint/60 hover:text-fg md:h-8">
                      Draft the email
                    </button>
                  </div>
                </div>
              </Row>
            ))}
          </List>
        )}
        {step === "financial" && <FinancialStep review={review} marks={marks} actions={actions} />}
        {step === "todos" && (
          <TodosStep
            todos={todos}
            people={people}
            me={me}
            pending={pending}
            meeting={meeting}
            onAdd={(t) => run(() => addReviewTodo({ meetingId: meeting?.id ?? null, title: t.title, assigneeId: t.assigneeId, dueOn: t.dueOn }))}
            onStatus={(id, s) => run(() => closeReviewTodo(id, s))}
            onFinish={(notes) => meeting && run(() => finishReview(meeting.id, notes))}
          />
        )}
      </section>

      <footer className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <button type="button" disabled={at === 0} onClick={() => go(STEPS[at - 1].key)} className="inline-flex h-11 items-center rounded-full px-4 text-sm text-muted hover:text-fg disabled:opacity-30">
          ← {at > 0 ? STEPS[at - 1].title : "Back"}
        </button>
        {at < STEPS.length - 1 && (
          <button type="button" onClick={() => go(STEPS[at + 1].key)} className="inline-flex h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg hover:opacity-90">
            {STEPS[at + 1].title} →
          </button>
        )}
      </footer>

      {past.length > 0 && (
        <details className="text-sm text-muted">
          <summary className="min-h-11 cursor-pointer py-2">Past reviews</summary>
          <ul className="grid gap-1 pb-2">
            {past.map((p) => (
              <li key={p.id} className="tabular">
                {p.title} · {p.done} items done
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function List({ children, empty }: { children: ReactNode[]; empty: string }) {
  if (!children.length) return <p className="rounded-2xl bg-ok-soft px-4 py-4 text-sm text-ok">{empty}</p>;
  return <ul className="grid gap-2">{children}</ul>;
}

function Row({ children, state, actions }: { children: ReactNode; state?: ItemState; actions: ReactNode }) {
  return (
    <li className={`grid gap-3 rounded-2xl border p-4 transition-colors md:grid-cols-[minmax(0,1fr)_auto] ${state === "done" ? "border-ok/40 bg-ok-soft/40" : state === "discuss" ? "border-warn/40 bg-surface" : "border-line bg-surface"}`}>
      <div className="flex min-w-0 items-start gap-3">{children}</div>
      {actions}
    </li>
  );
}

function ItemActions({ state, live, onMark, open, onAssign, form }: { state: ItemState | null; live: boolean; onMark: (s: ItemState) => void; open: boolean; onAssign: () => void; form: ReactNode }) {
  const b = (on: boolean, tone: string) => `inline-flex h-11 items-center rounded-full border px-3 text-xs transition-colors md:h-8 ${on ? tone : "border-line text-muted hover:border-faint/60 hover:text-fg"} disabled:opacity-40`;
  return (
    <div className="grid content-start justify-items-start gap-2 md:justify-items-end">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={!live} aria-pressed={state === "discuss"} onClick={() => onMark("discuss")} className={b(state === "discuss", "border-warn/50 bg-warn-soft text-warn")}>
          Discuss
        </button>
        <button type="button" disabled={!live} aria-pressed={state === "done"} onClick={() => onMark("done")} className={b(state === "done", "border-ok/50 bg-ok-soft text-ok")}>
          Done
        </button>
        <button type="button" aria-expanded={open} onClick={onAssign} className={b(open, "border-fg/40 bg-surface-2 text-fg")}>
          Assign
        </button>
      </div>
      {open && form}
    </div>
  );
}

const inWeek = () => new Date(Date.now() + 7 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function TodoForm({ people, me, defaultTitle, pending, onSave }: { people: Person[]; me: string; defaultTitle: string; pending: boolean; onSave: (t: { title: string; assigneeId: string; dueOn: string | null }) => void }) {
  const [title, setTitle] = useState(defaultTitle);
  const [who, setWho] = useState(me);
  const [due, setDue] = useState(inWeek());
  const field = "h-11 rounded-xl border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/70 md:h-9";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave({ title: title.trim(), assigneeId: who, dueOn: due || null });
      }}
      className="grid w-full gap-2 rounded-xl bg-surface-2/60 p-3 md:w-80"
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing" aria-label="To-do" className={field} />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who" className={field}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me ? `${p.name} (me)` : p.name}
            </option>
          ))}
        </select>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" className={field} />
      </div>
      <button type="submit" disabled={pending || !title.trim()} className="inline-flex h-11 items-center justify-center rounded-full bg-fg px-4 text-sm font-medium text-bg disabled:opacity-50 md:h-9">
        {pending ? "Saving…" : "Assign"}
      </button>
    </form>
  );
}

const ratioTone = (x: number | null) => (x == null ? "text-faint" : x >= 0.7 ? "text-ok" : x >= 0.5 ? "text-warn" : "text-bad");

/** The success ratio as a ring: green from 70%, amber from 50%, red under */
function Ring({ value, size = 132 }: { value: number | null; size?: number }) {
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-surface-2" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} className={`${ratioTone(value)} transition-[stroke-dasharray] duration-700`} />
      </svg>
      <div className="absolute grid justify-items-center">
        <span className="tabular font-heading text-[34px] leading-none">{pct(value)}</span>
        <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-faint">on target</span>
      </div>
    </div>
  );
}

const PACE_WORD: Partial<Record<KpiLine, { label: string; hint: string }>> = {
  email: { label: "Revenue pace", hint: "The typical client: where this month's attributed revenue lands at its current rate, against the month's revenue target" },
  creative: { label: "Delivery pace", hint: "The typical client: creative delivered this cycle, against what's due by today" },
};
const AD_PACE = { label: "Spend pace", hint: "The typical account: where this month's spend lands at its current daily rate, against the monthly budget" };

function Stat({ label, value, note, tone = "" }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <span className="grid content-start gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.12em] text-faint">{label}</span>
      <span className={`tabular font-heading text-[26px] leading-tight ${tone}`}>{value}</span>
      <span className="tabular text-xs text-muted">{note}</span>
    </span>
  );
}

function ScorecardStep({ review, actions, onCritical }: { review: Review; actions: (key: string, ctx: { clientId?: string | null; title: string }) => ReactNode; onCritical: () => void }) {
  const s = review.scorecard;
  const judged = s.lines.filter((l) => l.judged > 0);
  const quiet = s.lines.filter((l) => !l.judged);
  const byId = new Map(review.criticalRows.map((c) => [c.id, c]));

  if (!s.linesJudged) return <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">No KPI is judged yet, so there&apos;s no scorecard. It fills in as targets are set and accounts sync.</p>;

  return (
    <div className="grid gap-5">
      {/* The headline: the success ratio and where the book stands */}
      <section aria-label="Success ratio" className="grid gap-6 rounded-[22px] border border-line bg-surface p-5 md:grid-cols-[auto_minmax(0,1fr)] md:items-center md:gap-10 md:p-7">
        <div className="flex items-center gap-5">
          <Ring value={s.lineRatio} />
          <div className="grid gap-1 md:hidden">
            <p className="font-heading text-xl">Success ratio</p>
            <p className="tabular text-xs text-muted">
              {s.linesOn} of {s.linesJudged} KPI&apos;d lines on or better than target
            </p>
          </div>
        </div>
        <div className="grid gap-5">
          <div className="hidden md:grid md:gap-1">
            <p className="font-heading text-2xl">Success ratio</p>
            <p className="tabular text-sm text-muted">
              {s.linesOn} of {s.linesJudged} KPI&apos;d lines are on or better than target.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-4 sm:grid-cols-3">
            <Stat label="Every line on" value={pct(s.clientRatio)} note={`${s.clientsOn} of ${s.clientsJudged} clients`} tone={ratioTone(s.clientRatio)} />
            <Link href="/clients?kpi=off" title="Open these clients" className="rounded-xl transition-opacity hover:opacity-80">
              <Stat label="In the red" value={String(s.inRed)} note="a line off target" tone={s.inRed ? "text-bad" : "text-ok"} />
            </Link>
            <button type="button" onClick={onCritical} title="Go to the critical accounts" className="rounded-xl text-left transition-opacity hover:opacity-80">
              <Stat label="Critical" value={String(review.critical)} note="weighed by business size" tone={review.critical ? "text-bad" : "text-ok"} />
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* Each line: on, close and off, where it's heading, and its pace */}
        <section aria-label="By line" className="grid content-start gap-3">
          <h3 className="text-[11px] uppercase tracking-[0.14em] text-faint">By line</h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {judged.map((l) => {
              const key = `scorecard:${l.line}`;
              const total = Math.max(1, l.on + l.close + l.off);
              const pw = PACE_WORD[l.line] ?? AD_PACE;
              const paceOk = l.pace != null && l.pace >= 0.85 && l.pace <= 1.15;
              const paceNote = `${pw.hint}. Read over ${l.paced}${l.paceOver ? `; ${l.paceOver} over 115%` : ""}${l.paceUnder ? `; ${l.paceUnder} under 85%` : ""}.`;
              return (
                <li key={key} className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{LINE_LABEL[l.line]}</span>
                    <span className="tabular text-xs text-muted">
                      <span className={`font-medium ${ratioTone(l.on / l.judged)}`}>{l.on}</span> of {l.judged} on target
                    </span>
                  </div>
                  <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${l.on} on target, ${l.close} close, ${l.off} off`}>
                    {l.on > 0 && <span className="h-full rounded-full bg-ok" style={{ width: `${(l.on / total) * 100}%` }} />}
                    {l.close > 0 && <span className="h-full rounded-full bg-warn" style={{ width: `${(l.close / total) * 100}%` }} />}
                    {l.off > 0 && <span className="h-full rounded-full bg-bad" style={{ width: `${(l.off / total) * 100}%` }} />}
                  </div>
                  <div className="tabular flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                      {l.on} on
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                      {l.close} close
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-bad" />
                      {l.off} off
                    </span>
                    {l.improving > 0 && <span className="text-ok">↑ {l.improving} improving</span>}
                    {l.slipping > 0 && <span className="text-bad">↓ {l.slipping} slipping</span>}
                  </div>
                  {(l.spend > 0 || l.revenue > 0 || l.pace != null) && (
                    <dl className="tabular grid grid-cols-3 gap-2 rounded-xl bg-surface-2/60 px-3 py-2.5 text-xs">
                      {l.spend > 0 && (
                        <div className="grid gap-0.5">
                          <dt className="text-faint">Spend 14d</dt>
                          <dd className="font-medium">{money(l.spend)}</dd>
                        </div>
                      )}
                      {l.revenue > 0 && (
                        <div className="grid gap-0.5">
                          <dt className="text-faint">Revenue 14d</dt>
                          <dd className="font-medium">{money(l.revenue)}</dd>
                        </div>
                      )}
                      {l.pace != null && (
                        <div className="grid gap-0.5" title={paceNote}>
                          <dt className="text-faint">{pw.label}</dt>
                          <dd className={`font-medium ${paceOk ? "text-ok" : "text-warn"}`}>{pct(l.pace)}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  <div className="border-t border-line pt-3">{actions(key, { title: `${LINE_LABEL[l.line]}: ` })}</div>
                </li>
              );
            })}
          </ul>
          {quiet.length > 0 && <p className="text-xs text-faint">Nothing to judge yet on {quiet.map((l) => LINE_LABEL[l.line]).join(", ")}.</p>}
        </section>

        {/* The accounts to look at first, one plain line each; open one for the full reasons */}
        <section aria-label="High priority" className="grid content-start gap-3">
          <h3 className="text-[11px] uppercase tracking-[0.14em] text-faint">High priority</h3>
          {s.highPriority.length ? (
            <ol className="grid divide-y divide-line overflow-hidden rounded-[18px] border border-line bg-surface">
              {s.highPriority.map((c, i) => {
                const row = byId.get(c.id);
                const reasons = row?.reasons.length ? row.reasons : c.reasons;
                return (
                  <li key={c.id}>
                    <details className="group">
                      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60 [&::-webkit-details-marker]:hidden">
                        <span className="tabular grid h-6 w-6 shrink-0 place-items-center rounded-full bg-bad-soft text-[11px] font-semibold text-bad">{i + 1}</span>
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="truncate text-sm font-medium">{c.name}</span>
                          {reasons[0] && (
                            <span className="truncate text-xs text-muted" title={reasons[0]}>
                              {shortReason(reasons[0])}
                            </span>
                          )}
                        </span>
                        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-faint transition-transform group-open:rotate-180">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </summary>
                      <div className="grid gap-2 px-4 pb-4 pl-[52px]">
                        <ul className="grid gap-1.5 text-[13px] leading-relaxed text-muted">
                          {reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                        {row?.slug && (
                          <Link href={`/clients/${row.slug}`} className="inline-flex min-h-11 items-center text-xs font-medium text-brand-text hover:underline md:min-h-0">
                            Open {c.name} →
                          </Link>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="rounded-[18px] bg-ok-soft px-4 py-4 text-sm text-ok">Nothing critical right now.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function FinancialStep({ review, marks, actions }: { review: Review; marks: Marks; actions: (key: string, ctx: { clientId?: string | null; title: string }) => ReactNode }) {
  const rows = review.financial;
  const known = rows.filter((r) => r.monthly != null);
  const total = known.reduce((s, r) => s + (r.monthly ?? 0), 0);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted">
        {review.billingKnown ? (
          <>
            Billed in the last 45 days, from Stripe through Kaizen Track (read only): <span className="tabular font-medium text-fg">{money(total)}</span> across {known.length} clients. Gaps between what&apos;s billed and what we run are flagged.
          </>
        ) : (
          "Stripe billing isn't read yet, so this is the services and creative package each client is on. Billed amounts appear once Kaizen Track's mirror reads them."
        )}
      </p>
      <ul className="grid gap-2">
        {rows.slice(0, 60).map((r) => {
          const gap = r.unlisted.length || r.unbilled.length;
          return (
            <li key={r.key} className={`grid gap-3 rounded-2xl border p-4 md:grid-cols-[minmax(0,1fr)_auto] ${marks[r.key]?.state === "done" ? "border-ok/40 bg-ok-soft/40" : "border-line bg-surface"}`}>
              <div className="grid min-w-0 gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/clients/${r.slug}`} className="font-medium hover:text-brand-text">
                    {r.name}
                  </Link>
                  {r.monthly != null && <span className="tabular text-sm">{money(r.monthly)}</span>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.services.map((s) => (
                    <span key={s} className={`rounded-full px-2 py-0.5 text-[11px] ${r.unbilled.includes(s) ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>
                      {svc(s)}
                      {r.billed?.find((b) => b.service === s)?.amount != null ? ` ${money(r.billed.find((b) => b.service === s)!.amount)}` : ""}
                    </span>
                  ))}
                  {r.unlisted.map((s) => (
                    <span key={s} className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] text-bad">
                      {svc(s)} billed, not listed
                    </span>
                  ))}
                  {r.packageLabel && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand-text">{r.packageLabel}</span>}
                </div>
                {r.unbilled.length > 0 && <p className="text-xs text-warn">Listed but not billed: {r.unbilled.map(svc).join(", ")}</p>}
              </div>
              {gap ? actions(r.key, { clientId: r.id, title: `${r.name}: billing check` }) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TodosStep({ todos, people, me, pending, meeting, onAdd, onStatus, onFinish }: { todos: TodoRow[]; people: Person[]; me: string; pending: boolean; meeting: Meeting | null; onAdd: (t: { title: string; assigneeId: string; dueOn: string | null }) => void; onStatus: (id: string, s: "open" | "done" | "dismissed") => void; onFinish: (notes: string | null) => void }) {
  const [notes, setNotes] = useState(meeting?.notes ?? "");
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid content-start gap-2">
        {todos.length ? (
          <ul className="grid gap-2">
            {todos.map((t) => (
              <li key={t.id} className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4">
                <button type="button" aria-label={t.status === "done" ? "Open again" : "Mark done"} onClick={() => onStatus(t.id, t.status === "done" ? "open" : "done")} className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] ${t.status === "done" ? "border-ok bg-ok text-bg" : "border-line hover:border-fg/50"}`}>
                  {t.status === "done" ? "✓" : ""}
                </button>
                <div className="grid min-w-0 gap-0.5">
                  <p className={`text-sm ${t.status === "done" ? "text-muted line-through" : ""}`}>{t.title}</p>
                  <p className="tabular text-xs text-muted">
                    {t.assignee?.name ?? "Someone"}
                    {t.due_on ? ` · due ${new Date(`${t.due_on}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}
                    {t.client ? ` · ${t.client.name}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">No to-dos yet. Assign one from any item, or add one here.</p>
        )}
      </div>
      <div className="grid content-start gap-3">
        <TodoForm people={people} me={me} defaultTitle="" pending={pending} onSave={onAdd} />
        {meeting && (
          <div className="grid gap-2 rounded-xl bg-surface-2/60 p-3">
            <label htmlFor="review-notes" className="text-xs text-muted">
              Meeting notes
            </label>
            <textarea id="review-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand-text/70" />
            <button type="button" disabled={pending} onClick={() => onFinish(notes.trim() || null)} className="inline-flex h-11 items-center justify-center rounded-full bg-fg px-4 text-sm font-medium text-bg disabled:opacity-50 md:h-9">
              Finish the review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
