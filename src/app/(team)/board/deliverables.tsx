"use client";

import { useEffect, useRef, useState } from "react";
import { useUploads } from "@/components/upload-provider";
import { aspectLabel, aspectOf, filesFromDrop, groupFiles, isMedia, probe, safeName, type Picked, type StagedDesign, type StagedFile } from "@/lib/uploads/media";
import { startDesigns, startVersion, ticketDesigns, type Design } from "./design-actions";
import { FormatIcon } from "./ticket-card";
import type { Ticket } from "./types";
import { ReviewViewer } from "./review-viewer";
import { ticketComments, type ReviewComment } from "./review-actions";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Read and preview dropped files before anything uploads. */
async function stage(picked: Picked[]): Promise<StagedFile[]> {
  const out: StagedFile[] = [];
  for (const p of picked.filter((x) => isMedia(x.file))) {
    const pr = await probe(p.file);
    out.push({ ...p, ...pr, id: crypto.randomUUID(), aspect: aspectOf(pr.width, pr.height), preview: pr.thumb ? URL.createObjectURL(pr.thumb) : null });
  }
  return out;
}

const metaOf = (f: StagedFile, card: number | null) => ({
  original_name: f.file.name,
  mime: f.file.type || "application/octet-stream",
  bytes: f.file.size,
  width: f.width,
  height: f.height,
  duration_ms: f.durationMs,
  aspect: f.aspect,
  card,
});

/** uploaded: designs with at least one finished file. uploading: files still on their way. */
export type UploadState = { uploaded: number; uploading: number; loaded: boolean };

