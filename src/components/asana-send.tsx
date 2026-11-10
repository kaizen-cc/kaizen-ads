"use client";

import { useEffect, useState } from "react";
import type { PlannedTask, SentTask } from "@/lib/asana-request";
import type { BriefStructure } from "@/lib/brief-pdf-model";

type Res<T> = { ok: true; tasks: T[] } | { ok: false; error: string };

const fmtDate = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "No due date");

/**
 * "Send to Asana": first a preview of exactly what lands on the Creative board (one task per format, as the Google
 * Form makes them: name, column, assignee, due date, fields and the full description), then one click sends it.
 */
export function AsanaSend({
  preview,
  send,
  onSent,
  className = "",
  label = "Send to Asana",
  gate,
  handleRef,
}: {
  preview: () => Promise<Res<PlannedTask>>;
  send: () => Promise<Res<SentTask>>;
  onSent?: (tasks: SentTask[]) => void;
  className?: string;
  label?: string;
  /** Before the preview opens: false holds it (the request form applies a typed correction first) */
  gate?: () => boolean;
  /** Opens the preview from outside, past the gate */
  handleRef?: React.MutableRefObject<{ open: () => void } | null>;
}) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<PlannedTask[] | null>(null);
  const [sent, setSent] = useState<SentTask[] | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setOpen(true);
    setError(null);
    setSent(null);
    setBusy("preview");
    const r = await preview().catch(() => ({ ok: false as const, error: "Couldn't build the Asana task." }));
    setBusy(null);
    if (r.ok) setTasks(r.tasks);
    else setError(r.error);
  };
  const go = async () => {
    setBusy("send");
    setError(null);
    const r = await send().catch(() => ({ ok: false as const, error: "Couldn't send it to Asana." }));
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setSent(r.tasks);
    onSent?.(r.tasks);
  };

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { open: () => void start() };
    return () => {
      handleRef.current = null;
    };
  });

  return (
    <>
      <button type="button" onClick={() => (!gate || gate()) && void start()} className={className || "inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-fg hover:border-faint"}>
        <AsanaMark /> {label}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="Send to Asana">
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div className="relative grid max-h-[92dvh] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-t-[22px] border border-line bg-bg md:rounded-[22px]">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-heading text-[18px]">
                  <AsanaMark /> {sent ? "Sent to Asana" : "Send to the Creative board in Asana"}
                </p>
                <p className="text-[12.5px] text-muted">{sent ? "The creative team sees it like any request from the form." : "Exactly as it will land: the same layout as the Google Form's requests."}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:text-fg" aria-label="Close">
                ✕
              </button>
            </div>
            <div className="grid content-start gap-4 overflow-y-auto px-5 py-4">
              {error && <p className="rounded-[12px] border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p>}
              {busy === "preview" && <div className="h-40 animate-pulse rounded-[16px] bg-surface-2" />}
              {sent
                ? sent.map((t) => (
                    <div key={t.gid} className="grid gap-1 rounded-[16px] border border-ok/40 bg-ok-soft/30 p-4">
                      <p className="text-[14px] font-medium">✓ {t.name}</p>
                      <p className="text-[12.5px] text-muted">{t.assigned ? "Assigned as usual." : "Created unassigned: Asana didn't know the maker's email, so assign it there."}</p>
                      {t.url && (
                        <a href={t.url} target="_blank" rel="noreferrer" className="text-[13px] text-brand-text underline">
                          Open in Asana ↗
                        </a>
                      )}
                    </div>
                  ))
                : (tasks ?? []).map((t) => (
                    <div key={t.name} className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
                      <p className="text-[14.5px] font-medium leading-snug">{t.name}</p>
                      <div className="flex flex-wrap gap-1.5 text-[12px]">
                        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Column: {t.section}</span>
                        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">{t.assignee ? `Assignee: ${t.assignee.name}` : "No designer or editor on the account: unassigned"}</span>
                        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">Due {fmtDate(t.dueOn)}</span>
                        {t.fields.map((f) => (
                          <span key={f.name} className="rounded-full bg-surface-2 px-2.5 py-1 text-muted">
                            {f.name}: {f.value}
                          </span>
                        ))}
                      </div>
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-[12px] bg-bg/60 p-3 font-sans text-[12.5px] leading-relaxed text-muted">{t.notes}</pre>
                    </div>
                  ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-full px-4 text-[14px] text-muted hover:text-fg">
                {sent ? "Done" : "Cancel"}
              </button>
              {!sent && (
                <button type="button" onClick={go} disabled={!tasks?.length || Boolean(busy)} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-50">
                  {busy === "send" ? "Sending…" : `Send ${tasks?.length ?? ""} task${tasks?.length === 1 ? "" : "s"} to Asana`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Downloads the request as a Kaizen-branded PDF. The brief is restructured for it once (onStructure keeps that with the
 *  draft, so the next export of the same brief is instant). */
export function BriefPdfButton({ body, onStructure, className = "" }: { body: () => Record<string, unknown> | Promise<Record<string, unknown>>; onStructure?: (cache: { key: string; structure: BriefStructure }) => void; className?: string }) {
  const [busy, setBusy] = useState<"read" | "make" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={Boolean(busy)}
        onClick={async () => {
          setBusy("read");
          setError(null);
          try {
            const payload = await body();
            const post = (extra: Record<string, unknown>) => fetch("/api/requests/brief-pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, ...extra }) });
            // The brief as a production sheet first (instant when the draft already has it for this brief)
            const sr = await post({ mode: "structure" });
            let cache = payload.pdfCache ?? null;
            if (sr.ok) {
              const kept = (await sr.json()) as { key: string; structure: BriefStructure };
              cache = kept;
              onStructure?.(kept);
            }
            setBusy("make");
            const res = await post({ mode: "pdf", pdfCache: cache });
            if (!res.ok) throw new Error();
            const blob = await res.blob();
            const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "Creative request.pdf";
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch {
            setError("Couldn't make the PDF.");
          }
          setBusy(null);
        }}
        className={className || "inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-fg hover:border-faint disabled:opacity-60"}
      >
        ↓ {busy === "read" ? "Reading the brief…" : busy === "make" ? "Making the PDF…" : "Download PDF"}
      </button>
      {error && <span className="mt-1 text-[12px] text-bad">{error}</span>}
    </span>
  );
}

function AsanaMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <circle cx="12" cy="6.5" r="4" fill="#F06A6A" />
      <circle cx="5.5" cy="16" r="4" fill="#F06A6A" />
      <circle cx="18.5" cy="16" r="4" fill="#F06A6A" />
    </svg>
  );
}
