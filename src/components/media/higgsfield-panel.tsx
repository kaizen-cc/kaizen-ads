"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cancelMedia, clientMedia, mediaAccess, mediaToDeliverables, mediaToDrive, referenceUpload, startHiggsfield, ticketMedia, writeMediaPrompt, type MediaAccess } from "@/app/(team)/media-actions";
import { activeMedia, MediaProgress, trackMediaJob, useMediaJobs } from "@/components/media-jobs";
import { HF_MODELS, MAX_PROMPT_CHARS, type HfModel, type MediaJob } from "@/lib/media-models";
import { createClient } from "@/lib/supabase/client";

// "Generate with Higgsfield", on tickets and the client's shot list: an image or a video from a prompt (the AI can
// write it from the brief), with an optional reference image and the model's own options. It runs in the
// background: leave the page and a toast and the bell say when it's ready. Results stay on the ticket, and an image
// or video can become a deliverable or go to the client's Drive.

const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

type Ref = { path: string; preview: string; name: string };

export function HiggsfieldPanel({ requestId, clientId, deliverables = true }: { requestId?: string; clientId?: string; deliverables?: boolean }) {
  const [access, setAccess] = useState<MediaAccess | null>(null);
  const [list, setList] = useState<MediaJob[] | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [modelKey, setModelKey] = useState(HF_MODELS[0].key);
  const [prompt, setPrompt] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const [opts, setOpts] = useState<Record<string, unknown>>({});
  const [ref, setRef] = useState<Ref | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, start] = useTransition();
  const [writing, startWriting] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const live = useMediaJobs();

  const reload = () => {
    const l = requestId ? ticketMedia(requestId, ["image", "video"]) : clientId ? clientMedia(clientId, ["image", "video"]) : Promise.resolve([]);
    return l.then(setList);
  };
  useEffect(() => {
    let on = true;
    void mediaAccess().then((a) => on && setAccess(a));
    const l = requestId ? ticketMedia(requestId, ["image", "video"]) : clientId ? clientMedia(clientId, ["image", "video"]) : Promise.resolve([]);
    void l.then((x) => on && setList(x));
    // A job finishing anywhere: read the list again so the result shows here
    const done = () => void (requestId ? ticketMedia(requestId, ["image", "video"]) : clientId ? clientMedia(clientId, ["image", "video"]) : Promise.resolve([])).then((x) => on && setList(x));
    window.addEventListener("media-job-done", done);
    return () => {
      on = false;
      window.removeEventListener("media-job-done", done);
    };
  }, [requestId, clientId]);

  const models = HF_MODELS.filter((m) => m.kind === kind);
  const model: HfModel = models.find((m) => m.key === modelKey) ?? models[0];
  const valueOf = (key: string, d: unknown) => (opts[key] === undefined ? d : opts[key]);

  const pickKind = (k: "image" | "video") => {
    setKind(k);
    setModelKey(HF_MODELS.find((m) => m.kind === k)!.key);
    setOpts({});
  };

  const upload = async (f: File) => {
    setError(null);
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) return setError("References can be JPG, PNG, WebP or GIF.");
    if (f.size > 20 * 1024 * 1024) return setError("That image is over 20 MB.");
    setUploading(true);
    const r = await referenceUpload({ requestId: requestId ?? null, clientId: clientId ?? null }, f.name, f.type);
    if (!r.ok) {
      setUploading(false);
      return setError(r.error);
    }
    const { error: upErr } = await createClient().storage.from("ai-media").uploadToSignedUrl(r.path, r.token, f, { contentType: f.type });
    setUploading(false);
    if (upErr) return setError("The reference didn't upload. Try again.");
    setRef({ path: r.path, preview: URL.createObjectURL(f), name: f.name });
  };

  const write = () =>
    startWriting(async () => {
      if (!requestId) return;
      setError(null);
      const r = await writeMediaPrompt(requestId, kind, prompt ? `Improve this prompt: ${prompt}` : undefined);
      if (!r.ok) return setError(r.error);
      setPrompt(r.prompt);
      setWhy(r.why);
    });

  const generate = () =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await startHiggsfield({ model: model.key, prompt, options: opts, referencePath: model.reference === "none" ? null : (ref?.path ?? null), requestId: requestId ?? null, clientId: clientId ?? null });
      if (!r.ok) return setError(r.error);
      trackMediaJob(r.job);
      setList((l) => [r.job, ...(l ?? [])]);
    });

  const act = (fn: () => Promise<{ ok: true; note?: string } | { ok: false; error: string }>, done?: string) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      setNote(("note" in r && r.note) || done || null);
      await reload();
    });

  // The live status (from the bell's poll) wins over what was read when the panel opened
  const jobs = (list ?? []).map((j) => live.find((x) => x.id === j.id) ?? j);
  const can = access?.canGenerate && access.higgsfield;
  const needsPrompt = model.promptRequired || !(ref && model.reference !== "none");

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-faint">AI images and video</h3>
        {access && !access.higgsfield && <span className="text-[11px] text-faint">Higgsfield isn&apos;t connected yet</span>}
      </div>

      {can && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex min-h-14 items-center justify-between gap-3 rounded-[12px] border border-dashed border-line px-4 py-3 text-left transition-colors hover:border-faint hover:bg-surface"
        >
          <span className="grid gap-0.5">
            <span className="text-sm text-fg">Generate with Higgsfield</span>
            <span className="text-xs text-muted">An image or a short video from a prompt, with an optional reference</span>
          </span>
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-bg transition-transform group-hover:scale-105">
            <Spark />
          </span>
        </button>
      )}

      {can && open && (
        <div className="grid gap-4 rounded-[14px] border border-line bg-bg p-4 md:p-5">
          <div className="flex rounded-full bg-surface-2 p-1 sm:self-start sm:justify-self-start" role="tablist" aria-label="What to make">
            {(["image", "video"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => pickKind(k)} className={`h-9 flex-1 rounded-full px-5 text-sm capitalize transition-colors max-md:h-11 ${kind === k ? "bg-fg text-bg shadow-sm" : "text-muted hover:text-fg"}`}>
                {k}
              </button>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => (setModelKey(m.key), setOpts({}))}
                aria-pressed={m.key === model.key}
                className={`grid min-h-[68px] content-start gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${m.key === model.key ? "border-fg bg-surface" : "border-line hover:border-faint"}`}
              >
                <span className="text-[13px] font-medium">{m.label}</span>
                <span className="text-[11.5px] leading-snug text-muted">{m.about}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Prompt{needsPrompt ? "" : " (optional with a reference)"}</p>
              {requestId && (
                <button type="button" disabled={writing} onClick={write} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg disabled:opacity-60 max-md:min-h-11">
                  {writing ? (
                    <>
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-fg" aria-hidden /> Writing…
                    </>
                  ) : prompt ? (
                    "Improve it from the brief"
                  ) : (
                    "Write it from the brief"
                  )}
                </button>
              )}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => (setPrompt(e.target.value), setWhy(null))}
              rows={4}
              maxLength={MAX_PROMPT_CHARS}
              placeholder={kind === "video" ? "A woman in her 30s unboxes the serum at a sunlit bathroom counter, slow push-in, soft morning light, handheld feel…" : "Close-up of the serum bottle on wet stone, morning light, shallow depth of field, clean premium look…"}
              className="min-h-[104px] w-full resize-y rounded-[10px] border border-line bg-surface px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-brand-text/60"
            />
            {why && <p className="text-[11.5px] text-faint">{why}</p>}
          </div>

          {model.reference !== "none" && (
            <div className="flex flex-wrap items-center gap-3">
              {ref ? (
                <span className="flex items-center gap-3 rounded-[10px] border border-line bg-surface p-1.5 pr-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file */}
                  <img src={ref.preview} alt="" className="h-12 w-12 rounded-[7px] object-cover" />
                  <span className="grid min-w-0">
                    <span className="max-w-[180px] truncate text-xs">{ref.name}</span>
                    <span className="text-[11px] text-faint">{kind === "video" ? "The video starts from this" : "Reference"}</span>
                  </span>
                  <button type="button" onClick={() => setRef(null)} className="ml-1 grid h-11 w-11 place-items-center text-faint hover:text-fg md:h-8 md:w-8" aria-label="Remove the reference">
                    ×
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => file.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f) void upload(f);
                  }}
                  className="flex min-h-12 items-center gap-2 rounded-[10px] border border-dashed border-line px-4 text-xs text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-60"
                >
                  {uploading ? "Uploading…" : kind === "video" ? "Add a starting image (optional)" : "Add a product photo (optional)"}
                </button>
              )}
              <input
                ref={file}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                  e.target.value = "";
                }}
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {model.fields.map((f) =>
              f.type === "bool" ? (
                <label key={f.key} className="flex min-h-11 items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={Boolean(valueOf(f.key, f.default))} onChange={(e) => setOpts((o) => ({ ...o, [f.key]: e.target.checked }))} className="h-4 w-4 accent-[#b21e2c]" />
                  {f.label}
                </label>
              ) : f.type === "int" ? (
                <label key={f.key} className="grid gap-1">
                  <span className="flex justify-between text-[11px] text-faint">
                    <span>{f.label}</span>
                    <span className="tabular text-muted">{String(valueOf(f.key, f.default))}s</span>
                  </span>
                  <input type="range" min={f.min} max={f.max} step={f.step ?? 1} value={Number(valueOf(f.key, f.default))} onChange={(e) => setOpts((o) => ({ ...o, [f.key]: Number(e.target.value) }))} className="h-8 w-full accent-[#b21e2c]" />
                </label>
              ) : f.key === "aspect_ratio" && kind === "video" && ref ? null : (
                <div key={f.key} className="grid gap-1.5">
                  <span className="text-[11px] text-faint">{f.label}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {f.options.map((o) => (
                      <button key={o} type="button" onClick={() => setOpts((x) => ({ ...x, [f.key]: o }))} className={`h-8 min-w-11 rounded-full px-3 text-xs transition-colors max-md:h-11 ${String(valueOf(f.key, f.default)) === o ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg"}`}>
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || uploading || (needsPrompt && !prompt.trim())}
              onClick={generate}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 max-md:h-12 max-md:w-full max-md:justify-center"
            >
              {busy ? "Starting…" : `Generate ${kind}`}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-10 px-3 text-xs text-faint hover:text-fg max-md:h-11 max-md:w-full">
              Close
            </button>
            <p className="basis-full text-[11px] text-faint">It keeps going if you leave this page; you&apos;ll be told when it&apos;s ready. Uses Higgsfield credits.</p>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}
      {note && <p className="text-xs text-muted">{note}</p>}

      {jobs.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {jobs.map((j) => (
            <li key={j.id} className="grid content-start gap-2.5 overflow-hidden rounded-[12px] border border-line bg-surface">
              {j.status === "ready" && j.files.length ? (
                <div className={`grid gap-px bg-line ${j.files.length > 1 ? "grid-cols-2" : ""}`}>
                  {j.files.map((f) =>
                    f.mime.startsWith("video/") ? (
                      <video key={f.path} src={f.url ?? undefined} controls playsInline preload="metadata" className="aspect-[9/16] max-h-[420px] w-full bg-ink object-contain" />
                    ) : f.mime.startsWith("image/") ? (
                      <a key={f.path} href={f.url ?? undefined} target="_blank" rel="noreferrer" className="block bg-surface-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link from storage */}
                        <img src={f.url ?? undefined} alt={j.title ?? "AI image"} loading="lazy" className="max-h-[420px] w-full object-contain" />
                      </a>
                    ) : null,
                  )}
                </div>
              ) : (
                <div className="grid min-h-[120px] content-center gap-2 bg-bg px-4 py-5">
                  {activeMedia(j) ? <MediaProgress job={j} /> : <p className="text-xs text-bad">{j.error ?? "It didn't work."}</p>}
                </div>
              )}
              <div className="grid gap-1.5 px-3.5 pb-3">
                <p className="line-clamp-2 text-[12.5px] leading-snug">{j.prompt || j.title}</p>
                <p className="text-[11px] text-faint">
                  {HF_MODELS.find((m) => m.key === j.model)?.label ?? j.model} · {j.by ?? "Someone"} · {when(j.createdAt)}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {j.status === "ready" && j.files[0]?.url && (
                    <a href={j.files[0].url} download className="text-muted hover:text-fg max-md:py-2">
                      Download
                    </a>
                  )}
                  {access?.canGenerate && j.status === "ready" && requestId && deliverables && (
                    <button type="button" disabled={busy} onClick={() => act(() => mediaToDeliverables(j.id), "Added to the deliverables.")} className="text-muted hover:text-fg disabled:opacity-50 max-md:py-2">
                      Add to deliverables
                    </button>
                  )}
                  {access?.canGenerate && j.status === "ready" && j.clientId && !j.driveNote && (
                    <button type="button" disabled={busy} onClick={() => act(() => mediaToDrive(j.id))} className="text-muted hover:text-fg disabled:opacity-50 max-md:py-2">
                      Save to their Drive
                    </button>
                  )}
                  {j.mine && j.status === "queued" && (
                    <button type="button" disabled={busy} onClick={() => act(() => cancelMedia(j.id), "Stopped.")} className="text-muted hover:text-fg disabled:opacity-50 max-md:py-2">
                      Stop
                    </button>
                  )}
                  {can && j.prompt && !activeMedia(j) && (
                    <button type="button" onClick={() => (setPrompt(j.prompt ?? ""), setOpen(true))} className="text-muted hover:text-fg max-md:py-2">
                      Use this prompt
                    </button>
                  )}
                  {j.driveNote && <span className="text-faint">{j.driveNote}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {access && !access.canGenerate && list?.length === 0 && <p className="text-xs text-faint">Nothing generated yet. The creative team makes these here.</p>}
    </section>
  );
}

function Spark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" fill="currentColor" />
    </svg>
  );
}
