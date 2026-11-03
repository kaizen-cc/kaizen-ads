"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { BibleQuestion, QCategory, QStage, QTurn } from "@/lib/bible-questions";
import { useParam } from "@/lib/url-state";
import { discussBibleQuestion, passBibleQuestion } from "../brand-bible-actions";

// The Bible's open questions, each with its label, who answers it (the client first where it's theirs), and a
// conversation inside the question: answer it here with its full context, pass it on, or hand it up to the execs.
// A notification links straight to one (?q=).

const CATEGORY: Record<QCategory, { name: string; cls: string }> = {
  offer: { name: "Offer", cls: "bg-brand-soft text-brand-text" },
  creative: { name: "Creative & messaging", cls: "border border-brand/30 text-brand-text" },
  media: { name: "Media buying", cls: "bg-fg text-bg" },
  business: { name: "The business", cls: "bg-surface-2 text-fg" },
};
const ROUTE: Record<QCategory, QStage[]> = { offer: ["client", "media_buyer"], creative: ["client", "head_of_creative"], media: ["media_buyer"], business: ["client", "exec"] };
const WHO: Record<QStage, string> = { client: "Client", media_buyer: "Media buyer", head_of_creative: "Head of creative", exec: "Execs", answered: "Answered" };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(iso));

function Thread({ turns }: { turns: QTurn[] }) {
  if (!turns.length) return null;
  return (
    <div className="grid gap-2">
      {turns.map((t, i) => (
        <div key={i} className={`grid gap-0.5 ${t.role === "ai" ? "" : "justify-items-end"}`}>
          <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-[13.5px] leading-relaxed ${t.role === "ai" ? "border border-line bg-surface-2/60" : t.role === "client" ? "bg-brand/15" : "bg-fg text-bg"}`}>{t.text}</p>
          <span className="px-1 text-[11px] text-faint">
            {t.role === "ai" ? "Bible keeper" : (t.by ?? (t.role === "client" ? "Client" : "Team"))} · {fmt(t.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function OpenQuestion({ q, n, clientId, slug, focused }: { q: BibleQuestion; n: number; clientId: string; slug: string; focused: boolean }) {
  const router = useRouter();
  const [turns, setTurns] = useState(q.thread);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(focused || q.thread.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const ref = useRef<HTMLLIElement>(null);
  const route = ROUTE[q.category];
  const next = route[route.indexOf(q.stage) + 1];

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);

  const send = () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setError(null);
    setTurns((t) => [...t, { role: "team", text: msg, at: new Date().toISOString(), by: "You" }]);
    setText("");
    start(async () => {
      const r = await discussBibleQuestion(clientId, slug, q.id, msg);
      if (!r.ok) {
        setError(r.error);
        setTurns((t) => t.slice(0, -1));
        setText(msg);
        return;
      }
      setTurns(r.thread);
      if (r.answered) router.refresh();
    });
  };
  const pass = (toExecs: boolean) =>
    start(async () => {
      const r = await passBibleQuestion(clientId, slug, q.id, toExecs);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  return (
    <li ref={ref} className={`grid gap-3 rounded-[18px] border bg-bg/60 p-4 md:p-5 ${focused ? "border-brand/50 ring-2 ring-brand/20" : "border-line"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="tabular grid h-8 w-8 shrink-0 place-items-center rounded-full bg-warn-soft font-heading text-[13px] text-warn">{n}</span>
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${CATEGORY[q.category].cls}`}>{CATEGORY[q.category].name}</span>
            {/* Who answers, in order, with where it is now */}
            <span className="flex flex-wrap items-center gap-1 text-[11.5px] text-faint">
              {route.map((s, i) => (
                <span key={s} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden>→</span>}
                  <span className={s === q.stage ? "rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn" : ""}>{WHO[s]}</span>
                </span>
              ))}
              {q.stage === "exec" && (
                <>
                  <span aria-hidden>→</span>
                  <span className="rounded-full bg-bad-soft px-2 py-0.5 font-medium text-bad">Execs</span>
                </>
              )}
            </span>
          </div>
          <p className="text-[14.5px] leading-relaxed">{q.question}</p>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <button key={o} type="button" onClick={() => setText((t) => (q.multi && t.trim() ? `${t.trim()}; ${o}` : o))} className="min-h-9 rounded-full border border-line px-3 text-[12.5px] text-muted hover:border-faint hover:text-fg md:min-h-7">
                  {o}
                </button>
              ))}
              {q.multi && <span className="self-center text-[11.5px] text-faint">Any that apply</span>}
            </div>
          )}
          {q.stage === "client" && <p className="text-[12px] text-faint">Waiting on the client in their portal. You can answer for them if you already know.</p>}
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="h-11 w-full shrink-0 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9 md:w-auto">
            Answer
          </button>
        )}
      </div>
      {open && (
        <div className="grid gap-3 border-t border-line pt-3 md:ml-11">
          <Thread turns={turns} />
          {busy && (
            <span className="h-1 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
            </span>
          )}
          {error && <p className="text-[12.5px] text-bad">{error}</p>}
          <div className="flex items-end gap-2 rounded-[16px] border border-line bg-bg px-3 py-2 focus-within:border-faint">
            <textarea
              data-chat
              autoFocus={focused}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Answer it here. It goes straight into the Bible."
              className="min-h-11 flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed outline-none placeholder:text-faint md:text-[13.5px]"
            />
            <button type="button" disabled={busy || !text.trim()} onClick={send} className="h-11 shrink-0 rounded-full bg-brand px-4 text-[13px] font-medium text-white disabled:opacity-40 md:h-9">
              Send
            </button>
          </div>
          <div className="flex flex-wrap gap-2 text-[12.5px]">
            {next && q.stage !== "exec" && (
              <button type="button" disabled={busy} onClick={() => pass(false)} className="min-h-11 rounded-full px-2 text-muted hover:text-fg md:min-h-8">
                Pass to {WHO[next].toLowerCase()} →
              </button>
            )}
            {q.stage !== "exec" && (
              <button type="button" disabled={busy} onClick={() => pass(true)} className="min-h-11 rounded-full px-2 text-muted hover:text-fg md:min-h-8">
                Hand up to the execs ↑
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function BibleQuestions({ questions, clientId, slug }: { questions: BibleQuestion[]; clientId: string; slug: string }) {
  const focus = useParam("q");
  const open = questions.filter((q) => q.stage !== "answered");
  const done = questions.filter((q) => q.stage === "answered" && q.answer).reverse();
  return (
    <div className="grid gap-4">
      {open.length ? (
        <ol className="grid gap-3">
          {open.map((q, i) => (
            <OpenQuestion key={q.id} q={q} n={i + 1} clientId={clientId} slug={slug} focused={focus === q.id} />
          ))}
        </ol>
      ) : (
        <p className="rounded-[18px] border border-ok/30 bg-ok-soft px-4 py-3 text-[14px] text-ok">Nothing open. The Bible is ready for review.</p>
      )}
      {done.length > 0 && (
        <details className="group rounded-[18px] border border-line bg-bg/40 px-4 py-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-muted">
            Answered <span className="tabular rounded-full bg-ok-soft px-2 py-0.5 text-[11px] text-ok">{done.length}</span>
            <span className="ml-auto text-[12px] text-faint group-open:hidden">Show</span>
          </summary>
          <ul className="grid gap-3 pt-2">
            {done.map((q) => (
              <li key={q.id} className="grid gap-1 border-t border-line pt-3 text-[13.5px]">
                <span className="text-muted">{q.question}</span>
                <span className="leading-relaxed">{q.answer}</span>
                <span className="text-[11.5px] text-faint">
                  {q.answeredVia === "client" ? "The client" : (q.answeredBy ?? "The team")}
                  {q.answeredAt && ` · ${fmt(q.answeredAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
