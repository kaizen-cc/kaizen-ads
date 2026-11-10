"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { briefFileSlots } from "@/app/(team)/brief-file-actions";
import { BRIEF_BUCKET, BRIEF_FILE_ACCEPT, KIND_WORD, MAX_BRIEF_FILES, briefFileKind, briefFileProblem, clock, type BriefFile, type BriefFileKind } from "@/lib/brief-files";
import { createClient } from "@/lib/supabase/client";

// Files added to a brief's conversation (Talk it through, "Tell me what to change"): an attach button (44px on phones),
// drag and drop on desktop, each file uploaded as it's picked (a video watched here first: a few frames and its length,
// audio its length) and shown as a chip with its picture until the message goes. src/lib/brief-files.ts has the rules.

export type AttachItem = { key: string; name: string; kind: BriefFileKind; status: "uploading" | "ready" | "failed"; preview: string | null; note: string | null; file: BriefFile | null };

const FRAMES = 4;
const SIDE = 768;

/** A few frames through a video and its length, read here (nothing is processed on the server) */
async function readVideo(file: File): Promise<{ frames: Blob[]; seconds: number | null }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  try {
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.src = url;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 15000);
      v.onloadeddata = () => (clearTimeout(t), resolve());
      v.onerror = () => (clearTimeout(t), reject(new Error("unreadable")));
    });
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const scale = Math.min(1, SIDE / Math.max(v.videoWidth || SIDE, v.videoHeight || SIDE));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((v.videoWidth || SIDE) * scale));
    canvas.height = Math.max(1, Math.round((v.videoHeight || SIDE) * scale));
    const ctx = canvas.getContext("2d");
    const frames: Blob[] = [];
    if (ctx && dur > 0)
      for (let i = 0; i < FRAMES; i++) {
        const at = i === 0 ? Math.min(0.5, dur / 2) : (dur * (i + 0.5)) / FRAMES;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 4000);
          v.onseeked = () => (clearTimeout(t), resolve());
          v.currentTime = Math.min(at, Math.max(0, dur - 0.05));
        });
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const b = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
        if (b) frames.push(b);
      }
    return { frames, seconds: dur || null };
  } catch {
    return { frames: [], seconds: null };
  } finally {
    v.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

/** An audio file's length */
async function readAudio(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = url;
    return await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      a.onloadedmetadata = () => (clearTimeout(t), resolve(Number.isFinite(a.duration) ? a.duration : null));
      a.onerror = () => (clearTimeout(t), resolve(null));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The files of one message: added, uploaded as they're picked, the ready ones handed over when it's sent */
export function useBriefFiles(clientId: string | null) {
  const [items, setItems] = useState<AttachItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const previews = useRef<string[]>([]);
  // How many files this message has (kept here too, so several picked at once are counted as they're added)
  const count = useRef(0);
  useEffect(() => {
    count.current = items.length;
  }, [items.length]);
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const add = useCallback(
    async (list: FileList | File[]) => {
      setError(null);
      if (!clientId) return setError("Pick a client first.");
      const picked = Array.from(list);
      for (const file of picked) {
        const why = briefFileProblem({ name: file.name, mime: file.type, bytes: file.size });
        if (why) {
          setError(why);
          continue;
        }
        const kind = briefFileKind(file.type, file.name)!;
        const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (count.current >= MAX_BRIEF_FILES) {
          setError(`Up to ${MAX_BRIEF_FILES} files at a time.`);
          break;
        }
        count.current++;
        const preview = kind === "image" ? URL.createObjectURL(file) : null;
        if (preview) previews.current.push(preview);
        setItems((xs) => [...xs, { key, name: file.name, kind, status: "uploading", preview, note: kind === "video" ? "Watching it…" : null, file: null }]);
        try {
          let frames: Blob[] = [];
          let seconds: number | null = null;
          if (kind === "video") {
            ({ frames, seconds } = await readVideo(file));
            const first = frames[0] ? URL.createObjectURL(frames[0]) : null;
            if (first) previews.current.push(first);
            setItems((xs) => xs.map((x) => (x.key === key ? { ...x, preview: first, note: "Uploading…" } : x)));
          } else if (kind === "audio") seconds = await readAudio(file);
          const mime = file.type || (kind === "pdf" ? "application/pdf" : "application/octet-stream");
          const specs = [{ name: file.name, mime, bytes: file.size, role: "file" as const }, ...frames.map((b, i) => ({ name: `${i}.jpg`, mime: "image/jpeg", bytes: b.size, role: "frame" as const }))];
          const r = await briefFileSlots(clientId, specs);
          if (!r.ok) throw new Error(r.error);
          const supabase = createClient();
          const blobs: Blob[] = [file, ...frames];
          await Promise.all(
            blobs.map(async (b, i) => {
              const { error: e } = await supabase.storage.from(BRIEF_BUCKET).uploadToSignedUrl(r.slots[i].path, r.slots[i].token, b, { contentType: specs[i].mime });
              if (e && i === 0) throw new Error("The upload didn't go through. Try again.");
            }),
          );
          const done: BriefFile = { path: r.slots[0].path, name: file.name, mime, kind, bytes: file.size, ...(frames.length ? { frames: r.slots.slice(1).map((s) => s.path) } : {}), ...(seconds ? { seconds } : {}) };
          setItems((xs) => xs.map((x) => (x.key === key ? { ...x, status: "ready", note: seconds ? clock(seconds) : null, file: done } : x)));
        } catch (e) {
          setItems((xs) => xs.map((x) => (x.key === key ? { ...x, status: "failed", note: e instanceof Error ? e.message : "Upload failed" } : x)));
        }
      }
    },
    [clientId],
  );

  const remove = (key: string) => setItems((xs) => xs.filter((x) => x.key !== key));
  const clear = () => setItems([]);
  const ready = items.filter((x) => x.status === "ready" && x.file).map((x) => x.file!);
  const uploading = items.some((x) => x.status === "uploading");
  return { items, add, remove, clear, ready, uploading, error, setError };
}

/** Drag and drop onto a conversation (desktop): files dropped anywhere on it are added */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    dragging,
    bind: enabled
      ? {
          onDragEnter: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current++;
            setDragging(true);
          },
          onDragOver: (e: DragEvent) => {
            if (hasFiles(e)) e.preventDefault();
          },
          onDragLeave: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setDragging(false);
          },
          onDrop: (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setDragging(false);
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length) onFiles(files);
          },
        }
      : {},
  };
}

