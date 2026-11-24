"use client";

import { useState, useTransition } from "react";
import { dropStaged, releaseStaged, sendItemDraft } from "./actions";

// What the nightly agent left for you: drafts to send (one tap for your client's internal channel; copy for email or a
// teammate) and team tasks staged until you release them. Nothing here was sent for you.

export type DeskDraft = { id: string; title: string; kind: "slack" | "email"; text: string; where: string | null; to: string | null; subject: string | null; pdf: string | null; canSend: boolean };
export type DeskStaged = { id: string; title: string; detail: string; forName: string | null };

export function AgentDesk({ drafts, staged }: { drafts: DeskDraft[]; staged: DeskStaged[] }) {
  if (!drafts.length && !staged.length) return null;
  return (
    <section className="grid gap-3">
      <h2 className="font-heading text-[20px]">Ready for you</h2>
      {drafts.length > 0 && (
        <ul className="grid gap-2">
          {drafts.map((d) => (
            <Draft key={d.id} d={d} />
          ))}
        </ul>
      )}
      {staged.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Staged for your release · {staged.length}</p>
          <ul className="grid gap-2 md:grid-cols-2">
            {staged.map((s) => (
              <Staged key={s.id} s={s} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Draft({ d }: { d: DeskDraft }) {
  const [text, setText] = useState(d.text);
  const [state, setState] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const copy = async () => {
    await navigator.clipboard?.writeText(d.kind === "email" && d.subject ? `Subject: ${d.subject}\n\n${text}` : text).catch(() => null);
    setState("Copied");
  };
  return (
    <li className="grid gap-2 rounded-[18px] border border-line bg-surface p-4">
      <p className="text-[14px] font-medium">{d.title}</p>
      <p className="text-[12px] text-faint">{d.kind === "email" ? `Email${d.to ? ` to ${d.to}` : ""}${d.subject ? ` · ${d.subject}` : ""}` : d.where ? `Slack · ${d.where}` : "Slack"}</p>
      <textarea data-chat value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(8, Math.max(3, text.split("\n").length + 1))} className="w-full resize-y rounded-[10px] border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-brand/60" />
      {text.includes("[") && <p className="text-[11.5px] text-warn">Fill in the parts in [brackets] first.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {d.canSend && (
          <button type="button" disabled={pending || !text.trim()} onClick={() => window.confirm("Send this in the client's internal channel, as you?") && start(async () => setState((await sendItemDraft(d.id, text)).ok ? "Sent ✓" : "Couldn't send it"))} className="h-11 rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-60 md:h-9">
            {pending ? "Sending…" : "Send in Slack"}
          </button>
        )}
        <button type="button" onClick={() => void copy()} className="h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
          Copy
        </button>
        {d.pdf && (
          <a href={d.pdf} target="_blank" rel="noreferrer" className="h-11 rounded-full border border-line px-4 text-sm leading-[2.75rem] text-muted hover:text-fg md:h-9 md:leading-9">
            Open the PDF ↗
          </a>
        )}
        {state && <span className="text-[12px] text-faint">{state}</span>}
      </div>
    </li>
  );
}

function Staged({ s }: { s: DeskStaged }) {
  const [state, setState] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <li className="grid gap-2 rounded-[18px] border border-dashed border-line bg-surface p-4">
      <p className="text-[14px] font-medium">{s.title}</p>
      <p className="line-clamp-3 text-[12.5px] text-muted">{s.detail}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending || Boolean(state)} onClick={() => start(async () => setState((await releaseStaged(s.id)).ok ? `Released${s.forName ? ` to ${s.forName}` : ""} ✓` : "Couldn't release it"))} className="h-11 rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-60 md:h-9">
          Release{s.forName ? ` to ${s.forName.split(" ")[0]}` : ""}
        </button>
        <button type="button" disabled={pending || Boolean(state)} onClick={() => start(async () => setState((await dropStaged(s.id)).ok ? "Dropped" : "Couldn't drop it"))} className="h-11 rounded-full px-3 text-sm text-faint hover:text-fg md:h-9">
          Not needed
        </button>
        {state && <span className="text-[12px] text-faint">{state}</span>}
      </div>
    </li>
  );
}
