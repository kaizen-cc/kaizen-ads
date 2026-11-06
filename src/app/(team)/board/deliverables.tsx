"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUploads } from "@/components/upload-provider";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { aspectLabel, aspectOf, filesFromDrop, groupFiles, isMedia, probe, safeName, smallJpeg, type Picked, type StagedDesign, type StagedFile } from "@/lib/uploads/media";
import { creativeMissing } from "@/lib/creative-complete";
import { carryCards, checkCreative, deleteDesign, deleteFile, deleteVersion, noteBriefChange, setTicketCounts, startDesigns, startVersion, type Design } from "./design-actions";
import { CarouselBuilder } from "./carousel-builder";
import { FormatIcon } from "./ticket-card";
import type { Ticket } from "./types";
import { ReviewViewer } from "./review-viewer";
import type { ReviewComment } from "./review-actions";
import { cachedMedia, loadMedia, updateMedia } from "./media-cache";

// The ticket's creative. Dropping or picking files IS the upload: they go up at once (grouped into designs by name,
// with the AI telling net new from variations on the way), a carousel's cards go up as each card is filled, and a
// design, a version or a card can be deleted. What's still missing for the AI review is said under the files; the
// review starts on its own once nothing is.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Read and preview dropped files before they go up. */
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

/** uploaded: designs with at least one finished file. uploading: files still on their way. missing: what the AI review waits for. */
export type UploadState = { uploaded: number; uploading: number; loaded: boolean; missing: string[] };

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|psd|tiff?|svg)$/i;
const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
const isImage = (f: File) => (f.type.startsWith("image/") || IMAGE_EXT.test(f.name)) && !isVideo(f);
/** Only what the ticket is for: videos on a video ticket, images on an image ticket (carousels take both) */
const fitsFormat = (f: File, format: Ticket["format"]) => (format === "video" ? isVideo(f) : format === "image" ? isImage(f) : isVideo(f) || isImage(f));
const ACCEPT: Record<Ticket["format"], string> = { video: "video/*,.mov,.mp4,.m4v,.webm", image: "image/*,.psd", carousel: "image/*,video/*,.psd,.mov" };

/** The files that don't belong on this ticket's format, said plainly (or null when they all fit). */
function wrongFormat(files: File[], format: Ticket["format"]) {
  const off = files.filter((f) => !fitsFormat(f, format));
  if (!off.length) return null;
  const names = off.slice(0, 3).map((f) => f.name).join(", ") + (off.length > 3 ? ` and ${off.length - 3} more` : "");
  return format === "video" ? `This is a video ticket, so only video files go up. Left out: ${names}.` : `This is an image ticket, so only image files go up (no videos). Left out: ${names}.`;
}

type Busy = null | "reading" | "grouping" | "starting";

