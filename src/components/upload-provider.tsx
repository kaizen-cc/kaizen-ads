"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Upload } from "tus-js-client";
import { recordFiles, type UploadedFile } from "@/app/(team)/board/design-actions";
import { createClient } from "@/lib/supabase/client";

// Uploads run here, above every page, so a creative can drop files on a ticket, close it and keep working.
// Files go straight from the browser to storage in resumable 6 MB chunks; a dropped connection picks up where it left off.

export type UploadItem = { file: File; path: string; thumb: Blob | null; thumbPath: string | null; meta: Omit<UploadedFile, "path" | "thumb_path"> };
export type UploadJob = {
  id: string;
  requestId: string;
  label: string; // "#1061 · Calzone pull v2"
  versionId: string;
  items: UploadItem[];
  sent: number; // bytes
  total: number;
  status: "queued" | "uploading" | "saving" | "done" | "failed";
  error?: string;
};

type Ctx = {
  jobs: UploadJob[];
  enqueue: (job: Omit<UploadJob, "id" | "sent" | "total" | "status">) => void;
  /** Bumps whenever a ticket's upload finishes, so its deliverables can reload. */
  finished: Record<string, number>;
  demo: boolean;
};

const UploadContext = createContext<Ctx | null>(null);
export const useUploads = () => useContext(UploadContext);

const endpoint = () => `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(".supabase.co", ".storage.supabase.co")}/storage/v1/upload/resumable`;

function send(token: string, file: Blob, path: string, type: string, onBytes: (n: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: endpoint(),
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: { bucketName: "creative", objectName: path, contentType: type || "application/octet-stream", cacheControl: "3600" },
      chunkSize: 6 * 1024 * 1024, // Supabase requires exactly 6 MB
      onError: reject,
      onProgress: (sent) => onBytes(sent),
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}

export function UploadProvider({ children, demo = false }: { children: React.ReactNode; demo?: boolean }) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [finished, setFinished] = useState<Record<string, number>>({});
  const running = useRef(false);
  const queue = useRef<UploadJob[]>([]);

  const patch = useCallback((id: string, p: Partial<UploadJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j))), []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const supabase = createClient();
    while (queue.current.length) {
      const job = queue.current.shift()!;
      patch(job.id, { status: "uploading" });
      try {
        if (demo) {
          for (let p = 0; p <= 10; p++) {
            await new Promise((r) => setTimeout(r, 180));
            patch(job.id, { sent: (job.total * p) / 10 });
          }
        } else {
          // The session token lets storage check the same access rules as the rest of the app
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          if (!token) throw new Error("Signed out. Sign in again and re-drop the files.");
          let done = 0;
          for (const it of job.items) {
            if (it.thumb && it.thumbPath) await send(token, it.thumb, it.thumbPath, "image/webp", () => {});
            await send(token, it.file, it.path, it.file.type, (n) => patch(job.id, { sent: done + n }));
            done += it.file.size;
          }
          patch(job.id, { status: "saving", sent: job.total });
          const res = await recordFiles(
            job.versionId,
            job.items.map((it) => ({ ...it.meta, path: it.path, thumb_path: it.thumbPath })),
          );
          if (!res.ok) throw new Error(res.error);
        }
        patch(job.id, { status: "done", sent: job.total });
        setFinished((f) => ({ ...f, [job.requestId]: (f[job.requestId] ?? 0) + 1 }));
      } catch (e) {
        patch(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    }
    running.current = false;
  }, [demo, patch]);

  const enqueue = useCallback<Ctx["enqueue"]>(
    (j) => {
      const job: UploadJob = { ...j, id: crypto.randomUUID(), sent: 0, total: j.items.reduce((n, it) => n + it.file.size, 0) || 1, status: "queued" };
      queue.current.push(job);
      setJobs((js) => [...js, job]);
      void pump();
    },
    [pump],
  );

  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status !== "done" && j.status !== "failed")), []);

  // Leaving the app mid-upload would stop it; ask first
  const busy = jobs.some((j) => j.status === "queued" || j.status === "uploading" || j.status === "saving");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  return (
    <UploadContext.Provider value={{ jobs, enqueue, finished, demo }}>
      {children}
      <UploadTray jobs={jobs} onClear={clearFinished} />
    </UploadContext.Provider>
  );
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);

function UploadTray({ jobs, onClear }: { jobs: UploadJob[]; onClear: () => void }) {
  const [open, setOpen] = useState(true);
  const active = jobs.filter((j) => j.status !== "done" && j.status !== "failed").length;
  const failed = jobs.some((j) => j.status === "failed");
  // Everything landed: the tray steps aside after a few seconds. A failure stays until it's closed, so it isn't missed.
  useEffect(() => {
    if (!jobs.length || active || failed) return;
    const t = setTimeout(onClear, 5000);
    return () => clearTimeout(t);
  }, [jobs.length, active, failed, onClear]);
  if (!jobs.length) return null;
  const sent = jobs.reduce((n, j) => n + j.sent, 0);
  const total = jobs.reduce((n, j) => n + j.total, 0);
  return (
    <div className="fixed bottom-5 right-5 z-[60] w-[340px] overflow-hidden [&>button:first-child]:pr-10 rounded-[12px] border border-line bg-surface shadow-2xl animate-[step-in_.25s_ease-out]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className="relative grid h-8 w-8 place-items-center">
          <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--surface-2)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15" fill="none" stroke={active ? "var(--brand)" : "var(--ok)"} strokeWidth="3" strokeDasharray={`${(sent / total) * 94.2} 94.2`} strokeLinecap="round" />
          </svg>
          <span className="text-[10px] tabular">{Math.round((sent / total) * 100)}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{active ? `Uploading ${active} ${active === 1 ? "design" : "designs"}` : "Uploads finished"}</span>
          <span className="block text-xs text-faint">
            {mb(sent)} of {mb(total)}
            {active ? " · you can keep working" : ""}
          </span>
        </span>
        <span className="text-xs text-faint">{open ? "Hide" : "Show"}</span>
      </button>
      {!active && (
        <button onClick={onClear} aria-label="Close" className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg">
          ×
        </button>
      )}
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-line">
          {jobs.map((j) => (
            <div key={j.id} className="grid gap-1.5 border-b border-line/60 px-4 py-2.5 last:border-0">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate">{j.label}</span>
                <span className={`shrink-0 ${j.status === "failed" ? "text-bad" : j.status === "done" ? "text-ok" : "text-faint"}`}>
                  {j.status === "done" ? "Done" : j.status === "failed" ? "Failed" : j.status === "saving" ? "Saving…" : j.status === "queued" ? "Waiting" : `${Math.round((j.sent / j.total) * 100)}%`}
                </span>
              </div>
              <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                <span className={`block h-full rounded-full transition-[width] duration-300 ${j.status === "failed" ? "bg-bad" : j.status === "done" ? "bg-ok" : "bg-brand"}`} style={{ width: `${(j.sent / j.total) * 100}%` }} />
              </span>
              {j.error && <span className="text-[11px] text-bad">{j.error}</span>}
            </div>
          ))}
          {!active && (
            <button onClick={onClear} className="w-full px-4 py-2 text-xs text-muted hover:text-fg">
              {failed ? "Close" : "Clear finished"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
