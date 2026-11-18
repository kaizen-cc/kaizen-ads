"use client";

import { fileSize, historyLine, linkify, type AsanaAttachment, type AsanaComment, type AsanaHistoryItem, type AsanaSubtask } from "@/lib/asana-context";

const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const Heading = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</p>;

/** Text with its line breaks and working links */
export function LinkedText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <p className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>
      {linkify(text).map((p, i) =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="text-brand-text underline underline-offset-2 hover:text-fg">
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

/** Everything the Asana task carries, read-only: description, fields, subtasks, attachments, comments and history */
export function AsanaContext({ notes, fields, subtasks, attachments, comments, history }: { notes: string | null; fields: Record<string, string>; subtasks: AsanaSubtask[]; attachments: AsanaAttachment[]; comments: AsanaComment[]; history: AsanaHistoryItem[] }) {
  const field = Object.entries(fields);
  return (
    <div className="grid gap-5 max-md:[overflow-wrap:anywhere]">
      {notes?.trim() && (
        <section className="grid gap-2">
          <Heading>Description in Asana</Heading>
          <LinkedText text={notes} className="rounded-[12px] border border-line bg-surface p-4 text-[13px] leading-relaxed text-muted" />
        </section>
      )}
      {field.length > 0 && (
        <section className="grid gap-2">
          <Heading>Asana fields</Heading>
          <dl className="grid gap-1 text-[13px]">
            {field.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 md:grid-cols-[140px_minmax(0,1fr)]">
                <dt className="text-faint">{k}</dt>
                <dd className="text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {subtasks.length > 0 && (
        <section className="grid gap-2">
          <Heading>
            Subtasks · {subtasks.filter((s) => s.done).length} of {subtasks.length} done
          </Heading>
          <ul className="grid gap-1.5 text-[13px]">
            {subtasks.map((s) => (
              <li key={s.gid} className="flex items-start gap-2.5 rounded-[10px] border border-line px-3 py-2">
                <span aria-hidden className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${s.done ? "border-ok bg-ok-soft text-ok" : "border-line text-transparent"}`}>
                  ✓
                </span>
                <span className="grid min-w-0 gap-0.5">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className={`hover:underline ${s.done ? "text-faint line-through" : "text-fg"}`}>
                      {s.name}
                    </a>
                  ) : (
                    <span className={s.done ? "text-faint line-through" : "text-fg"}>{s.name}</span>
                  )}
                  {(s.assignee || s.dueOn) && <span className="text-xs text-faint">{[s.assignee, s.dueOn ? `due ${s.dueOn}` : null].filter(Boolean).join(" · ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {attachments.length > 0 && (
        <section className="grid gap-2">
          <Heading>Attachments · {attachments.length}</Heading>
          <ul className="grid gap-1.5 text-[13px]">
            {attachments.map((a) => (
              <li key={a.gid} className="flex items-center justify-between gap-3 rounded-[10px] border border-line px-3 py-2">
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-fg hover:underline max-md:py-1">
                    {a.name}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-fg">{a.name}</span>
                )}
                <span className="shrink-0 text-xs text-faint">{[a.host && a.host !== "asana" ? a.host : null, fileSize(a.size)].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {comments.length > 0 && (
        <section className="grid gap-2">
          <Heading>Comments in Asana · {comments.length}</Heading>
          <ul className="grid gap-2">
            {comments.map((c, i) => (
              <li key={i} className="grid gap-1 rounded-[12px] border border-line p-3 text-[13px]">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-faint">
                  <b className="font-medium text-muted">{c.by ?? "Someone"}</b>
                  <span>{stamp(c.at)}</span>
                </span>
                <LinkedText text={c.text} className="leading-relaxed text-fg/80" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {history.length > 0 && (
        <section className="grid gap-2">
          <Heading>History in Asana</Heading>
          <ul className="grid gap-1 text-xs text-muted">
            {history
              .slice()
              .reverse()
              .map((h, i) => (
                <li key={i}>
                  <span className="text-faint">{stamp(h.at)}</span> · {historyLine(h)}
                  {h.by ? <span className="text-faint"> · {h.by}</span> : null}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
