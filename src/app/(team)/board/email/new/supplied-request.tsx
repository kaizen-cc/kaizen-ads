"use client";

import { useState } from "react";
import { readClientSheet, sendClientSheet } from "./actions";

// Client supplies the content: their team fills a Google Sheet with each email's images, copy and CTA links. No
// strategy, brief or copy steps: link the sheet (last week's is remembered), we read it for the emails in it, add a note
// if needed, and it goes straight to the client's email designer as one Asana task in Ready for Design, counting against
// the allotment and running through the board like any request.

type Emails = import("@/lib/email-supplied").SuppliedEmail[];
const PRIORITY = [
  { key: "low", label: "Low" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "High" },
  { key: "urgent", label: "Urgent" },
] as const;
const chip = (on: boolean) => `min-h-11 rounded-full border px-4 text-[13.5px] transition md:min-h-10 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`;

export function SuppliedRequest({ clientId, clientName, lastSheet, onPlanNormally }: { clientId: string; clientName: string; lastSheet: string | null; onPlanNormally: () => void }) {
  const [url, setUrl] = useState(lastSheet ?? "");
  const [read, setRead] = useState<{ title: string; emails: Emails; summary: string; channel: "email" | "sms" | "mixed" } | null>(null);
  const [count, setCount] = useState(1);
  const [name, setName] = useState("Weekly campaigns");
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState("normal");
  const [busy, setBusy] = useState<null | "read" | "send">(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ task: { name: string; url: string }; designer: string | null; note: string | null } | null>(null);

  const readIt = async () => {
    if (!url.trim()) return;
    setBusy("read");
    setError(null);
    const r = await readClientSheet(clientId, url);
    setBusy(null);
    if (!r.ok) return setError(`${r.error} You can still send it: say how many emails are in it.`);
    setRead({ title: r.sheet.title, emails: r.sheet.emails, summary: r.sheet.summary, channel: r.sheet.channel });
    setCount(Math.max(1, Math.min(5, r.sheet.emails.length || 1)));
    if (r.sheet.title) setName(r.sheet.title.replace(/\s*[-|·]\s*(copy|sheet|emails?)\s*$/i, "").slice(0, 60) || "Weekly campaigns");
  };
  const send = async () => {
    setBusy("send");
    setError(null);
    const r = await sendClientSheet({ clientId, url, count, channel: read?.channel === "sms" ? "sms" : "email", name, note, priority, emails: read?.emails ?? [], summary: read?.summary ?? null });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setMade(r);
  };

  if (made)
    return (
      <section className="grid gap-3 rounded-[22px] border border-ok/40 bg-ok-soft/40 p-5">
        <p className="font-heading text-[18px] text-fg">Sent to {made.designer ?? "the design column"}</p>
        <a href={made.task.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-[14px] border border-line bg-surface px-4 py-3 text-[14px] text-fg hover:border-faint [overflow-wrap:anywhere]">
          <span aria-hidden className="text-ok">↗</span>
          {made.task.name}
        </a>
        {made.note && <p className="text-[12.5px] text-muted">{made.note}</p>}
        <button type="button" onClick={() => { setMade(null); setRead(null); setNote(""); }} className="min-h-11 justify-self-start rounded-full bg-fg px-5 text-[13.5px] font-medium text-bg">
          Send another sheet
        </button>
      </section>
    );

  return (
    <section aria-label="Client supplies the content" className="grid gap-5 rounded-[22px] border border-brand/30 bg-gradient-to-br from-brand/[0.07] to-surface p-5 md:p-6">
      <div className="grid gap-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Client supplies the content</p>
        <p className="text-[14px] text-muted">{clientName}&rsquo;s team provides the images, copy and CTA links in their sheet. Link it and it goes straight to their designer.</p>
      </div>

      <div className="grid gap-2">
        <label htmlFor="client-sheet" className="text-sm font-medium">
          Their Google Sheet
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="client-sheet"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setRead(null);
            }}
            onBlur={() => url.trim() && !read && void readIt()}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className="h-12 min-w-0 flex-1 rounded-[12px] border border-line bg-bg px-4 text-[16px] outline-none focus:border-brand-text/70 md:text-[14.5px]"
          />
          <button type="button" onClick={() => void readIt()} disabled={!url.trim() || busy !== null} className="min-h-12 rounded-full border border-line px-4 text-[13.5px] text-muted hover:border-faint hover:text-fg disabled:opacity-50">
            {busy === "read" ? "Reading…" : read ? "Read again" : "Read it"}
          </button>
        </div>
        {lastSheet && url === lastSheet && !read && <p className="text-[12px] text-faint">Last week&rsquo;s sheet. Paste a new link if they made a new one.</p>}
      </div>

      {read && (
        <div className="grid gap-2 rounded-[16px] border border-line bg-surface p-4">
          <p className="text-[13.5px] font-medium text-fg [overflow-wrap:anywhere]">{read.title}</p>
          {read.summary && <p className="text-[13px] text-muted">{read.summary}</p>}
          {read.emails.length ? (
            <div className="grid gap-3">
              {read.emails.map((e, i) => (
                <div key={i} className="grid gap-1">
                  <p className="text-[13px] font-medium text-fg [overflow-wrap:anywhere]">
                    Email #{i + 1}: {e.name}
                    {e.send && <span className="font-normal text-faint"> · {e.send}</span>}
                  </p>
                  {e.notes && <p className="text-[12px] text-muted">{e.notes}</p>}
                  <ol className="grid gap-0.5 text-[12.5px]">
                    {e.blocks.map((b, j) => (
                      <li key={j} className="[overflow-wrap:anywhere]">
                        <span className="text-faint">{b.section || `Block ${j}`}</span> <span className="text-fg">{b.promo}</span>
                        {b.button && !/^[-\s]*$/.test(b.button) && <span className="text-muted"> · {b.button}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-faint">No emails found in it yet. Say how many below.</p>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm font-medium">
          Request name
          <input value={name} onChange={(e) => setName(e.target.value)} className="h-11 rounded-[12px] border border-line bg-bg px-3 text-[16px] font-normal outline-none focus:border-faint md:text-[14px]" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Emails in it
          <input inputMode="numeric" value={String(count)} onChange={(e) => setCount(Math.max(1, Math.min(5, Number(e.target.value.replace(/\D/g, "")) || 1)))} className="h-11 w-24 rounded-[12px] border border-line bg-bg px-3 text-center text-[16px] font-normal tabular outline-none focus:border-faint md:text-[14px]" />
          <span className="text-[11.5px] font-normal text-faint">Up to 5 per request; they count against the allotment.</span>
        </label>
      </div>

      <label className="grid gap-1.5 text-sm font-medium">
        Note for the designer <span className="font-normal text-faint">(optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything not in the sheet" className="rounded-[12px] border border-line bg-bg px-3 py-2 text-[16px] font-normal outline-none focus:border-faint md:text-[14px]" />
      </label>

      <div className="grid gap-2">
        <p className="text-sm font-medium">Priority</p>
        <div className="flex flex-wrap gap-2">
          {PRIORITY.map((p) => (
            <button key={p.key} type="button" onClick={() => setPriority(p.key)} className={chip(priority === p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void send()} disabled={!url.trim() || busy !== null} className="inline-flex min-h-12 items-center rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.6)] transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 max-sm:w-full max-sm:justify-center">
          {busy === "send" ? "Sending to the designer…" : "Send to the designer"}
        </button>
        <button type="button" onClick={onPlanNormally} className="min-h-11 text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline">
          Plan one with the strategist instead
        </button>
      </div>
    </section>
  );
}
