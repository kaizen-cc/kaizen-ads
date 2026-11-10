"use client";

import { useEffect, useRef, useState } from "react";
import type { SuggestionDraft, TalkTurn } from "@/lib/suggestions";
import type { QuickBrief } from "@/lib/quick-brief";
import { linksIn } from "@/lib/saved-references";
import { inlineAsks, talkStep, wantsWrite } from "@/lib/talk-flow";
import type { Draft } from "./draft";
import { talkRequest, type TalkResult } from "./actions";
import { Spark } from "./parts";
import { AiProgress } from "@/components/ai-progress";
import { LinkCards } from "@/components/link-refs";
import type { PreviewItem } from "./start-flow";
import { AttachButton, AttachedFiles, useBriefFiles, useFileDrop } from "@/components/brief-attach";
import { MarketRefCards } from "@/components/market-ref-cards";
import { briefFileUrl, fileMention, type BriefFile } from "@/lib/brief-files";
import type { Reference } from "@/lib/ai-tools/motion";

/**
 * "Talk it through": the team member tells the strategist the idea, and it asks only what it needs, inside the
 * conversation (its questions are part of its message, answered by typing or with a quick pick). The moment it has
 * enough, or the person says "write it", the full brief is written right there (its progress in the chat) and the
 * request opens in Ready to send, where every field can still be changed (src/lib/talk-flow.ts). The quick preview
 * is optional ("Preview first"). Kept in this browser per client, so a refresh or the back button doesn't lose the
 * conversation; sending the request (or "New conversation") clears it.
 *
 * One brief, refined: coming back and saying more refines the same brief (same title and concept unless asked), and
 * "go back to the brief" brings the preview back as it stood. A pasted link is a reference for this brief, never a new
 * topic: it's attached (with a preview card) and the brief stays.
 */

type Saved = {
  turns: TalkTurn[];
  draft: SuggestionDraft | null;
  ready: boolean;
  patch: Partial<Draft> | null;
  open?: { questions: string[]; conflicts: string[] } | null;
  /** The questions and conflicts the strategist asked, by the index of its message: shown inside that message */
  asks?: Record<number, { questions: string[]; conflicts: string[] }>;
  /** Every version of the quick preview, oldest first, and the one shown */
  previews?: QuickBrief[];
  at?: number;
  /** Earlier full drafts, oldest first (the current one is draft) */
  drafts?: { draft: SuggestionDraft; patch: Partial<Draft> | null }[];
  /** Links pasted as references for this brief (and files added to the conversation) */
  refs?: string[];
  /** Live market ads the strategist brought up, by the index of its message */
  market?: Record<number, Reference[]>;
};
const key = (clientId: string) => `kz:request-chat:${clientId}`;
const EVENT = "kz:talk-preview";

/** The quick preview of a talk, as it arrives and as it's edited: kept by the conversation (src/components/quick-brief-sheet.tsx onBriefChange) */
export function recordTalkPreview(clientId: string, brief: QuickBrief) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { clientId, brief } }));
}

const GO_BACK = /^\s*(please\s+)?(go|take (me|us)|bring (it|me))\s+back(\s+to\s+(the|my|our|that|this)\s+(brief|preview|version|idea))?\s*[.!]*\s*$|^\s*(restore|undo)\b|\bgo back to the (brief|preview)\b/i;
const sameBrief = (a: QuickBrief | undefined, b: QuickBrief) => Boolean(a) && JSON.stringify(a) === JSON.stringify(b);

/** What the page's Continue button does here: write the brief from the conversation (whatever is typed goes with it) */
export type ChatHandle = { canContinue: boolean; continue: () => void };

