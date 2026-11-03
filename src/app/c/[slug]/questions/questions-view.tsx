"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { QCategory, QTurn } from "@/lib/bible-questions";
import { answerQuestion, dontKnow } from "./actions";

// One card per question: a tap on an option (or a few, where any apply), or a line in their own words. "I don't know"
// is always there and hands it to our team. Each answer goes straight into their brand plan.

type Q = { id: string; question: string; category: QCategory; options: string[]; multi: boolean; thread: QTurn[] };
const ABOUT: Record<QCategory, string> = { offer: "Your offers", creative: "Your brand and claims", media: "Your ads", business: "Your business" };

function Card({ q, slug, n, onDone }: { q: Q; slug: string; n: number; onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState(q.thread);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const toggle = (o: string) => setPicked((p) => (q.multi ? (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]) : [o]));
  const answer = [picked.join("; "), text.trim()].filter(Boolean).join(". ");
  const send = () =>
    start(async () => {
      setError(null);
      const r = await answerQuestion(slug, q.id, answer);
      if (!r.ok) return setError(r.error);
      setTurns(r.thread);
      if (r.answered) onDone();
      else {
        setPicked([]);
        setText("");
      }
    });
  return (
    <li className="grid gap-4 rounded-[24px] border border-line bg-surface p-5 md:p-7">
      <div className="flex items-baseline gap-3">
        <span className="tabular font-heading text-[13px] text-brand-text">{String(n).padStart(2, "0")}</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{ABOUT[q.category]}</span>
      </div>
      <p className="font-heading text-[19px] leading-snug md:text-[21px]">{q.question}</p>
      {q.options.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {q.options.map((o) => {
            const on = picked.includes(o);
            return (
              <button key={o} type="button" onClick={() => toggle(o)} className={`flex min-h-12 items-center gap-3 rounded-[16px] border px-4 text-left text-[14.5px] transition-colors ${on ? "border-brand bg-brand/10" : "border-line hover:border-faint"}`}>
                <span className={`grid h-5 w-5 shrink-0 place-items-center border-2 ${q.multi ? "rounded-[6px]" : "rounded-full"} ${on ? "border-brand bg-brand text-white" : "border-faint"}`}>{on && <span className="text-[11px] leading-none">✓</span>}</span>
                <span className="min-w-0">{o}</span>
              </button>
            );
          })}
        </div>
      )}
      {q.multi && q.options.length > 0 && <p className="-mt-2 text-[12.5px] text-faint">Pick any that apply.</p>}
      {turns.length > 0 && (
        <div className="grid gap-2">
          {turns.map((t, i) => (
            <p key={i} className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-[14px] leading-relaxed ${t.role === "ai" ? "border border-line bg-surface-2/60" : "justify-self-end bg-brand/15"}`}>
              {t.text}
            </p>
          ))}
        </div>
      )}
      <textarea
        data-chat
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={1}
        placeholder={q.options.length ? "Anything to add? (optional)" : "Your answer, in your own words"}
        className="min-h-12 w-full resize-none rounded-[16px] border border-line bg-bg px-4 py-3 text-[16px] leading-relaxed outline-none placeholder:text-faint focus:border-brand-text/60 md:text-[14.5px]"
      />
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !answer} onClick={send} className="h-12 rounded-full bg-brand px-6 text-[15px] font-medium text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save my answer"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              await dontKnow(slug, q.id);
              onDone();
            })
          }
          className="h-12 rounded-full px-4 text-[14px] text-muted hover:text-fg"
        >
          I don&rsquo;t know, ask your team
        </button>
      </div>
    </li>
  );
}

export function QuestionsView({ slug, brand, firstName, open, answered }: { slug: string; brand: string; firstName: string | null; open: Q[]; answered: number }) {
  const [left, setLeft] = useState(open);
  const done = answered + open.length - left.length;
  return (
    <div className="grid gap-5">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-7 pt-8 md:px-10 md:pb-10 md:pt-12">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/30 blur-[120px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Kaizen Marketing · {brand}</p>
        <h1 className="mt-2 font-heading text-[28px] leading-[1.08] tracking-tight md:text-[42px]">{left.length ? `${firstName ? `${firstName}, a` : "A"} few questions only you can answer` : "That's everything, thank you"}</h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          {left.length
            ? `${left.length} left. Each answer goes straight into your brand plan, so your ads say exactly what's true. Not sure? Tap "I don't know" and our team takes it.`
            : `Your answers${done ? ` (${done})` : ""} are in your brand plan. We'll take it from here.`}
        </p>
      </section>
      {left.length > 0 && (
        <ol className="grid gap-4">
          {left.map((q, i) => (
            <Card key={q.id} q={q} slug={slug} n={i + 1} onDone={() => setLeft((l) => l.filter((x) => x.id !== q.id))} />
          ))}
        </ol>
      )}
      <Link href={`/c/${slug}`} className="justify-self-start text-[14px] text-muted hover:text-fg">
        ← Back to your portal
      </Link>
    </div>
  );
}
