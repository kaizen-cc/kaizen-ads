"use client";

import { useState } from "react";
import { INTAKE_FORM_URL, type Deck, type Reactions, type Section } from "@/lib/presentation-types";

// The client presentation, as the client sees it (and the team previews it): a cover, then one card per part of how
// we see them, each with "Spot on" / "Not quite", how we launch, the few things only they can tell us, and approve.

type Handlers = {
  onReact?: (section: Section, verdict: "right" | "off", note: string) => Promise<void>;
  onAnswer?: (question: string, answer: string) => Promise<void>;
  onLaunch?: (choice: "engagement_first" | "wait") => Promise<void>;
  onApprove?: () => Promise<void>;
};

const FORMAT = { image: "Image", video: "Video", carousel: "Carousel" } as const;

export function PresentationDeck({ brand, deck, reactions, approved, readOnly = false, intake, ...h }: { brand: string; deck: Deck; reactions: Reactions; approved: boolean; readOnly?: boolean; /** Written without their intake form: a way to send it, with their Client ID */ intake?: { clientId: number | null } } & Handlers) {
  const locked = readOnly || approved;
  const offCount = Object.values(reactions.sections ?? {}).filter((r) => r?.verdict === "off").length;
  return (
    <div className="grid gap-4 md:gap-5">
      {/* Cover */}
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-8 pt-9 md:px-10 md:pb-12 md:pt-14">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/30 blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-40 left-1/4 -z-10 h-80 w-80 rounded-full bg-[#5b8def]/15 blur-[120px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">Kaizen Marketing · How we see {brand}</p>
        <h1 className="mt-4 font-display text-[34px] leading-[1.04] tracking-tight md:text-[56px]">{deck.headline}</h1>
        <p className="mt-5 max-w-2xl text-[15.5px] leading-relaxed text-muted md:text-[17px]">{deck.intro}</p>
        {!readOnly && !approved && <p className="mt-6 text-[12.5px] text-faint">About five minutes · tap Spot on or Not quite on each part</p>}
      </section>

      {intake && <IntakeNudge clientId={intake.clientId} />}

      <Card n={1} title="Who you are" section="brand" reactions={reactions} locked={locked} onReact={h.onReact}>
        <p className="font-heading text-[20px] leading-snug md:text-[24px]">{deck.brand.statement}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {deck.brand.different.map((d) => (
            <span key={d} className="rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-[13.5px]">
              {d}
            </span>
          ))}
        </div>
      </Card>

      <Card n={2} title="What you want from ads" section="goal" reactions={reactions} locked={locked} onReact={h.onReact}>
        <p className="font-heading text-[20px] leading-snug md:text-[24px]">{deck.goal.line}</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand/10 px-3.5 py-1.5 text-[13.5px] text-brand-text">
          <span aria-hidden>◎</span> {deck.goal.measure}
        </p>
      </Card>

      <Card n={3} title="Who we're speaking to" section="audiences" reactions={reactions} locked={locked} onReact={h.onReact}>
        <div className="grid gap-3 md:grid-cols-3">
          {deck.audiences.map((a) => (
            <div key={a.name} className="grid content-start gap-2 rounded-[18px] border border-line bg-bg p-4">
              <p className="font-heading text-[16px]">{a.name}</p>
              <p className="text-[13.5px] leading-relaxed text-muted">{a.who}</p>
              <p className="text-[13.5px] leading-relaxed">
                <span className="text-faint">Wants: </span>
                {a.wants}
              </p>
              <p className="mt-1 border-l-2 border-brand pl-3 text-[14px] italic leading-relaxed">&ldquo;{a.hook}&rdquo;</p>
            </div>
          ))}
        </div>
      </Card>

      <Card n={4} title="How you sound" section="voice" reactions={reactions} locked={locked} onReact={h.onReact}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {deck.voice.words.map((w) => (
            <span key={w} className="font-display text-[30px] leading-tight tracking-tight md:text-[40px]">
              {w}
            </span>
          ))}
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">{deck.voice.sounds}</p>
        {deck.voice.never.length > 0 && (
          <div className="mt-4 grid gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">We&rsquo;ll never</p>
            {deck.voice.never.map((x) => (
              <p key={x} className="flex gap-2 text-[14px]">
                <span aria-hidden className="text-brand-text">×</span> {x}
              </p>
            ))}
          </div>
        )}
      </Card>

      <Card n={5} title="The first campaigns we'd run" section="ideas" reactions={reactions} locked={locked} onReact={h.onReact}>
        <div className="grid gap-3 md:grid-cols-2">
          {deck.ideas.map((x, i) => (
            <div key={x.title} className="grid content-start gap-2 rounded-[18px] border border-line bg-bg p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="tabular text-[11px] font-semibold text-faint">0{i + 1}</span>
                <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">{FORMAT[x.format]}</span>
              </div>
              <p className="font-heading text-[16.5px] leading-snug">{x.title}</p>
              <p className="text-[14px] leading-relaxed">&ldquo;{x.hook}&rdquo;</p>
              <p className="text-[13px] leading-relaxed text-muted">{x.why}</p>
            </div>
          ))}
        </div>
      </Card>

      <Launch deck={deck} reactions={reactions} locked={locked} onLaunch={h.onLaunch} />

      {deck.questions.length > 0 && <Questions deck={deck} reactions={reactions} locked={locked} onAnswer={h.onAnswer} />}

      {/* Approve */}
      <section className="grid gap-3 rounded-[24px] border border-line bg-surface p-5 md:p-8">
        {approved ? (
          <p className="font-heading text-[18px] text-ok">✓ Approved. Thank you! The team is on it, and your first creative is next.</p>
        ) : (
          <>
            <p className="font-heading text-[20px]">Is this you?</p>
            <p className="text-[14px] leading-relaxed text-muted">
              {offCount ? `You marked ${offCount} part${offCount > 1 ? "s" : ""} as not quite: we'll fix ${offCount > 1 ? "those" : "that"} with what you told us.` : "Approve it and we start on your first creative."}
            </p>
            {!readOnly && (
              <Busy onClick={h.onApprove} className="h-12 justify-self-start rounded-full bg-brand px-6 text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                {offCount ? "Approve with my notes" : "Yes, this is us"}
              </Busy>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function IntakeNudge({ clientId }: { clientId: number | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="grid gap-3 rounded-[24px] border border-brand/40 bg-brand/[0.07] p-5 md:flex md:items-center md:justify-between md:gap-6 md:p-6">
      <div className="grid gap-1">
        <p className="font-heading text-[16.5px]">We&rsquo;re still missing your intake form</p>
        <p className="text-[14px] leading-relaxed text-muted">Everything below is our best read without it. Ten minutes on the form sharpens all of it.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {clientId != null && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(String(clientId)).then(() => setCopied(true));
            }}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-line bg-bg px-4 text-[13.5px]"
            title="It asks for this: tap to copy"
          >
            <span className="text-faint">Your Client ID</span>
            <span className="tabular font-heading text-[15px]">{clientId}</span>
            <span className="text-[12px] text-brand-text">{copied ? "Copied" : "Copy"}</span>
          </button>
        )}
        <a href={INTAKE_FORM_URL} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover">
          Fill in the intake form ↗
        </a>
      </div>
    </section>
  );
}

function Busy({ onClick, className, children }: { onClick?: () => Promise<void>; className: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy || !onClick}
      className={className}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick?.();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "One moment…" : children}
    </button>
  );
}

function Card({ n, title, section, reactions, locked, onReact, children }: { n: number; title: string; section: Section; reactions: Reactions; locked: boolean; onReact?: Handlers["onReact"]; children: React.ReactNode }) {
  const r = reactions.sections?.[section];
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(r?.note ?? "");
  return (
    <section className={`grid gap-4 rounded-[24px] border bg-surface p-5 md:p-8 ${r?.verdict === "off" ? "border-warn/50" : r?.verdict === "right" ? "border-ok/40" : "border-line"}`}>
      <p className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
        <span className="tabular grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-[11px] tracking-normal text-muted">{n}</span>
        {title}
      </p>
      <div>{children}</div>
      <div className="grid gap-2.5 border-t border-line pt-4">
        {r && !open && (
          <p className={`text-[13px] ${r.verdict === "right" ? "text-ok" : "text-warn"}`}>
            {r.verdict === "right" ? "✓ Spot on" : `Not quite: ${r.note || "no note"}`} <span className="text-faint">· {r.by}</span>
          </p>
        )}
        {!locked && !open && (
          <div className="flex flex-wrap gap-2">
            <Busy onClick={onReact && (() => onReact(section, "right", ""))} className={`h-11 rounded-full px-5 text-[14px] ${r?.verdict === "right" ? "bg-ok text-white" : "border border-line hover:border-faint"}`}>
              Spot on
            </Busy>
            <button type="button" onClick={() => setOpen(true)} className={`h-11 rounded-full px-5 text-[14px] ${r?.verdict === "off" ? "bg-warn text-white" : "border border-line hover:border-faint"}`}>
              Not quite
            </button>
          </div>
        )}
        {open && (
          <div className="grid gap-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
              rows={3}
              placeholder="What would you change? Say it however it comes."
              className="w-full resize-none rounded-[14px] border border-line bg-bg px-3.5 py-3 text-[15px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60"
            />
            <div className="flex gap-2">
              <Busy
                onClick={
                  onReact &&
                  (async () => {
                    await onReact(section, "off", note.trim());
                    setOpen(false);
                  })
                }
                className="h-11 rounded-full bg-fg px-5 text-[14px] text-bg disabled:opacity-40"
              >
                Save
              </Busy>
              <button type="button" onClick={() => setOpen(false)} className="h-11 rounded-full px-4 text-[14px] text-muted hover:text-fg">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Launch({ deck, reactions, locked, onLaunch }: { deck: Deck; reactions: Reactions; locked: boolean; onLaunch?: Handlers["onLaunch"] }) {
  const picked = reactions.launch?.choice;
  const options = [
    { key: "engagement_first" as const, title: "Live within 48 hours", body: deck.launch.fast, tag: "Recommended" },
    { key: "wait" as const, title: "Wait for conversion campaigns", body: deck.launch.wait, tag: null },
  ];
  return (
    <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-5 md:p-8">
      <p className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
        <span className="tabular grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-[11px] tracking-normal text-muted">6</span>
        Getting you live
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {options.map((x) => {
          const on = picked === x.key;
          return (
            <button
              key={x.key}
              type="button"
              disabled={locked || !onLaunch}
              onClick={() => onLaunch?.(x.key)}
              className={`grid content-start gap-2 rounded-[18px] border p-4 text-left transition-colors disabled:cursor-default ${on ? "border-brand bg-brand/10" : "border-line bg-bg enabled:hover:border-faint"}`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-heading text-[16.5px]">{x.title}</span>
                {on ? <span className="text-[12px] text-brand-text">✓ Chosen</span> : x.tag && <span className="rounded-full bg-brand/15 px-2.5 py-0.5 text-[11px] text-brand-text">{x.tag}</span>}
              </span>
              <span className="text-[14px] leading-relaxed text-muted">{x.body}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Questions({ deck, reactions, locked, onAnswer }: { deck: Deck; reactions: Reactions; locked: boolean; onAnswer?: Handlers["onAnswer"] }) {
  return (
    <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-5 md:p-8">
      <p className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
        <span className="tabular grid h-6 w-6 place-items-center rounded-full bg-surface-2 text-[11px] tracking-normal text-muted">7</span>
        A few things only you can tell us
      </p>
      <div className="grid gap-5">
        {deck.questions.map((q) => (
          <Question key={q.question} q={q} saved={reactions.answers?.[q.question]?.answer ?? ""} locked={locked} onAnswer={onAnswer} />
        ))}
      </div>
    </section>
  );
}

function Question({ q, saved, locked, onAnswer }: { q: { question: string; why: string }; saved: string; locked: boolean; onAnswer?: Handlers["onAnswer"] }) {
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved.trim();
  return (
    <div className="grid gap-2">
      <p className="text-[15.5px] leading-snug">{q.question}</p>
      <p className="text-[12.5px] text-faint">{q.why}</p>
      {locked ? (
        <p className="text-[14px] text-muted">{saved || "Not answered"}</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Your answer"
            className="w-full resize-none rounded-[14px] border border-line bg-bg px-3.5 py-3 text-[15px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60"
          />
          {dirty && (
            <Busy onClick={onAnswer && (() => onAnswer(q.question, text.trim()))} className="h-10 justify-self-start rounded-full bg-fg px-4 text-[13.5px] text-bg disabled:opacity-40">
              Save answer
            </Busy>
          )}
          {!dirty && saved && <p className="text-[12px] text-ok">✓ Saved</p>}
        </>
      )}
    </div>
  );
}
