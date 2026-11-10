"use client";

import { useEffect, useRef, useState } from "react";
import type { SuggestionDraft, TalkTurn } from "@/lib/suggestions";
import type { QuickBrief } from "@/lib/quick-brief";
import { linksIn } from "@/lib/saved-references";
import type { Draft } from "./draft";
import { talkRequest } from "./actions";
import { Spark } from "./parts";
import { BriefJobSlot } from "@/components/brief-jobs";
import { LinkCards } from "@/components/link-refs";
import type { PreviewItem } from "./start-flow";
import { AttachButton, AttachedFiles, useBriefFiles, useFileDrop } from "@/components/brief-attach";
import { MarketRefCards } from "@/components/market-ref-cards";
import { briefFileUrl, fileMention } from "@/lib/brief-files";
import type { Reference } from "@/lib/ai-tools/motion";

/**
 * "Talk it through": the team member tells the strategist the idea, it asks only what it needs (one or two questions
 * at a time) and the brief builds beside the conversation. "Use this brief" fills the request and opens it at Review,
 * where every field can still be changed. Kept in this browser per client, so a refresh doesn't lose the conversation.
 *
 * One brief, refined: the quick preview (and the full brief) persist across turns, and every follow-up refines that
 * same one (same title and concept unless asked). Each version is kept, with "Previous version" to step back, and
 * "go back to the brief" brings the brief back as it stood. A pasted link is a reference for this brief, never a new
 * topic: it's attached (with a preview card) and the brief stays.
 */

type Saved = {
  turns: TalkTurn[];
  draft: SuggestionDraft | null;
  ready: boolean;
  patch: Partial<Draft> | null;
  open?: { questions: string[]; conflicts: string[] } | null;
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
const FMT = { image: "image", video: "video", carousel: "carousel" } as const;
const EVENT = "kz:talk-preview";

/** The quick preview of a talk, as it arrives and as it's edited: kept by the conversation (src/components/quick-brief-sheet.tsx onBriefChange) */
export function recordTalkPreview(clientId: string, brief: QuickBrief) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { clientId, brief } }));
}

const GO_BACK = /^\s*(please\s+)?(go|take (me|us)|bring (it|me))\s+back(\s+to\s+(the|my|our|that|this)\s+(brief|preview|version|idea))?\s*[.!]*\s*$|^\s*(restore|undo)\b|\bgo back to the (brief|preview)\b/i;
const sameBrief = (a: QuickBrief | undefined, b: QuickBrief) => Boolean(a) && JSON.stringify(a) === JSON.stringify(b);

