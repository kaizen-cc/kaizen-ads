"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DRAFT_KIND_LABEL, composeLinks, type DraftKind } from "@/lib/email-drafts/core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { dismissEmailDraft, editEmailDraft, openEmailDraft, scanForEmails } from "../email-draft-actions";
import { closeReviewTodo } from "../../csuite/actions";

// "Emails ready to send": each drafted email with who it's to, why it was drafted, and Open draft (into their Gmail, or
// a prefilled compose), Edit (a sheet, in the address so back closes it), Dismiss. Never sends anything.

type Draft = { id: string; client: string; kind: string; subject: string; body: string; to: string[]; reason: string | null; opened: boolean; files?: { id: string; name: string }[] };

export function EmailsReady({ drafts }: { drafts: Draft[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const editing = useParam("draft");
  const current = drafts.find((d) => d.id === editing) ?? null;

  const open = (d: Draft) =>
    start(async () => {
      const r = await openEmailDraft(d.id);
      if (!r.ok) return setNote(r.error);
      window.open(r.href, "_blank", "noopener");
      setNote(r.where === "gmail" ? "It's in your Gmail drafts, ready to send." : "Opened in a new compose window.");
      router.refresh();
    });

  return (
    <section id="emails-ready" aria-label="Emails ready to send" className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Emails ready to send <span className="tabular text-base text-faint">{drafts.length}</span>
        </h2>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await scanForEmails();
              setNote(r.ok ? (r.added ? `${r.added} new ${r.added === 1 ? "draft" : "drafts"}.` : "Nothing new needs an email.") : r.error);
              router.refresh();
            })
          }
          className="inline-flex h-11 items-center text-xs text-muted hover:text-fg md:h-8"
        >
          {pending ? "Working…" : "Look for more"}
        </button>
      </div>
      {note && (
        <p className="text-xs text-muted" aria-live="polite">
          {note}
        </p>
      )}
      <ul className="grid gap-2">
        {drafts.map((d) => (
          <li key={d.id} className="grid gap-2 rounded-2xl bg-surface-2/50 p-3.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="grid min-w-0 gap-0.5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="rounded-full bg-brand-soft px-2 py-0.5 font-medium text-brand-text">{DRAFT_KIND_LABEL[d.kind as DraftKind] ?? "Email"}</span>
                <span>{d.client}</span>
                {d.opened && <span className="text-ok">opened</span>}
              </div>
              <p className="truncate text-sm font-medium">{d.subject}</p>
              {d.reason && <p className="line-clamp-1 text-xs text-muted">{d.reason}</p>}
              {/* Files that go with it: attached when it opens in Gmail; download one to attach it by hand otherwise */}
              {d.files?.length ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {d.files.map((f) => (
                    <a key={f.id} href={`/api/documents/${f.id}?download=1`} className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[11.5px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-7">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
                      </svg>
                      <span className="truncate">{f.name}</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={pending} onClick={() => open(d)} className="inline-flex h-11 items-center rounded-full bg-fg px-3.5 text-xs font-medium text-bg disabled:opacity-50 md:h-8">
                Open draft
              </button>
              <button type="button" onClick={() => pushParams({ draft: d.id })} className="inline-flex h-11 items-center rounded-full border border-line px-3 text-xs text-muted hover:text-fg md:h-8">
                Edit
              </button>
              <button type="button" disabled={pending} onClick={() => start(async () => void (await dismissEmailDraft(d.id), router.refresh()))} className="inline-flex h-11 items-center rounded-full px-3 text-xs text-faint hover:text-fg md:h-8">
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
      {current && <EditSheet key={current.id} d={current} onClose={() => closeParams("draft")} onSaved={() => router.refresh()} />}
    </section>
  );
}

function EditSheet({ d, onClose, onSaved }: { d: Draft; onClose: () => void; onSaved: () => void }) {
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const field = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand-text/70";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-fg/25 md:items-center" onClick={onClose} role="presentation">
      <div role="dialog" aria-label={`Edit the email to ${d.client}`} onClick={(e) => e.stopPropagation()} className="grid max-h-[92dvh] w-full max-w-2xl gap-3 overflow-y-auto rounded-t-[22px] border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:rounded-[22px]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">To {d.client}</p>
            <p className="text-xs text-muted">{d.to.length ? d.to.join(", ") : "No contact on file: add one on the client page"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-8 md:w-8">
            ✕
          </button>
        </div>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" className={field} />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} aria-label="Message" className={`${field} leading-relaxed`} />
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(`${subject}\n\n${body}`).then(() => setCopied(true));
            }}
            className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <a href={composeLinks({ to: d.to, subject, body }).mailto} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:h-9">
            Mail app
          </a>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await editEmailDraft(d.id, subject, body);
                if (!r.ok) return setError(r.error);
                onSaved();
                onClose();
              })
            }
            className="inline-flex h-11 items-center rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-50 md:h-9"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReviewTodos({ todos }: { todos: { id: string; title: string; due: string | null; client: string | null }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return (
    <section aria-label="From the account review" className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <h2 className="font-heading text-xl">
        From the account review <span className="tabular text-base text-faint">{todos.length}</span>
      </h2>
      <ul className="grid gap-1.5">
        {todos.map((t) => (
          <li key={t.id} className="flex items-start gap-3 rounded-xl px-1 py-1.5">
            <button type="button" disabled={pending} aria-label="Mark done" onClick={() => start(async () => void (await closeReviewTodo(t.id, "done"), router.refresh()))} className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line hover:border-ok hover:bg-ok-soft" />
            <div className="grid min-w-0 gap-0.5">
              <p className="text-sm">{t.title}</p>
              <p className={`tabular text-xs ${t.due && t.due < today ? "text-bad" : "text-muted"}`}>
                {t.due ? `Due ${new Date(`${t.due}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "No due date"}
                {t.client ? ` · ${t.client}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
