"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { copyEmailHeading, copyGroupName, type CopyComment } from "@/lib/copy-docs/core";
import type { CopyDoc } from "@/lib/copy-docs/server";
import { approveCopy, askForChange, commentOnLine, copyVersion, editLine, requestCopy, resolveComment } from "../actions";

// The copy document view: reads like the email it will become, every line tappable to comment on, the lines the last
// revision changed marked, a note box to ask the AI copywriter for a change, and the steps after: Approve (the Google
// Doc in the client's Drive), then Create in Asana (Kaizen OS requests coming soon). A change made on a call (by voice
// or in the chat) shows up here on its own. Each line can also be rewritten by hand (Edit): the strategist's edits and
// comments are kept and teach the copywriter (this client's lesson, or every client's when it's about the craft).
// Inside another page (the email request form) it reloads through onReload instead of refreshing the page.

const KIND: Record<string, string> = { campaign: "Email campaign", flow: "Email flow", sms: "SMS", creative: "Ad creative brief", social: "Organic social" };

export function CopyDocView({
  doc: start,
  changed: firstChanged,
  requests: firstRequests,
  onReload,
  onRequested,
  embedded = false,
}: {
  doc: CopyDoc;
  changed: string[];
  me: string;
  requests: { name: string; url: string }[];
  /** Inside another page: load the copy again (instead of refreshing the page) */
  onReload?: () => void;
  /** The Asana request was made */
  onRequested?: (tasks: { name: string; url: string }[]) => void;
  /** Inside another page: no outer page margins */
  embedded?: boolean;
}) {
  const router = useRouter();
  const reload = () => (onReload ? onReload() : startTransition(() => router.refresh()));
  const [doc, setDoc] = useState(start);
  const changed = firstChanged;
  const [comments, setComments] = useState<CopyComment[]>(start.comments);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState(firstRequests);
  const [followerNote, setFollowerNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "revise" | "approve" | "request">(null);
  const [, startTransition] = useTransition();

  // A change made on a call or in the chat shows up here
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const v = await copyVersion(doc.id).catch(() => null);
      if (v && (v.version !== start.version || v.status !== doc.status)) {
        if (onReload) onReload();
        else startTransition(() => router.refresh());
      }
    }, 6000);
    return () => clearInterval(t);
  }, [doc.id, doc.status, start.version, router, onReload]);

  const openFor = (anchor: string) => comments.filter((c) => c.anchor === anchor);
  const unresolved = comments.filter((c) => !c.resolved).length;

  const revise = async () => {
    setBusy("revise");
    setError(null);
    const r = await askForChange(doc.id, note);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setNote("");
    reload();
  };
  const approve = async () => {
    setBusy("approve");
    setError(null);
    const r = await approveCopy(doc.id);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setDoc((d) => ({ ...d, status: "approved", docUrl: r.docUrl }));
  };
  const request = async () => {
    setBusy("request");
    setError(null);
    const r = await requestCopy(doc.id, "asana");
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setRequests(r.tasks);
    setFollowerNote(r.followerMissing);
    setDoc((d) => ({ ...d, status: "requested" }));
    onRequested?.(r.tasks);
  };

  const c = doc.content;
  const b = c.brief;
  const why = doc.versions.at(-1)?.why;

  return (
    <div className={`grid w-full gap-6 pb-40 ${embedded ? "" : "mx-auto max-w-3xl"}`}>
      <header className="relative grid gap-3 overflow-hidden rounded-[24px] border border-line bg-surface p-5 shadow-sm md:p-7">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-brand opacity-[0.09] blur-3xl" />
        <p className="relative text-[11px] font-medium uppercase tracking-[0.16em] text-brand-text">
          {KIND[c.kind] ?? "Copy"} · {c.emails.length} {c.kind === "sms" ? "text" : c.kind === "social" ? "post" : c.kind === "creative" ? "concept" : "email"}
          {c.emails.length === 1 ? "" : "s"} · v{doc.version}
        </p>
        <h1 className="relative font-display text-[26px] leading-tight tracking-tight text-fg [overflow-wrap:anywhere] md:text-[34px]">{c.title}</h1>
        {doc.client && <p className="relative text-[13px] text-muted">{doc.client}</p>}
        <div className="relative flex flex-wrap items-center gap-2 pt-1">
          <StatusPill status={doc.status} />
          {doc.version > 1 && changed.length > 0 && (
            <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11.5px] text-brand-text">
              {changed.length} line{changed.length === 1 ? "" : "s"} changed in v{doc.version}
              {why ? `: ${why}` : ""}
            </span>
          )}
          {unresolved > 0 && <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11.5px] text-fg">{unresolved} open comment{unresolved === 1 ? "" : "s"}</span>}
        </div>
        <NextSteps doc={doc} busy={busy} requests={requests} followerNote={followerNote} onApprove={approve} onRequest={request} />
      </header>

      {(b.goal || b.audience || b.sendAt || b.offer || b.rules.length > 0) && (
        <section aria-label="The brief" className="grid gap-3 rounded-[20px] border border-line bg-surface-2/50 p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">The brief</p>
          <dl className="grid gap-2.5 text-[14px] leading-relaxed sm:grid-cols-2">
            {[
              ["Goal", b.goal],
              ["Audience", b.audience],
              ["Send", [b.sendAt, b.sendDate].filter(Boolean).join(" · ")],
              ["Offer", b.offer],
              ["Design direction", b.designDirection],
              ["Assets", b.assets],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="grid gap-0.5">
                  <dt className="text-[11.5px] text-faint">{k}</dt>
                  <dd className="text-fg [overflow-wrap:anywhere]">{v}</dd>
                </div>
              ))}
          </dl>
          {b.rules.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {b.rules.map((r) => (
                <li key={r} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-muted">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {c.emails.map((e, i) => (
        <article key={i} aria-label={e.name} className="grid gap-1 overflow-hidden rounded-[22px] border border-line bg-surface shadow-sm">
          <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
            {/* Email copy: each email by Kaizen's naming convention (the Template Library), its own name beneath */}
            {c.kind === "campaign" || c.kind === "flow" || c.kind === "sms" ? (
              <span className="grid min-w-0">
                <h2 className="text-[15px] font-semibold text-fg [overflow-wrap:anywhere]">{copyEmailHeading(doc.client ?? "Client", copyGroupName(c), c.kind, i)}</h2>
                <span className="text-[12px] text-faint">{e.name}</span>
              </span>
            ) : (
              <h2 className="text-[15px] font-semibold text-fg">{e.name}</h2>
            )}
            {e.timing && <span className="text-[12px] text-faint">{e.timing}</span>}
          </div>
          <div className="grid gap-0.5 px-2 py-2 md:px-3">
            {e.subject && <Line anchor={`e${i}.subject`} label="Subject" text={e.subject} strong {...{ open, setOpen, changed, comments: openFor(`e${i}.subject`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />}
            {e.preview && <Line anchor={`e${i}.preview`} label="Preview text" text={e.preview} muted {...{ open, setOpen, changed, comments: openFor(`e${i}.preview`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />}
            {e.sections.map((s, j) => (
              <div key={j} className="grid gap-0.5 pt-2">
                {s.heading && <Line anchor={`e${i}.s${j}.heading`} text={s.heading} heading {...{ open, setOpen, changed, comments: openFor(`e${i}.s${j}.heading`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />}
                {s.body && <Line anchor={`e${i}.s${j}.body`} text={s.body} {...{ open, setOpen, changed, comments: openFor(`e${i}.s${j}.body`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />}
              </div>
            ))}
            {e.cta && (
              <div className="px-3 pt-3">
                <Line anchor={`e${i}.cta`} text={e.cta.label} button {...{ open, setOpen, changed, comments: openFor(`e${i}.cta`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />
              </div>
            )}
          </div>
          {e.designNotes.length > 0 && (
            <div className="mx-3 mb-3 grid gap-1 rounded-[14px] bg-surface-2/70 p-3">
              <p className="px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-faint">For the designer</p>
              {e.designNotes.map((n, j) => (
                <Line key={j} anchor={`e${i}.d${j}`} text={n} muted {...{ open, setOpen, changed, comments: openFor(`e${i}.d${j}`), docId: doc.id, setComments, editable: doc.status !== "requested", onEdited: reload }} />
              ))}
            </div>
          )}
        </article>
      ))}

      {error && (
        <p role="alert" className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">
          {error}
        </p>
      )}

      {doc.status === "draft" && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 px-4 pb-safe pt-3 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2 pb-3">
            <label className="sr-only" htmlFor="copy-note">
              Ask for a change
            </label>
            <textarea
              id="copy-note"
              value={note}
              rows={1}
              onChange={(e) => setNote(e.target.value)}
              placeholder={unresolved ? `Ask for a change, or apply the ${unresolved} comment${unresolved === 1 ? "" : "s"}` : "Ask for a change: “make the subject punchier”"}
              className="max-h-40 min-h-11 flex-1 resize-none rounded-[16px] border border-line bg-surface px-4 py-2.5 text-[16px] leading-snug text-fg outline-none transition-colors focus:border-faint md:text-[14px]"
            />
            <button type="button" onClick={revise} disabled={busy !== null || (!note.trim() && !unresolved)} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-brand px-4 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50">
              {busy === "revise" ? "Revising…" : note.trim() ? "Revise" : "Apply comments"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: CopyDoc["status"] }) {
  const s = status === "requested" ? { t: "Requested", c: "bg-ok-soft text-ok" } : status === "approved" ? { t: "Approved", c: "bg-ok-soft text-ok" } : { t: "Draft for review", c: "bg-surface-2 text-muted" };
  return <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ${s.c}`}>{s.t}</span>;
}

function NextSteps({ doc, busy, requests, followerNote, onApprove, onRequest }: { doc: CopyDoc; busy: string | null; requests: { name: string; url: string }[]; followerNote: string | null; onApprove: () => void; onRequest: () => void }) {
  const btn = "inline-flex min-h-11 items-center rounded-full px-4 text-[13.5px] font-medium transition active:scale-[0.98] disabled:opacity-50 md:min-h-10";
  if (doc.status === "draft")
    return (
      <div className="relative flex flex-wrap gap-2 pt-2">
        <button type="button" onClick={onApprove} disabled={busy !== null} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
          {busy === "approve" ? "Saving to their Drive…" : "Approve"}
        </button>
        <span className="self-center text-[12px] text-faint">Approving saves it as a Google Doc in their Drive, under Email Marketing.</span>
      </div>
    );
  return (
    <div className="relative grid gap-2 pt-2">
      <div className="flex flex-wrap gap-2">
        {doc.docUrl && (
          <a href={doc.docUrl} target="_blank" rel="noopener noreferrer" className={`${btn} border border-line text-fg hover:border-faint`}>
            Open the Google Doc
          </a>
        )}
        {!requests.length && doc.status === "approved" && (
          <>
            <button type="button" onClick={onRequest} disabled={busy !== null} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
              {busy === "request" ? "Creating in Asana…" : "Create in Asana"}
            </button>
            <button type="button" disabled className={`${btn} border border-dashed border-line text-faint`} title="Kaizen OS requests are coming soon">
              Kaizen OS · soon
            </button>
          </>
        )}
      </div>
      {(requests.length > 0 || doc.asanaUrl) && (
        <ul className="grid gap-1.5">
          {(requests.length ? requests : [{ name: "The Asana request", url: doc.asanaUrl! }]).map((r) => (
            <li key={r.url}>
              <a href={r.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-[12px] border border-line px-3 py-2 text-[13px] text-fg transition-colors hover:border-faint [overflow-wrap:anywhere]">
                <span aria-hidden className="text-brand-text">↗</span>
                {r.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      {followerNote && <p className="text-[12px] text-muted">{followerNote}</p>}
    </div>
  );
}

type LineProps = {
  anchor: string;
  text: string;
  label?: string;
  strong?: boolean;
  muted?: boolean;
  heading?: boolean;
  button?: boolean;
  open: string | null;
  setOpen: (a: string | null) => void;
  changed: string[];
  comments: CopyComment[];
  docId: string;
  setComments: (c: CopyComment[]) => void;
  /** The line can be rewritten by hand */
  editable?: boolean;
  /** A hand edit was saved (the next version) */
  onEdited?: () => void;
};

/** One line of the copy: tap to comment; marked when the last revision changed it */
function Line({ anchor, text, label, strong, muted, heading, button, open, setOpen, changed, comments, docId, setComments, editable = false, onEdited }: LineProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const saveEdit = async () => {
    if (editing == null || !editing.trim()) return;
    setSaving(true);
    setEditError(null);
    const r = await editLine(docId, anchor, editing);
    setSaving(false);
    if (!r.ok) return setEditError(r.error);
    setEditing(null);
    onEdited?.();
  };
  const isOpen = open === anchor;
  const isNew = changed.includes(anchor);
  const live = comments.filter((c) => !c.resolved);
  const send = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    const r = await commentOnLine(docId, { anchor, quote: text.slice(0, 200), text: draft });
    setSaving(false);
    if (r.ok) {
      setComments(r.comments);
      setDraft("");
    }
  };
  const tone = heading ? "text-[17px] font-semibold leading-snug" : strong ? "text-[15px] font-semibold" : muted ? "text-[13.5px] text-muted" : "text-[14.5px] leading-relaxed";
  return (
    <div className={`group relative rounded-[12px] transition-colors ${isOpen ? "bg-surface-2/70" : "hover:bg-surface-2/40"} ${isNew ? "ring-1 ring-brand/40" : ""}`}>
      <button type="button" onClick={() => setOpen(isOpen ? null : anchor)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-3 py-2 text-left">
        {label && <span className="mt-0.5 w-24 shrink-0 text-[11.5px] text-faint">{label}</span>}
        {button ? (
          <span className="inline-flex rounded-full bg-brand px-4 py-2 text-[13.5px] font-medium text-white">{text}</span>
        ) : (
          <span className={`min-w-0 flex-1 whitespace-pre-line text-fg [overflow-wrap:anywhere] ${tone}`}>{text}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pt-0.5">
          {isNew && <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand-text">New</span>}
          {live.length > 0 && <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-fg">{live.length}</span>}
        </span>
      </button>
      {isOpen && (
        <div className="grid gap-2 px-3 pb-3">
          {editable &&
            (editing == null ? (
              <button type="button" onClick={() => setEditing(text)} className="justify-self-start rounded-full border border-line px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-faint hover:text-fg">
                Edit this line
              </button>
            ) : (
              <div className="grid gap-2">
                <textarea
                  value={editing}
                  autoFocus
                  onChange={(e) => setEditing(e.target.value)}
                  rows={Math.min(8, Math.max(2, Math.ceil(editing.length / 60)))}
                  aria-label="Edit the line"
                  className="w-full resize-y rounded-[12px] border border-brand/40 bg-surface px-3 py-2 text-[16px] leading-relaxed text-fg outline-none focus:border-brand md:text-[14px]"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={saveEdit} disabled={saving || !editing.trim()} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50 md:min-h-9">
                    {saving ? "Saving…" : "Save edit"}
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
                    Cancel
                  </button>
                  <span className="text-[11.5px] text-faint">The copywriter learns from your edit.</span>
                </div>
                {editError && <p className="text-[12.5px] text-bad">{editError}</p>}
              </div>
            ))}
          {comments.map((c) => (
            <div key={c.id} className={`flex items-start gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] ${c.resolved ? "opacity-60" : ""}`}>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="font-medium text-fg">{c.byName.split(" ")[0]}</span> <span className="text-muted">{c.text}</span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  const r = await resolveComment(docId, c.id, !c.resolved);
                  if (r.ok) setComments(r.comments);
                }}
                className="shrink-0 text-[12px] text-faint hover:text-fg"
              >
                {c.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
          ))}
          <div className="flex items-end gap-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} placeholder="Comment on this line" className="min-h-11 flex-1 resize-none rounded-[12px] border border-line bg-surface px-3 py-2 text-[16px] text-fg outline-none focus:border-faint md:text-[13.5px]" />
            <button type="button" onClick={send} disabled={saving || !draft.trim()} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-fg transition-colors hover:border-faint disabled:opacity-50">
              {saving ? "Saving…" : "Comment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
