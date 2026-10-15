"use client";

import { useEffect, useState } from "react";
import type { CreativeNote, CreativeNotes } from "@/lib/ai";
import type { ReviewProgress } from "@/lib/creative-review";
import { stageInfo } from "@/lib/stages";
import { aiReview, sendOn, startAiReview, type AiReviewState, type AiRun } from "./review-actions";
import type { Ticket } from "./types";

// The AI review: the maker runs it before sending the work on (QA), fixes and replaces files, runs it again, then sends it
// (or sends it anyway, which their lead sees). The reviewer sees the same notes in creative review.

const ACCENT = "#6c7ee1";
const SECTIONS: { key: CreativeNote["severity"]; label: string; dot: string; text: string }[] = [
  { key: "fix", label: "Fix", dot: "bg-bad", text: "text-bad" },
  { key: "watch", label: "Keep an eye on", dot: "bg-warn", text: "text-warn" },
  { key: "good", label: "Working well", dot: "bg-ok", text: "text-ok" },
];
const VERDICT: Record<CreativeNotes["verdict"], { label: string; cls: string }> = {
  fix: { label: "Needs fixes", cls: "bg-bad-soft text-bad" },
  minor: { label: "A few things to check", cls: "bg-warn-soft text-warn" },
  ready: { label: "Looks ready", cls: "bg-ok/15 text-ok" },
};

export const DEMO_NOTES: CreativeNotes = {
  verdict: "fix",
  headline: "2 things to fix. First: D1 (9:16): the price sits in the bottom third, where the Reels caption covers it.",
  notes: [
    { severity: "fix", design: "D1", size: "9:16", area: "Placement", note: "The \"$8 Calzone Mondays\" price sits in the bottom third, where the Reels caption and buttons cover it. Move it above the middle." },
    { severity: "fix", design: "D2", size: "", area: "Offer", note: "Badge reads \"20% OFF\" but the brief's offer is 25% off this week only." },
    { severity: "watch", design: "D1", size: "4:5", area: "Text", note: "The subhead is thin white on a light crust; at phone size it's hard to read. A shadow or darker panel would help." },
    { severity: "watch", design: "D2", size: "", area: "Brief", note: "The brief asks to show the calzone cut open; D2 shows it whole." },
    { severity: "good", design: "D1", size: "", area: "Craft", note: "The cheese pull is sharp and warm, exactly the first look the brief asked for." },
  ],
};
const DEMO_DESIGNS = [
  { ref: "D1", name: "Calzone pull" },
  { ref: "D2", name: "Calzone pull · CTA test" },
];

const ScanIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />
  </svg>
);

