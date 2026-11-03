"use client";

import { useState, useTransition } from "react";
import { previewStageEmail, pushStageEmail, sentEmail } from "./actions";

// The client's emails, for the team: the one that fits where they are now (offered first, any other a pick away),
// previewed exactly as it will land and sent to every contact as of this moment; and every email they've had from us,
// each one viewable as it looked.

type Kind = "welcome" | "intake" | "presentation" | "live";
export type SentRow = { id: string | null; kind: string; name: string; subject: string; to: string[]; manual: boolean; by: string | null; at: string };

const KINDS: { kind: Kind; name: string; what: string }[] = [
  { kind: "welcome", name: "Welcome and setup", what: "Their setup steps and the link to their guide" },
  { kind: "intake", name: "Intake form", what: "The marketing intake form, with their Client ID" },
  { kind: "presentation", name: "Review how we see you", what: "Their brand plan, waiting on their approval" },
  { kind: "live", name: "You're live", what: "Their first campaign is running" },
];

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (iso: string) => {
  const d = Math.floor((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000);
  return d >= 0 ? "today" : d === -1 ? "yesterday" : `${-d} days ago`;
};

function Frame({ html }: { html: string }) {
  // The email as it lands: its own light page, no scripts
  return <iframe title="Email preview" srcDoc={html} sandbox="" className="h-[560px] w-full rounded-[12px] border border-line bg-white md:h-[640px]" />;
}

export function EmailsPanel({ clientId, slug, stage, sent }: { clientId: string; slug: string; stage: { kind: Kind | null; why: string }; sent: SentRow[] }) {
  const [kind, setKind] = useState<Kind>(stage.kind ?? "welcome");
  const [preview, setPreview] = useState<{ kind: Kind; subject: string; html: string; to: string[]; reminder: boolean } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, { subject: string; html: string | null; text: string | null }>>({});
  const [busy, start] = useTransition();
  const [sending, setSending] = useState(false);

  const last = sent.find((s) => s.kind === kind);
  const shown = preview?.kind === kind ? preview : null;

  const look = (k: Kind) => {
    setNote(null);
    start(async () => {
      const r = await previewStageEmail(clientId, k);
      if (r.ok) setPreview({ kind: k, subject: r.subject, html: r.html, to: r.to, reminder: r.reminder });
      else {
        setPreview(null);
        setNote({ ok: false, text: r.error });
      }
    });
  };
  const send = () => {
    if (!shown) return;
    if (!window.confirm(`Send "${shown.subject}" to ${shown.to.length} contact${shown.to.length === 1 ? "" : "s"} now?`)) return;
    setSending(true);
    setNote(null);
    void pushStageEmail(clientId, slug, kind).then((r) => {
      setSending(false);
      if (r.ok) {
        setPreview(null);
        setNote({ ok: true, text: `Sent to ${r.sent.join(", ")}.` });
      } else setNote({ ok: false, text: r.error });
    });
  };
  const view = (row: SentRow) => {
    const key = row.id ?? `${row.kind}:${row.at}`;
    if (open === key) return setOpen(null);
    setOpen(key);
    if (!row.id || opened[row.id]) return;
    const id = row.id;
    void sentEmail(id).then((r) => r.ok && setOpened((o) => ({ ...o, [id]: { subject: r.subject, html: r.html, text: r.text } })));
  };

  return (
    <div className="grid gap-5">
      {/* The one to send now */}
      <div className="grid gap-3 rounded-[16px] border border-line bg-surface-2/40 p-4">
        <div className="grid gap-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-brand-text">{stage.kind ? "Where they are" : "Nothing waiting on them"}</p>
          <p className="text-[13.5px] text-muted">{stage.why}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setNote(null);
            }}
            className="h-11 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[14px] outline-none focus:border-brand-text/60 md:h-10"
            aria-label="Which email"
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.name}
                {k.kind === stage.kind ? " (suggested)" : ""}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => look(kind)} disabled={busy} className="h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg disabled:opacity-50 md:h-10">
            {busy ? "Writing it…" : shown ? "Refresh preview" : "Preview"}
          </button>
        </div>
        <p className="text-[12.5px] text-faint">
          {KINDS.find((k) => k.kind === kind)?.what}.{" "}
          {last ? `Last sent ${when(last.at)} (${ago(last.at)}) to ${last.to.length} contact${last.to.length === 1 ? "" : "s"}${last.manual && last.by ? `, by ${last.by}` : ""}.` : "Not sent yet."}
        </p>
        {shown && (
          <div className="grid gap-3">
            <div className="grid gap-1 text-[13px]">
              <p>
                <span className="text-faint">Subject </span>
                {shown.subject}
              </p>
              <p className="text-muted">
                <span className="text-faint">To </span>
                {shown.to.length ? shown.to.join(", ") : "nobody yet: add a contact first"}
              </p>
              {shown.reminder && <p className="text-[12.5px] text-faint">Written as a reminder, since they&rsquo;ve had this one before.</p>}
            </div>
            <Frame html={shown.html} />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={send} disabled={sending || !shown.to.length} className="h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-50">
                {sending ? "Sending…" : `Send to ${shown.to.length} contact${shown.to.length === 1 ? "" : "s"}`}
              </button>
              <p className="text-[12px] text-faint">Goes to every contact on the list right now, including any you just added.</p>
            </div>
          </div>
        )}
        {note && <p className={`rounded-[10px] px-3 py-2 text-[13px] ${note.ok ? "bg-ok-soft text-ok" : "bg-warn-soft/60 text-warn"}`}>{note.text}</p>}
      </div>

      {/* Everything they've had from us */}
      <div className="grid gap-2">
        <p className="text-[13px] font-medium">Sent</p>
        {sent.length ? (
          <ul className="grid">
            {sent.map((row) => {
              const key = row.id ?? `${row.kind}:${row.at}`;
              const o = row.id ? opened[row.id] : null;
              return (
                <li key={key} className="grid gap-2 border-t border-line py-2.5 first:border-t-0">
                  <button type="button" onClick={() => view(row)} className="flex min-h-11 items-start gap-3 text-left md:min-h-0">
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-[13.5px]">{row.subject}</span>
                      <span className="truncate text-[12px] text-faint">
                        {row.name} · {when(row.at)} · {row.to.length ? `${row.to.length} contact${row.to.length === 1 ? "" : "s"}` : "sent"} · {row.manual ? `pushed by ${row.by ?? "the team"}` : "automatic"}
                      </span>
                    </span>
                    <span className="shrink-0 pt-0.5 text-[12.5px] text-brand-text">{open === key ? "Hide" : "View"}</span>
                  </button>
                  {open === key && (
                    <div className="grid gap-2">
                      {row.to.length > 0 && <p className="text-[12.5px] text-muted">To {row.to.join(", ")}</p>}
                      {!row.id ? <p className="text-[12.5px] text-faint">Sent before we kept a copy of each email, so there&rsquo;s no preview of this one.</p> : !o ? <p className="text-[12.5px] text-faint">Opening…</p> : o.html ? <Frame html={o.html} /> : <pre className="whitespace-pre-wrap text-[12.5px] text-muted">{o.text}</pre>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-faint">No emails sent to them yet.</p>
        )}
      </div>
    </div>
  );
}
