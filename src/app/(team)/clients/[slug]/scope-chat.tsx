"use client";

import { useState } from "react";
import { AttachButton, ChatImageStrip, useChatImages } from "@/components/chat-images";
import { applyScope, proposeScope } from "./email-scope-actions";

// "Adjust with AI" on the SOW card: the person says what the client actually signed or decided ("they only signed the
// 1-month sprint, months 2 and 3 were just pitched", "they picked Option B", "December is 5 campaigns, not 3"); the AI
// proposes the month changes, shown before anything is written; Apply writes them with a dated note of why (kept).
// Unsigned or removed months stay visible and can be reopened.

type Change = Awaited<ReturnType<typeof proposeScope>> extends infer R ? (R extends { ok: true; changes: infer C } ? C : never) : never;
type Turn = { role: "you" | "ai"; text: string };

const monthName = (m: string) => new Date(`${m.slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const r = (max: number | null | undefined, min: number | null | undefined) => (max == null ? "0" : min != null && min < max ? `${min}-${max}` : String(max));
const ACTION: Record<string, string> = { set: "Set", unsigned: "Mark not signed", removed: "Remove", reopen: "Reopen" };

export function ScopeChat({ clientId, onApplied }: { clientId: string; onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "think" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const pics = useChatImages();
  const [proposal, setProposal] = useState<{ note: string; changes: Change } | null>(null);

  const send = async () => {
    if (!text.trim() && !pics.urls.length) return;
    const sentPics = pics.urls;
    const next = [...turns, { role: "you" as const, text: text.trim() || "(see the attached screenshot)" }];
    setTurns(next);
    setText("");
    pics.clear();
    setBusy("think");
    setError(null);
    const res = await proposeScope(clientId, next, sentPics);
    setBusy(null);
    if (!res.ok) {
      pics.restore(sentPics);
      return setError(res.error);
    }
    setTurns([...next, { role: "ai", text: res.reply }]);
    setProposal(res.changes.length ? { note: res.note, changes: res.changes } : null);
  };
  const apply = async () => {
    if (!proposal) return;
    setBusy("apply");
    setError(null);
    const res = await applyScope(clientId, proposal.changes, proposal.note);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setTurns((t) => [...t, { role: "ai", text: `Applied ${res.applied} change${res.applied === 1 ? "" : "s"}, with the note kept.` }]);
    setProposal(null);
    onApplied();
  };

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-2 justify-self-start rounded-full border border-brand/40 px-4 text-[13px] text-brand-text transition hover:bg-brand/10 md:min-h-9">
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
          <path fill="currentColor" d="M12 2c.6 4.6 2.9 7.4 8 8.2v1.6c-5.1.8-7.4 3.6-8 8.2h-.1c-.6-4.6-2.9-7.4-8-8.2v-1.6c5.1-.8 7.4-3.6 8-8.2z" />
        </svg>
        Adjust with AI
      </button>
    );

  return (
    <section aria-label="Adjust the scope with AI" className="grid gap-3 rounded-[16px] border border-brand/30 bg-brand/[0.04] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-brand-text">Adjust with AI</p>
        <button type="button" onClick={() => setOpen(false)} className="min-h-10 text-[12px] text-faint hover:text-fg md:min-h-0">
          Close
        </button>
      </div>
      {!turns.length && <p className="text-[12.5px] text-muted">Say what the client signed or decided: &ldquo;They only signed the 1-month sprint, months 2 and 3 were just pitched&rdquo;, &ldquo;They picked Option B&rdquo;, &ldquo;December is 5 campaigns, not 3&rdquo;.</p>}
      {turns.map((t, i) => (
        <p key={i} className={`max-w-[90%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2 text-[13.5px] leading-relaxed [overflow-wrap:anywhere] ${t.role === "you" ? "justify-self-end bg-fg text-bg" : "justify-self-start bg-surface text-fg"}`}>
          {t.text}
        </p>
      ))}
      {busy === "think" && <p className="text-[12.5px] text-faint">Reading the SOW and the months…</p>}
      {proposal && (
        <div className="grid gap-2 rounded-[14px] border border-line bg-surface p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">What would change</p>
          {proposal.changes.map((c, i) => (
            <p key={i} className="text-[13px] text-fg">
              <span className="font-medium">{ACTION[c.action] ?? c.action}</span> {monthName(c.month)}
              {c.action === "set" && (
                <span className="text-muted">
                  {": "}
                  {r(c.campaigns, c.campaigns_min)} campaigns, {r(c.sms, c.sms_min)} SMS, {c.flows ?? 0} flows, {r(c.flow_emails, c.flow_emails_min)} flow emails
                </span>
              )}
              {c.why && <span className="text-faint"> · {c.why}</span>}
            </p>
          ))}
          {proposal.note && <p className="text-[12px] text-muted">Note kept: {proposal.note}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={apply} disabled={busy !== null} className="min-h-11 rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50 md:min-h-9">
              {busy === "apply" ? "Applying…" : "Apply"}
            </button>
            <button type="button" onClick={() => setProposal(null)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
              Not this
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <ChatImageStrip chat={pics} />
      <div className={`flex items-end gap-2 rounded-[14px] ${pics.over ? "ring-2 ring-brand-text/50" : ""}`} {...pics.box}>
        <AttachButton chat={pics} disabled={busy !== null} />
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="What changed"
          placeholder="They only signed the 1-month sprint… (paste a screenshot)"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-[14px] border border-line bg-bg px-3.5 py-2.5 text-[16px] leading-snug text-fg outline-none focus:border-faint md:text-[13.5px]"
        />
        <button type="button" onClick={() => void send()} disabled={(!text.trim() && !pics.urls.length) || busy !== null} className="min-h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50">
          Send
        </button>
      </div>
    </section>
  );
}