/** Live progress: real steps (files opened, designs checked), eased in between so the bar never sits still. */
function Progress({ p }: { p: ReviewProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, []);

  const n = Math.max(1, p.designs.length);
  const filesPart = p.files.total ? p.files.done / p.files.total : 1;
  const designPart =
    p.designs.reduce((sum, d) => {
      if (d.status === "done" || d.status === "failed") return sum + 1;
      if (d.status === "checking") return sum + Math.min(0.92, Math.max(0, now - (d.startedAt ?? now)) / 50_000); // a design takes ~30–60s
      return sum;
    }, 0) / n;
  const pct = p.phase === "done" ? 100 : p.phase === "files" ? 3 + 12 * filesPart : 15 + 82 * designPart;
  const checking = p.designs.filter((d) => d.status === "checking");
  const label =
    p.phase === "files" ? p.files.label : checking.length ? `Checking ${checking.map((d) => d.ref).join(", ")}: reading the text, the offer, brand rules and placements` : "Putting the notes together";

  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-muted">{label}…</p>
        <span className="tabular font-heading text-[22px] leading-none" style={{ color: ACCENT }}>
          {Math.floor(pct)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${ACCENT}, #9aa7f0)` }} />
      </div>
      <ul className="grid gap-1.5">
        <li className="flex items-center gap-2.5 text-xs">
          <StepDot state={p.phase === "files" ? "active" : "done"} />
          <span className={p.phase === "files" ? "text-fg" : "text-muted"}>Open every file</span>
          <span className="tabular ml-auto text-faint">
            {p.files.done}/{p.files.total}
          </span>
        </li>
        {p.designs.map((d) => (
          <li key={d.ref} className="flex items-center gap-2.5 text-xs">
            <StepDot state={d.status === "checking" ? "active" : d.status === "done" ? "done" : d.status === "failed" ? "failed" : "waiting"} />
            <span className={d.status === "checking" ? "text-fg" : d.status === "waiting" ? "text-faint" : "text-muted"}>
              {d.ref} · {d.name}
            </span>
            <span className="ml-auto text-faint">
              {d.status === "done" ? (
                d.fixes ? (
                  <span className="text-bad">{d.fixes} to fix</span>
                ) : d.watch ? (
                  <span className="text-warn">{d.watch} to check</span>
                ) : (
                  <span className="text-ok">clean</span>
                )
              ) : d.status === "checking" ? (
                "checking"
              ) : d.status === "failed" ? (
                "couldn't check"
              ) : (
                "waiting"
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepDot({ state }: { state: "waiting" | "active" | "done" | "failed" }) {
  if (state === "done")
    return (
      <span className="grid h-4 w-4 place-items-center rounded-full bg-ok/20 text-ok">
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      </span>
    );
  if (state === "active") return <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#6c7ee1]/25 border-t-[#6c7ee1]" />;
  if (state === "failed") return <span className="grid h-4 w-4 place-items-center rounded-full bg-surface-2 text-[10px] text-faint">!</span>;
  return <span className="h-4 w-4 rounded-full border border-line" />;
}

function Notes({ notes, dim = false }: { notes: CreativeNotes; dim?: boolean }) {
  return (
    <div className={`grid gap-3 ${dim ? "opacity-60" : ""}`}>
      <p className="text-sm leading-relaxed">{notes.headline}</p>
      {SECTIONS.map((sec) => {
        const list = notes.notes.filter((n) => n.severity === sec.key);
        if (!list.length) return null;
        return (
          <div key={sec.key} className="grid gap-1.5">
            <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${sec.text}`}>
              {sec.label} · {list.length}
            </p>
            <ul className="grid gap-1.5">
              {list.map((n, i) => (
                <li key={i} className="flex gap-2.5 rounded-[8px] bg-bg/60 px-3 py-2 text-sm">
                  <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${sec.dot}`} />
                  <span className="min-w-0 flex-1 leading-relaxed">
                    <span className="mr-1.5 text-xs text-faint">{[n.design, n.size, n.area].filter(Boolean).join(" · ")}</span>
                    {n.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const fmtAgo = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Loads the review state and keeps it fresh while a run is going. */
function useReview(ticketId: string, demo: boolean) {
  const [state, setState] = useState<AiReviewState | null>(demo ? { latest: null, runs: 0, hasCreative: true, forced: null } : null);
  const running = state?.latest?.status === "running";
  useEffect(() => {
    if (demo) return;
    let live = true;
    aiReview(ticketId).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [ticketId, demo]);
  useEffect(() => {
    if (demo || !running) return;
    const t = setInterval(() => void aiReview(ticketId).then(setState), 1500);
    return () => clearInterval(t);
  }, [ticketId, demo, running]);
  return [state, setState] as const;
}

/** A fake run for the design preview: real-looking progress, then the sample notes. */
function useDemoRun(setState: (s: AiReviewState) => void) {
  return () => {
    const start = Date.now();
    const designs = DEMO_DESIGNS.map((d) => ({ ...d, status: "waiting" as const, fixes: 0, watch: 0 }));
    const base = (p: ReviewProgress, extra: Partial<AiRun> = {}): AiReviewState => ({
      latest: { id: "demo", status: "running", progress: p, notes: null, error: null, startedAt: new Date(start).toISOString(), updatedAt: new Date().toISOString(), by: "You", current: true, ...extra },
      runs: 1,
      hasCreative: true,
      forced: null,
    });
    const steps: [number, () => AiReviewState][] = [
      [0, () => base({ phase: "files", files: { done: 0, total: 3, label: "Opening D1 · 4:5" }, designs })],
      [700, () => base({ phase: "files", files: { done: 2, total: 3, label: "Opening D2 · 4:5" }, designs })],
      [1400, () => base({ phase: "designs", files: { done: 3, total: 3, label: "Files ready" }, designs: designs.map((d) => ({ ...d, status: "checking", startedAt: Date.now() })) })],
      [4200, () => base({ phase: "designs", files: { done: 3, total: 3, label: "" }, designs: [{ ...designs[0], status: "done", fixes: 1, watch: 1 }, { ...designs[1], status: "checking", startedAt: start + 1400 }] })],
      [
        6500,
        () =>
          base(
            { phase: "done", files: { done: 3, total: 3, label: "" }, designs: [{ ...designs[0], status: "done", fixes: 1, watch: 1 }, { ...designs[1], status: "done", fixes: 1, watch: 1 }] },
            { status: "done", notes: DEMO_NOTES },
          ),
      ],
    ];
    for (const [ms, make] of steps) setTimeout(() => setState(make()), ms);
  };
}

/**
 * The maker's side, in the stage card once the files are up: run the AI review, see its notes, fix and replace, run it
 * again, then send it on. Sending past open fixes (or without a review) is allowed and flagged for their lead.
 */
export function AiGate({ ticket, onSent, back, demo = false }: { ticket: Ticket; onSent: (stage: Ticket["stage"]) => void; back?: React.ReactNode; demo?: boolean }) {
  const [state, setState] = useReview(ticket.id, demo);
  const demoRun = useDemoRun(setState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const info = stageInfo(ticket.stage);
  const nextLabel = info.nextLabel ?? "Send on";
  const where = info.next === "internal_review" ? "creative review" : "the client";

  const review = async () => {
    setError(null);
    setConfirm(false);
    if (demo) return demoRun();
    setBusy(true);
    const r = await startAiReview(ticket.id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setState(r.state);
  };
  const send = async (force: boolean) => {
    setError(null);
    setBusy(true);
    const r = demo ? ({ ok: true } as const) : await sendOn(ticket.id, { force, note });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onSent(info.next!);
  };

  if (!state) return <p className="text-xs text-faint">Loading the AI review…</p>;
  const run = state.latest;
  const current = run?.current && run.status !== "failed" ? run : null;
  const fixes = current?.status === "done" ? (current.notes?.notes.filter((n) => n.severity === "fix").length ?? 0) : 0;
  const clean = current?.status === "done" && current.notes?.verdict !== "fix";

  return (
    <div className="grid gap-4 rounded-[12px] border border-line bg-bg/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <ScanIcon className="h-4 w-4 text-[#6c7ee1]" />
          AI review
          {current?.status === "done" && current.notes && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT[current.notes.verdict].cls}`}>{VERDICT[current.notes.verdict].label}</span>}
        </p>
        {run && run.status !== "running" && (
          <span className="text-[11px] text-faint">
            {state.runs > 1 ? `Review ${state.runs} · ` : ""}
            {fmtAgo(run.updatedAt)}
          </span>
        )}
      </div>

      {run?.status === "running" ? (
        <Progress p={run.progress} />
      ) : current?.status === "done" && current.notes ? (
        <Notes notes={current.notes} />
      ) : (
        <div className="grid gap-3">
          {run?.status === "done" && run.notes && !run.current ? (
            <>
              <p className="text-sm text-muted">You replaced files since the last review. Run it again to check the new version.</p>
              <details className="text-xs text-faint">
                <summary className="cursor-pointer hover:text-fg">What the last review said</summary>
                <div className="mt-2">
                  <Notes notes={run.notes} dim />
                </div>
              </details>
            </>
          ) : (
            <p className="text-sm text-muted">
              {run?.status === "failed" ? `${run.error ?? "The last review didn't finish."} ` : ""}
              Before it goes to {where}, the AI checks every file: typos, the offer against the brief, brand rules, Meta safe zones and sizes. Fix what it finds first and there&apos;s less back and forth.
            </p>
          )}
        </div>
      )}

      {run?.status !== "running" && (
        <div className="grid gap-3 border-t border-line pt-4">
          {clean ? (
            <>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={`Add a note for ${where} (optional)`}
                className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  disabled={busy}
                  onClick={() => send(false)}
                  className="h-10 rounded-brand bg-brand px-4 text-sm font-medium text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:bg-brand-hover disabled:opacity-60"
                >
                  {busy ? "Sending…" : `${nextLabel} →`}
                </button>
                <button disabled={busy} onClick={review} className="h-10 rounded-brand px-3 text-sm text-muted hover:text-fg disabled:opacity-60">
                  Review again
                </button>
                {back}
              </div>
            </>
          ) : confirm ? (
            <div className="grid gap-3 rounded-[10px] border border-warn/30 bg-warn-soft/40 p-3.5">
              <p className="text-sm">
                {fixes
                  ? `${fixes} AI note${fixes === 1 ? "" : "s"} to fix ${fixes === 1 ? "is" : "are"} still open. You can send it anyway; your lead will see it went on with them open.`
                  : "It hasn't had an AI review. You can send it anyway; your lead will see it skipped the review."}
              </p>
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why? e.g. the price is what the client asked for on the call"
                className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button disabled={busy} onClick={() => send(true)} className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-60">
                  {busy ? "Sending…" : "Send anyway"}
                </button>
                <button onClick={() => setConfirm(false)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                disabled={busy}
                onClick={review}
                className="h-10 rounded-brand px-4 text-sm font-medium text-white disabled:opacity-60"
                style={{ background: ACCENT, boxShadow: "0 8px 24px -10px rgba(108,126,225,0.9)" }}
              >
                {busy ? "Starting…" : current ? "Review again" : run ? "Review the new files" : "Review creative"}
              </button>
              {fixes > 0 && <span className="text-xs text-faint">Fix the notes, Replace the files, then review again.</span>}
              <button disabled={busy} onClick={() => setConfirm(true)} className="ml-auto h-10 rounded-brand px-3 text-xs text-faint hover:text-fg disabled:opacity-60">
                Send anyway
              </button>
              {back}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

/** The reviewer's side, in creative review: the latest AI notes, and (for leads) whether it was sent on past them. */
export function AiReviewNotes({ ticket, demo = false }: { ticket: Ticket; demo?: boolean }) {
  const [state, setState] = useReview(ticket.id, demo);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!demo) return;
    setState({
      latest: { id: "demo", status: "done", progress: { phase: "done", files: { done: 3, total: 3, label: "" }, designs: [] }, notes: DEMO_NOTES, error: null, startedAt: "", updatedAt: new Date().toISOString(), by: "Nelson", current: true },
      runs: 2,
      hasCreative: true,
      forced: { by: "Nelson", at: new Date().toISOString(), skipped: false, fixes: 1, note: "The 20% is what the client said on Tuesday's call." },
    });
  }, [demo, setState]);

  const rerun = async () => {
    if (demo) return;
    const r = await startAiReview(ticket.id);
    if (r.ok) setState(r.state);
  };

  if (!state) return null;
  const run = state.latest;
  return (
    <div className="grid gap-3 rounded-[10px] border border-line bg-surface p-4">
      {state.forced && (
        <div className="grid gap-1 rounded-[8px] border border-warn/30 bg-warn-soft/40 px-3 py-2.5 text-sm">
          <p className="font-medium text-warn">
            {state.forced.skipped ? "Sent without an AI review" : `Sent with ${state.forced.fixes} AI fix${state.forced.fixes === 1 ? "" : "es"} still open`}
          </p>
          <p className="text-xs text-muted">
            {state.forced.by ?? "Someone"} · {fmtAgo(state.forced.at)}
            {state.forced.note && <> · &ldquo;{state.forced.note}&rdquo;</>}
          </p>
          <p className="text-[11px] text-faint">Only leads and execs see this.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left">
          <ScanIcon className="h-4 w-4 text-[#6c7ee1]" />
          <span className="text-sm font-medium">AI review notes</span>
          {run?.status === "done" && run.notes && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT[run.notes.verdict].cls}`}>{VERDICT[run.notes.verdict].label}</span>}
        </button>
        {run?.status !== "running" && (
          <span className="flex items-center gap-3 text-xs text-faint">
            {run && (
              <span>
                {state.runs > 1 ? `${state.runs} reviews · ` : ""}
                {run.by ? `run by ${run.by.split(" ")[0]} · ` : ""}
                {fmtAgo(run.updatedAt)}
              </span>
            )}
            <button onClick={rerun} className="hover:text-fg">
              {run ? "Look again" : "Run it now"}
            </button>
          </span>
        )}
      </div>
      {!run ? (
        <p className="text-xs text-muted">No AI review was run on this creative before it was sent.</p>
      ) : run.status === "running" ? (
        <Progress p={run.progress} />
      ) : run.status === "failed" ? (
        <p className="text-xs text-muted">{run.error}</p>
      ) : (
        open &&
        run.notes && (
          <>
            {!run.current && <p className="text-xs text-warn">These notes are about an earlier version of the files.</p>}
            <Notes notes={run.notes} />
          </>
        )
      )}
    </div>
  );
}