/** The paperclip: opens the file picker (pictures, videos, audio, PDFs) */
export function AttachButton({ onPick, disabled = false }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        aria-label="Add files: pictures, videos, audio or PDFs"
        title="Add files: pictures, videos, audio or PDFs"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={BRIEF_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onPick(files);
        }}
      />
    </>
  );
}

const ICON: Record<BriefFileKind, string> = { image: "IMG", video: "VID", audio: "AUD", pdf: "PDF" };

/** The files waiting to go with the message, each with its picture, what it is, and a way to take it off */
export function AttachedFiles({ items, onRemove }: { items: AttachItem[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]" aria-label="Files to send">
      {items.map((x) => (
        <li key={x.key} className={`flex min-w-0 max-w-[220px] shrink-0 items-center gap-2 rounded-[12px] border bg-bg py-1 pl-1 pr-1 ${x.status === "failed" ? "border-bad/40" : "border-line"}`}>
          <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[9px] bg-surface-2 text-[10px] font-semibold tracking-[0.06em] text-faint">
            {x.preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={x.preview} alt="" className="h-full w-full object-cover" />
            ) : (
              ICON[x.kind]
            )}
            {x.kind === "video" && x.preview && <span aria-hidden className="absolute inset-0 grid place-items-center bg-black/25 text-[11px] text-white">▶</span>}
          </span>
          <span className="grid min-w-0">
            <span className="truncate text-[12.5px] leading-tight">{x.name}</span>
            <span className={`truncate text-[11px] ${x.status === "failed" ? "text-bad" : "text-faint"}`}>{x.status === "uploading" ? (x.note ?? "Uploading…") : x.status === "failed" ? (x.note ?? "Didn't upload") : [KIND_WORD[x.kind], x.note].filter(Boolean).join(" · ")}</span>
          </span>
          <button type="button" onClick={() => onRemove(x.key)} aria-label={`Remove ${x.name}`} className="grid h-11 w-9 shrink-0 place-items-center rounded-full text-faint hover:text-fg md:h-8 md:w-8">
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
