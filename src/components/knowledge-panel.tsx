"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Upload } from "tus-js-client";
import { knowledgeUploadSlots, removeKnowledge, rereadKnowledge, saveKnowledge, setKnowledgeBackground } from "@/app/(team)/knowledge-actions";
import type { KnowledgeDoc, KnowledgeTarget } from "@/lib/knowledge";
import { createClient } from "@/lib/supabase/client";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// Knowledge files for an agent, every agent, the Ads Lab or a client: drop PDFs (or Word, PowerPoint, pictures of
// documents, text files), they upload straight to storage in resumable chunks, and each is read in the background
// into its text, a summary and key points. The agents read only the parts that match what they're doing.

const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.json,.html,image/png,image/jpeg,image/webp";
const MAX = 50 * 1024 * 1024;
const endpoint = () => `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(".supabase.co", ".storage.supabase.co")}/storage/v1/upload/resumable`;

/** One file to storage: resumable in 6 MB chunks with the signed slot; the plain signed upload if that isn't accepted */
async function upload(file: File, path: string, token: string, onBytes: (n: number) => void) {
  const tus = () =>
    new Promise<void>((resolve, reject) => {
      const u = new Upload(file, {
        endpoint: endpoint(),
        retryDelays: [0, 3000, 5000, 10000],
        headers: { "x-signature": token, apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        metadata: { bucketName: "knowledge", objectName: path, contentType: file.type || "application/octet-stream", cacheControl: "3600" },
        chunkSize: 6 * 1024 * 1024,
        onError: reject,
        onProgress: (sent) => onBytes(sent),
        onSuccess: () => resolve(),
      });
      u.start();
    });
  try {
    await tus();
  } catch {
    const { error } = await createClient().storage.from("knowledge").uploadToSignedUrl(path, token, file, { contentType: file.type || "application/octet-stream" });
    if (error) throw new Error(error.message);
    onBytes(file.size);
  }
}

const size = (b: number | null) => (b == null ? "" : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const kindOf = (d: KnowledgeDoc) => {
  if (d.mime === "text/x-loom") return "Loom";
  const ext = d.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || d.mime === "application/pdf") return "PDF";
  if (ext === "docx") return "Word";
  if (ext === "pptx") return "Slides";
  if (ext === "xlsx") return "Sheet";
  if (d.mime?.startsWith("image/")) return "Image";
  return ext.toUpperCase() || "File";
};

export function KnowledgePanel({
  target,
  docs,
  canEdit,
  title = "Knowledge files",
  description,
  compact = false,
}: {
  target: KnowledgeTarget;
  docs: KnowledgeDoc[];
  canEdit: boolean;
  title?: string;
  description?: string;
  /** A small list (the Ads Lab side column) */
  compact?: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState<{ name: string; pct: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const reading = docs.some((d) => d.status === "reading");

  // While anything is being read, the list follows it
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [reading, router]);

  const add = async (list: FileList | File[]) => {
    const files = [...list].slice(0, 10);
    if (!files.length) return;
    setError(null);
    const big = files.find((f) => f.size > MAX);
    if (big) return setError(`"${big.name}" is over 50 MB.`);
    setSending(files.map((f) => ({ name: f.name, pct: 0 })));
    try {
      const slots = await knowledgeUploadSlots(target, files.map((f) => ({ name: f.name, bytes: f.size })));
      if (!slots.ok) throw new Error(slots.error);
      await Promise.all(files.map((f, i) => upload(f, slots.slots[i].path, slots.slots[i].token, (n) => setSending((s) => s.map((x, k) => (k === i ? { ...x, pct: Math.round((n / Math.max(1, f.size)) * 100) } : x))))));
      const saved = await saveKnowledge(target, files.map((f, i) => ({ path: slots.slots[i].path, name: f.name, mime: f.type, bytes: f.size })));
      if (!saved.ok) throw new Error(saved.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload didn't go through. Try again.");
    } finally {
      setSending([]);
    }
  };

  const shown = compact ? docs.slice(0, 6) : docs;
  return (
    <section
      className={`grid gap-3 ${compact ? "" : "rounded-[22px] border border-line bg-surface p-4 md:p-6"}`}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(false);
        void add(e.dataTransfer.files);
      }}
    >
      {!compact && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="font-heading text-[20px] leading-tight">{title}</h2>
            {description && <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">{description}</p>}
          </div>
          {docs.length > 0 && <span className="tabular text-[12px] text-faint">{docs.filter((d) => d.status === "ready").length} read</span>}
        </div>
      )}

      {canEdit && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={sending.length > 0}
          className={`group grid w-full place-items-center gap-1 rounded-[16px] border border-dashed px-4 text-center transition-colors disabled:opacity-70 ${compact ? "min-h-11 py-2" : "min-h-[96px] py-5"} ${dragging ? "border-brand bg-brand-soft" : "border-line hover:border-faint hover:bg-surface-2/50"}`}
        >
          <span className={`font-medium ${compact ? "text-[12.5px]" : "text-[14px]"}`}>{sending.length ? "Uploading…" : compact ? "+ Add PDFs and documents" : "Drop PDFs here, or choose files"}</span>
          {!compact && !sending.length && <span className="text-[12px] text-faint">PDF, Word, PowerPoint, Excel, pictures of documents or text · up to 50 MB each</span>}
          <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && void add(e.target.files).then(() => (e.target.value = ""))} />
        </button>
      )}
      {sending.length > 0 && (
        <div className="grid gap-1.5">
          {sending.map((s) => (
            <div key={s.name} className="grid gap-1">
              <div className="flex justify-between gap-3 text-[12px] text-muted">
                <span className="truncate">{s.name}</span>
                <span className="tabular">{s.pct}%</span>
              </div>
              <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${s.pct}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}

      {shown.length > 0 ? (
        <ul className="grid gap-2">
          {shown.map((d) => (
            <DocRow key={d.id} d={d} target={target} canEdit={canEdit} compact={compact} />
          ))}
        </ul>
      ) : (
        !compact && <p className="text-[13px] text-faint">Nothing added yet.</p>
      )}
    </section>
  );
}

function DocRow({ d, target, canEdit, compact }: { d: KnowledgeDoc; target: KnowledgeTarget; canEdit: boolean; compact: boolean }) {
  const router = useRouter();
  const openId = useParam("kdoc");
  const open = openId === d.id;
  const [busy, setBusy] = useState(false);
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) alert(r.error);
    router.refresh();
  };
  const name = d.title || d.name;
  return (
    <li className={`grid gap-2 rounded-[14px] border p-3 ${d.background ? "border-dashed border-line opacity-75" : "border-line bg-bg/40"} ${compact ? "text-[12.5px]" : ""}`}>
      <button type="button" onClick={() => (open ? closeParams("kdoc") : pushParams({ kdoc: d.id }))} className="flex w-full items-start gap-3 text-left" aria-expanded={open}>
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{kindOf(d)}</span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-[14px] font-medium">{name}</span>
          <span className="flex flex-wrap gap-x-2 text-[11.5px] text-faint">
            {d.pages ? <span>{d.pages} {d.pages === 1 ? "page" : "pages"}</span> : null}
            {d.bytes ? <span>{size(d.bytes)}</span> : null}
            <span>{d.by ? `${d.by} · ` : ""}{when(d.at)}</span>
            {d.background && <span>Background</span>}
          </span>
          {d.status === "ready" && d.summary && !open && <span className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">{d.summary}</span>}
        </span>
        <Status d={d} />
      </button>
      {d.status === "reading" && (
        <span className="h-1 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.max(6, d.progress)}%` }} />
        </span>
      )}
      {d.status === "failed" && d.note && <p className="text-[12px] text-bad">{d.note}</p>}
      {open && (
        <div className="grid gap-2 border-t border-line pt-2">
          {d.summary && <p className="text-[13px] leading-relaxed text-muted">{d.summary}</p>}
          {d.keyPoints.length > 0 && (
            <ul className="grid gap-1 text-[13px]">
              {d.keyPoints.map((k, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-brand-text">•</span>
                  <span>{k}</span>
                </li>
              ))}
            </ul>
          )}
          {d.method && d.status === "ready" && (
            <p className="text-[11.5px] text-faint">
              {d.method === "loom" ? "From the Loom's transcript" : d.method === "ai" ? "Read by the AI page by page (a scan or picture)" : "Read from the file's own text"}
              {d.name !== name ? ` · ${d.name}` : ""}
              {d.url && (
                <>
                  {" · "}
                  <a href={d.url.replace(/#.*$/, "")} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
                    Watch
                  </a>
                </>
              )}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || d.status === "reading"} onClick={() => act(rereadKnowledge(d.id))} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
                Read again
              </button>
              {target.scope === "client" ? (
                <button type="button" disabled={busy} onClick={() => act(setKnowledgeBackground(d.id, !d.background))} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
                  {d.background ? "Bring back to the front" : "Set as background"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove "${name}"? The agents won't read it any more.`)) void act(removeKnowledge(d.id));
                  }}
                  className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-bad disabled:opacity-50 md:min-h-9"
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Status({ d }: { d: KnowledgeDoc }) {
  if (d.status === "reading") return <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand-text">Reading {d.progress ? `${d.progress}%` : "…"}</span>;
  if (d.status === "failed") return <span className="shrink-0 rounded-full bg-bad-soft px-2.5 py-1 text-[11px] font-medium text-bad">Couldn&rsquo;t read</span>;
  return <span className="shrink-0 rounded-full bg-ok-soft px-2.5 py-1 text-[11px] font-medium text-ok">Ready</span>;
}
