"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import type { Review, ReviewIssue, Suggestions } from "@/lib/ai";
import { draws, type Allotment } from "@/lib/allotment";
import { FORMAT_LABEL, type Format, type Priority } from "@/lib/stages";
import { ClientTag, FormatIcon } from "@/app/(team)/board/ticket-card";
import { createBatch, reviewRequest, suggestForRequest, type ContextSummary, type ReviewResult } from "./actions";
import { FORMATS, SIZES, emptyDraft, selectedFormats, totalFor, type Draft, type Size } from "./draft";
import { AllotmentMeter, AspectOption, Chip, ClientSearch, Progress, Spark, Stepper, Thinking, type ClientOption } from "./parts";

const STEPS = ["Client", "Formats", "Direction", "Brief", "Review"];
const TURNAROUND: Record<Format, number> = { image: 2, video: 4, carousel: 2 };
const MAKER: Record<Format, { role: string; label: string }> = {
  image: { role: "graphic_designer", label: "designer" },
  carousel: { role: "graphic_designer", label: "designer" },
  video: { role: "video_editor", label: "video editor" },
};
const FIELD_STEP: Record<ReviewIssue["field"], number> = { formats: 1, sizes: 1, title: 2, angle: 2, audience: 2, brief: 3, references: 3 };
const FIELD_LABEL: Record<ReviewIssue["field"], string> = {
  formats: "Formats",
  sizes: "Sizes",
  title: "Title",
  angle: "Angle",
  audience: "Audience",
  brief: "Brief",
  references: "References",
};

const input =
  "h-12 w-full rounded-[8px] border border-line bg-surface px-4 text-[15px] outline-none transition-colors placeholder:text-faint focus:border-brand-text/70";

type AiState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; s: Suggestions; context: ContextSummary }
  | { status: "error"; error: string };
type ReviewState = { status: "idle" } | { status: "running" } | { status: "done"; review: Review } | { status: "error"; error: string };