export function Deliverables({ ticket, demoDesigns, onState }: { ticket: Ticket; demoDesigns?: Design[]; onState?: (s: UploadState) => void }) {
  const uploads = useUploads();
  const [designs, setDesigns] = useState<Design[] | null>(demoDesigns ?? null);
  const [staged, setStaged] = useState<StagedDesign[] | null>(null);
  const [reading, setReading] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ design: Design; version: number } | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [replacing, setReplacing] = useState<{ design: Design; files: StagedFile[]; note: string } | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceFor = useRef<Design | null>(null);

  const finished = uploads?.finished[ticket.id] ?? 0;
  const demo = Boolean(demoDesigns);
  useEffect(() => {
    if (demo) return;
    let live = true;
    ticketDesigns(ticket.id).then((d) => live && setDesigns(d));
    return () => {
      live = false;
    };
  }, [ticket.id, finished, demo]);

  // Review comments (pins), refreshed whenever the viewer or the review panel changes them
  useEffect(() => {
    if (demo) return;
    let live = true;
    const load = () => ticketComments(ticket.id).then((c) => live && setComments(c));
    load();
    const on = (e: Event) => (e as CustomEvent).detail === ticket.id && load();
    window.addEventListener("kz:comments", on);
    return () => {
      live = false;
      window.removeEventListener("kz:comments", on);
    };
  }, [ticket.id, demo]);

  // Folder inputs need a non-standard attribute
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const pending = (uploads?.jobs ?? []).filter((j) => j.requestId === ticket.id && j.status !== "done" && j.status !== "failed");

  // Tell the drawer whether there's a finished creative (it gates moving past production)
  const uploadedCount = (designs ?? []).filter((d) => d.versions[0]?.files.length).length;
  useEffect(() => {
    onState?.({ uploaded: uploadedCount, uploading: pending.length, loaded: designs !== null });
  }, [onState, uploadedCount, pending.length, designs]);

  const take = async (picked: Picked[]) => {
    setError(null);
    if (!picked.length) return;
    setReading(true);
    const files = await stage(picked);
    setReading(false);
    if (!files.length) return setError("Those files aren't images or videos.");
    setStaged(groupFiles(files, ticket.format));
  };

  const fromInput = (list: FileList | null, folders: boolean) =>
    take([...(list ?? [])].map((file) => ({ file, folder: folders ? (file.webkitRelativePath.split("/")[0] ?? null) : null })));

  const upload = async () => {
    if (!staged?.length || !uploads) return;
    setError(null);
    const res = demo
      ? { ok: true as const, prefix: "demo", started: staged.map((_, i) => ({ designId: `d${i}`, versionId: `v${i}`, version: 1 })) }
      : await startDesigns(
          ticket.id,
          staged.map((d) => ({ name: d.name, variationOf: d.variationOf })),
        );
    if (!res.ok) return setError(res.error);
    staged.forEach((d, i) => {
      const s = res.started[i];
      const dir = `${res.prefix}/${s.designId}/v${s.version}`;
      uploads.enqueue({
        requestId: ticket.id,
        label: `#${ticket.number} · ${d.name}`,
        versionId: s.versionId,
        items: d.files.map((f, n) => {
          const name = `${String(n + 1).padStart(2, "0")}-${safeName(f.file.name)}`;
          return { file: f.file, path: `${dir}/${name}`, thumb: f.thumb, thumbPath: f.thumb ? `${dir}/${name}.thumb.webp` : null, meta: metaOf(f, ticket.format === "carousel" ? n + 1 : null) };
        }),
      });
    });
    setStaged(null);
  };

  const replace = async () => {
    if (!replacing || !uploads) return;
    const { design, files, note } = replacing;
    const res = demo
      ? { ok: true as const, prefix: "demo", started: { designId: design.id, versionId: "v", version: design.currentVersion + 1 } }
      : await startVersion(design.id, note);
    if (!res.ok) return setError(res.error);
    const dir = `${res.prefix}/${res.started.designId}/v${res.started.version}`;
    uploads.enqueue({
      requestId: ticket.id,
      label: `#${ticket.number} · ${design.name} v${res.started.version}`,
      versionId: res.started.versionId,
      items: files.map((f, n) => {
        const name = `${String(n + 1).padStart(2, "0")}-${safeName(f.file.name)}`;
        return { file: f.file, path: `${dir}/${name}`, thumb: f.thumb, thumbPath: f.thumb ? `${dir}/${name}.thumb.webp` : null, meta: metaOf(f, ticket.format === "carousel" ? n + 1 : null) };
      }),
    });
    setReplacing(null);
  };

  const net = (designs ?? []).filter((d) => !d.isVariation).length;
  const vars = (designs ?? []).filter((d) => d.isVariation).length;

  return (
    <section
      className="grid gap-3"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        await take(await filesFromDrop(e.dataTransfer.items));
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Deliverables</h3>
        <span className="text-xs text-faint">
          <span className={net >= ticket.newCount ? "text-ok" : "text-muted"}>
            {net} of {ticket.newCount} new
          </span>
          {ticket.variationCount > 0 && (
            <>
              {" · "}
              <span className={vars >= ticket.variationCount ? "text-ok" : "text-muted"}>
                {vars} of {plural(ticket.variationCount, "variation")}
              </span>
            </>
          )}
        </span>
      </div>

      <input ref={filesInput} type="file" multiple accept="image/*,video/*,.psd,.mov" className="hidden" onChange={(e) => (fromInput(e.target.files, false), (e.target.value = ""))} />
      <input ref={folderInput} type="file" multiple className="hidden" onChange={(e) => (fromInput(e.target.files, true), (e.target.value = ""))} />
      <input
        ref={replaceInput}
        type="file"
        multiple
        accept="image/*,video/*,.psd,.mov"
        className="hidden"
        onChange={async (e) => {
          const design = replaceFor.current;
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (!design || !list.length) return;
          setReading(true);
          const files = await stage(list.map((file) => ({ file, folder: null })));
          setReading(false);
          setReplacing({ design, files, note: "" });
        }}
      />

      {/* Staging: what the drop will become, before anything uploads */}
      {staged ? (
        <div className="grid gap-3 rounded-[10px] border border-brand-text/30 bg-surface p-4 animate-[step-in_.25s_ease-out]">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">
              {plural(staged.length, "design")} · {plural(staged.reduce((n, d) => n + d.files.length, 0), "file")}
            </p>
            <p className="text-xs text-faint">Grouped by name. Rename or mark variations before uploading.</p>
          </div>
          <ul className="grid gap-2">
            {staged.map((d, i) => {
              const sizes = [...new Set(d.files.map((f) => f.aspect).filter(Boolean))] as string[];
              const missing = ticket.format !== "carousel" ? ticket.sizes.filter((s) => !sizes.includes(s)) : [];
              return (
                <li key={d.key} className="grid gap-2.5 rounded-[8px] bg-surface-2 p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex shrink-0 -space-x-3">
                      {d.files.slice(0, 4).map((f) => (
                        <Thumb key={f.id} src={f.preview} format={ticket.format} className="h-12 w-12 rounded-[6px] ring-2 ring-surface-2" />
                      ))}
                    </div>
                    <input
                      value={d.name}
                      onChange={(e) => setStaged(staged.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      aria-label="Design name"
                      className="h-9 min-w-0 flex-1 rounded-brand border border-transparent bg-transparent px-2 text-sm outline-none hover:border-line focus:border-brand-text/60"
                    />
                    <button onClick={() => setStaged(staged.filter((_, j) => j !== i).length ? staged.filter((_, j) => j !== i) : null)} className="text-xs text-faint hover:text-fg" aria-label="Remove">
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    {ticket.format === "carousel" ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-muted">{plural(d.files.length, "card")}</span>
                    ) : (
                      sizes.map((s) => (
                        <span key={s} className="tabular rounded-full border border-line px-2 py-0.5 text-muted">
                          {aspectLabel(s)}
                        </span>
                      ))
                    )}
                    {missing.length > 0 && <span className="text-warn">No {missing.map((m) => aspectLabel(m)).join(", ")} yet</span>}
                    {(designs ?? []).filter((x) => !x.isVariation).length > 0 && (
                      <select
                        value={d.variationOf ?? ""}
                        onChange={(e) => setStaged(staged.map((x, j) => (j === i ? { ...x, variationOf: e.target.value || null } : x)))}
                        aria-label="Variation of"
                        className="ml-auto h-7 rounded-full border border-line bg-bg px-2 text-xs text-muted"
                      >
                        <option value="">Net new design</option>
                        {(designs ?? [])
                          .filter((x) => !x.isVariation)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              Variation of D{x.position} · {x.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setStaged(null)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
              Cancel
            </button>
            <button onClick={upload} className="h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">
              Upload {plural(staged.length, "design")}
            </button>
          </div>
        </div>
      ) : replacing ? (
        <div className="grid gap-3 rounded-[10px] border border-brand-text/30 bg-surface p-4 animate-[step-in_.25s_ease-out]">
          <p className="text-sm font-medium">
            New version of D{replacing.design.position} · {replacing.design.name}
            <span className="font-normal text-muted"> → v{replacing.design.currentVersion + 1}</span>
          </p>
          <div className="flex gap-2">
            {replacing.files.slice(0, 6).map((f) => (
              <Thumb key={f.id} src={f.preview} format={ticket.format} className="h-14 w-14 rounded-[6px]" />
            ))}
          </div>
          <input
            autoFocus
            value={replacing.note}
            onChange={(e) => setReplacing({ ...replacing, note: e.target.value })}
            placeholder="What changed? e.g. Bigger logo, price moved to the top"
            className="h-10 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
          />
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => setReplacing(null)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
              Cancel
            </button>
            <button onClick={replace} className="h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">
              Upload v{replacing.design.currentVersion + 1}
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`grid place-items-center gap-2 rounded-[10px] border border-dashed px-6 py-7 text-center transition-colors ${
            over ? "border-brand-text bg-brand-soft" : "border-line"
          }`}
        >
          {reading ? (
            <p className="text-sm text-muted">Reading files…</p>
          ) : (
            <>
              <p className="text-sm text-muted">{over ? "Drop to add" : "Drop files or a folder here"}</p>
              <p className="flex items-center gap-2 text-xs text-faint">
                <button onClick={() => filesInput.current?.click()} className="text-fg underline-offset-4 hover:underline">
                  Choose files
                </button>
                ·
                <button onClick={() => folderInput.current?.click()} className="text-fg underline-offset-4 hover:underline">
                  Choose a folder
                </button>
              </p>
              <p className="text-[11px] text-faint">Sizes of the same idea group into one design automatically.</p>
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-brand-text">{error}</p>}

      {/* What's here */}
      {designs === null ? (
        <p className="text-xs text-faint">Loading…</p>
      ) : designs.length + pending.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3">
          {pending.map((j) => (
            <li key={j.id} className="grid gap-2 rounded-[10px] border border-line bg-surface p-2.5">
              <div className="relative grid aspect-[4/5] place-items-center overflow-hidden rounded-[7px] bg-surface-2">
                <span className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-fg/10 to-transparent animate-[ai-sweep_1.4s_ease-in-out_infinite]" />
                <span className="text-xs tabular text-muted">{j.status === "saving" ? "Saving…" : `${Math.round((j.sent / j.total) * 100)}%`}</span>
              </div>
              <p className="truncate text-xs text-muted">{j.label.split(" · ").slice(1).join(" · ")}</p>
            </li>
          ))}
          {designs.map((d) => {
            const v = d.versions[0];
            const cover = v?.files.find((f) => f.aspect === "4x5") ?? v?.files[0];
            const sizes = [...new Set((v?.files ?? []).map((f) => f.aspect).filter(Boolean))] as string[];
            const of = d.variationOf ? designs.find((x) => x.id === d.variationOf) : null;
            return (
              <li key={d.id} className="group grid gap-2 rounded-[10px] border border-line bg-surface p-2.5 transition-colors hover:border-faint">
                <button onClick={() => setViewing({ design: d, version: d.currentVersion })} className="relative block overflow-hidden rounded-[7px]" aria-label={`Open ${d.name}`}>
                  {(() => {
                    const open = comments.filter((c) => c.designId === d.id && c.version === d.currentVersion && !c.resolved).length;
                    return open ? (
                      <span className="absolute right-1 top-1 z-10 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white shadow" title={`${open} open comment${open === 1 ? "" : "s"}`}>
                        {open}
                      </span>
                    ) : null;
                  })()}
                  <Thumb src={cover?.thumbUrl ?? null} format={ticket.format} video={cover?.mime.startsWith("video/")} className="aspect-[4/5] w-full" />
                  <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">D{d.position}</span>
                  {d.currentVersion > 1 && <span className="absolute right-2 top-2 rounded-full bg-brand px-2 py-0.5 text-[11px] font-medium text-white">v{d.currentVersion}</span>}
                  {!v?.files.length && <span className="absolute inset-x-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-center text-[11px] text-warn">Upload didn&apos;t finish</span>}
                </button>
                <div className="grid gap-1 px-0.5">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-faint">
                    {of && <span className="text-brand-text">Variation of D{of.position}</span>}
                    {ticket.format === "carousel" ? <span>{plural(v?.files.length ?? 0, "card")}</span> : sizes.map((s) => <span key={s} className="tabular">{aspectLabel(s)}</span>)}
                  </div>
                </div>
                <button
                  onClick={() => {
                    replaceFor.current = d;
                    replaceInput.current?.click();
                  }}
                  className="h-8 rounded-brand border border-line text-xs text-muted transition-colors hover:border-faint hover:text-fg"
                >
                  Replace
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {viewing && (
        <ReviewViewer
          requestId={ticket.id}
          design={viewing.design}
          version={viewing.version}
          format={ticket.format}
          comments={comments}
          onComments={setComments}
          onVersion={(n) => setViewing({ ...viewing, version: n })}
          onClose={() => setViewing(null)}
          demo={demo}
        />
      )}
    </section>
  );
}

function Thumb({ src, format, video = false, className = "" }: { src: string | null; format: Ticket["format"]; video?: boolean; className?: string }) {
  return (
    <span className={`relative grid place-items-center overflow-hidden bg-gradient-to-br from-surface-2 to-bg text-faint ${className}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <FormatIcon format={format} size={20} />
      )}
      {video && src && (
        <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[10px] text-white">▶</span>
      )}
    </span>
  );
}
