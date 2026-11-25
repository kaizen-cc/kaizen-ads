"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { dueLabel, type RecapLine, type RoutineReport } from "@/lib/routines-core";
import { answerAgent, sendItemDraft } from "@/app/today/actions";

// A routine's report as a designed, scannable card (Mel, Nov 25 2026): the headline, then each section as its own
// collapsible group with a count, one row per item (client chip, short verb-first title, due), each row acting where
// it sits: open the item, Send the drafted message, answer the agent's question inline, hand a staged task off. Long
// words are cut to two lines with a tap to read the rest. The same card in the recap deck (dark) and on the Overview.

type Tone = { dark: boolean };
const c = (t: Tone, dark: string, page: string) => (t.dark ? dark : page);

export function RecapCard({ report, label, at, dark = false, compact = false, headline = true }: { report: RoutineReport; label?: string; at?: string | null; dark?: boolean; compact?: boolean; headline?: boolean }) {
  const t = { dark };
  const sections = report.sections.filter((s) => s.lines.length);
  const [open, setOpen] = useState<Set<number>>(() => new Set(sections.length ? [0] : []));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [first, ...rest] = report.headline.split(/(?<=[.!?])\s/);
  const toggle = (n: number) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <section className={`grid gap-3 ${compact ? "" : "md:gap-4"}`} aria-label={label ?? "Recap"}>
      {headline && (
      <header className="grid gap-1">
        {(label || at) && <p className={`text-[10.5px] uppercase tracking-[0.16em] ${c(t, "text-white/50", "text-ink/45")}`}>{[label, at].filter(Boolean).join(" · ")}</p>}
        <p className={`font-heading leading-snug ${compact ? "text-[14.5px]" : "text-[17px] md:text-lg"} ${c(t, "text-white", "text-fg")}`}>{first}</p>
        {rest.length > 0 && <Clamp text={rest.join(" ")} t={t} className={compact ? "text-[12px]" : "text-[13px]"} />}
      </header>
      )}
      {/* Every section's count at a glance, each a jump to it */}
      {sections.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {sections.map((s, n) => (
            <button
              key={s.title}
              type="button"
              onClick={() => setOpen((o) => new Set(o).add(n))}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] ${c(t, "bg-white/10 text-white/80 hover:bg-white/15", "bg-ink/[0.06] text-ink/75 hover:bg-ink/10")}`}
            >
              <span className="tabular font-semibold">{s.lines.length}</span> {s.title}
            </button>
          ))}
        </div>
      )}
      <div className={`grid overflow-hidden rounded-2xl border ${c(t, "border-white/10 bg-white/[0.03]", "border-ink/10 bg-surface")}`}>
        {sections.map((s, n) => (
          <div key={s.title} className={n ? `border-t ${c(t, "border-white/10", "border-ink/10")}` : ""}>
            <button type="button" onClick={() => toggle(n)} aria-expanded={open.has(n)} className={`flex min-h-12 w-full items-center gap-2 px-4 text-left ${c(t, "hover:bg-white/[0.04]", "hover:bg-ink/[0.03]")}`}>
              <span className={`flex-1 text-[13.5px] font-medium ${c(t, "text-white", "text-fg")}`}>{s.title}</span>
              <span className={`tabular grid h-6 min-w-6 place-items-center rounded-full px-2 text-[11.5px] font-semibold ${c(t, "bg-white/15 text-white", "bg-ink/10 text-ink/80")}`}>{s.lines.length}</span>
              <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open.has(n) ? "rotate-180" : ""} ${c(t, "text-white/50", "text-ink/40")}`} aria-hidden>
                <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {open.has(n) && <Rows lines={s.lines} t={t} today={today} limit={compact ? 3 : 8} />}
          </div>
        ))}
      </div>
      {report.failedSources?.length ? <p className={`text-[11.5px] ${c(t, "text-white/45", "text-ink/45")}`}>Couldn&apos;t read: {report.failedSources.join("; ")}</p> : null}
    </section>
  );
}