export type RequestDemo = { suggestions: Suggestions; context: ContextSummary; review: Review };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const countLabel = (n: number, v: number) => [n && `${n} new`, v && plural(v, "variation")].filter(Boolean).join(" + ");
const dueLabel = (f: Format, p: Priority) => {
  const days = p === "urgent" ? Math.floor(TURNAROUND[f] / 2) : TURNAROUND[f];
  return days === 0 ? "due today" : `due in ${plural(days, "business day")}`;
};

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function RequestForm({
  clients,
  allotments,
  anglesByClient,
  teamByClient,
  initialClient,
  aiOn,
  demo,
}: {
  clients: ClientOption[];
  allotments: Record<string, Allotment>;
  anglesByClient: Record<string, string[]>;
  teamByClient: Record<string, Record<string, string>>;
  initialClient: string | null;
  aiOn: boolean;
  demo?: RequestDemo; // design preview: sample AI answers, no server calls
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(initialClient));
  const [step, setStep] = useState(initialClient ? 1 : 0);
  const [ai, setAi] = useState<AiState>(initialClient && aiOn ? { status: "loading" } : { status: "idle" });
  const [briefAi, setBriefAi] = useState<{ status: "idle" | "loading" } | { status: "offer"; text: string }>({ status: "idle" });
  const [review, setReview] = useState<ReviewState>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number[] | null>(null);
  const [pending, start] = useTransition();
  const latest = useRef(0); // ignore suggestions that come back after the client changed
  const topRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reveal = (el: React.RefObject<HTMLDivElement | null>, block: ScrollLogicalPosition) =>
    requestAnimationFrame(() => el.current?.scrollIntoView({ behavior: "smooth", block }));

  const client = clients.find((c) => c.id === draft.clientId) ?? null;
  const team = draft.clientId ? (teamByClient[draft.clientId] ?? {}) : {};
  const formats = selectedFormats(draft);
  const total = formats.reduce((n, f) => n + totalFor(draft.formats[f]), 0);
  const s = ai.status === "ready" ? ai.s : null;
  const allotment = draft.clientId ? allotments[draft.clientId] : undefined;
  const taking = draws(draft.formats);

  const fetchSuggestions = (d: Draft): Promise<AiState> =>
    demo
      ? new Promise((r) => setTimeout(() => r({ status: "ready", s: demo.suggestions, context: demo.context }), 1100))
      : suggestForRequest(d).then((res) => (res.ok ? { status: "ready", s: res.suggestions, context: res.context } : { status: "error", error: res.error }));

  const suggest = (d: Draft) => {
    if (!aiOn) return;
    const id = ++latest.current;
    setAi({ status: "loading" });
    fetchSuggestions(d).then((r) => id === latest.current && setAi(r));
  };

  // Arriving with ?client= starts reading that client right away
  useEffect(() => {
    if (!initialClient || !aiOn) return;
    const id = ++latest.current;
    fetchSuggestions(draft).then((r) => id === latest.current && setAi(r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setReview({ status: "idle" });
  };

  const pickClient = (c: ClientOption) => {
    const next = { ...emptyDraft(c.id), formats: draft.formats, sizes: draft.sizes };
    setDraft(next);
    setBriefAi({ status: "idle" });
    setReview({ status: "idle" });
    go(1);
    suggest(next);
  };

  const toggleFormat = (f: Format) => {
    const next = { ...draft.formats };
    if (next[f]) delete next[f];
    else next[f] = { new: 1, variations: 0 };
    set({ formats: next });
  };

  const setCount = (f: Format, key: "new" | "variations", n: number) => set({ formats: { ...draft.formats, [f]: { ...draft.formats[f]!, [key]: n } } });

  const applyMix = (sg: Suggestions) =>
    set({
      formats: Object.fromEntries(sg.mix.map((m) => [m.format, { new: m.new, variations: m.variations }])),
      ...(sg.sizes.length ? { sizes: sg.sizes } : {}),
    });

  const toggleSize = (z: Size) => set({ sizes: draft.sizes.includes(z) ? draft.sizes.filter((x) => x !== z) : SIZES.filter((x) => x === z || draft.sizes.includes(x)) });

  const blocked = [
    !draft.clientId && "Pick a client to continue.",
    (formats.length === 0 && "Pick at least one format.") ||
      (formats.some((f) => totalFor(draft.formats[f]) === 0) && "Each format needs at least one creative.") ||
      (draft.sizes.length === 0 && "Pick at least one size."),
    !draft.title.trim() && "Give it a title.",
    false,
    false,
  ][step];

  function go(i: number) {
    setError(null);
    setStep(i);
    reveal(topRef, "start");
  }

  const draftBrief = () => {
    if (!aiOn) return;
    setBriefAi({ status: "loading" });
    fetchSuggestions(draft).then((r) => {
      if (r.status !== "ready") {
        setBriefAi({ status: "idle" });
        setError(r.status === "error" ? r.error : null);
        return;
      }
      setAi(r);
      if (!draft.brief.trim()) {
        set({ brief: r.s.brief });
        setBriefAi({ status: "idle" });
      } else setBriefAi({ status: "offer", text: r.s.brief });
    });
  };

  const send = (r: Review | null) =>
    start(async () => {
      setError(null);
      if (demo) {
        setCreated(formats.map((_, i) => 1061 + i));
        return;
      }
      const res = await createBatch(draft, r);
      if (res.ok) setCreated(res.numbers);
      else setError(res.error);
    });

  const runReview = () => {
    if (!aiOn) return send(null);
    setReview({ status: "running" });
    reveal(reviewRef, "center");
    const ask: Promise<ReviewResult> = demo ? new Promise((r) => setTimeout(() => r({ ok: true, review: demo.review }), 3200)) : reviewRequest(draft);
    ask.then((res) => {
      if (!res.ok) return setReview({ status: "error", error: res.error });
      setReview({ status: "done", review: res.review });
      reveal(reviewRef, "center");
      if (res.review.issues.length === 0) send(res.review);
    });
  };

  const reset = () => {
    latest.current++;
    setDraft(emptyDraft(null));
    setAi({ status: "idle" });
    setReview({ status: "idle" });
    setBriefAi({ status: "idle" });
    setCreated(null);
    go(0);
  };

  const heading = [
    ["Who’s it for?", "Search by name. The work goes to that client’s designer or editor."],
    ["What are we making?", "Pick every format you need. Each one becomes its own ticket for the right person."],
    ["What’s the direction?", "Name it and set the angle, so the team and the copy agent aim the same way."],
    ["Brief the team", "What to show, what to say, and what to stay away from."],
    ["Ready to send", aiOn ? "Check it over. The AI scrubs it against the client’s history before it goes out." : "Check it over before it goes out."],
  ][step];

  return (
    <div ref={topRef} className="grid scroll-mt-8 gap-8 xl:grid-cols-[minmax(0,1fr)_288px] xl:gap-10">
      <div className="grid min-w-0 content-start gap-9">
        <div className="grid gap-6">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">New request</p>
            <Link href="/board" className="text-xs text-muted hover:text-fg">
              Cancel
            </Link>
          </div>
          {!created && <Progress steps={STEPS} current={step} onJump={go} />}
          {!created && <AiStrip aiOn={aiOn} ai={ai} clientName={client?.name ?? null} onRefresh={() => suggest(draft)} />}
        </div>

        {created ? (
          <Done numbers={created} formats={formats} team={team} clientName={client?.name ?? ""} onAgain={reset} />
        ) : (
          <form
            key={step}
            onSubmit={(e) => {
              e.preventDefault();
              if (step < 4 && !blocked) go(step + 1);
            }}
            className="grid gap-8 animate-[step-in_.35s_cubic-bezier(.2,.8,.2,1)]"
          >
            <div className="grid gap-2">
              {client && step > 0 && (
                <div className="mb-2 flex items-center gap-2">
                  <ClientTag name={client.name} />
                  <button type="button" onClick={() => go(0)} className="text-xs text-faint hover:text-fg">
                    Change
                  </button>
                </div>
              )}
              <h1 className="font-heading text-[28px] leading-tight sm:text-[32px]">{heading[0]}</h1>
              <p className="text-sm text-muted">{heading[1]}</p>
            </div>

            {step === 0 && <ClientSearch clients={clients} allotments={allotments} onPick={pickClient} />}

            {step === 1 && (
              <div className="grid gap-8">
                <div className="grid gap-3 sm:grid-cols-3">
                  {FORMATS.map((f) => {
                    const on = Boolean(draft.formats[f]);
                    const maker = team[MAKER[f].role];
                    return (
                      <button
                        key={f}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleFormat(f)}
                        className={`grid gap-4 rounded-[10px] border p-4 text-left transition-all ${
                          on ? "border-brand-text/60 bg-brand-soft shadow-[0_10px_30px_-18px_rgba(178,30,44,0.9)]" : "border-line bg-surface hover:border-faint"
                        }`}
                      >
                        <span className="flex items-start justify-between">
                          <span className={`grid h-10 w-10 place-items-center rounded-[8px] ${on ? "bg-brand text-white" : "bg-surface-2 text-muted"}`}>
                            <FormatIcon format={f} size={20} />
                          </span>
                          <span className={`grid h-5 w-5 place-items-center rounded-full border text-[11px] ${on ? "border-brand bg-brand text-white" : "border-line text-transparent"}`}>✓</span>
                        </span>
                        <span className="grid gap-0.5">
                          <span className="font-medium">{FORMAT_LABEL[f]}</span>
                          <span className="text-xs text-faint">{plural(TURNAROUND[f], "business day")}</span>
                        </span>
                        <span className="flex min-w-0 items-center gap-2 border-t border-line/70 pt-3 text-xs">
                          {maker ? (
                            <>
                              <PersonAvatar name={maker} size={20} />
                              <span className="truncate text-muted">{maker}</span>
                            </>
                          ) : (
                            <span className="text-warn">No {MAKER[f].label} assigned</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {s && s.mix.length > 0 && (
                  <div className="grid gap-3 rounded-[10px] border border-brand-text/20 bg-brand-soft/30 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <Spark size={11} className="text-brand-text" /> Suggested for this client
                      </p>
                      <button type="button" onClick={() => applyMix(s)} className="h-8 shrink-0 rounded-full border border-brand-text/40 px-3 text-xs text-fg hover:bg-brand-soft">
                        Use this mix
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {s.mix.map((m) => (
                        <span key={m.format} className="inline-flex items-center gap-1.5 rounded-full bg-bg/60 px-3 py-1 text-xs">
                          <FormatIcon format={m.format} size={12} /> {FORMAT_LABEL[m.format]}
                          <span className="text-muted">· {countLabel(m.new, m.variations)}</span>
                        </span>
                      ))}
                      {s.sizes.length > 0 && <span className="tabular rounded-full bg-bg/60 px-3 py-1 text-xs text-muted">{s.sizes.map((z) => z.replace("x", ":")).join(" · ")}</span>}
                    </div>
                    {s.mixWhy && <p className="text-xs leading-relaxed text-muted">{s.mixWhy}</p>}
                  </div>
                )}

                <AllotmentMeter allotment={allotment} request={taking} />

                {formats.length > 0 && (
                  <Field label="How many" hint={`${plural(formats.length, "ticket")} · ${plural(total, "creative")}`}>
                    <div className="grid divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
                      {formats.map((f) => {
                        const c = draft.formats[f]!;
                        return (
                          <div key={f} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:gap-6">
                            <span className="flex items-center gap-2 text-sm sm:h-10">
                              <FormatIcon format={f} size={16} /> {FORMAT_LABEL[f]}
                            </span>
                            <div className="grid grid-cols-[auto_auto_minmax(40px,1fr)] items-end gap-3">
                              <Stepper label="Net new" value={c.new} onChange={(n) => setCount(f, "new", n)} />
                              <Stepper label="Variations" value={c.variations} onChange={(n) => setCount(f, "variations", n)} />
                              <span className="grid justify-items-end gap-1.5">
                                <span className="text-[11px] text-faint">Total</span>
                                <span className={`tabular grid h-10 place-items-center text-lg ${c.new + c.variations === 0 ? "text-bad" : ""}`}>{c.new + c.variations}</span>
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs leading-relaxed text-faint">
                      <span className="text-muted">Net new</span> is a distinct design. A <span className="text-muted">variation</span> keeps the design and tests copy, headline or CTA. Variations don&apos;t count toward the allotment.
                    </p>
                  </Field>
                )}

                <Field label="Sizes" hint="Sizes of one design count as one">
                  <div className="grid max-w-md grid-cols-3 gap-3">
                    {SIZES.map((z) => (
                      <AspectOption key={z} size={z} on={draft.sizes.includes(z)} onToggle={() => toggleSize(z)} />
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-8">
                <Field id="title" label="Title">
                  <input id="title" autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. BFCM · Buy More, Save More" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.titles.map((t) => (
                      <Chip key={t} ai on={draft.title === t} onClick={() => set({ title: t })}>
                        {t}
                      </Chip>
                    ))}
                  </Suggest>
                </Field>

                <Field id="angle" label="Angle or avatar" hint="Copy is written once per angle">
                  <input id="angle" value={draft.angle} onChange={(e) => set({ angle: e.target.value })} placeholder="Fresh, never frozen" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.angles.map((a) => (
                      <Chip key={a.name} ai title={a.why} on={draft.angle === a.name} onClick={() => set({ angle: a.name })}>
                        {a.name}
                      </Chip>
                    ))}
                    {(anglesByClient[draft.clientId ?? ""] ?? [])
                      .filter((a) => !s?.angles.some((x) => x.name === a))
                      .slice(0, 8)
                      .map((a) => (
                        <Chip key={a} on={draft.angle === a} onClick={() => set({ angle: a })}>
                          {a}
                        </Chip>
                      ))}
                  </Suggest>
                </Field>

                <Field id="audience" label="Audience">
                  <input id="audience" value={draft.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="Parents of kids 5–12, retargeting" className={input} />
                  <Suggest loading={ai.status === "loading"}>
                    {s?.audiences.map((a) => (
                      <Chip key={a} ai on={draft.audience === a} onClick={() => set({ audience: a })}>
                        {a}
                      </Chip>
                    ))}
                  </Suggest>
                </Field>

                <Field label="Priority">
                  <div role="radiogroup" className="grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["normal", "Normal", "Standard turnaround"],
                        ["high", "High", "Top of their queue"],
                        ["urgent", "Urgent", "Half the turnaround"],
                      ] as const
                    ).map(([v, l, h]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={draft.priority === v}
                        onClick={() => set({ priority: v })}
                        className={`grid gap-0.5 rounded-[10px] border px-4 py-3 text-left transition-colors ${
                          draft.priority === v ? (v === "urgent" ? "border-bad/60 bg-bad-soft" : "border-brand-text/60 bg-brand-soft") : "border-line bg-surface hover:border-faint"
                        }`}
                      >
                        <span className="text-sm font-medium">{l}</span>
                        <span className="text-xs text-faint">{h}</span>
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-8">
                <Field
                  id="brief"
                  label="Brief"
                  hint={
                    aiOn && (
                      <button
                        type="button"
                        onClick={draftBrief}
                        disabled={briefAi.status === "loading"}
                        className="inline-flex items-center gap-1.5 rounded-full border border-brand-text/30 px-3 py-1 text-xs text-fg hover:bg-brand-soft disabled:opacity-60"
                      >
                        <Spark size={10} className={`text-brand-text ${briefAi.status === "loading" ? "animate-[ai-pulse_1s_ease-in-out_infinite]" : ""}`} />
                        {briefAi.status === "loading" ? "Writing…" : draft.brief.trim() ? "Rewrite with AI" : "Draft with AI"}
                      </button>
                    )
                  }
                >
                  <textarea
                    id="brief"
                    autoFocus
                    rows={10}
                    value={draft.brief}
                    onChange={(e) => set({ brief: e.target.value })}
                    placeholder="What it should say and show. The hook, the offer, on-image text, anything the creative needs."
                    className="w-full rounded-[8px] border border-line bg-surface px-4 py-3.5 text-[15px] leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
                  />
                  {briefAi.status === "offer" && (
                    <div className="grid gap-3 rounded-[10px] border border-brand-text/25 bg-brand-soft/30 p-4 animate-[step-in_.25s_ease-out]">
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <Spark size={10} className="text-brand-text" /> Suggested brief
                      </p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">{briefAi.text}</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => (set({ brief: briefAi.text }), setBriefAi({ status: "idle" }))} className="h-8 rounded-full bg-fg px-3 text-xs text-bg">
                          Replace mine
                        </button>
                        <button type="button" onClick={() => (set({ brief: `${draft.brief.trim()}\n\n${briefAi.text}` }), setBriefAi({ status: "idle" }))} className="h-8 rounded-full border border-line px-3 text-xs hover:border-faint">
                          Add below mine
                        </button>
                        <button type="button" onClick={() => setBriefAi({ status: "idle" })} className="h-8 px-2 text-xs text-faint hover:text-fg">
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                  {s && s.hooks.length > 0 && (
                    <div className="grid gap-2">
                      <span className="text-xs text-faint">Hooks to try · click to add</span>
                      <div className="flex flex-wrap gap-2">
                        {s.hooks.map((h) => (
                          <Chip key={h} ai on={draft.brief.includes(h)} onClick={() => !draft.brief.includes(h) && set({ brief: `${draft.brief.trimEnd()}${draft.brief.trim() ? "\n" : ""}Hook: ${h}` })}>
                            {h}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>

                {s && s.watchouts.length > 0 && <Watchouts items={s.watchouts} />}

                <Field id="refs" label="References" hint="One link per line">
                  <textarea
                    id="refs"
                    rows={3}
                    value={draft.refs}
                    onChange={(e) => set({ refs: e.target.value })}
                    placeholder="Motion snapshots, the ad to iterate, examples"
                    className="w-full rounded-[8px] border border-line bg-surface px-4 py-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand-text/70"
                  />
                </Field>
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-6">
                <div className="grid gap-px overflow-hidden rounded-[10px] border border-line bg-line">
                  {formats.map((f) => {
                    const c = draft.formats[f]!;
                    const maker = team[MAKER[f].role];
                    return (
                      <div key={f} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-4 py-3.5">
                        <span className="grid h-9 w-9 place-items-center rounded-[8px] bg-surface-2 text-muted">
                          <FormatIcon format={f} size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">
                            {FORMAT_LABEL[f]} <span className="font-normal text-muted">· {countLabel(c.new, c.variations)}</span>
                          </span>
                          <span className="block text-xs text-faint">{dueLabel(f, draft.priority)}</span>
                        </span>
                        <span className="flex items-center gap-2 text-sm">
                          {maker ? (
                            <>
                              <PersonAvatar name={maker} size={22} /> {maker}
                            </>
                          ) : (
                            <span className="text-warn">Lands unassigned</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <AllotmentMeter allotment={allotment} request={taking} compact />

                <dl className="grid gap-x-6 gap-y-4 rounded-[10px] border border-line bg-surface p-5 text-sm sm:grid-cols-2">
                  {[
                    ["Title", draft.title, 2],
                    ["Angle", draft.angle || "—", 2],
                    ["Audience", draft.audience || "—", 2],
                    ["Priority", draft.priority[0].toUpperCase() + draft.priority.slice(1), 2],
                    ["Sizes", draft.sizes.map((z) => z.replace("x", ":")).join(", "), 1],
                    ["References", `${draft.refs.split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).length || "None"}`, 3],
                  ].map(([k, v, to]) => (
                    <div key={k as string} className="group min-w-0">
                      <dt className="flex items-center gap-2 text-xs text-faint">
                        {k}
                        <button type="button" onClick={() => go(to as number)} className="opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100">
                          Edit
                        </button>
                      </dt>
                      <dd className="mt-1 truncate">{v}</dd>
                    </div>
                  ))}
                  <div className="group sm:col-span-2">
                    <dt className="flex items-center gap-2 text-xs text-faint">
                      Brief
                      <button type="button" onClick={() => go(3)} className="opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100">
                        Edit
                      </button>
                    </dt>
                    <dd className="mt-1 line-clamp-4 whitespace-pre-wrap leading-relaxed text-muted">{draft.brief || "No brief written."}</dd>
                  </div>
                </dl>

                <div ref={reviewRef} className="grid empty:hidden">
                  {review.status === "running" && <Scanning />}
                  {review.status === "done" && <ReviewCard review={review.review} onEdit={(f) => go(FIELD_STEP[f])} />}
                </div>
                {review.status === "error" && (
                  <p className="rounded-[10px] border border-line bg-surface px-4 py-3 text-sm text-muted">
                    The AI review didn&apos;t run: {review.error} You can still send it.
                  </p>
                )}
              </div>
            )}

            {/* Footer */}
            <div className={`flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 ${step === 0 ? "hidden" : ""}`}>
              <div>
                {step > 0 && (
                  <button type="button" onClick={() => go(step - 1)} className="h-11 rounded-brand px-4 text-sm text-muted hover:bg-surface hover:text-fg">
                    ← Back
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {(error || (blocked && step > 0)) && <span className={`text-sm ${error ? "text-brand-text" : "text-faint"}`}>{error ?? blocked}</span>}
                {step < 4 ? (
                  step > 0 && (
                    <button disabled={Boolean(blocked)} className="h-11 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition-colors hover:bg-brand-hover disabled:bg-surface-2 disabled:text-faint disabled:shadow-none">
                      Continue
                    </button>
                  )
                ) : review.status === "done" && review.review.issues.length > 0 && !pending ? (
                  <>
                    <button type="button" onClick={() => send(review.review)} className="h-11 rounded-brand border border-line px-5 text-sm text-muted hover:border-faint hover:text-fg">
                      Send anyway
                    </button>
                    <button
                      type="button"
                      onClick={() => go(FIELD_STEP[review.review.issues[0].field])}
                      className="h-11 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] hover:bg-brand-hover"
                    >
                      Fix it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={pending || review.status === "running"}
                    onClick={() => (review.status === "error" ? send(null) : runReview())}
                    className="inline-flex h-11 items-center gap-2 rounded-brand bg-brand px-6 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition-colors hover:bg-brand-hover disabled:opacity-70"
                  >
                    {aiOn && review.status !== "error" && <Spark size={12} />}
                    {pending
                      ? "Creating…"
                      : review.status === "running"
                        ? "Reviewing…"
                        : review.status === "error"
                          ? "Send without review"
                          : aiOn
                            ? "Request creative"
                            : `Create ${plural(formats.length, "ticket")}`}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </div>

      <AiPanel aiOn={aiOn} ai={ai} clientName={client?.name ?? null} onRefresh={() => suggest(draft)} />
    </div>
  );
}

function Suggest({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  if (loading)
    return (
      <div className="flex gap-2" aria-label="Loading suggestions">
        {[96, 140, 80].map((w) => (
          <span key={w} className="relative h-7 overflow-hidden rounded-full bg-surface-2" style={{ width: w }}>
            <span className="absolute inset-y-0 w-1/2 bg-gradient-to-r from-transparent via-fg/10 to-transparent animate-[ai-sweep_1.4s_ease-in-out_infinite]" />
          </span>
        ))}
      </div>
    );
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  if (!items || (Array.isArray(items) && items.length === 0)) return null;
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function Watchouts({ items }: { items: string[] }) {
  return (
    <div className="grid gap-2 rounded-[10px] border border-warn/25 bg-warn-soft/40 px-4 py-3.5">
      <p className="text-xs font-medium text-warn">From this client&apos;s feedback</p>
      <ul className="grid gap-1.5">
        {items.map((w) => (
          <li key={w} className="flex gap-2 text-sm text-muted">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-warn" />
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SCAN_LINES = ["Reading the client’s feedback history", "Checking the campaign direction", "Matching formats, sizes and brief", "Looking for anything Meta would reject"];

function Scanning() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, SCAN_LINES.length - 1)), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="relative overflow-hidden rounded-[10px] border border-brand-text/25 bg-surface p-5" role="status">
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-brand/15 to-transparent animate-[ai-sweep_1.8s_ease-in-out_infinite]" />
      <p className="relative flex items-center gap-2 text-sm font-medium">
        <Spark className="text-brand-text animate-[ai-pulse_1.2s_ease-in-out_infinite]" /> Reviewing the request
      </p>
      <ul className="relative mt-4 grid gap-2.5">
        {SCAN_LINES.map((l, n) => (
          <li key={l} className={`flex items-center gap-2.5 text-sm transition-opacity duration-300 ${n <= i ? "opacity-100" : "opacity-30"}`}>
            <span className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${n < i ? "bg-ok text-bg" : n === i ? "border border-brand-text" : "border border-line"}`}>{n < i ? "✓" : ""}</span>
            <span className={n === i ? "text-fg" : "text-muted"}>{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewCard({ review, onEdit }: { review: Review; onEdit: (f: ReviewIssue["field"]) => void }) {
  if (review.issues.length === 0)
    return (
      <div className="flex items-center gap-3 rounded-[10px] border border-ok/30 bg-ok-soft px-4 py-3.5 animate-[step-in_.25s_ease-out]">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ok text-xs text-bg">✓</span>
        <p className="text-sm">{review.summary || "Looks good. Sending it to the team."}</p>
      </div>
    );
  const blockers = review.issues.filter((x) => x.severity === "block").length;
  return (
    <div className="grid gap-4 rounded-[10px] border border-line bg-surface p-5 animate-[step-in_.3s_ease-out]">
      <div className="flex items-start gap-3">
        <Spark size={14} className="mt-1 shrink-0 text-brand-text" />
        <div>
          <p className="font-medium">
            {blockers ? `${plural(blockers, "thing")} to fix before this goes out` : `${plural(review.issues.length, "thing")} worth a second look`}
          </p>
          <p className="mt-0.5 text-sm text-muted">{review.summary}</p>
        </div>
      </div>
      <ul className="grid gap-2">
        {review.issues.map((x, i) => (
          <li key={i} className="grid gap-1.5 rounded-[8px] bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-medium ${x.severity === "block" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                  {x.severity === "block" ? "Must fix" : "Heads up"}
                </span>
                <span className="text-faint">{FIELD_LABEL[x.field]}</span>
              </span>
              <button type="button" onClick={() => onEdit(x.field)} className="text-xs text-muted hover:text-fg">
                Edit →
              </button>
            </div>
            <p className="text-sm">{x.issue}</p>
            <p className="text-sm text-muted">{x.fix}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AiPanel({ aiOn, ai, clientName, onRefresh }: { aiOn: boolean; ai: AiState; clientName: string | null; onRefresh: () => void }) {
  return (
    <aside className="hidden xl:sticky xl:top-8 xl:block xl:self-start">
      <div className="relative grid gap-4 overflow-hidden rounded-[12px] border border-line bg-surface p-5">
        <span className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand to-[#5a0f16] text-white shadow-[0_6px_20px_-6px_rgba(178,30,44,0.9)]">
            <Spark size={14} className={ai.status === "loading" ? "animate-[ai-pulse_1s_ease-in-out_infinite]" : ""} />
          </span>
          <div>
            <p className="text-sm font-medium">Kaizen AI</p>
            <p className="text-[11px] text-faint">{!aiOn ? "Not connected" : ai.status === "loading" ? "Reading…" : ai.status === "ready" ? "Ready" : "Standing by"}</p>
          </div>
        </div>

        <div className="relative grid gap-3 text-sm leading-relaxed">
          {!aiOn ? (
            <p className="text-muted">Suggestions and the request review switch on once the AI key is added. The form works the same without it.</p>
          ) : !clientName ? (
            <p className="text-muted">Pick a client and I&apos;ll read their past requests, angles and feedback, then suggest every field.</p>
          ) : ai.status === "loading" ? (
            <>
              <p className="text-muted">
                Reading <span className="text-fg">{clientName}</span>&apos;s history…
              </p>
              <Thinking />
            </>
          ) : ai.status === "ready" ? (
            <>
              <p className="text-muted">
                Read {plural(ai.context.requests, "past request")}, {plural(ai.context.angles, "angle")} and {plural(ai.context.memory, "feedback note")} for{" "}
                <span className="text-fg">{clientName}</span>. Look for <Spark size={10} className="inline text-brand-text" /> on each field.
              </p>
              {!ai.context.adAccount && <p className="text-xs text-faint">No Meta ad account linked to this client yet.</p>}
              <button type="button" onClick={onRefresh} className="justify-self-start text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
                Refresh with what&apos;s filled in
              </button>
            </>
          ) : ai.status === "error" ? (
            <>
              <p className="text-muted">{ai.error}</p>
              <button type="button" onClick={onRefresh} className="justify-self-start text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
                Try again
              </button>
            </>
          ) : (
            <p className="text-muted">Ready when you are.</p>
          )}
        </div>

        {aiOn && (
          <p className="relative border-t border-line pt-3 text-[11px] leading-relaxed text-faint">
            Before anything is created, the AI checks the request against the client&apos;s feedback and campaign direction.
          </p>
        )}
      </div>
    </aside>
  );
}

/** Narrower screens: the AI's status on one line above the form. */
function AiStrip({ aiOn, ai, clientName, onRefresh }: { aiOn: boolean; ai: AiState; clientName: string | null; onRefresh: () => void }) {
  if (!aiOn || !clientName) return null;
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3.5 py-2.5 text-xs text-muted xl:hidden">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-[#5a0f16] text-white">
        <Spark size={11} className={ai.status === "loading" ? "animate-[ai-pulse_1s_ease-in-out_infinite]" : ""} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {ai.status === "loading"
          ? `Reading ${clientName}\u2019s history\u2026`
          : ai.status === "ready"
            ? `Kaizen AI read ${plural(ai.context.requests, "past request")}, ${plural(ai.context.angles, "angle")} and ${plural(ai.context.memory, "feedback note")}`
            : ai.status === "error"
              ? ai.error
              : "Kaizen AI is standing by"}
      </span>
      {ai.status !== "loading" && (
        <button type="button" onClick={onRefresh} className="shrink-0 text-faint hover:text-fg">
          {ai.status === "error" ? "Retry" : "Refresh"}
        </button>
      )}
    </div>
  );
}

function Done({
  numbers,
  formats,
  team,
  clientName,
  onAgain,
}: {
  numbers: number[];
  formats: Format[];
  team: Record<string, string>;
  clientName: string;
  onAgain: () => void;
}) {
  const makers = [...new Set(formats.map((f) => team[MAKER[f].role]).filter(Boolean))];
  return (
    <div className="grid justify-items-start gap-6 animate-[step-in_.4s_cubic-bezier(.2,.8,.2,1)]">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-ok-soft text-2xl text-ok ring-8 ring-ok-soft/40">✓</span>
      <div className="grid gap-2">
        <h1 className="font-heading text-[32px] leading-tight">{numbers.length === 1 ? "Request sent" : `${numbers.length} tickets created`}</h1>
        <p className="text-sm text-muted">
          {clientName} · {makers.length ? `${makers.join(" and ")} ${makers.length === 1 ? "has" : "have"} it now.` : "It's on the board, waiting for someone to pick it up."} The turnaround clock is running.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {numbers.map((n, i) => (
          <Link key={n} href={`/board?t=${n}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:border-faint">
            {formats[i] && <FormatIcon format={formats[i]} />}
            <span className="tabular text-muted">#{n}</span>
            {formats[i] && FORMAT_LABEL[formats[i]]}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Link href={`/board?t=${numbers[0]}`} className="grid h-11 place-items-center rounded-brand bg-brand px-6 text-sm font-medium text-white hover:bg-brand-hover">
          Open the board
        </Link>
        <button type="button" onClick={onAgain} className="h-11 rounded-brand border border-line px-5 text-sm text-muted hover:border-faint hover:text-fg">
          Request another
        </button>
      </div>
    </div>
  );
}
