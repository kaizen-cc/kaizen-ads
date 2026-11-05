"use client";

import { useEffect, useRef, useState } from "react";
import type { SuggestionDraft, TalkTurn } from "@/lib/suggestions";
import type { Draft } from "./draft";
import { talkRequest } from "./actions";
import { Spark } from "./parts";
import type { PreviewItem } from "./start-flow";

/**
 * "Talk it through": the team member tells the strategist the idea, it asks only what it needs (one or two questions
 * at a time) and the brief builds beside the conversation. "Use this brief" fills the request and opens it at Review,
 * where every field can still be changed. Kept in this browser per client, so a refresh doesn't lose the conversation.
 */

type Saved = { turns: TalkTurn[]; draft: SuggestionDraft | null; ready: boolean; patch: Partial<Draft> | null; open?: { questions: string[]; conflicts: string[] } | null };
const key = (clientId: string) => `kz:request-chat:${clientId}`;
const FMT = { image: "image", video: "video", carousel: "carousel" } as const;

export function RequestChat({ clientId, clientName, onUse, onPreview, onBack }: { clientId: string; clientName: string; onUse: (patch: Partial<Draft>) => void; /** Before the first full brief: its quick preview */ onPreview: (item: PreviewItem) => void; onBack: () => void }) {
  const [state, setState] = useState<Saved>({ turns: [], draft: null, ready: false, patch: null });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key(clientId));
      if (raw) {
        const saved = JSON.parse(raw) as Saved;
        void Promise.resolve().then(() => setState(saved));
      }
    } catch {}
  }, [clientId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key(clientId), JSON.stringify(state));
    } catch {}
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state, clientId]);

  const [phase, setPhase] = useState<"checking" | "writing" | null>(null);
  const preview = (turns: TalkTurn[]) =>
    onPreview({ key: `talk-${turns.length}`, source: { kind: "talk", turns }, from: { kicker: "Talked through", label: turns.filter((x) => x.role === "user")[0]?.text.slice(0, 120) ?? "Your idea" }, progressLabel: "request chat" });
  const send = async (force = false) => {
    // Nothing written yet: "write it" opens the quick preview first, and the full brief follows what's agreed there
    if (force && !state.draft) return preview(state.turns);
    const t = force ? "Go ahead and write it with what we have." : text.trim();
    if (!t || busy) return;
    const turns: TalkTurn[] = [...state.turns, { role: "user", text: t }];
    setState((s) => ({ ...s, turns }));
    if (!force) setText("");
    setBusy(true);
    setPhase(force ? "writing" : "checking");
    setError(null);
    const r = await talkRequest(clientId, turns, state.draft, force, !state.draft).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setBusy(false);
    setPhase(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setState((s) => ({
      turns: [...turns, { role: "ai", text: r.reply }],
      draft: r.draft ?? s.draft,
      ready: r.ready,
      patch: r.patch ?? s.patch,
      open: r.building || r.previewReady ? null : { questions: r.questions, conflicts: r.conflicts },
    }));
    if (r.previewReady) preview([...turns, { role: "ai", text: r.reply }]);
  };

  const use = () => {
    if (!state.patch) return;
    try {
      sessionStorage.removeItem(key(clientId));
    } catch {}
    onUse({ ...state.patch, origin: { kind: "brief", label: "Talked through with the strategist" } });
  };

  const d = state.draft;
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      {/* The conversation */}
      <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-[20px] border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-white">
              <Spark size={12} />
            </span>
            Strategist
          </span>
          <button type="button" onClick={onBack} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-8">
            ← Other ways
          </button>
        </div>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 py-4">
          {state.turns.length === 0 && (
            <div className="grid gap-2 rounded-[14px] bg-surface-2/60 p-4 text-[14px] leading-relaxed text-muted">
              <p className="font-medium text-fg">What do you want to make for {clientName}?</p>
              <p>Say it the way you&rsquo;d say it to the team: the idea, the format, how many, anything it has to include. I&rsquo;ll ask only what I need and build the brief from their Bible, numbers and assets as we go.</p>
              <div className="flex flex-wrap gap-2 pt-1">
                {["A UGC video answering the price objection", "3 statics for the new offer", "A carousel showing how it works, step by step"].map((x) => (
                  <button key={x} type="button" onClick={() => setText(x)} className="min-h-10 rounded-full border border-line px-3 text-[12.5px] text-muted hover:text-fg md:min-h-8">
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
          {state.turns.map((t, i) => (
            <div key={i} className={`max-w-[88%] whitespace-pre-wrap rounded-[16px] px-4 py-2.5 text-[14px] leading-relaxed ${t.role === "user" ? "justify-self-end bg-fg text-bg" : "justify-self-start bg-surface-2 text-fg"}`}>
              {t.text}
            </div>
          ))}
          {busy && <div className="justify-self-start rounded-[16px] bg-surface-2 px-4 py-2.5 text-[14px] text-muted">{phase === "writing" ? "Writing the brief…" : "Reading it through…"}</div>}
          {error && <p className="rounded-[12px] border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
          <div ref={endRef} />
        </div>
        <div className="flex items-end gap-2 border-t border-line p-3">
          <textarea
            data-chat
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={state.turns.length ? "Answer, or add anything…" : "Describe the creative you want…"}
            className="min-h-11 flex-1 resize-none rounded-[14px] border border-line bg-bg px-4 py-2.5 text-[16px] outline-none placeholder:text-faint focus:border-brand-text/60 md:text-[14.5px]"
          />
          <button type="button" onClick={() => void send()} disabled={!text.trim() || busy} className="h-11 shrink-0 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-50">
            Send
          </button>
        </div>
      </section>

      {/* The brief as it stands */}
      <aside className="grid min-w-0 content-start gap-3 rounded-[20px] border border-line bg-surface p-4 lg:sticky lg:top-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">The brief so far</p>
        {d ? (
          <>
            <p className="font-heading text-[18px] leading-snug">{d.title}</p>
            <dl className="grid gap-2 text-[13px]">
              <div>
                <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Making</dt>
                <dd>{d.formats.map((f) => `${f.new} new${f.variations ? ` + ${f.variations} var.` : ""} ${FMT[f.format]}${f.new + f.variations === 1 ? "" : "s"}`).join(" · ") || "–"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Angle</dt>
                <dd>{d.angle || "–"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Audience</dt>
                <dd className="line-clamp-3 text-muted">{d.audience || "–"}</dd>
              </div>
              {d.concepts.length > 0 && (
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Concepts</dt>
                  <dd className="grid gap-1.5 pt-1">
                    {d.concepts.map((c, i) => (
                      <span key={i} className="block rounded-[10px] bg-surface-2/70 px-3 py-2">
                        <b className="font-medium">{c.name}</b>
                        <span className="block text-[12.5px] text-muted">&ldquo;{c.hook}&rdquo;</span>
                      </span>
                    ))}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Brief</dt>
                <dd className="line-clamp-6 whitespace-pre-wrap text-muted">{d.brief}</dd>
              </div>
            </dl>
            <button type="button" onClick={use} className={`min-h-11 rounded-full px-4 text-[14px] font-medium ${state.ready ? "bg-brand text-white" : "border border-line text-fg hover:border-faint"}`}>
              {state.ready ? "Use this brief →" : "Use it as it is →"}
            </button>
            <p className="text-[12px] text-faint">Every field can still be changed before it goes out.</p>
          </>
        ) : state.open && (state.open.questions.length > 0 || state.open.conflicts.length > 0) ? (
          <div className="grid gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">To settle before it&rsquo;s written</p>
            {state.open.conflicts.length > 0 && (
              <ul className="grid gap-1.5 text-[13px]">
                {state.open.conflicts.map((c, i) => (
                  <li key={i} className="rounded-[10px] border border-warn/30 bg-warn-soft/40 px-3 py-2">{c}</li>
                ))}
              </ul>
            )}
            {state.open.questions.length > 0 && (
              <ol className="grid list-decimal gap-1.5 pl-5 text-[13px] text-muted">
                {state.open.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            )}
            <button type="button" disabled={busy} onClick={() => void send(true)} className="min-h-11 rounded-full border border-line px-4 text-[13.5px] text-muted hover:text-fg disabled:opacity-60">
              Write it with what we have
            </button>
          </div>
        ) : state.turns.length > 1 ? (
          <div className="grid gap-2">
            <p className="text-[13.5px] text-muted">Everything&rsquo;s clear. See the quick preview, change anything, then the full brief is written from it.</p>
            <button type="button" disabled={busy} onClick={() => preview(state.turns)} className="min-h-11 rounded-full bg-brand px-4 text-[14px] font-medium text-white disabled:opacity-60">
              See the quick preview
            </button>
          </div>
        ) : (
          <p className="text-[13.5px] text-muted">{phase === "writing" ? "Writing the brief…" : "It builds here once everything's clear."}</p>
        )}
      </aside>
    </div>
  );
}
