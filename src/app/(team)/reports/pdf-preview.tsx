"use client";

import { useEffect, useMemo, useState } from "react";

// The report's preview is the PDF itself: the same file the client gets, drawn page by page, so what the buyer sees is
// exactly what goes out. Every line the buyer writes (the headline, the summary, each point, the extras) can be
// clicked on the page to change it; the pages are drawn again from the new PDF once it's saved.

export type PdfField = { id: string; label: string; value: string; removable?: boolean };
type Span = { left: number; top: number; width: number; height: number; text: string };
type Page = { src: string; ratio: number; spans: Span[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const RENDER_WIDTH = 1600; // pixels per page: sharp on a retina screen at the studio's width

/** Which of the buyer's lines a piece of text on the page belongs to (wrapped lines and hyphenated words included). */
function fieldOf(text: string, fields: { id: string; n: string }[]) {
  const t = norm(text.replace(/-\s*$/, ""));
  if (t.length < 6) return null;
  const hits = fields.filter((f) => f.n.includes(t));
  if (!hits.length) return null;
  return hits.sort((a, b) => a.n.length - b.n.length)[0].id;
}

export function PdfPreview({ url, version, fields, editable, onSave, onRemove }: { url: string; version: string; fields: PdfField[]; editable: boolean; onSave: (id: string, value: string) => void; onRemove: (id: string) => void }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; page: number; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Which line each piece of text on the pages belongs to, from the lines as they are now
  const known = useMemo(() => fields.map((f) => ({ id: f.id, n: norm(f.value) })).filter((f) => f.n.length >= 6), [fields]);
  const owner = useMemo(() => pages?.map((p) => p.spans.map((x) => fieldOf(x.text, known))) ?? [], [pages, known]);

  useEffect(() => {
    let live = true;
    // A moment's wait, so a burst of edits draws the PDF once
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.text()).slice(0, 200) || "The PDF couldn't be made");
        const data = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const task = pdfjs.getDocument({ data });
        const doc = await task.promise;
        const out: Page[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
          const text = await page.getTextContent();
          const spans: Span[] = [];
          for (const item of text.items) {
            if (!("str" in item) || !item.str.trim()) continue;
            const tx = pdfjs.Util.transform(base.transform, item.transform) as number[];
            const h = Math.hypot(tx[2], tx[3]);
            spans.push({ left: tx[4] / base.width, top: (tx[5] - h) / base.height, width: item.width / base.width, height: (h * 1.25) / base.height, text: item.str });
          }
          out.push({ src: blob ? URL.createObjectURL(blob) : canvas.toDataURL(), ratio: base.height / base.width, spans });
        }
        await task.destroy();
        if (!live) return out.forEach((p) => URL.revokeObjectURL(p.src));
        setPages((before) => {
          before?.forEach((p) => URL.revokeObjectURL(p.src));
          return out;
        });
        setFailed(null);
      } catch (e) {
        if (live) setFailed(e instanceof Error ? e.message : "The PDF couldn't be made");
      } finally {
        if (live) setLoading(false);
      }
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, version]);

  const field = edit ? fields.find((f) => f.id === edit.id) : null;

  return (
    <div className="relative grid gap-4">
      {loading && pages && (
        <span className="pointer-events-none sticky top-20 z-10 justify-self-end rounded-full bg-fg px-3 py-1 text-[11.5px] text-bg shadow-lg">Updating the PDF…</span>
      )}
      {!pages && !failed && (
        <div className="grid aspect-[8.5/11] place-items-center rounded-[6px] bg-white">
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[#ececee]">
            <span className="block h-full w-1/2 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-[#c8102e]" />
          </span>
        </div>
      )}
      {failed && <p className="rounded-[12px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-[13px] text-bad">{failed}</p>}
      {pages?.map((p, i) => (
        <div key={p.src} className="relative overflow-hidden rounded-[4px] bg-white shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]" style={{ aspectRatio: `1 / ${p.ratio}` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.src} alt={`Page ${i + 1}`} className="absolute inset-0 h-full w-full select-none" draggable={false} />
          {editable &&
            p.spans.map((s, j) => {
              const id = owner[i]?.[j];
              if (!id) return null;
              return (
                <button
                  key={j}
                  type="button"
                  aria-label={`Change: ${fields.find((f) => f.id === id)?.label ?? "this line"}`}
                  onMouseEnter={() => setHover(id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setEdit({ id, page: i, x: s.left, y: s.top + s.height })}
                  className={`absolute cursor-text rounded-[2px] transition-colors ${hover === id ? "bg-[#c8102e]/10 ring-1 ring-[#c8102e]/40" : ""}`}
                  style={{ left: `${s.left * 100}%`, top: `${s.top * 100}%`, width: `${s.width * 100}%`, height: `${s.height * 100}%` }}
                />
              );
            })}
          {edit && field && edit.page === i && (
            <Editor
              key={edit.id}
              field={field}
              at={edit}
              onClose={() => setEdit(null)}
              onSave={(v) => {
                setEdit(null);
                if (v.trim() !== field.value.trim()) onSave(field.id, v.trim());
              }}
              onRemove={
                field.removable
                  ? () => {
                      setEdit(null);
                      onRemove(field.id);
                    }
                  : undefined
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

function Editor({ field, at, onSave, onClose, onRemove }: { field: PdfField; at: { x: number; y: number }; onSave: (v: string) => void; onClose: () => void; onRemove?: () => void }) {
  const [draft, setDraft] = useState(field.value);
  return (
    <>
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/10 md:bg-transparent" />
      <div
        className="z-50 grid gap-2 rounded-[14px] border border-line bg-surface p-3 text-fg shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] md:absolute md:w-[min(520px,90%)]"
        style={{ left: `min(${at.x * 100}%, calc(100% - min(520px, 90%) - 12px))`, top: `${at.y * 100}%` }}
      >
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{field.label}</p>
        <textarea
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSave(draft);
            }
          }}
          rows={3}
          className="w-full resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60 md:max-h-[40vh]"
        />
        <div className="flex items-center gap-2">
          {onRemove && (
            <button type="button" onClick={onRemove} className="h-10 rounded-full px-3 text-[13px] text-bad hover:bg-bad-soft/40 md:h-9">
              Remove this line
            </button>
          )}
          <span className="ml-auto text-[11px] text-faint max-md:hidden">Ctrl+Enter to save</span>
          <button type="button" onClick={onClose} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg md:h-9">
            Cancel
          </button>
          <button type="button" onClick={() => onSave(draft)} className="h-10 rounded-full bg-fg px-4 text-[13px] text-bg md:h-9">
            Save
          </button>
        </div>
      </div>
    </>
  );
}
