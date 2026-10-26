"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { aspectLabel } from "@/lib/uploads/media";
import { FORMAT_LABEL, type Format } from "@/lib/stages";
import type { Design, DesignFile } from "./design-actions";
import { addComment, rememberComment, setCommentResolved, type ReviewComment } from "./review-actions";

const fmtWhen = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Tell the rest of the drawer (review panel, design cards) that comments changed. */
export const commentsChanged = (requestId: string) => window.dispatchEvent(new CustomEvent("kz:comments", { detail: requestId }));

type Draft = { x: number | null; y: number | null; w?: number | null; h?: number | null; tMs: number | null };

/**
 * Full-screen viewer for one design. Click to pin a comment to a spot, or drag to box an area; on a video, comment at the
 * current moment. Every comment belongs to the version it was made on, so old notes don't haunt new versions.
 */
export function ReviewViewer({
  requestId,
  design,
  version,
  format,
  comments,
  onComments,
  onVersion,
  onClose,
  demo = false,
}: {
  requestId: string;
  design: Design;
  version: number;
  format: Format;
  comments: ReviewComment[];
  onComments: (c: ReviewComment[]) => void;
  onVersion: (n: number) => void;
  onClose: () => void;
  demo?: boolean;
}) {
  const v = design.versions.find((x) => x.version === version) ?? design.versions[0];
  const [fileId, setFileId] = useState<string | null>(null);
  const file: DesignFile | undefined = v?.files.find((f) => f.id === fileId) ?? v?.files.find((f) => f.aspect === "4x5") ?? v?.files[0];
  const isVideo = Boolean(file?.mime.startsWith("video/"));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // being drawn
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nowMs, setNowMs] = useState(0); // where the video is, for "Comment at 0:07"
  const input = useRef<HTMLTextAreaElement>(null);

  const mine = useMemo(() => comments.filter((c) => c.designId === design.id && c.version === v?.version), [comments, design.id, v?.version]);
  const older = useMemo(() => comments.filter((c) => c.designId === design.id && c.version !== v?.version), [comments, design.id, v?.version]);
  // Pins shown on this file (comments without a file belong to the whole design)
  const pins = mine.filter((c) => c.x != null && c.y != null && (!c.fileId || c.fileId === file?.id));
  const number = (c: ReviewComment) => mine.indexOf(c) + 1;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (draft) setDraft(null);
      else onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, draft]);

  const begin = (d: Draft) => {
    setDraft(d);
    setError(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const save = () =>
    start(async () => {
      if (!text.trim()) return;
      if (demo) {
        onComments([
          ...comments,
          { id: `demo-${Date.now()}`, designId: design.id, version: v.version, fileId: file?.id ?? null, x: draft?.x ?? null, y: draft?.y ?? null, w: draft?.w ?? null, h: draft?.h ?? null, tMs: draft?.tMs ?? null, body: text.trim(), round: "internal", author: "You", remembered: false, resolved: false, at: new Date().toISOString() },
        ]);
        setText("");
        setDraft(null);
        return;
      }
      const r = await addComment({ requestId, designId: design.id, version: v.version, fileId: file?.id ?? null, x: draft?.x, y: draft?.y, w: draft?.w, h: draft?.h, tMs: draft?.tMs, body: text });
      if (!r.ok) return setError(r.error);
      onComments(r.comments);
      commentsChanged(requestId);
      setText("");
      setDraft(null);
    });

  const act = (fn: () => Promise<{ ok: true; comments: ReviewComment[] } | { ok: false; error: string }>) =>
    start(async () => {
      if (demo) return;
      const r = await fn();
      if (!r.ok) return setError(r.error);
      onComments(r.comments);
      commentsChanged(requestId);
    });

  return (
    <div className="fixed inset-0 z-[70] grid grid-rows-[auto_1fr] bg-black/92 backdrop-blur-sm animate-[sheet-fade_.2s_ease-out]" role="dialog" aria-modal="true" aria-label={design.name}>
      <header className="flex items-center justify-between gap-4 px-6 py-4 max-md:gap-3 max-md:px-4 max-md:pb-3 max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">
            D{design.position} · {design.name}
          </p>
          <p className="text-xs text-white/50 max-md:line-clamp-2">
            {FORMAT_LABEL[format]} · v{v?.version} {v?.by ? `by ${v.by}` : ""} · {v ? fmtWhen(v.at) : ""}
            {v?.note && <span className="text-white/70"> · “{v.note}”</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {file?.url && (
            <a href={file.url} target="_blank" rel="noreferrer" className="hidden h-9 rounded-full border border-white/20 px-4 text-sm leading-9 text-white/80 hover:bg-white/10 sm:block">
              Open original
            </a>
          )}
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 max-md:h-11 max-md:w-11 max-md:bg-white/10 max-md:text-white" aria-label="Close">
            ✕
          </button>
        </div>
      </header>

      {/* Phones: the creative, then its comments, scroll as one page; the comment box is pinned to the bottom of the screen */}
      <div
        className={`grid min-h-0 lg:grid-cols-[minmax(0,1fr)_360px] max-md:content-start max-md:overflow-y-auto max-md:overscroll-contain ${
          draft ? "max-md:pb-[calc(13rem+env(safe-area-inset-bottom))]" : "max-md:pb-[calc(5rem+env(safe-area-inset-bottom))]"
        }`}
      >
        {/* The creative */}
        <div className="grid min-h-0 grid-rows-[1fr_auto] gap-3 px-6 pb-6 max-md:px-4 max-md:pb-4">
          <div className="grid min-h-0 place-items-center">
            {!file ? (
              <p className="text-sm text-white/60">No files on this version.</p>
            ) : isVideo && file.url ? (
              <video ref={videoRef} key={file.id} src={file.url} controls playsInline onTimeUpdate={(e) => setNowMs(Math.round(e.currentTarget.currentTime * 1000))} className="max-h-full max-w-full rounded-[8px] max-md:max-h-[60svh]" />
            ) : file.url && file.mime.startsWith("image/") ? (
              <div className="relative max-h-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={file.id}
                  src={file.url}
                  alt={file.name}
                  draggable={false}
                  onPointerDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const x = (e.clientX - r.left) / r.width;
                    const y = (e.clientY - r.top) / r.height;
                    setBox({ x0: x, y0: y, x1: x, y1: y });
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!box) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    setBox({ ...box, x1: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y1: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
                  }}
                  onPointerUp={() => {
                    if (!box) return;
                    const w = Math.abs(box.x1 - box.x0);
                    const h = Math.abs(box.y1 - box.y0);
                    begin(w < 0.03 && h < 0.03 ? { x: box.x0, y: box.y0, tMs: null } : { x: Math.min(box.x0, box.x1), y: Math.min(box.y0, box.y1), w, h, tMs: null });
                    setBox(null);
                  }}
                  onPointerCancel={() => setBox(null)}
                  className="block max-h-[calc(100vh-220px)] max-w-full cursor-crosshair touch-none select-none rounded-[8px] object-contain max-md:max-h-[60svh] max-md:[-webkit-touch-callout:none]"
                />
                {pins.map((c) => (
                  <span key={c.id} className="contents">
                  {c.w != null && c.h != null && (
                    <span
                      className={`pointer-events-none absolute rounded-[4px] border-2 ${c.resolved ? "border-white/60 bg-white/10" : "border-brand bg-brand/15"} ${hover === c.id ? "bg-brand/25" : ""}`}
                      style={{ left: `${c.x! * 100}%`, top: `${c.y! * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}
                    />
                  )}
                  <span
                    onMouseEnter={() => setHover(c.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => setHover(c.id)} // touch: tapping a pin lights it and its comment
                    className={`absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-xs font-semibold shadow-[0_4px_14px_rgba(0,0,0,0.5)] ring-2 ring-white transition-transform max-md:h-8 max-md:w-8 max-md:text-[13px] ${
                      c.resolved ? "bg-white/70 text-black/60" : "bg-brand text-white"
                    } ${hover === c.id ? "scale-125" : ""}`}
                    style={{ left: `${c.x! * 100}%`, top: `${c.y! * 100}%` }}
                  >
                    {number(c)}
                  </span>
                  </span>
                ))}
                {box && (
                  <span
                    className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-brand bg-brand/15 shadow-[0_0_0_1.5px_rgba(255,255,255,0.8)]"
                    style={{ left: `${Math.min(box.x0, box.x1) * 100}%`, top: `${Math.min(box.y0, box.y1) * 100}%`, width: `${Math.abs(box.x1 - box.x0) * 100}%`, height: `${Math.abs(box.y1 - box.y0) * 100}%` }}
                  />
                )}
                {!box && draft?.x != null && draft.y != null && draft.w != null && draft.h != null && (
                  <span className="pointer-events-none absolute animate-pulse rounded-[4px] border-2 border-brand bg-brand/20 shadow-[0_0_0_1.5px_rgba(255,255,255,0.8)]" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />
                )}
                {!box && draft?.x != null && draft.y != null && (
                  <span className="absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-pulse place-items-center rounded-full bg-white text-xs font-semibold text-black ring-2 ring-brand" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}>
                    +
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-white/60">Preview not available. Open the original.</p>
            )}
          </div>

          <div className="grid gap-2">
            {(v?.files.length ?? 0) > 1 && (
              <div className="flex flex-wrap justify-center gap-2">
                {v!.files.map((f, i) => (
                  <button
                    key={f.id}
                    onClick={() => (setFileId(f.id), setDraft(null))}
                    className={`h-8 rounded-full px-3 text-xs max-md:h-10 max-md:px-4 ${f.id === file?.id ? "bg-white text-black" : "border border-white/20 text-white/70 hover:bg-white/10"}`}
                  >
                    {format === "carousel" ? `Card ${f.card ?? i + 1}` : aspectLabel(f.aspect)}
                  </button>
                ))}
              </div>
            )}
            {design.versions.length > 1 && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {design.versions.map((x) => (
                  <button
                    key={x.id}
                    onClick={() => (onVersion(x.version), setFileId(null), setDraft(null))}
                    title={x.note ?? undefined}
                    className={`grid rounded-[8px] px-3 py-1.5 text-left text-xs max-md:min-h-11 max-md:content-center ${x.version === v?.version ? "bg-brand text-white" : "border border-white/15 text-white/70 hover:bg-white/10"}`}
                  >
                    <span className="font-medium">v{x.version}</span>
                    {x.note && <span className="max-w-[180px] truncate opacity-80">{x.note}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Comments */}
        <aside className="grid min-h-0 grid-rows-[auto_1fr_auto] border-t border-white/10 bg-black/40 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between px-5 py-4 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1 max-md:px-4">
            <p className="text-sm font-medium text-white">
              Comments <span className="tabular text-white/40">{mine.length}</span>
            </p>
            <p className="text-[11px] text-white/40">
              {isVideo ? (
                "Pause where it's wrong, then comment"
              ) : (
                <>
                  <span className="max-md:hidden">Click to pin a comment, or drag to box an area</span>
                  <span className="md:hidden">Tap the creative to pin a comment, or drag to box an area</span>
                </>
              )}
            </p>
          </div>

          <ol className="grid min-h-0 content-start gap-2 overflow-y-auto px-5 pb-4 max-md:px-4">
            {mine.length === 0 && <li className="rounded-[10px] border border-dashed border-white/15 px-4 py-6 text-center text-xs text-white/40">No comments on v{v?.version} yet.</li>}
            {mine.map((c) => (
              <li
                key={c.id}
                onMouseEnter={() => setHover(c.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(c.id)} // touch: tapping a comment lights its pin
                className={`grid gap-2 rounded-[12px] border px-3.5 py-3 transition-colors ${hover === c.id ? "border-white/30 bg-white/[0.06]" : "border-white/10 bg-white/[0.03]"} ${c.resolved ? "opacity-50" : ""}`}
              >
                <div className="flex items-start gap-2.5">
                  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${c.x != null ? "bg-brand text-white" : "bg-white/15 text-white/80"}`}>{number(c)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-white/45">
                      {c.author ?? "Someone"} · {fmtWhen(c.at)}
                      {c.tMs != null && (
                        <button onClick={() => videoRef.current && ((videoRef.current.currentTime = c.tMs! / 1000), videoRef.current.pause())} className="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 tabular text-white/80 hover:bg-white/20 max-md:px-2.5 max-md:py-1.5">
                          ▶ {clock(c.tMs)}
                        </button>
                      )}
                    </p>
                    <p className={`mt-1 whitespace-pre-wrap text-sm leading-relaxed text-white/90 ${c.resolved ? "line-through" : ""}`}>{c.body}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-8 max-md:[&>*]:inline-flex max-md:[&>*]:min-h-10 max-md:[&>*]:items-center max-md:[&>*]:px-3.5 max-md:[&>*]:text-xs">
                  <button onClick={() => act(() => setCommentResolved(c.id, requestId, !c.resolved))} className="rounded-full px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white max-md:bg-white/[0.06]">
                    {c.resolved ? "Reopen" : "Resolve"}
                  </button>
                  {c.remembered ? (
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/60">In client memory</span>
                  ) : (
                    <button onClick={() => act(() => rememberComment(c.id, requestId))} className="rounded-full px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white max-md:bg-white/[0.06]" title="Save as an Avoid rule for this client, so the AI and future briefs know">
                      Remember for this client
                    </button>
                  )}
                </div>
              </li>
            ))}
            {older.length > 0 && <li className="pt-2 text-[11px] text-white/35">{older.length} comment{older.length === 1 ? "" : "s"} on other versions</li>}
          </ol>

          <div className="grid gap-2 border-t border-white/10 px-5 py-4 max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-10 max-md:bg-[#0b0b0d]/95 max-md:px-4 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-md:pt-3 max-md:backdrop-blur-xl">
            {draft ? (
              <p className="text-[11px] text-white/60 max-md:flex max-md:items-center max-md:justify-between max-md:text-xs">
                {draft.tMs != null ? `At ${clock(draft.tMs)}` : draft.w != null ? "On the area you boxed" : draft.x != null ? "Pinned to the spot you clicked" : "On the whole design"}
                <button onClick={() => setDraft(null)} className="ml-2 text-white/40 hover:text-white max-md:-my-2 max-md:px-2 max-md:py-2.5">
                  cancel
                </button>
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-md:flex-nowrap max-md:[&>button]:h-11 max-md:[&>button]:flex-1 max-md:[&>button]:text-[13px]">
                {isVideo && (
                  <button onClick={() => (videoRef.current?.pause(), begin({ x: null, y: null, tMs: nowMs }))} className="h-8 rounded-full bg-white px-3.5 text-xs font-medium text-black">
                    Comment at {clock(nowMs)}
                  </button>
                )}
                <button onClick={() => begin({ x: null, y: null, tMs: null })} className="h-8 rounded-full border border-white/20 px-3.5 text-xs text-white/70 hover:bg-white/10">
                  Comment on the whole design
                </button>
              </div>
            )}
            {draft && (
              <>
                <textarea
                  ref={input}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                  }}
                  rows={3}
                  placeholder="What should change here?"
                  className="resize-none rounded-[10px] border border-white/15 bg-white/[0.06] px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/40"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white/35 max-md:hidden">Ctrl + Enter to post</span>
                  <button disabled={busy || !text.trim()} onClick={save} className="h-8 rounded-full bg-brand px-4 text-xs font-medium text-white disabled:opacity-40 max-md:h-11 max-md:w-full max-md:text-sm">
                    {busy ? "Posting…" : "Post comment"}
                  </button>
                </div>
              </>
            )}
            {error && <p className="text-xs text-red-300">{error}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