function Rows({ lines, t, today, limit }: { lines: RecapLine[]; t: Tone; today: string; limit: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, limit);
  return (
    <ul className="grid pb-2">
      {shown.map((l, n) => (
        <Row key={`${l.itemId ?? ""}:${n}`} l={l} t={t} today={today} />
      ))}
      {lines.length > shown.length && (
        <li className="px-4 pt-1">
          <button type="button" onClick={() => setAll(true)} className={`h-10 text-[12.5px] ${c(t, "text-white/65 hover:text-white", "text-ink/60 hover:text-fg")}`}>
            {lines.length - shown.length} more
          </button>
        </li>
      )}
    </ul>
  );
}

function Row({ l, t, today }: { l: RecapLine; t: Tone; today: string }) {
  const [panel, setPanel] = useState<"send" | "answer" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const due = dueLabel(l.due, today);
  // Older reports kept "Title: the rest" in one line: the rest reads as the detail
  const [title, legacy] = l.detail || l.client ? [l.text, null] : splitLegacy(l.text);
  const detail = l.detail ?? legacy;
  const act = l.act ?? (l.href ? "open" : null);
  const btn = `inline-flex h-10 items-center rounded-full px-3.5 text-[12.5px] md:h-8 ${c(t, "border border-white/20 text-white/85 hover:bg-white/10", "border border-ink/15 text-ink/80 hover:bg-ink/[0.05]")}`;
  const primary = `inline-flex h-10 items-center rounded-full px-3.5 text-[12.5px] font-medium md:h-8 ${c(t, "bg-white text-black hover:bg-white/90", "bg-fg text-bg hover:opacity-90")}`;
  return (
    <li className={`grid gap-1.5 px-4 py-2.5 ${done ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {l.client && <span className={`max-w-[11rem] truncate rounded-full px-2 py-0.5 text-[11px] ${c(t, "bg-white/10 text-white/75", "bg-ink/[0.07] text-ink/70")}`}>{l.client}</span>}
            {l.tag && l.tag !== "certain" && <span className={`text-[10.5px] italic ${c(t, "text-white/45", "text-ink/45")}`}>{l.tag}</span>}
          </div>
          <p className={`line-clamp-2 text-[13.5px] leading-snug ${c(t, "text-white/90", "text-fg")}`}>{title}</p>
        </div>
        {due && <span className={`tabular shrink-0 pt-0.5 text-[11.5px] ${due.late ? c(t, "text-[#ff4d5e]", "text-bad") : c(t, "text-white/55", "text-ink/50")}`}>{due.text}</span>}
      </div>
      {detail && <Clamp text={detail} t={t} className="text-[12.5px]" />}
      {done ? (
        <p className={`text-[12px] ${c(t, "text-[#5be3a5]", "text-ok")}`}>{done}</p>
      ) : (
        act && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {act === "send" && l.draft && (
              <button type="button" onClick={() => setPanel(panel === "send" ? null : "send")} className={primary} aria-expanded={panel === "send"}>
                Send
              </button>
            )}
            {act === "answer" && l.itemId && (
              <button type="button" onClick={() => setPanel(panel === "answer" ? null : "answer")} className={primary} aria-expanded={panel === "answer"}>
                Answer
              </button>
            )}
            {act === "handoff" && l.href && (
              <Go href={l.href} className={primary}>
                Hand off
              </Go>
            )}
            {l.href && act !== "handoff" && (
              <Go href={l.href} className={btn}>
                Open
              </Go>
            )}
          </div>
        )
      )}
      {!done && panel === "send" && l.draft && <SendPanel l={l} t={t} onDone={setDone} />}
      {!done && panel === "answer" && l.itemId && <AnswerPanel id={l.itemId} question={l.question ?? null} t={t} onDone={setDone} />}
    </li>
  );
}

/** "Title: the rest" from a report saved before rows had their own fields */
function splitLegacy(text: string): [string, string | null] {
  const m = /^(.{6,90}?):\s+(.+)$/.exec(text);
  return m ? [m[1], m[2]] : [text, null];
}

function Go({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children} ↗
    </a>
  );
}

/** Long words cut to two lines, a tap to read the rest */
function Clamp({ text, t, className }: { text: string; t: Tone; className: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 140;
  return (
    <p className={`${className} leading-relaxed ${c(t, "text-white/65", "text-ink/65")}`}>
      <span className={more || !long ? "" : "line-clamp-2"}>{text}</span>
      {long && (
        <button type="button" onClick={() => setMore(!more)} className={`ml-1 underline-offset-2 hover:underline ${c(t, "text-white/80", "text-ink/80")}`}>
          {more ? "Less" : "More"}
        </button>
      )}
    </p>
  );
}

function SendPanel({ l, t, onDone }: { l: RecapLine; t: Tone; onDone: (s: string) => void }) {
  const d = l.draft!;
  const [text, setText] = useState(d.text);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const gmail = d.kind === "email" ? `https://mail.google.com/mail/?view=cm&fs=1${d.to ? `&to=${encodeURIComponent(d.to)}` : ""}${d.subject ? `&su=${encodeURIComponent(d.subject)}` : ""}&body=${encodeURIComponent(text)}` : null;
  const box = `w-full rounded-xl border p-3 text-[13px] leading-relaxed outline-none ${c(t, "border-white/15 bg-black/30 text-white focus:border-white/40", "border-ink/15 bg-bg text-fg focus:border-ink/40")}`;
  const btn = `inline-flex h-10 items-center rounded-full px-3.5 text-[12.5px] md:h-8 ${c(t, "border border-white/20 text-white/85 hover:bg-white/10", "border border-ink/15 text-ink/80 hover:bg-ink/[0.05]")}`;
  const primary = `inline-flex h-10 items-center rounded-full px-3.5 text-[12.5px] font-medium disabled:opacity-50 md:h-8 ${c(t, "bg-white text-black hover:bg-white/90", "bg-fg text-bg hover:opacity-90")}`;
  return (
    <div className="grid gap-2 pt-1">
      <p className={`text-[11.5px] ${c(t, "text-white/50", "text-ink/50")}`}>
        {d.kind === "email" ? `Email${d.to ? ` to ${d.to}` : ""}${d.subject ? ` · ${d.subject}` : ""}` : `Slack${d.channel ? ` · ${d.channel.startsWith("internal") ? d.channel : `#${d.channel}`}` : ""}`}
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))} className={box} aria-label="The drafted message" />
      <div className="flex flex-wrap gap-1.5">
        {d.kind === "slack" && d.canPost && l.itemId && (
          <button
            type="button"
            disabled={pending || !text.trim()}
            onClick={() =>
              start(async () => {
                const r = await sendItemDraft(l.itemId!, text);
                if (r.ok) onDone("Sent in Slack as you ✓");
                else setErr(r.error);
              })
            }
            className={primary}
          >
            {pending ? "Sending…" : "Send in Slack"}
          </button>
        )}
        {gmail && (
          <a href={gmail} target="_blank" rel="noreferrer" className={primary}>
            Open in Gmail ↗
          </a>
        )}
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard?.writeText(text).catch(() => null);
            setCopied(true);
          }}
          className={btn}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {err && <p className="text-[12px] text-[#ff4d5e]">{err}</p>}
    </div>
  );
}

function AnswerPanel({ id, question, t, onDone }: { id: string; question: string | null; t: Tone; onDone: (s: string) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await answerAgent(id, text);
      if (r.ok) onDone("Answered: the agent works it tonight ✓");
      else setErr(r.error);
    });
  return (
    <form
      className="grid gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {question && <p className={`text-[12.5px] ${c(t, "text-white/75", "text-ink/75")}`}>{question}</p>}
      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your answer"
          aria-label="Your answer"
          className={`h-11 min-w-0 flex-1 rounded-full border px-4 text-[13.5px] outline-none md:h-9 ${c(t, "border-white/15 bg-black/30 text-white placeholder:text-white/35 focus:border-white/40", "border-ink/15 bg-bg text-fg placeholder:text-ink/35 focus:border-ink/40")}`}
        />
        <button type="submit" disabled={pending || !text.trim()} className={`h-11 shrink-0 rounded-full px-4 text-[13px] font-medium disabled:opacity-50 md:h-9 ${c(t, "bg-white text-black", "bg-fg text-bg")}`}>
          {pending ? "…" : "Answer"}
        </button>
      </div>
      {err && <p className="text-[12px] text-[#ff4d5e]">{err}</p>}
    </form>
  );
}