export function RequestChat({ clientId, clientName, onUse, onPreview, onBack }: { clientId: string; clientName: string; onUse: (patch: Partial<Draft>) => void; /** Before the first full brief: its quick preview */ onPreview: (item: PreviewItem) => void; onBack: () => void }) {
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

  const send = async (force = false) => {
    // Nothing written yet: "write it" opens the quick preview first, and the full brief follows what's agreed there
    if (force && !state.draft) return preview(state.turns, false);
    if (!force && files.uploading) return setError("Wait for the files to finish uploading.");
    const sent = force ? [] : files.ready;
    const typed = force ? "Go ahead and write it with what we have." : text.trim() || (sent.length ? "Use these as references for this brief." : "");
    if (!typed || busy) return;
    // The files go with the message (named in it, so the conversation keeps them) and onto the brief as references
    const t = sent.length ? `${typed}\n${sent.map(fileMention).join(" ")}` : typed;
    const sentUrls: string[] = [];
    if (sent.length) {
      sentUrls.push(...sent.map((f) => briefFileUrl(window.location.origin, f)));
      addRefs(sentUrls);
      files.clear();
    }
    const turns: TalkTurn[] = [...state.turns, { role: "user", text: t }];
    if (!force) setText("");
    setError(null);

    // "Go back to the brief": the brief as it stood, no AI (nothing is rewritten)
    if (!force && GO_BACK.test(t) && (current || state.draft)) {
      say(turns, current ? "Here's the brief as it stood. Change anything in the preview, or tell me what to adjust." : "Here's the brief as it stood.");
      if (current) preview([...turns, { role: "ai", text: "Here's the brief as it stood." }], false);
      return;
    }

    // A pasted link is a reference for this brief: attached, and the brief stays as it is
    const urls = force ? [] : linksIn(typed);
    if (urls.length) {
      const rest = urls.reduce((s, u) => s.replace(u, " "), typed).replace(/\s+/g, " ").trim();
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
    setBusy(true);
    setPhase(force ? "writing" : "checking");
    const r = await talkRequest(clientId, turns, state.draft, force, !state.draft, sent).catch(() => ({ ok: false as const, error: "Something went wrong. Try again." }));
    setBusy(false);
    setPhase(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setState((s) => {
      // A new full draft: the one before it is kept, so it can be brought back
      const drafts = r.draft && s.draft ? [...(s.drafts ?? []), { draft: s.draft, patch: s.patch }].slice(-8) : (s.drafts ?? []);
      const keepRefs = (d: SuggestionDraft | null) => (d && (s.refs ?? []).length ? { ...d, refs: [...new Set([...(d.refs ?? []), ...(s.refs ?? [])])].slice(0, 10) } : d);
      const patch = r.patch && (s.refs ?? []).length ? { ...r.patch, refs: [...new Set([...(r.patch.refs ?? "").split(/\s+/).filter(Boolean), ...(s.refs ?? [])])].join("\n") } : r.patch;
      return {
        ...s,
        turns: [...turns, { role: "ai", text: r.reply }],
        // The market ads it brought up show under its message
        market: r.market?.length ? { ...(s.market ?? {}), [turns.length]: r.market } : s.market,
        draft: keepRefs(r.draft) ?? s.draft,
        drafts,
        ready: r.ready,
        patch: patch ?? s.patch,
        open: r.building || r.previewReady ? null : { questions: r.questions, conflicts: r.conflicts },
      };
    });
    if (r.previewReady) preview([...turns, { role: "ai", text: r.reply }], true, sentUrls);
  };

  const use = () => {
    if (!state.patch) return;
    try {
      sessionStorage.removeItem(key(clientId));
    } catch {}
    onUse({ ...state.patch, origin: { kind: "brief", label: "Talked through with the strategist" } });
  };

  const stepBack = () => setState((s) => ({ ...s, at: Math.max(0, (s.at ?? (s.previews ?? []).length - 1) - 1) }));
  const stepForward = () => setState((s) => ({ ...s, at: Math.min((s.previews ?? []).length - 1, (s.at ?? 0) + 1) }));
  const draftBack = () =>
    setState((s) => {
      const list = s.drafts ?? [];
      const prev = list[list.length - 1];
      if (!prev || !s.draft) return s;
      // The two swap: the one shown goes to the history, so it can be brought back the same way
      return { ...s, draft: prev.draft, patch: prev.patch, drafts: [...list.slice(0, -1), { draft: s.draft, patch: s.patch }] };
    });
  const removeRef = (u: string) =>
    setState((s) => ({
      ...s,
      refs: (s.refs ?? []).filter((x) => x !== u),
      previews: (s.previews ?? []).map((b) => ({ ...b, refs: (b.refs ?? []).filter((x) => x !== u) })),
      draft: s.draft ? { ...s.draft, refs: (s.draft.refs ?? []).filter((x) => x !== u) } : s.draft,
      patch: s.patch ? { ...s.patch, refs: (s.patch.refs ?? "").split(/\s+/).filter((x) => x && x !== u).join("\n") } : s.patch,
    }));

  const d = state.draft;
  // This conversation's brief, keyed by how it started (jobKeyOf): its background job's progress shows by its button
  const talkSource = state.turns.length ? ({ kind: "talk", turns: state.turns } as const) : null;
  const versions = previews.length > 1 && (
    <div className="flex items-center justify-between gap-2 text-[12px] text-faint">
      <span className="tabular">
        Version {at + 1} of {previews.length}
      </span>
      <span className="flex gap-1">
        <button type="button" onClick={stepBack} disabled={at <= 0} className="min-h-11 rounded-full px-3 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40 md:min-h-8">
          ← Previous version
        </button>
        {at < previews.length - 1 && (
          <button type="button" onClick={stepForward} className="min-h-11 rounded-full px-3 text-muted hover:bg-surface-2 hover:text-fg md:min-h-8">
            Newer →
          </button>
        )}
      </span>
    </div>
  );
  const refCards = refs.length > 0 && (
    <div className="grid gap-1.5">
      <p className="text-[11px] uppercase tracking-[0.1em] text-faint">References</p>
      <LinkCards urls={refs} clientId={clientId} clientName={clientName} size="sm" onRemove={removeRef} />
    </div>
  );
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      {/* The conversation */}
      <section {...drop.bind} className={`relative flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-[20px] border bg-surface ${drop.dragging ? "border-brand/60" : "border-line"}`}>
        {drop.dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-bg/80 text-[14px] font-medium text-fg">Drop to add to the brief</div>}
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
              <p>Say it the way you&rsquo;d say it to the team: the idea, the format, how many, anything it has to include. Paste any link as a reference (Motion, Pinterest, Instagram, TikTok, the Ad Library, YouTube). I&rsquo;ll ask only what I need and build the brief from their Bible, numbers and assets as we go.</p>
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
            <div key={i} className={`grid min-w-0 gap-2 ${t.role === "user" ? "justify-items-end" : "justify-items-start"}`}>
              <div className={`max-w-[88%] whitespace-pre-wrap break-words rounded-[16px] px-4 py-2.5 text-[14px] leading-relaxed ${t.role === "user" ? "bg-fg text-bg" : "bg-surface-2 text-fg"}`}>{t.text}</div>
              {t.role === "ai" && state.market?.[i]?.length ? <MarketRefCards refs={state.market[i]} added={refs} onAdd={(u) => addRefs([u])} /> : null}
            </div>
          ))}
          {busy && <div className="justify-self-start rounded-[16px] bg-surface-2 px-4 py-2.5 text-[14px] text-muted">{phase === "writing" ? "Writing the brief…" : "Reading it through…"}</div>}
          {error && <p className="rounded-[12px] border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
          <div ref={endRef} />
        </div>
        {(files.items.length > 0 || files.error) && (
          <div className="grid gap-1.5 border-t border-line px-3 pt-2.5">
            <AttachedFiles items={files.items} onRemove={files.remove} />
            {files.error && <p className="text-[12.5px] text-bad">{files.error}</p>}
          </div>
        )}
        <div className="flex items-end gap-2 border-t border-line p-3">
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
          <button type="button" onClick={() => void send()} disabled={(!text.trim() && !files.ready.length) || busy} className="h-11 shrink-0 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-50">
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
              {d.avatar && (
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">{d.avatarTest ? "Avatar test" : "Avatar"}</dt>
                  <dd>{d.avatar}</dd>
                </div>
              )}
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
            {refCards}
            {(state.drafts ?? []).length > 0 && (
              <button type="button" onClick={draftBack} className="min-h-11 justify-self-start rounded-full px-3 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg md:min-h-8">
                ← Previous version
              </button>
            )}
            <button type="button" onClick={use} className={`min-h-11 rounded-full px-4 text-[14px] font-medium ${state.ready ? "bg-brand text-white" : "border border-line text-fg hover:border-faint"}`}>
              {state.ready ? "Use this brief →" : "Use it as it is →"}
            </button>
            <p className="text-[12px] text-faint">Every field can still be changed before it goes out.</p>
          </>
        ) : current ? (
          <div className="grid gap-3">
            {versions}
            <p className="font-heading text-[18px] leading-snug">{current.title || "Untitled"}</p>
            <p className="text-[13.5px] leading-relaxed text-muted">{current.concept}</p>
            <dl className="grid gap-2 text-[13px]">
              {current.avatar && (
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">{current.avatarTest ? "Avatar test" : "Avatar"}</dt>
                  <dd>{current.avatar}</dd>
                </div>
              )}
              {current.angle && (
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Angle</dt>
                  <dd>{current.angle}</dd>
                </div>
              )}
              {current.hook && (
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Hook</dt>
                  <dd>&ldquo;{current.hook}&rdquo;</dd>
                </div>
              )}
              <div>
                <dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Making</dt>
                <dd>{current.formats.map((f) => `${f.new} new${f.variations ? ` + ${f.variations} var.` : ""} ${FMT[f.format]}${f.new + f.variations === 1 ? "" : "s"}`).join(" · ") || "–"}</dd>
              </div>
            </dl>
            {refCards}
            {state.open && (state.open.questions.length > 0 || state.open.conflicts.length > 0) && (
              <ol className="grid list-decimal gap-1.5 rounded-[12px] border border-warn/30 bg-warn-soft/30 py-2 pl-8 pr-3 text-[13px] text-muted">
                {[...state.open.conflicts, ...state.open.questions].map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            )}
            {/* Its brief being written in the background: the progress here, then "Brief ready · Open" (or Retry) */}
            <BriefJobSlot source={talkSource} clientId={clientId} compact={false}>
              <button type="button" disabled={busy} onClick={() => preview(state.turns, false)} className="min-h-11 rounded-full bg-brand px-4 text-[14px] font-medium text-white disabled:opacity-60">
                Open the preview
              </button>
            </BriefJobSlot>
            <p className="text-[12px] text-faint">Keep talking to refine this same brief. Say &ldquo;go back to the brief&rdquo; any time to see it as it stood.</p>
          </div>
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
            {refCards}
            <BriefJobSlot source={talkSource} clientId={clientId} compact={false}>
              <button type="button" disabled={busy} onClick={() => void send(true)} className="min-h-11 rounded-full border border-line px-4 text-[13.5px] text-muted hover:text-fg disabled:opacity-60">
                Write it with what we have
              </button>
            </BriefJobSlot>
          </div>
        ) : state.turns.length > 1 ? (
          <div className="grid gap-2">
            <p className="text-[13.5px] text-muted">Everything&rsquo;s clear. See the quick preview, change anything, then the full brief is written from it.</p>
            {refCards}
            {/* Its brief being written in the background: the progress here, then "Brief ready · Open" (or Retry) */}
            <BriefJobSlot source={talkSource} clientId={clientId} compact={false}>
              <button type="button" disabled={busy} onClick={() => preview(state.turns, false)} className="min-h-11 rounded-full bg-brand px-4 text-[14px] font-medium text-white disabled:opacity-60">
                See the quick preview
              </button>
            </BriefJobSlot>
          </div>
        ) : (
          <>
            <p className="text-[13.5px] text-muted">{phase === "writing" ? "Writing the brief…" : "It builds here once everything's clear."}</p>
            {refCards}
          </>
        )}
      </aside>
    </div>
  );
}