export function RequestChat({ clientId, clientName, onUse, onPreview, onBack, onHandle }: { clientId: string; clientName: string; onUse: (patch: Partial<Draft>) => void; /** Before the first full brief: its quick preview */ onPreview: (item: PreviewItem) => void; onBack: () => void; /** The page's Continue: told when it can go, and what it does */ onHandle?: (h: ChatHandle) => void }) {
  const [state, setState] = useState<Saved>({ turns: [], draft: null, ready: false, patch: null });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The next preview that arrives is a new version (something was said since); edits after it change that version
  const nextIsNew = useRef(false);
  // Files added to the next message (pictures, videos, audio, PDFs), and dropping them on the conversation
  const files = useBriefFiles(clientId);
  const drop = useFileDrop((f) => void files.add(f));

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
  }, [state, clientId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.turns.length, busy]);

  // The preview sheet hands back the preview as it stands: a new version when it was refined, otherwise the edit
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ clientId: string; brief: QuickBrief }>).detail;
      if (!d || d.clientId !== clientId) return;
      setState((s) => {
        const list = s.previews ?? [];
        const at = s.at ?? list.length - 1;
        if (sameBrief(list[at], d.brief)) return s;
        if (nextIsNew.current || !list.length) {
          nextIsNew.current = false;
          const next = [...list, d.brief].slice(-12);
          return { ...s, previews: next, at: next.length - 1 };
        }
        return { ...s, previews: list.map((b, i) => (i === at ? d.brief : b)) };
      });
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [clientId]);

  const previews = state.previews ?? [];
  const at = Math.min(state.at ?? previews.length - 1, previews.length - 1);
  const current = at >= 0 ? previews[at] : null;
  const refs = state.refs ?? [];

  const [phase, setPhase] = useState<"checking" | "writing" | null>(null);
  /** fresh: something was said since the version shown, so it comes back refined as the next version of the same brief */
  const preview = (turns: TalkTurn[], fresh: boolean, added: string[] = []) => {
    const refs = [...new Set([...(state.refs ?? []), ...added])];
    if (current && fresh) nextIsNew.current = true;
    onPreview({
      key: `talk-${turns.length}-${at}${fresh ? "-r" : ""}`,
      source: { kind: "talk", turns, current: current ? { ...current, refs: [...new Set([...(current.refs ?? []), ...refs])] } : null, refs, refine: fresh },
      from: { kicker: "Talked through", label: turns.filter((x) => x.role === "user")[0]?.text.slice(0, 120) ?? "Your idea" },
      progressLabel: "request chat",
    });
  };

  const say = (turns: TalkTurn[], reply: string) => setState((s) => ({ ...s, turns: [...turns, { role: "ai", text: reply }] }));

  /** Links (and files) as references for this brief: on the preview shown, the draft and the request */
  const addRefs = (urls: string[]) =>
    setState((s) => ({
      ...s,
      refs: [...new Set([...(s.refs ?? []), ...urls])].slice(0, 10),
      previews: (s.previews ?? []).map((b, i) => (i === Math.min(s.at ?? (s.previews ?? []).length - 1, (s.previews ?? []).length - 1) ? { ...b, refs: [...new Set([...(b.refs ?? []), ...urls])].slice(0, 10) } : b)),
      draft: s.draft ? { ...s.draft, refs: [...new Set([...(s.draft.refs ?? []), ...urls])].slice(0, 10) } : s.draft,
      patch: s.patch ? { ...s.patch, refs: [...new Set([...(s.patch.refs ?? "").split(/\s+/).filter(Boolean), ...urls])].join("\n") } : s.patch,
    }));

  // Written: the request opens in Ready to send (the conversation is kept, so back returns to it)
  const land = (patch: Partial<Draft>) => onUse({ ...patch, origin: { kind: "brief", label: "Talked through with the strategist" } });

  /** Keeps a turn's answer: the strategist's message (its questions inline), the request as it stands */
  const keep = (turns: TalkTurn[], r: Extract<TalkResult, { ok: true }>) =>
    setState((s) => {
      // A new full draft: the one before it is kept, so it can be brought back
      const drafts = r.draft && s.draft ? [...(s.drafts ?? []), { draft: s.draft, patch: s.patch }].slice(-8) : (s.drafts ?? []);
      const keepRefs = (d: SuggestionDraft | null) => (d && (s.refs ?? []).length ? { ...d, refs: [...new Set([...(d.refs ?? []), ...(s.refs ?? [])])].slice(0, 10) } : d);
      const patch = r.patch && (s.refs ?? []).length ? { ...r.patch, refs: [...new Set([...(r.patch.refs ?? "").split(/\s+/).filter(Boolean), ...(s.refs ?? [])])].join("\n") } : r.patch;
      const asks = { ...(s.asks ?? {}) };
      if (r.questions.length || r.conflicts.length) asks[turns.length] = { questions: r.questions, conflicts: r.conflicts };
      const next: Saved = { ...s, turns: [...turns, { role: "ai", text: r.reply }], market: r.market?.length ? { ...(s.market ?? {}), [turns.length]: r.market } : s.market, draft: keepRefs(r.draft) ?? s.draft, drafts, ready: r.ready, patch: patch ?? s.patch, open: null, asks };
      // Kept at once: a written brief opens Ready to send in the same moment, and back must find the whole conversation
      try {
        sessionStorage.setItem(key(clientId), JSON.stringify(next));
      } catch {}
      return next;
    });

  /** The full brief, written now from the conversation (its progress shows in the chat), then Ready to send */
  const write = async (turns: TalkTurn[], sent: BriefFile[] = []) => {
    setBusy(true);
    setPhase("writing");
    const r = await talkRequest(clientId, turns, state.draft, true, false, sent).catch((): TalkResult => ({ ok: false, error: "Something went wrong. Try again." }));
    setBusy(false);
    setPhase(null);
    if (!r.ok) return setError(r.error);
    keep(turns, r);
    const withRefs = r.patch && refs.length ? { ...r.patch, refs: [...new Set([...(r.patch.refs ?? "").split(/\s+/).filter(Boolean), ...refs])].join("\n") } : r.patch;
    if (talkStep(r) === "land" && withRefs) land(withRefs);
  };

  const send = async (force = false, typed?: string) => {
    if (!force && files.uploading) return setError("Wait for the files to finish uploading.");
    const sent = force ? [] : files.ready;
    const said = force ? text.trim() || "Write it with what we have." : (typed ?? text).trim() || (sent.length ? "Use these as references for this brief." : "");
    if (!said || busy) return;
    // The files go with the message (named in it, so the conversation keeps them) and onto the brief as references
    const t = sent.length ? `${said}\n${sent.map(fileMention).join(" ")}` : said;
    if (sent.length) {
      addRefs(sent.map((f) => briefFileUrl(window.location.origin, f)));
      files.clear();
    }
    const turns: TalkTurn[] = [...state.turns, { role: "user", text: t }];
    if (typed === undefined) setText("");
    setError(null);

    // "Go back to the brief": the brief as it stood, no AI (nothing is rewritten)
    if (!force && GO_BACK.test(t) && (current || state.draft)) {
      say(turns, current ? "Here's the brief as it stood. Change anything in the preview, or tell me what to adjust." : "Here's the brief as it stood.");
      if (current) preview([...turns, { role: "ai", text: "Here's the brief as it stood." }], false);
      return;
    }

    // A pasted link is a reference for this brief: attached, and the brief stays as it is
    const urls = force ? [] : linksIn(said);
    if (urls.length) {
      const rest = urls.reduce((s, u) => s.replace(u, " "), said).replace(/\s+/g, " ").trim();
      setState((s) => ({
        ...s,
        refs: [...new Set([...(s.refs ?? []), ...urls])].slice(0, 10),
        // The preview shown keeps them too
        previews: (s.previews ?? []).map((b, i) => (i === at ? { ...b, refs: [...new Set([...(b.refs ?? []), ...urls])].slice(0, 10) } : b)),
        draft: s.draft ? { ...s.draft, refs: [...new Set([...(s.draft.refs ?? []), ...urls])].slice(0, 10) } : s.draft,
        patch: s.patch ? { ...s.patch, refs: [...new Set([...(s.patch.refs ?? "").split(/\s+/).filter(Boolean), ...urls])].join("\n") } : s.patch,
      }));
      // Only a link (or "use this as a reference"): nothing for the strategist to rewrite
      if (!sent.length && (!rest || /^(use (this|these|it|them)|for reference|as (a )?reference|ref(erence)?|like this|see|check (this|these)( out)?)[.!:]*$/i.test(rest))) {
        say(turns, `Added ${urls.length === 1 ? "it" : "them"} as ${urls.length === 1 ? "a reference" : "references"} to this brief. Everything else stays as it is.`);
        return;
      }
    }

    setState((s) => ({ ...s, turns }));
    // "Write it" (a button, a quick pick, or said in words): straight to the full brief
    if (force || (state.turns.length > 0 && wantsWrite(t))) return write(turns, sent);

    setBusy(true);
    setPhase("checking");
    // Nothing written yet: a quick read first (questions come back in the chat); once it's clear, the full brief
    const r = await talkRequest(clientId, turns, state.draft, false, !state.draft, sent).catch((): TalkResult => ({ ok: false, error: "Something went wrong. Try again." }));
    setBusy(false);
    setPhase(null);
    if (!r.ok) return setError(r.error);
    keep(turns, r);
    const step = talkStep(r);
    if (step === "write") return write([...turns, { role: "ai", text: r.reply }], sent);
    if (step === "land" && r.patch) land(r.patch);
  };

  const removeRef = (u: string) =>
    setState((s) => ({
      ...s,
      refs: (s.refs ?? []).filter((x) => x !== u),
      previews: (s.previews ?? []).map((b) => ({ ...b, refs: (b.refs ?? []).filter((x) => x !== u) })),
      draft: s.draft ? { ...s.draft, refs: (s.draft.refs ?? []).filter((x) => x !== u) } : s.draft,
      patch: s.patch ? { ...s.patch, refs: (s.patch.refs ?? "").split(/\s+/).filter((x) => x && x !== u).join("\n") } : s.patch,
    }));

  const startOver = () => {
    forgetTalk(clientId);
    setState({ turns: [], draft: null, ready: false, patch: null });
    setText("");
    setError(null);
  };

  // This conversation's brief, keyed by how it started (jobKeyOf): a background write from its preview shows here
  // The page's Continue: write the brief once there's an idea (said or typed), never while it's working
  const canContinue = !busy && (state.turns.some((t) => t.role === "user") || Boolean(text.trim()));
  const handleRef = useRef(onHandle);
  useEffect(() => {
    handleRef.current = onHandle;
  });
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    handleRef.current?.({ canContinue, continue: () => void sendRef.current(true) });
  }, [canContinue]);

  const said = state.turns.some((t) => t.role === "user");
  return (
    <section {...drop.bind} className={`relative mx-auto flex min-h-[460px] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-[22px] border bg-surface ${drop.dragging ? "border-brand/60" : "border-line"}`}>
      {drop.dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-bg/80 text-[14px] font-medium text-fg">Drop to add to the brief</div>}
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-white">
            <Spark size={12} />
          </span>
          Strategist
        </span>
        <span className="flex items-center gap-1">
          {said && !busy && (
            <button type="button" onClick={startOver} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
              New conversation
            </button>
          )}
          <button type="button" onClick={onBack} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
            ← Other ways
          </button>
        </span>
      </div>

      {/* The conversation: the strategist's questions are part of its message, answered right here */}
      <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {state.turns.length === 0 && (
          <div className="grid gap-2 rounded-[16px] bg-surface-2/60 p-4 text-[14px] leading-relaxed text-muted">
            <p className="font-medium text-fg">What do you want to make for {clientName}?</p>
            <p>Say it the way you&rsquo;d say it to the team: the idea, the format, how many. Paste any link as a reference. I&rsquo;ll ask only what I need, then write the full brief.</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {["A UGC video answering the price objection", "3 statics for the new offer", "A carousel showing how it works, step by step"].map((x) => (
                <button key={x} type="button" onClick={() => setText(x)} className="min-h-11 rounded-full border border-line px-3.5 text-[13px] text-muted hover:text-fg md:min-h-9">
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}
        {state.turns.map((t, i) => {
          const ask = t.role === "ai" && state.asks?.[i] ? inlineAsks(t.text, state.asks[i]) : null;
          return (
            <div key={i} className={`grid max-w-[88%] gap-2 rounded-[18px] px-4 py-2.5 text-[14.5px] leading-relaxed ${t.role === "user" ? "justify-self-end bg-fg text-bg" : "justify-self-start bg-surface-2 text-fg"}`}>
              <p className="whitespace-pre-wrap break-words">{t.text}</p>
              {ask && ask.conflicts.length > 0 && (
                <ul className="grid gap-1.5">
                  {ask.conflicts.map((c, j) => (
                    <li key={j} className="rounded-[12px] border border-warn/40 bg-warn-soft/50 px-3 py-2 text-[13.5px]">
                      {c}
                    </li>
                  ))}
                </ul>
              )}
              {ask && ask.questions.length > 0 && (
                <ol className="grid list-decimal gap-1 pl-5 text-[14px]">
                  {ask.questions.map((q, j) => (
                    <li key={j}>{q}</li>
                  ))}
                </ol>
              )}
              {t.role === "ai" && state.market?.[i]?.length ? <MarketRefCards refs={state.market[i]} added={refs} onAdd={(u) => addRefs([u])} /> : null}
            </div>
          );
        })}
        {busy && phase === "checking" && <div className="justify-self-start rounded-[18px] bg-surface-2 px-4 py-2.5 text-[14px] text-muted">Reading it through…</div>}
        {busy && phase === "writing" && (
          <div className="w-full justify-self-start rounded-[18px] border border-line bg-bg/60 px-4 py-3">
            <AiProgress size="sm" label="request chat" fallbackMs={60_000} title="Writing the full brief" steps={["Reading the conversation", "Pulling in the Brand Bible and the numbers", "Writing the concept and the hooks", "Checking it against the client's rules"]} note="It opens in Ready to send when it's done." />
          </div>
        )}
        {error && (
          <p className="flex flex-wrap items-center gap-2 rounded-[12px] border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">
            {error}
            {said && (
              <button type="button" onClick={() => void send(true)} className="min-h-9 rounded-full border border-bad/40 px-3 text-[12.5px] hover:bg-bad/10">
                Try again
              </button>
            )}
          </p>
        )}
        <div ref={endRef} />
      </div>

      {refs.length > 0 && (
        <div className="grid gap-1.5 border-t border-line px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.1em] text-faint">References</p>
          <LinkCards urls={refs} clientId={clientId} clientName={clientName} size="sm" onRemove={removeRef} />
        </div>
      )}
      {(files.items.length > 0 || files.error) && (
        <div className="grid gap-1.5 border-t border-line px-3 pt-2.5">
          <AttachedFiles items={files.items} onRemove={files.remove} />
          {files.error && <p className="text-[12.5px] text-bad">{files.error}</p>}
        </div>
      )}

      <div className="grid gap-2 border-t border-line p-3">
        <div className="flex items-end gap-2">
          <AttachButton onPick={(f) => void files.add(f)} disabled={busy} />
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
            placeholder={state.turns.length ? "Answer, refine, or paste a reference link…" : "Describe the creative you want…"}
            className="min-h-11 flex-1 resize-none rounded-[14px] border border-line bg-bg px-4 py-2.5 text-[16px] outline-none placeholder:text-faint focus:border-brand-text/60 md:text-[14.5px]"
          />
          {/* Send shows only once there's something to send; moving on is the page's Continue */}
          {(text.trim() || files.ready.length > 0) && (
            <button type="button" onClick={() => void send()} disabled={busy} className="h-11 shrink-0 rounded-full border border-line px-5 text-[14px] font-medium text-fg hover:border-faint disabled:opacity-50 animate-[sheet-fade_.15s_ease-out]">
              Send
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The conversation for a client is done with (its request was sent): the next talk starts fresh */
export function forgetTalk(clientId: string) {
  try {
    sessionStorage.removeItem(key(clientId));
  } catch {}
}
