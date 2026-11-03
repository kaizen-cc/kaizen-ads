"use client";

import { useState } from "react";
import { draftReply, sendReply } from "@/app/today/actions";

// The reply someone owes, drafted in their voice from the whole thread: edit it, copy it, open the message, or (in
// Slack) send it in the thread as yourself. On the Overview's cards (light) and in the daily recap (dark).

type Props = {
  id: string;
  source: "slack" | "gmail";
  url: string | null;
  initial: string | null;
  channel?: string | null;
  tone?: "light" | "dark";
  /** Sent from here: the card can close */
  onSent?: () => void;
};

export function DraftReply({ id, source, url, initial, channel = null, tone = "light", onSent }: Props) {
  const [text, setText] = useState(initial ?? "");
  const [has, setHas] = useState(Boolean(initial));
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = tone === "dark";
  const ghost = dark ? "border border-white/25 text-white/85 hover:bg-white/10" : "border border-line text-muted hover:text-fg";
  const btn = `inline-flex h-11 items-center justify-center rounded-full px-4 text-sm md:h-9 disabled:opacity-60 ${ghost}`;

  const draft = async (fresh: boolean) => {
    setBusy("draft");
    setError(null);
    const r = await draftReply(id, fresh);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setText(r.draft);
    setHas(true);
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(text).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const send = async () => {
    if (!window.confirm(`Send this${channel ? ` in #${channel}` : ""} as you, in the thread?`)) return;
    setBusy("send");
    setError(null);
    const r = await sendReply(id, text);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onSent?.();
  };

  if (!has)
    return (
      <div className="grid gap-1.5">
        <button type="button" disabled={busy !== null} onClick={() => void draft(false)} className={`${btn} w-full md:w-auto md:justify-self-start`}>
          {busy === "draft" ? "Reading the thread and drafting…" : "✎ Draft my reply"}
        </button>
        {error && <p className={`text-xs ${dark ? "text-[#ff8a95]" : "text-bad"}`}>{error}</p>}
      </div>
    );

  return (
    <div className={`grid gap-2 rounded-[14px] p-3 ${dark ? "border border-white/15 bg-white/[0.06]" : "border border-line bg-surface"}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${dark ? "text-white/55" : "text-faint"}`}>Your reply, drafted</p>
      <textarea data-chat
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        className={`w-full resize-y rounded-[10px] px-3 py-2 text-[14px] leading-relaxed outline-none ${dark ? "border border-white/15 bg-black/30 text-white focus:border-white/40" : "border border-line bg-bg text-fg focus:border-brand-text/60"}`}
      />
      {text.includes("[") && <p className={`text-[11px] ${dark ? "text-[#ffcf6b]" : "text-warn"}`}>Fill in the parts in [brackets] before it goes.</p>}
      <div className="flex flex-wrap gap-2">
        {source === "slack" && (
          <button type="button" disabled={busy !== null || !text.trim()} onClick={() => void send()} className={`inline-flex h-11 w-full items-center justify-center rounded-full px-4 text-sm font-medium md:h-9 md:w-auto disabled:opacity-60 ${dark ? "bg-white text-black hover:bg-white/90" : "bg-fg text-bg"}`}>
            {busy === "send" ? "Sending…" : "Send in Slack"}
          </button>
        )}
        <button type="button" onClick={() => void copy()} className={btn}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" onClick={() => void copy()} className={btn} title="Copies the draft and opens the message">
            {source === "gmail" ? "Copy & open the email" : "Copy & open in Slack"} ↗
          </a>
        )}
        <button type="button" disabled={busy !== null} onClick={() => void draft(true)} className={`h-11 rounded-full px-3 text-sm md:h-9 disabled:opacity-60 ${dark ? "text-white/55 hover:text-white" : "text-faint hover:text-fg"}`}>
          {busy === "draft" ? "Redrafting…" : "Redraft"}
        </button>
      </div>
      {error && <p className={`text-xs ${dark ? "text-[#ff8a95]" : "text-bad"}`}>{error}</p>}
    </div>
  );
}
