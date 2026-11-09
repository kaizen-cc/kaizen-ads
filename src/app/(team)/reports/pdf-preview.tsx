"use client";

import { useEffect, useRef, useState } from "react";
import type { ReportPdfInput } from "@/lib/reports/report-doc";

// The report's preview is the PDF itself: the same document the client gets, drawn in the browser from what the buyer
// has on screen, so every change shows at once (saving happens alongside). What can change carries an invisible link
// in the preview's PDF only: the buyer's words (headline, summary, each point, the note) open a text box; metrics, rows,
// columns and campaigns open their menu; "View ad" and other links open.

/** list: a point in a list (What we did, What's next...): its place in it, so a line can be added below it or moved */
export type PdfField = { id: string; label: string; value: string; removable?: boolean; list?: { at: number; count: number } };
type Box = { left: number; top: number; width: number; height: number; url: string };
type Page = { key: string; canvas: HTMLCanvasElement; ratio: number; links: Box[] };
type Base = { input: ReportPdfInput; images: (string | null)[][] };

const EDIT_HOST = "https://edit.kaizen.invalid/";
const RENDER_MAX = 1400; // pixels per page at most (the page's width on screen times the screen's density)

/** A drawn page, shown as it is (no image to encode) */
function Drawn({ canvas }: { canvas: HTMLCanvasElement }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.replaceChildren(canvas);
  }, [canvas]);
  return <div ref={box} className="absolute inset-0 select-none" />;
}