export function Deliverables({ ticket, demoDesigns, onState, canDisagree = false }: { ticket: Ticket; demoDesigns?: Design[]; onState?: (s: UploadState) => void; canDisagree?: boolean }) {
  const uploads = useUploads();
  const demo = Boolean(demoDesigns);
  // What was loaded before shows at once; it refreshes behind
  const [designs, setDesigns] = useState<Design[] | null>(demoDesigns ?? cachedMedia(ticket.id)?.designs ?? null);
  const [comments, setComments] = useState<ReviewComment[]>(cachedMedia(ticket.id)?.comments ?? []);
  const [busy, setBusy] = useState<Busy>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ label: string; run: () => Promise<{ ok: true } | { ok: false; error: string }> } | null>(null);
  // The creative open in the viewer is in the address (?design=&ver=&pin=), so back closes it and a link opens it
  const viewId = useParam("design");
  const viewVer = Number(useParam("ver")) || null;
  const viewPin = useParam("pin");
  // When this person last opened each design: comments since then are new to them (kept in this browser)
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      return typeof window === "undefined" ? {} : (JSON.parse(localStorage.getItem("kz:seen-comments") ?? "{}") as Record<string, string>);
    } catch {
      return {};
    }
  });
  const markSeen = (designId: string) =>
    setSeen((m) => {
      const next = { ...m, [designId]: new Date().toISOString() };
      try {
        localStorage.setItem("kz:seen-comments", JSON.stringify(next));
      } catch {}
      return next;
    });
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceFor = useRef<{ design: Design; card: number | null } | null>(null);
  const [counts, setCounts] = useState<{ new: number; variations: number } | null>(null); // after correcting the ticket here
  const router = useRouter();
  const asked = counts ?? { new: ticket.newCount, variations: ticket.variationCount };
  const viewDesign = designs?.find((d) => d.id === viewId) ?? null;
  const viewing = viewDesign ? { design: viewDesign, version: viewDesign.versions.some((x) => x.version === viewVer) ? viewVer! : viewDesign.currentVersion, focus: viewPin } : null;

  const finished = uploads?.finished[ticket.id] ?? 0;
  const reload = (force = true) =>
    demo
      ? Promise.resolve()
      : loadMedia(ticket.id, force).then((m) => {
          if (!m) return;
          setDesigns(m.designs);
          setComments(m.comments);
        });
  useEffect(() => {
    void reload(finished > 0 || !cachedMedia(ticket.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, finished, demo]);

  const designsRef = useRef(designs);
  useEffect(() => {
    designsRef.current = designs;
  }, [designs]);
  // Review comments (pins), refreshed whenever the viewer, the review panel or the AI review changes them
  useEffect(() => {
    if (demo) return;
    const on = (e: Event) => (e as CustomEvent).detail === ticket.id && void reload();
    window.addEventListener("kz:comments", on);
    // An AI note (or the finished review) opens the creative at its comment
    const open = async (e: Event) => {
      const { requestId, designId, commentId } = (e as CustomEvent<{ requestId: string; designId: string; commentId: string | null }>).detail;
      if (requestId !== ticket.id) return;
      await reload();
      const d = designsRef.current?.find((x) => x.id === designId);
      if (!d) return;
      pushParams({ design: d.id, ver: null, pin: commentId });
      markSeen(d.id);
    };
    window.addEventListener("kz:open-comment", open);
    return () => {
      window.removeEventListener("kz:comments", on);
      window.removeEventListener("kz:open-comment", open);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, demo]);

  // Copies into the client's Drive happen in the background: while any is on its way (or a round just landed and
  // isn't lined up yet), the statuses refresh on their own
  useEffect(() => {
    if (demo) return;
    const busy = (designs ?? []).some((d) => {
      const v = d.versions[0];
      if (!v) return false;
      if (v.files.some((f) => f.drive?.status === "syncing")) return true;
      return v.files.some((f) => !f.drive) && Date.now() - new Date(v.at).getTime() < 3 * 60_000;
    });
    if (!busy) return;
    const t = setTimeout(() => void reload(), 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, demo, ticket.id]);

  // Folder inputs need a non-standard attribute
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  const pending = (uploads?.jobs ?? []).filter((j) => j.requestId === ticket.id && j.status !== "done" && j.status !== "failed");
  const missing = designs ? creativeMissing({ ...ticket, newCount: asked.new, variationCount: asked.variations }, designs.map((d) => ({ position: d.position, isVariation: d.isVariation, files: d.versions[0]?.files ?? [] }))) : [];
  const missingKey = missing.join("|");

  // Tell the drawer whether there's a finished creative (it gates moving past production) and what's still missing
  const uploadedCount = (designs ?? []).filter((d) => d.versions[0]?.files.length).length;
  useEffect(() => {
    onState?.({ uploaded: uploadedCount, uploading: pending.length, loaded: designs !== null, missing: missingKey ? missingKey.split("|") : [] });
  }, [onState, uploadedCount, pending.length, designs, missingKey]);

  /** Files into storage: each design's files under its own version, carousel cards numbered in order. */
  const send = (d: { name: string; files: StagedFile[] }, s: { versionId: string; designId: string; version: number }, prefix: string, cardFrom = 1) => {
    if (!uploads) return;
    const dir = `${prefix}/${s.designId}/v${s.version}`;
    uploads.enqueue({
      requestId: ticket.id,
      label: `#${ticket.number} · ${d.name}`,
      versionId: s.versionId,
      items: d.files.map((f, n) => {
        const name = `${String(n + cardFrom).padStart(2, "0")}-${crypto.randomUUID().slice(0, 4)}-${safeName(f.file.name)}`;
        return { file: f.file, path: `${dir}/${name}`, thumb: f.thumb, thumbPath: f.thumb ? `${dir}/${name}.thumb.webp` : null, meta: metaOf(f, ticket.format === "carousel" ? n + cardFrom : null) };
      }),
    });
  };

  /** Dropped or picked: read, grouped (the AI says what's net new, a variation or the same design in another size), up. */
  const take = async (all: Picked[]) => {
    setError(null);
    const picked = all.filter((p) => fitsFormat(p.file, ticket.format));
    const off = wrongFormat(all.map((p) => p.file), ticket.format);
    if (off) setError(off);
    if (!picked.length) return;
    setBusy("reading");
    const files = await stage(picked);
    if (!files.length) {
      setBusy(null);
      return setError("Those files aren't images or videos.");
    }
    let list = groupFiles(files, ticket.format);
    setBusy("grouping");
    list = await grouped(list);
    setBusy("starting");
    await upload(list);
    setBusy(null);
  };

  /** The AI's read of new vs variation vs another size, applied; if it can't run, the files go up grouped by name. */
  const grouped = async (list: StagedDesign[]): Promise<StagedDesign[]> => {
    if (demo || list.length < 2) return list;
    const inputs = await Promise.all(
      list.map(async (d) => ({
        name: d.name,
        sizes: [...new Set(d.files.map((f) => f.aspect).filter(Boolean))] as string[],
        image: await smallJpeg((d.files.find((f) => f.aspect === "4x5" && f.thumb) ?? d.files.find((f) => f.thumb))?.thumb ?? null),
      })),
    );
    const res = await checkCreative(ticket.id, inputs).catch(() => null);
    if (!res?.ok) return list;
    const byPosition = new Map((designs ?? []).map((d) => [`D${d.position}`, d.id]));
    let next = [...list];
    for (const v of res.check.designs) {
      const d = list[Number(v.ref.slice(1)) - 1];
      if (!d) continue;
      const target = v.of.startsWith("S") ? list[Number(v.of.slice(1)) - 1] : null;
      if (v.kind === "same_design" && target && next.some((x) => x.key === target.key)) {
        next = next.filter((x) => x.key !== d.key).map((x) => (x.key === target.key ? { ...x, files: [...x.files, ...d.files] } : x));
      } else if (v.kind === "variation") {
        const of = target ? STAGED + target.key : (byPosition.get(v.of) ?? null);
        next = next.map((x) => (x.key === d.key ? { ...x, variationOf: of } : x));
      }
    }
    return next;
  };

  const upload = async (list: StagedDesign[]) => {
    if (!list.length) return;
    const ordered = uploadOrder(list);
    const res = demo
      ? { ok: true as const, prefix: "demo", started: ordered.map((_, i) => ({ designId: `d${i}`, versionId: `v${i}`, version: 1 })) }
      : await startDesigns(
          ticket.id,
          ordered.map((d) => (d.variationOf?.startsWith(STAGED) ? { name: d.name, variationOf: null, variationOfIndex: ordered.findIndex((x) => STAGED + x.key === d.variationOf) } : { name: d.name, variationOf: d.variationOf })),
        );
    if (!res.ok) return setError(res.error);
    ordered.forEach((d, i) => send(d, res.started[i], res.prefix));
    void reload();
  };

  const correctCounts = async (n: number, v: number) => {
    if (!demo) {
      const res = await setTicketCounts(ticket.id, n, v, "Corrected at upload to match the creative");
      if (!res.ok) return setError(res.error);
      router.refresh();
    }
    setCounts({ new: n, variations: v });
  };

  /** A new version: the files picked replace the design (or, on a carousel, just the card picked; the rest carry over). */
  const replace = async (files: File[]) => {
    const target = replaceFor.current;
    if (!target || !uploads) return;
    const list = files.filter((f) => fitsFormat(f, ticket.format));
    setError(wrongFormat(files, ticket.format));
    if (!list.length) return;
    setBusy("reading");
    const staged = await stage(list.map((file) => ({ file, folder: null })));
    setBusy("starting");
    const res = demo ? { ok: true as const, prefix: "demo", started: { designId: target.design.id, versionId: "v", version: target.design.currentVersion + 1 } } : await startVersion(target.design.id, "");
    if (!res.ok) {
      setBusy(null);
      return setError(res.error);
    }
    if (target.card != null && !demo) {
      const kept = await carryCards(res.started.versionId, staged.map((_, i) => target.card! + i));
      if (!kept.ok) setError(kept.error);
    }
    send({ name: `${target.design.name} v${res.started.version}`, files: staged }, res.started, res.prefix, target.card ?? 1);
    setBusy(null);
    void reload();
  };

  /** A card into an empty slot of a carousel already on the ticket: added to its current version. */
  const addCard = async (design: Design, card: number, file: File) => {
    const v = design.versions[0];
    if (!v || !uploads) return;
    const staged = await stage([{ file, folder: null }]);
    if (!staged.length) return;
    // Storage folders are client/request/design/vN
    send({ name: `${design.name} · card ${card}`, files: staged }, { designId: design.id, versionId: v.id, version: v.version }, `${ticket.clientId}/${ticket.id}`, card);
  };

  const remove = (label: string, run: () => Promise<{ ok: true } | { ok: false; error: string }>) => setConfirm({ label, run });

  /** Open comments on a design's current version added since this person last opened it */
  const unreadOf = (d: Design) => comments.filter((c) => c.designId === d.id && c.version === d.currentVersion && !c.resolved && (!seen[d.id] || c.at > seen[d.id])).length;

  // New designs are added while it's being made; past that (in review, with the client) a design is changed with Replace
  const canAdd = ["requested", "in_production", "client_revision"].includes(ticket.stage) || !(designs ?? []).length;
  const net = (designs ?? []).filter((d) => !d.isVariation).length;
  const vars = (designs ?? []).filter((d) => d.isVariation).length;
  const making = ["requested", "in_production", "client_revision"].includes(ticket.stage);
  const tooMany = net > asked.new || vars > asked.variations;

  return (
    <section
      data-deliverables
      className="grid gap-3"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        // Carousels take their files in the card slots (they keep the order)
        if (ticket.format === "carousel" || busy) return;
        await take(await filesFromDrop(e.dataTransfer.items));
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Deliverables</h3>
        <span className="flex flex-wrap items-center gap-2 text-xs text-faint">
          <span className={net >= asked.new ? "text-ok" : "text-muted"}>
            {net} of {asked.new} new
          </span>
          {asked.variations > 0 && (
            <span className={vars >= asked.variations ? "text-ok" : "text-muted"}>
              · {vars} of {plural(asked.variations, "variation")}
            </span>
          )}
          {tooMany && making && (
            <button type="button" onClick={() => void correctCounts(Math.max(net, asked.new), Math.max(vars, asked.variations))} className="rounded-full border border-line px-2.5 py-0.5 text-muted hover:text-fg max-md:min-h-10 max-md:px-3.5" title="More designs are here than the ticket asked for: make the ticket match (every version counts toward the allotment)">
              Make it {Math.max(net, asked.new)} new{Math.max(vars, asked.variations) ? ` + ${Math.max(vars, asked.variations)} var.` : ""}
            </button>
          )}
        </span>
      </div>

      <input ref={filesInput} type="file" multiple accept={ACCEPT[ticket.format]} className="hidden" onChange={(e) => (take([...(e.target.files ?? [])].map((file) => ({ file, folder: null }))), (e.target.value = ""))} />
      <input ref={folderInput} type="file" multiple className="hidden" onChange={(e) => (take([...(e.target.files ?? [])].map((file) => ({ file, folder: file.webkitRelativePath.split("/")[0] ?? null }))), (e.target.value = ""))} />
      <input
        ref={replaceInput}
        type="file"
        multiple
        accept={ACCEPT[ticket.format]}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void replace(files);
        }}
      />

      {canAdd &&
        (ticket.format === "carousel" ? (
          // Carousels: a slot for each card; a file in its slot is uploaded, no extra step
          <CarouselBuilder
            cards={ticket.cards ?? 5}
            next={(designs ?? []).length + 1}
            show={(designs ?? []).length < asked.new + asked.variations || !(designs ?? []).length}
            read={(files) => stage(files.map((file) => ({ file, folder: null })))}
            onCreate={async (name) => {
              const res = demo ? { ok: true as const, prefix: "demo", started: [{ designId: "d", versionId: "v", version: 1 }] } : await startDesigns(ticket.id, [{ name, variationOf: null }]);
              if (!res.ok) {
                setError(res.error);
                return null;
              }
              return { ...res.started[0], prefix: res.prefix };
            }}
            onUpload={(s, card, file) => send({ name: `card ${card}`, files: [file] }, s, s.prefix, card)}
            onDone={() => void reload()}
          />
        ) : (
          <div className={`grid place-items-center gap-2 rounded-[10px] border border-dashed px-6 py-7 text-center transition-colors ${over ? "border-brand-text bg-brand-soft" : "border-line"}`}>
            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6c7ee1]" />
                {busy === "reading" ? "Reading the files…" : busy === "grouping" ? "Sorting them into designs…" : "Uploading…"}
              </p>
            ) : (
              <>
                <p className="text-sm text-muted max-md:hidden">{over ? "Drop to upload" : "Drop files or a folder here: they upload right away"}</p>
                <p className="flex items-center gap-2 text-xs text-faint">
                  <button onClick={() => filesInput.current?.click()} className="text-fg underline-offset-4 hover:underline max-md:h-11 max-md:rounded-full max-md:border max-md:border-line max-md:bg-surface max-md:px-5 max-md:text-sm max-md:font-medium">
                    Choose files
                  </button>
                  <span className="max-md:hidden">·</span>
                  <button onClick={() => folderInput.current?.click()} className="text-fg underline-offset-4 hover:underline max-md:hidden">
                    Choose a folder
                  </button>
                </p>
                <p className="text-[11px] text-faint">Sizes of the same idea group into one design automatically.</p>
              </>
            )}
          </div>
        ))}
      {error && <p className="text-sm text-brand-text">{error}</p>}

      {/* What's here */}
      {designs === null ? (
        <ul className="grid grid-cols-2 gap-3" aria-label="Loading the creative">
          {[0, 1].map((i) => (
            <li key={i} className="aspect-[4/5] animate-pulse rounded-[10px] bg-surface-2" />
          ))}
        </ul>
      ) : designs.length + pending.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3">
          {pending.map((j) => (
            <li key={j.id} className="grid gap-2 rounded-[10px] border border-line bg-surface p-2.5">
              <div className="relative grid aspect-[4/5] place-items-center overflow-hidden rounded-[7px] bg-surface-2">
                <span className="absolute inset-y-0 left-0 w-1/2 animate-[ai-sweep_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-fg/10 to-transparent" />
                <span className="tabular text-xs text-muted">{j.status === "saving" ? "Saving…" : `${Math.round((j.sent / j.total) * 100)}%`}</span>
              </div>
              <p className="truncate text-xs text-muted">{j.label.split(" · ").slice(1).join(" · ")}</p>
            </li>
          ))}
          {designs.map((d) => {
            const v = d.versions[0];
            const cover = v?.files.find((f) => f.aspect === "4x5") ?? v?.files[0];
            const sizes = [...new Set((v?.files ?? []).map((f) => f.aspect).filter(Boolean))] as string[];
            const of = d.variationOf ? designs.find((x) => x.id === d.variationOf) : null;
            const open = comments.filter((c) => c.designId === d.id && c.version === d.currentVersion && !c.resolved).length;
            const fresh = unreadOf(d);
            const wantCards = Math.max(2, ticket.cards ?? 5);
            return (
              <li key={d.id} className={`group grid content-start gap-2 rounded-[10px] border bg-surface p-2.5 transition-colors hover:border-faint ${fresh ? "border-[#6c7ee1] shadow-[0_0_0_3px_rgba(108,126,225,0.25),0_12px_32px_-12px_rgba(108,126,225,0.8)]" : "border-line"}`}>
                <button onClick={() => (pushParams({ design: d.id, ver: null, pin: null }), markSeen(d.id))} className="relative block overflow-hidden rounded-[7px]" aria-label={`Open ${d.name}`}>
                  {fresh ? (
                    <span className="absolute inset-x-2 bottom-2 z-10 flex items-center justify-center gap-1.5 rounded-full bg-[#6c7ee1] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-lg">
                      <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white" />
                      {fresh} new comment{fresh === 1 ? "" : "s"} · {cover?.mime.startsWith("video/") ? "Watch" : "Open"}
                    </span>
                  ) : open ? (
                    <span className="absolute right-1 top-1 z-10 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white shadow" title={`${open} open comment${open === 1 ? "" : "s"}`}>
                      {open}
                    </span>
                  ) : null}
                  <Thumb src={cover?.thumbUrl ?? null} format={ticket.format} video={cover?.mime.startsWith("video/")} className="aspect-[4/5] w-full" />
                  <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">D{d.position}</span>
                  {d.currentVersion > 1 && !open && <span className="absolute right-2 top-2 rounded-full bg-brand px-2 py-0.5 text-[11px] font-medium text-white">v{d.currentVersion}</span>}
                  {!v?.files.length && <span className="absolute inset-x-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-center text-[11px] text-warn">Upload didn&apos;t finish</span>}
                </button>
                <div className="grid gap-1 px-0.5">
                  <p className="truncate text-sm font-medium">{d.name}</p>
                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-faint">
                    {of && <span className="text-brand-text">Variation of D{of.position}</span>}
                    {ticket.format === "carousel" ? <span>{plural(v?.files.length ?? 0, "card")}</span> : sizes.map((s) => <span key={s} className="tabular">{aspectLabel(s)}</span>)}
                  </div>
                  {v && <DriveStatus files={v.files} />}
                </div>
                {/* A carousel's cards: replace one (the rest carry over), delete one, or fill an empty slot */}
                {ticket.format === "carousel" && v && !d.clientApproved && (
                  <div className="-mx-0.5 flex gap-1 overflow-x-auto px-0.5 pb-0.5">
                    {Array.from({ length: Math.max(wantCards, v.files.length) }, (_, i) => {
                      const f = v.files.find((x) => x.card === i + 1) ?? (v.files.every((x) => x.card == null) ? v.files[i] : undefined);
                      return f ? (
                        <span key={i} className="group/card relative h-12 w-10 shrink-0 overflow-hidden rounded-[5px] bg-surface-2 max-md:h-14 max-md:w-11">
                          {f.thumbUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={f.thumbUrl} alt={`Card ${i + 1}`} className="h-full w-full object-cover" />
                          )}
                          <span className="absolute inset-0 hidden flex-col items-stretch justify-center gap-0.5 bg-black/70 p-0.5 group-hover/card:flex [@media(hover:none)]:flex [@media(hover:none)]:bg-black/40">
                            <button type="button" title={`Replace card ${i + 1}`} onClick={() => ((replaceFor.current = { design: d, card: i + 1 }), replaceInput.current?.click())} className="rounded bg-white/90 text-[9px] font-medium text-black">
                              ↻
                            </button>
                            <button type="button" title={`Delete card ${i + 1}`} onClick={() => remove(`card ${i + 1} of ${d.name}`, () => deleteFile(f.id))} className="rounded bg-white/90 text-[9px] font-medium text-bad">
                              ✕
                            </button>
                          </span>
                        </span>
                      ) : (
                        <label key={i} className="grid h-12 w-10 shrink-0 cursor-pointer place-items-center rounded-[5px] border border-dashed border-line text-[11px] text-faint hover:border-brand-text/60 hover:text-fg max-md:h-14 max-md:w-11" title={`Add card ${i + 1}`}>
                          +{i + 1}
                          <input type="file" accept={ACCEPT.carousel} className="hidden" onChange={(e) => (e.target.files?.[0] && void addCard(d, i + 1, e.target.files[0]), (e.target.value = ""))} />
                        </label>
                      );
                    })}
                  </div>
                )}
                {d.clientApproved ? (
                  <span className="grid h-8 place-items-center rounded-brand bg-ok/10 text-xs text-ok max-md:h-auto max-md:min-h-11 max-md:px-1 max-md:text-center" title="The client approved this design; it can't be changed">
                    ✓ Client approved · locked
                  </span>
                ) : (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        replaceFor.current = { design: d, card: null };
                        replaceInput.current?.click();
                      }}
                      className="h-8 flex-1 rounded-brand border border-line text-xs text-muted transition-colors hover:border-faint hover:text-fg max-md:h-11 max-md:text-sm"
                    >
                      Replace
                    </button>
                    <button
                      onClick={() => remove(d.currentVersion > 1 ? `v${d.currentVersion} of ${d.name} (v${d.currentVersion - 1} becomes current again)` : d.name, () => (d.currentVersion > 1 ? deleteVersion(d.id) : deleteDesign(d.id)))}
                      aria-label={`Delete ${d.name}`}
                      title={d.currentVersion > 1 ? `Delete v${d.currentVersion}` : "Delete this design"}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-brand border border-line text-xs text-faint transition-colors hover:border-bad/50 hover:text-bad max-md:h-11 max-md:w-11"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* What the AI review is waiting for: it starts on its own once nothing is missing */}
      {making && designs !== null && designs.length > 0 && missing.length > 0 && !pending.length && (
        <p className="flex items-start gap-2 rounded-[8px] bg-surface-2/70 px-3 py-2 text-xs text-muted">
          <EyeIcon className="mt-px h-3.5 w-3.5 shrink-0 text-[#6c7ee1]" />
          <span>
            <span className="text-fg">Before the AI review:</span> {missing.join(" · ")}
          </span>
        </p>
      )}

      {/* Anything in the brief that couldn't be done as asked, said for the lead (optional) */}
      {making && designs !== null && designs.length > 0 && !demo && (
        <div className="grid gap-2">
          {note === null ? (
            <button type="button" onClick={() => setNote("")} className="justify-self-start text-xs text-faint hover:text-fg max-md:min-h-11">
              Had to change something from the brief? Tell the lead →
            </button>
          ) : (
            <div className="grid gap-2 rounded-[8px] border border-line bg-bg/40 p-3">
              <textarea
                data-chat
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="What wasn't possible and what you did instead (e.g. no lifestyle photo of the product, so used the studio shot with a kitchen background)"
                className="rounded-[8px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand-text/60"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!note.trim()}
                  onClick={async () => {
                    const r = await noteBriefChange(ticket.id, note);
                    if (!r.ok) return setError(r.error);
                    window.dispatchEvent(new CustomEvent("kz:brief", { detail: ticket.id }));
                    setNote(null);
                  }}
                  className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg disabled:opacity-40 max-md:h-11"
                >
                  Save
                </button>
                <button type="button" onClick={() => setNote(null)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg max-md:h-11">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirm && (
        <div className="grid gap-2.5 rounded-[10px] border border-bad/30 bg-bad-soft/30 p-3.5">
          <p className="text-sm">Delete {confirm.label}? The files are removed for good.</p>
          <div className="flex gap-2 max-md:[&>button]:h-11 max-md:[&>button]:flex-1">
            <button
              type="button"
              onClick={async () => {
                const job = confirm;
                setConfirm(null);
                if (demo) return;
                const r = await job.run();
                if (!r.ok) return setError(r.error);
                closeParams("design", "ver", "pin");
                void reload();
                router.refresh();
              }}
              className="h-9 rounded-brand bg-bad px-4 text-sm font-medium text-white"
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirm(null)} className="h-9 rounded-brand px-3 text-sm text-muted hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      )}

      {viewing && (
        <ReviewViewer
          key={viewing.design.id}
          requestId={ticket.id}
          design={viewing.design}
          version={viewing.version}
          format={ticket.format}
          comments={comments}
          onComments={(c) => (setComments(c), updateMedia(ticket.id, { comments: c }))}
          onVersion={(n) => replaceParams({ ver: n === viewing.design.currentVersion ? null : String(n) })}
          onClose={() => (markSeen(viewing.design.id), closeParams("design", "ver", "pin"))}
          focus={viewing.focus ?? null}
          demo={demo}
          canDisagree={canDisagree}
        />
      )}
    </section>
  );
}

/**
 * Each file's copy in the client's Drive (Ad Creative / Avatar / Angle / Month Concept): "In Drive ✓" with a link per
 * size or slide, "Syncing…", or what stopped it, with where to fix it. Nothing until the file is lined up for Drive.
 */
function DriveStatus({ files }: { files: Design["versions"][number]["files"] }) {
  const tracked = files.filter((f) => f.drive);
  if (!tracked.length) return null;
  const label = (f: (typeof files)[number]) => (f.card != null ? `Slide ${f.card}` : f.aspect ? aspectLabel(f.aspect) : f.name);
  const failed = tracked.filter((f) => f.drive!.status === "error");
  const syncing = tracked.filter((f) => f.drive!.status === "syncing");
  const synced = tracked.filter((f) => f.drive!.status === "synced");
  if (failed.length) {
    const d = failed[0].drive!;
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-bad" title={failed.map((f) => `${label(f)}: ${f.drive!.error ?? "failed"}`).join("\n")}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bad" />
        <span className="min-w-0">{d.error ?? "Couldn't copy to Drive"}</span>
        {d.fixUrl && (
          <a href={d.fixUrl} className="font-medium text-fg underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:items-center">
            Set the folder
          </a>
        )}
      </p>
    );
  }
  if (syncing.length)
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-faint" title={syncing.map((f) => `${label(f)}${f.drive!.error ? `: retrying (${f.drive!.error})` : ""}`).join("\n")}>
        <span className="h-1.5 w-1.5 shrink-0 animate-[ai-pulse_1s_ease-in-out_infinite] rounded-full bg-brand-text" />
        Syncing to Drive{tracked.length > 1 ? ` · ${synced.length}/${tracked.length}` : "…"}
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ok">
      {synced.length === 1 && synced[0].drive!.url ? (
        <a href={synced[0].drive!.url} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:items-center">
          In Drive ✓
        </a>
      ) : (
        <>
          <span>In Drive ✓</span>
          {synced.map((f) =>
            f.drive!.url ? (
              <a key={f.id} href={f.drive!.url} target="_blank" rel="noreferrer" className="tabular text-faint hover:text-fg hover:underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:items-center max-md:px-1">
                {label(f)}
              </a>
            ) : null,
          )}
        </>
      )}
    </p>
  );
}

function Thumb({ src, format, video = false, className = "" }: { src: string | null; format: Ticket["format"]; video?: boolean; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={`relative grid place-items-center overflow-hidden bg-gradient-to-br from-surface-2 to-bg text-faint ${className}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" decoding="async" onLoad={() => setLoaded(true)} className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`} />
      ) : (
        <FormatIcon format={format} size={20} />
      )}
      {src && !loaded && <span className="absolute inset-0 animate-pulse bg-surface-2" />}
      {video && src && <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[10px] text-white">▶</span>}
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

function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}
