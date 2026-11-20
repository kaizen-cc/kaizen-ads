"use client";

import { useState } from "react";
import { draftCallPromise, draftPromise, draftReply, sendPromiseUpdate, sendReply } from "@/app/today/actions";

// The reply someone owes, drafted in their voice from the whole thread: edit it, copy it, open the message, or (in
// Slack) send it in the thread as yourself. On the Overview's cards (light) and in the daily recap (dark).
// The same for a promise: `said` is an update on something they said yes to (sent in the same thread; it closes the
// promise when it hands the thing over), `call` an update to the client on something promised on a call (copied and
// sent by them in the client's channel or email: never posted for them).

type Props = {
  id: string;
  /** What it answers: a message waiting on them (default), something they said yes to, or a call promise */
  kind?: "owed" | "said" | "call";
  source: "slack" | "gmail";
  url: string | null;
  initial: string | null;
  channel?: string | null;
  tone?: "light" | "dark";
  /** Sent from here: the card can close */
  onSent?: () => void;
};

export function DraftReply({ id, kind = "owed", source, url, initial, channel = null, tone = "light", onSent }: Props) {
  const [text, setText] = useState(initial ?? "");
  const [has, setHas] = useState(Boolean(initial));
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An update that hands the promised thing over closes the promise when it's sent
  const [delivered, setDelivered] = useState(false);
  const canSend = source === "slack" && kind !== "call";
  const noun = kind === "owed" ? "reply" : "update";
  const dark = tone === "dark";
  const ghost = dark ? "border border-white/25 text-white/85 hover:bg-white/10" : "border border-line text-muted hover:text-fg";
  const btn = `inline-flex h-11 items-center justify-center rounded-full px-4 text-sm md:h-9 disabled:opacity-60 ${ghost}`;

  const draft = async (fresh: boolean) => {
    setBusy("draft");
    setError(null);
    const r = kind === "said" ? await draftPromise(id, fresh) : kind === "call" ? await draftCallPromise(id, fresh) : await draftReply(id, fresh);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setText(r.draft);
    if ("delivered" in r) setDelivered(Boolean(r.delivered));
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
    const r = kind === "said" ? await sendPromiseUpdate(id, text, delivered) : await sendReply(id, text);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onSent?.();
  };

  if (!has)
    return (
      <div className="grid gap-1.5">
        <button type="button" disabled={busy !== null} onClick={() => void draft(false)} className={`${btn} w-full md:w-auto md:justify-self-start`}>
          {busy === "draft" ? (kind === "call" ? "Reading the client and drafting…" : "Reading the thread and drafting…") : kind === "call" ? "✎ Draft my update to the client" : `✎ Draft my ${noun}`}
        </button>
        {error && <p className={`text-xs ${dark ? "text-[#ff8a95]" : "text-bad"}`}>{error}</p>}
      </div>
    );

  return (
    <div className={`grid gap-2 rounded-[14px] p-3 ${dark ? "border border-white/15 bg-white/[0.06]" : "border border-line bg-surface"}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${dark ? "text-white/55" : "text-faint"}`}>{kind === "call" ? "Your update to the client, drafted" : `Your ${noun}, drafted`}</p>
      <textarea data-chat
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        className={`w-full resize-y rounded-[10px] px-3 py-2 text-[14px] leading-relaxed outline-none ${dark ? "border border-white/15 bg-black/30 text-white focus:border-white/40" : "border border-line bg-bg text-fg focus:border-brand-text/60"}`}
      />
      {text.includes("[") && <p className={`text-[11px] ${dark ? "text-[#ffcf6b]" : "text-warn"}`}>Fill in the parts in [brackets] before it goes.</p>}
      <div className="flex flex-wrap gap-2">
        {kind === "said" && canSend && (
          <label className={`flex w-full items-center gap-2 text-[12px] ${dark ? "text-white/70" : "text-muted"}`}>
            <input type="checkbox" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} className="h-4 w-4" />
            This hands it over: close the promise when it&apos;s sent
          </label>
        )}
        {canSend && (
          <button type="button" disabled={busy !== null || !text.trim()} onClick={() => void send()} className={`inline-flex h-11 w-full items-center justify-center rounded-full px-4 text-sm font-medium md:h-9 md:w-auto disabled:opacity-60 ${dark ? "bg-white text-black hover:bg-white/90" : "bg-fg text-bg"}`}>
            {busy === "send" ? "Sending…" : "Send in Slack"}
          </button>
        )}
        <button type="button" onClick={() => void copy()} className={btn}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" onClick={() => void copy()} className={btn} title="Copies the draft and opens the message">
            {kind === "call" ? (source === "gmail" ? "Copy & write the email" : "Copy & open their channel") : source === "gmail" ? "Copy & open the email" : "Copy & open in Slack"} ↗
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