export function PdfPreview({
  source,
  baseKey,
  patch,
  patchKey,
  fields,
  editable,
  onSave,
  onRemove,
  onAdd,
  onMove,
  hotMenu,
}: {
  /** Where the report's document input and pictures come from (read again when baseKey changes) */
  source: string;
  baseKey: string;
  /** The buyer's changes on screen, applied to the document before it's drawn (drawn again when patchKey changes) */
  patch: (input: ReportPdfInput) => ReportPdfInput;
  patchKey: string;
  fields: PdfField[];
  editable: boolean;
  onSave: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  /** A new line in the same list as this point, just below it (with this point's own words, when changed in the same box) */
  onAdd?: (id: string, value: string, current?: string) => void;
  /** A point moved one place up (-1) or down (1) in its list */
  onMove?: (id: string, by: -1 | 1) => void;
  /** The menu for a metric, row, column or campaign clicked on the page ("meta/tile/2"); close() shuts it */
  hotMenu?: (target: string, close: () => void) => React.ReactNode;
}) {
  const [base, setBase] = useState<Base | null>(null);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [hot, setHot] = useState<{ target: string; page: number; x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; page: number; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const patchRef = useRef(patch);
  useEffect(() => {
    patchRef.current = patch;
  });

  // The document and its pictures, from the server (once, and when the report itself changes there)
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(source, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.text()).slice(0, 200) || "The report couldn't be loaded");
        const b = (await res.json()) as Base;
        if (live) setBase(b);
      } catch (e) {
        if (live) setFailed(e instanceof Error ? e.message : "The report couldn't be loaded");
      }
    })();
    return () => {
      live = false;
    };
  }, [source, baseKey]);

  // Drawn here, in the browser, on every change: no trip to the server
  useEffect(() => {
    if (!base) return;
    let live = true;
    const t = setTimeout(async () => {
      setDrawing(true);
      try {
        const [{ pdf }, { ReportDocument }, pdfjs] = await Promise.all([import("@react-pdf/renderer"), import("@/lib/reports/report-doc"), import("pdfjs-dist")]);
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const blob = await pdf(<ReportDocument input={patchRef.current(base.input)} images={base.images} />).toBlob();
        const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
        const doc = await task.promise;
        const width = Math.min(RENDER_MAX, Math.round((wrap.current?.clientWidth || 800) * (window.devicePixelRatio || 1)));
        const run = `${Date.now()}`;
        // Each page shows the moment it's drawn (the one being edited is usually the first or second)
        for (let i = 1; i <= doc.numPages; i++) {
          if (!live) break;
          const page = await doc.getPage(i);
          const view = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: width / view.width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.cssText = "width:100%;height:100%;display:block";
          await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
          const [m0, m1, m2, m3, m4, m5] = view.transform as number[];
          const at = (x: number, y: number) => [m0 * x + m2 * y + m4, m1 * x + m3 * y + m5];
          const links: Box[] = [];
          for (const a of (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
            const href = a.url ?? a.unsafeUrl;
            if (a.subtype !== "Link" || !href || !a.rect) continue;
            const [x1, y1] = at(a.rect[0], a.rect[1]);
            const [x2, y2] = at(a.rect[2], a.rect[3]);
            links.push({ left: Math.min(x1, x2) / view.width, top: Math.min(y1, y2) / view.height, width: Math.abs(x2 - x1) / view.width, height: Math.abs(y2 - y1) / view.height, url: href });
          }
          const drawn: Page = { key: `${run}-${i}`, canvas, ratio: view.height / view.width, links };
          if (live) setPages((before) => [...(before ?? []).slice(0, i - 1), drawn, ...(before ?? []).slice(i, doc.numPages)].slice(0, doc.numPages));
        }
        await task.destroy();
        setFailed(null);
      } catch (e) {
        if (live) setFailed(e instanceof Error ? e.message : "The PDF couldn't be drawn");
      } finally {
        if (live) setDrawing(false);
      }
    }, 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [base, patchKey]);

  const field = edit ? fields.find((f) => f.id === edit.id) : null;

  return (
    <div ref={wrap} className="relative grid gap-4">
      {/* A white label client's report is generic: the buyer sees that what's drawn is what goes */}
      {base?.input.whiteLabel && (
        <p className="justify-self-start rounded-full border border-line bg-surface-2 px-3 py-1 text-[12px] text-muted">
          <span className="font-medium text-fg">White label:</span> no Kaizen branding
        </p>
      )}
      {drawing && pages &&<span className="pointer-events-none sticky top-20 z-10 justify-self-end rounded-full bg-fg px-3 py-1 text-[11.5px] text-bg shadow-lg">Updating…</span>}
      {!pages && !failed && (
        <div className="grid aspect-[8.5/11] place-items-center rounded-[6px] bg-white">
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[#ececee]">
            <span className="block h-full w-1/2 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-[#c8102e]" />
          </span>
        </div>
      )}
      {failed && <p className="rounded-[12px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-[13px] text-bad">{failed}</p>}
      {pages?.map((p, i) => (
        <div key={i} className="relative overflow-hidden rounded-[4px] bg-white shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]" style={{ aspectRatio: `1 / ${p.ratio}` }}>
          <Drawn canvas={p.canvas} />
          {p.links.map((l, j) => {
            const style = { left: `${l.left * 100}%`, top: `${l.top * 100}%`, width: `${l.width * 100}%`, height: `${l.height * 100}%` };
            if (!l.url.startsWith(EDIT_HOST)) return <a key={j} href={l.url} target="_blank" rel="noreferrer" aria-label="Open the link" className="absolute z-[1] rounded-[2px] hover:bg-[#c8102e]/10" style={style} />;
            if (!editable) return null;
            const target = l.url.slice(EDIT_HOST.length);
            // The buyer's own words ("meta/text/headline", "meta/text/did/2") open a text box
            const text = target.match(/^[a-z]+\/text\/(.+)$/);
            const id = text ? text[1].replace("/", ".") : null;
            if (text && !fields.some((f) => f.id === id)) return null;
            const active = text ? edit?.id === id && edit?.page === i : hot?.target === target && hot?.page === i;
            return (
              <button
                key={j}
                type="button"
                aria-label={text ? "Change this text" : "Change this"}
                onClick={() => (text ? setEdit({ id: id!, page: i, x: l.left, y: l.top + l.height }) : hotMenu && setHot({ target, page: i, x: l.left, y: l.top + l.height }))}
                className={`absolute z-[1] rounded-[4px] ring-[#c8102e]/50 transition-shadow hover:bg-[#c8102e]/[0.05] hover:ring-1 ${text ? "cursor-text" : ""} ${active ? "bg-[#c8102e]/[0.06] ring-2" : ""}`}
                style={style}
              />
            );
          })}
          {hot && hot.page === i && hotMenu && (
            <>
              <button type="button" aria-label="Close" onClick={() => setHot(null)} className="fixed inset-0 z-40 cursor-default bg-black/10 md:bg-transparent" />
              <div
                className="z-50 grid max-h-[60vh] gap-2 overflow-y-auto rounded-[14px] border border-line bg-surface p-3 text-fg shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] md:absolute md:w-[300px]"
                style={{ left: `min(${hot.x * 100}%, calc(100% - 312px))`, top: `${hot.y * 100}%` }}
              >
                {hotMenu(hot.target, () => setHot(null))}
              </div>
            </>
          )}
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
              onAdd={
                field.list && onAdd
                  ? (v, current) => {
                      setEdit(null);
                      onAdd(field.id, v.trim(), current.trim() && current.trim() !== field.value.trim() ? current.trim() : undefined);
                    }
                  : undefined
              }
              onMove={
                field.list && onMove
                  ? (by) => {
                      setEdit(null);
                      onMove(field.id, by);
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

function Editor({
  field,
  at,
  onSave,
  onClose,
  onRemove,
  onAdd,
  onMove,
}: {
  field: PdfField;
  at: { x: number; y: number };
  onSave: (v: string) => void;
  onClose: () => void;
  onRemove?: () => void;
  onAdd?: (v: string, current: string) => void;
  onMove?: (by: -1 | 1) => void;
}) {
  const [draft, setDraft] = useState(field.value);
  // Writing a new line below this one (this one's words kept as they are in the box)
  const [fresh, setFresh] = useState<string | null>(null);
  const adding = fresh != null;
  const save = () => (adding ? fresh.trim() && onAdd?.(fresh, draft) : onSave(draft));
  const list = field.list;
  return (
    <>
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/10 md:bg-transparent" />
      <div
        className="z-50 grid gap-2 rounded-[14px] border border-line bg-surface p-3 text-fg shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] max-md:fixed max-md:inset-x-3 max-md:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] md:absolute md:w-[min(520px,90%)]"
        style={{ left: `min(${at.x * 100}%, calc(100% - min(520px, 90%) - 12px))`, top: `${at.y * 100}%` }}
      >
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{adding ? `New line in ${field.label}` : field.label}</p>
        <textarea data-chat
          key={adding ? "fresh" : "line"}
          value={adding ? fresh : draft}
          autoFocus
          placeholder={adding ? "Write it as it should read in the report" : undefined}
          onChange={(e) => (adding ? setFresh(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          rows={3}
          className="w-full resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60 md:max-h-[40vh]"
        />
        {!adding && list && (onAdd || onMove) && (
          <div className="flex flex-wrap items-center gap-1">
            {onAdd && (
              <button type="button" onClick={() => setFresh("")} className="h-10 rounded-full border border-line px-3 text-[13px] text-muted hover:text-fg md:h-9">
                + Add a line below
              </button>
            )}
            {onMove && list.count > 1 && (
              <>
                <button type="button" disabled={list.at === 0} onClick={() => onMove(-1)} aria-label="Move this line up" className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-30 md:h-9">
                  ↑ Up
                </button>
                <button type="button" disabled={list.at >= list.count - 1} onClick={() => onMove(1)} aria-label="Move this line down" className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-30 md:h-9">
                  ↓ Down
                </button>
              </>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          {onRemove && !adding && (
            <button type="button" onClick={onRemove} className="h-10 rounded-full px-3 text-[13px] text-bad hover:bg-bad-soft/40 md:h-9">
              Remove this line
            </button>
          )}
          <span className="ml-auto text-[11px] text-faint max-md:hidden">Ctrl+Enter to {adding ? "add" : "save"}</span>
          <button type="button" onClick={adding ? () => setFresh(null) : onClose} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg md:h-9">
            {adding ? "Back" : "Cancel"}
          </button>
          <button type="button" disabled={adding && !fresh.trim()} onClick={save} className="h-10 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40 md:h-9">
            {adding ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
