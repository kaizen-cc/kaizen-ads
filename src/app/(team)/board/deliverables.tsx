"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUploads } from "@/components/upload-provider";
import { aspectLabel, aspectOf, filesFromDrop, groupFiles, isMedia, probe, safeName, smallJpeg, type Picked, type StagedDesign, type StagedFile } from "@/lib/uploads/media";
import type { CreativeCheck } from "@/lib/ai";
import { checkCreative, noteBriefChange, setTicketCounts, startDesigns, startVersion, ticketDesigns, type Design } from "./design-actions";
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

// A staged design can be a variation of a design already on the ticket (its id) or of another one in this upload
const STAGED = "staged:";

/** What the AI said about one staged design, keyed by the staged design's key. */
type Verdict = { kind: CreativeCheck["designs"][number]["kind"]; of: { staged: string } | { design: string } | null; reason: string };
type CheckState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "done"; summary: string; verdicts: Record<string, Verdict>; left: number | null; applied: boolean };

/** Parents before their variations, so the database can link a variation to a design in the same upload. */
function uploadOrder(staged: StagedDesign[]) {
  const done: StagedDesign[] = [];
  const pending = [...staged];
  while (pending.length) {
    const i = pending.findIndex((d) => !d.variationOf?.startsWith(STAGED) || done.some((x) => STAGED + x.key === d.variationOf));
    done.push(...pending.splice(i < 0 ? 0 : i, 1));
  }
  return done;
}

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
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [adjusted, setAdjusted] = useState<{ on: boolean; note: string }>({ on: false, note: "" });
  const [counts, setCounts] = useState<{ new: number; variations: number } | null>(null); // after correcting the ticket here
  const router = useRouter();
  const asked = counts ?? { new: ticket.newCount, variations: ticket.variationCount };

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
    // Another drop adds to what's already staged (it never replaces it); the same file dropped twice counts once
    const before = (staged ?? []).flatMap((d) => d.files);
    const fresh = files.filter((f) => !before.some((b) => b.file.name === f.file.name && b.file.size === f.file.size));
    const grouped = groupFiles([...before, ...fresh], ticket.format);
    setStaged(grouped);
    runCheck(grouped);
  };

  /** The AI looks at the staged designs next to what's on the ticket. */
  const checkRun = useRef(0);
  const runCheck = async (list: StagedDesign[]) => {
    const id = ++checkRun.current;
    setCheck({ status: "running" });
    if (demo) {
      await new Promise((r) => setTimeout(r, 900));
      if (id !== checkRun.current) return;
      const verdicts: Record<string, Verdict> = {};
      list.forEach((d, i) => {
        verdicts[d.key] =
          i === 0
            ? { kind: "new", of: null, reason: "Its own layout and main visual." }
            : { kind: "variation", of: { staged: list[0].key }, reason: `Same layout and photo as ${list[0].name}; only the headline and colours change.` };
      });
      return setCheck({ status: "done", summary: list.length > 1 ? `One design and ${plural(list.length - 1, "variation")} of it.` : "One net new design.", verdicts, left: 3, applied: false });
    }
    const inputs = await Promise.all(
      list.map(async (d) => ({
        name: d.name,
        sizes: [...new Set(d.files.map((f) => f.aspect).filter(Boolean))] as string[],
        image: await smallJpeg((d.files.find((f) => f.aspect === "4x5" && f.thumb) ?? d.files.find((f) => f.thumb))?.thumb ?? null),
      })),
    );
    const res = await checkCreative(ticket.id, inputs);
    if (id !== checkRun.current) return;
    if (!res.ok) return setCheck({ status: "failed", error: res.error });
    const byPosition = new Map((designs ?? []).map((d) => [`D${d.position}`, d.id]));
    const verdicts: Record<string, Verdict> = {};
    for (const v of res.check.designs) {
      const d = list[Number(v.ref.slice(1)) - 1];
      if (!d) continue;
      const target = v.of.startsWith("S") ? list[Number(v.of.slice(1)) - 1] : null;
      const of = target ? { staged: target.key } : byPosition.has(v.of) ? { design: byPosition.get(v.of)! } : null;
      verdicts[d.key] = { kind: of || v.kind === "new" ? v.kind : "new", of, reason: v.reason };
    }
    setCheck({ status: "done", summary: res.check.summary, verdicts, left: res.left, applied: false });
  };

  /** Take what the AI said: mark variations, put the same design's other sizes together. */
  const applyCheck = () => {
    if (!staged || check.status !== "done") return;
    let next = staged.map((d) => {
      const v = check.verdicts[d.key];
      if (!v || v.kind === "same_design") return d;
      if (v.kind === "new") return { ...d, variationOf: null };
      return { ...d, variationOf: v.of ? ("staged" in v.of ? STAGED + v.of.staged : v.of.design) : null };
    });
    for (const d of staged) {
      const v = check.verdicts[d.key];
      if (v?.kind !== "same_design" || !v.of || !("staged" in v.of)) continue;
      const into = (v.of as { staged: string }).staged;
      if (!next.some((x) => x.key === into)) continue;
      next = next.filter((x) => x.key !== d.key).map((x) => (x.key === into ? { ...x, files: [...x.files, ...d.files] } : x));
      next = next.map((x) => (x.variationOf === STAGED + d.key ? { ...x, variationOf: STAGED + into } : x));
    }
    setStaged(next);
    setCheck({ ...check, applied: true });
  };

  const correctCounts = async (n: number, v: number) => {
    const reason = "Corrected at upload to match the creative";
    if (!demo) {
      const res = await setTicketCounts(ticket.id, n, v, reason);
      if (!res.ok) return setError(res.error);
      router.refresh();
    }
    setCounts({ new: n, variations: v });
  };

  const fromInput = (list: FileList | null, folders: boolean) =>
    take([...(list ?? [])].map((file) => ({ file, folder: folders ? (file.webkitRelativePath.split("/")[0] ?? null) : null })));

  const upload = async () => {
    if (!staged?.length || !uploads) return;
    setError(null);
    const ordered = uploadOrder(staged);
    const res = demo
      ? { ok: true as const, prefix: "demo", started: ordered.map((_, i) => ({ designId: `d${i}`, versionId: `v${i}`, version: 1 })) }
      : await startDesigns(
          ticket.id,
          ordered.map((d) =>
            d.variationOf?.startsWith(STAGED)
              ? { name: d.name, variationOf: null, variationOfIndex: ordered.findIndex((x) => STAGED + x.key === d.variationOf) }
              : { name: d.name, variationOf: d.variationOf },
          ),
        );
    if (!res.ok) return setError(res.error);
    if (adjusted.on && adjusted.note.trim() && !demo) {
      const r = await noteBriefChange(ticket.id, adjusted.note);
      if (!r.ok) setError(r.error);
      window.dispatchEvent(new CustomEvent("kz:brief", { detail: ticket.id }));
    }
    setAdjusted({ on: false, note: "" });
    ordered.forEach((d, i) => {
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
    setCheck({ status: "idle" });
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

  // New designs are added while it's being made; past that (in review, with the client) a design is changed with Replace
  const canAdd = ["requested", "in_production", "client_revision"].includes(ticket.stage) || !(designs ?? []).length;
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
          <span className={net >= asked.new ? "text-ok" : "text-muted"}>
            {net} of {asked.new} new
          </span>
          {asked.variations > 0 && (
            <>
              {" · "}
              <span className={vars >= asked.variations ? "text-ok" : "text-muted"}>
                {vars} of {plural(asked.variations, "variation")}
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
          <CheckPanel
            ticket={ticket}
            staged={staged}
            designs={designs ?? []}
            check={check}
            asked={asked}
            onApply={applyCheck}
            onRetry={() => runCheck(staged)}
            onCounts={correctCounts}
          />
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
                    {((designs ?? []).some((x) => !x.isVariation) || staged.length > 1) && (
                      <select
                        value={d.variationOf ?? ""}
                        onChange={(e) => setStaged(staged.map((x, j) => (j === i ? { ...x, variationOf: e.target.value || null } : x)))}
                        aria-label="Variation of"
                        className="ml-auto h-7 rounded-full border border-line bg-bg px-2 text-xs text-muted"
                      >
                        <option value="">Net new design</option>
                        {staged
                          .filter((x) => x.key !== d.key && !x.variationOf)
                          .map((x) => (
                            <option key={x.key} value={STAGED + x.key}>
                              Variation of {x.name}
                            </option>
                          ))}
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
                  {check.status === "done" && check.verdicts[d.key] && (
                    <p className="flex items-start gap-1.5 text-xs text-muted">
                      <EyeIcon className="mt-px h-3.5 w-3.5 shrink-0 text-[#6c7ee1]" />
                      <span>
                        <span className="text-fg">{verdictLabel(check.verdicts[d.key], staged, designs ?? [])}</span> · {check.verdicts[d.key].reason}
                      </span>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {/* Anything in the brief that couldn't be done as asked: said here, so the lead sees it before reviewing */}
          <div className="grid gap-2 rounded-[8px] border border-line bg-bg/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">Did you have to change anything from the brief?</p>
              <span className="flex gap-1">
                {([false, true] as const).map((v) => (
                  <button key={String(v)} type="button" onClick={() => setAdjusted(v ? { on: true, note: adjusted.note } : { on: false, note: "" })} className={`h-7 rounded-full px-3 text-xs transition-colors ${adjusted.on === v ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                    {v ? "Yes" : "No"}
                  </button>
                ))}
              </span>
            </div>
            {adjusted.on && (
              <textarea
                autoFocus
                value={adjusted.note}
                onChange={(e) => setAdjusted({ on: true, note: e.target.value })}
                rows={2}
                placeholder="What wasn't possible and what you did instead (e.g. no lifestyle photo of the product, so used the studio shot with a kitchen background)"
                className="rounded-[8px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => filesInput.current?.click()} className="mr-auto h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
              + Add more files
            </button>
            <button
              onClick={() => {
                checkRun.current++;
                setStaged(null);
                setCheck({ status: "idle" });
                setAdjusted({ on: false, note: "" });
              }}
              className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg"
            >
              Cancel
            </button>
            <button onClick={upload} disabled={adjusted.on && !adjusted.note.trim()} className="h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50">
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
      ) : !canAdd ? null : (
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
                {d.clientApproved ? (
                  <span className="grid h-8 place-items-center rounded-brand bg-ok/10 text-xs text-ok" title="The client approved this design; it can't be changed">
                    ✓ Client approved · locked
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      replaceFor.current = d;
                      replaceInput.current?.click();
                    }}
                    className="h-8 rounded-brand border border-line text-xs text-muted transition-colors hover:border-faint hover:text-fg"
                  >
                    Replace
                  </button>
                )}
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

function EyeIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
    </svg>
  );
}

function verdictLabel(v: Verdict, staged: StagedDesign[], designs: Design[]) {
  const name = !v.of ? "" : "staged" in v.of ? (staged.find((x) => x.key === (v.of as { staged: string }).staged)?.name ?? "another design") : `D${designs.find((x) => x.id === (v.of as { design: string }).design)?.position ?? "?"}`;
  return v.kind === "new" ? "Net new" : v.kind === "variation" ? `Variation of ${name}` : `Same design as ${name}, another size`;
}

/** The creative check: sizes that came in and are missing, what's new vs a variation, and whether that matches the ticket. */
function CheckPanel({
  ticket,
  staged,
  designs,
  check,
  asked,
  onApply,
  onRetry,
  onCounts,
}: {
  ticket: Ticket;
  staged: StagedDesign[];
  designs: Design[];
  check: CheckState;
  asked: { new: number; variations: number };
  onApply: () => void;
  onRetry: () => void;
  onCounts: (n: number, v: number) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  // Sizes: measured from the files themselves, against what the ticket asked for
  const carousel = ticket.format === "carousel";
  const sizesOf = (d: StagedDesign) => new Set(d.files.map((f) => f.aspect).filter(Boolean) as string[]);
  const all = [...new Set(staged.flatMap((d) => [...sizesOf(d)]))];
  const missing = ticket.sizes
    .map((s) => ({ size: s, lacking: staged.filter((d) => !sizesOf(d).has(s)) }))
    .filter((m) => m.lacking.length);
  const extra = all.filter((s) => ticket.sizes.length && !ticket.sizes.includes(s));
  const everyone = (n: number) => (staged.length === 1 ? "" : n === staged.length ? (staged.length === 2 ? " on both" : " on all") : "");

  // Counts: what this upload makes, with what's already on the ticket
  const existingNew = designs.filter((d) => !d.isVariation).length;
  const existingVar = designs.length - existingNew;
  const planNew = existingNew + staged.filter((d) => !d.variationOf).length;
  const planVar = existingVar + staged.filter((d) => d.variationOf).length;
  const overNew = planNew > asked.new;
  const overVar = planVar > asked.variations;
  const proposed = {
    new: overNew ? planNew : overVar ? Math.max(planNew, asked.new - (planVar - asked.variations)) : asked.new,
    variations: Math.max(planVar, asked.variations),
  };
  const mismatch = (overNew || overVar) && (proposed.new !== asked.new || proposed.variations !== asked.variations);
  const freed = asked.new - proposed.new;
  const extraNew = proposed.new - asked.new;
  const left = check.status === "done" ? check.left : null;
  const pending =
    check.status === "done" &&
    !check.applied &&
    staged.some((d) => {
      const v = check.verdicts[d.key];
      if (!v) return false;
      if (v.kind === "same_design") return Boolean(v.of && "staged" in v.of);
      const want = v.kind === "new" || !v.of ? null : "staged" in v.of ? STAGED + v.of.staged : v.of.design;
      return want !== d.variationOf;
    });

  return (
    <div className="grid gap-2.5 rounded-[8px] border border-line bg-bg/60 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium text-fg">
          <EyeIcon className="h-4 w-4 text-[#6c7ee1]" />
          Creative check
        </p>
        {check.status === "running" ? (
          <span className="flex items-center gap-1.5 text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6c7ee1]" />
            Looking at the designs…
          </span>
        ) : (
          check.status !== "idle" && (
            <button onClick={onRetry} className="text-faint hover:text-fg">
              Check again
            </button>
          )
        )}
      </div>

      {!carousel && (
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
          <span className="text-faint">Sizes</span>
          <span className="text-muted">
            {all.length
              ? all.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <span className="tabular text-fg">{aspectLabel(s)}</span>
                    {extra.includes(s) && <span className="text-faint"> (not on the ticket)</span>}
                  </span>
                ))
              : "Couldn't read the sizes"}
          </span>
          <span className="text-faint">Missing</span>
          {missing.length ? (
            <span className="text-warn">
              {missing.every((m) => m.lacking.length === staged.length)
                ? `${missing.map((m) => aspectLabel(m.size)).join(", ")}${everyone(staged.length)}`
                : missing.map((m) => `${aspectLabel(m.size)} on ${m.lacking.length === staged.length ? "all" : m.lacking.map((d) => d.name).join(", ")}`).join(" · ")}
            </span>
          ) : (
            <span className="text-ok">Every size asked for is here</span>
          )}
        </div>
      )}

      {check.status === "failed" && <p className="text-faint">{check.error}</p>}
      {check.status === "done" && (
        <div className="grid gap-2 border-t border-line pt-2.5">
          <p className="text-muted">{check.summary}</p>
          {pending && (
            <button onClick={onApply} className="justify-self-start rounded-full bg-[#6c7ee1]/15 px-3 py-1.5 font-medium text-[#9aa7f0] hover:bg-[#6c7ee1]/25">
              Use the AI&apos;s grouping
            </button>
          )}
        </div>
      )}

      <div className="grid gap-2 border-t border-line pt-2.5">
        <p className="text-muted">
          With this upload: <span className="text-fg tabular">{plural(planNew, "net new", "net new")}</span>
          {planVar > 0 && <span className="text-fg tabular"> · {plural(planVar, "variation")}</span>}
          <span className="text-faint">
            {" "}
            · ticket is for {asked.new} new{asked.variations ? ` + ${plural(asked.variations, "variation")}` : ""}
          </span>
        </p>
        {mismatch && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] bg-warn/10 px-2.5 py-2">
            <span className={extraNew > 0 && left !== null && extraNew > left ? "text-bad" : "text-warn"}>
              {extraNew > 0
                ? `${plural(extraNew, "more net new design")} would count toward the allotment${left !== null ? ` (${left} left${extraNew > left ? `, over by ${extraNew - left}` : ""})` : ""}.`
                : freed > 0
                  ? `Variations don't count toward the allotment: correcting the ticket gives ${freed} back.`
                  : "Variations don't count toward the allotment."}
            </span>
            <button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                await onCounts(proposed.new, proposed.variations);
                setSaving(false);
              }}
              className="rounded-full border border-line px-3 py-1 text-muted hover:border-faint hover:text-fg disabled:opacity-60"
            >
              {saving ? "Saving…" : `Make it ${proposed.new} new${proposed.variations ? ` + ${proposed.variations} var.` : ""}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
