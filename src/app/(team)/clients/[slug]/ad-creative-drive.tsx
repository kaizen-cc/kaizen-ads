"use client";

import { useEffect, useState, useTransition } from "react";
import { field } from "@/components/ui";
import type { ClientDriveSummary } from "@/lib/creative-drive";
import { adCreativeDrive, setAdCreativeFolder, syncExistingToDrive } from "./drive-actions";

const DOT = { ok: "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]", warn: "bg-warn", bad: "bg-bad", off: "bg-faint/50" } as const;

/**
 * Where the client's ticket creative lands in Drive: their "Ad Creatives" folder (found by name, made when there's none,
 * or a pasted link remembered for the client), in Year / Month / "#1234 Title" folders,
 * how many files are there, on their way or stuck, and for execs the backfill of what was uploaded before.
 */
export function AdCreativeDrive({ clientId, slug, exec, demo = false }: { clientId: string; slug: string; exec: boolean; demo?: boolean }) {
  const [s, setS] = useState<ClientDriveSummary | null>(null);
  const [loaded, setLoaded] = useState(demo);
  const [link, setLink] = useState("");
  const [saving, startSave] = useTransition();
  const [syncing, startSync] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = () =>
    adCreativeDrive(clientId).then((x) => {
      setS(x);
      setLoaded(true);
      setLink(x?.folderId ? `https://drive.google.com/drive/folders/${x.folderId}` : "");
    });
  useEffect(() => {
    if (demo) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, demo]);
  // While files are on their way, the counts refresh on their own
  useEffect(() => {
    if (!s?.syncing || demo) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.syncing, demo]);

  const save = (value: string) => {
    const was = s?.folderId ? `https://drive.google.com/drive/folders/${s.folderId}` : "";
    if (value.trim() === was) return;
    startSave(async () => {
      setError(null);
      setNote(null);
      const res = await setAdCreativeFolder(clientId, slug, value);
      if (!res.ok) return setError(res.error);
      setNote(value.trim() ? "Saved. Waiting files are going in now." : "Cleared. It's looked for by name again.");
      await load();
    });
  };

  const sync = (all: boolean) =>
    startSync(async () => {
      setError(null);
      setNote(null);
      const res = await syncExistingToDrive(all ? null : clientId);
      if (!res.ok) return setError(res.error);
      setNote(all ? "Every client's existing files are lining up for Drive. It runs in the background." : "Their existing files are lining up for Drive. It runs in the background.");
      setTimeout(() => void load(), 4000);
    });

  const tone = !s ? "off" : !s.connected || s.errors ? "bad" : s.syncing ? "warn" : s.folderId ? "ok" : "off";
  const status = !loaded
    ? "Checking…"
    : !s
      ? "Not available"
      : !s.connected
        ? "Drive isn't connected for uploads"
        : s.errors
          ? `${s.errors} file${s.errors === 1 ? "" : "s"} stopped: ${s.error ?? "see the ticket"}`
          : s.syncing
            ? `Syncing ${s.syncing} file${s.syncing === 1 ? "" : "s"}…`
            : s.synced
              ? `${s.synced} file${s.synced === 1 ? "" : "s"} in Drive`
              : s.folderId
                ? "Ready: new uploads go here"
                : s.hasClientFolder
                  ? "Found (or made) on the first upload"
                  : "Drive isn't connected for this client: add their Drive folder in the details, or paste the Ad Creatives folder here";

  return (
    <div id="ad-creative-drive" className="grid scroll-mt-24 gap-3">
      <label className="grid gap-1.5 text-sm font-medium">
        <span>
          Ad Creatives folder <span className="font-normal text-faint">(ticket uploads go in Year / Month / #ticket folders inside it)</span>
        </span>
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onBlur={(e) => save(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save(e.currentTarget.value))}
          disabled={saving || demo}
          className={field}
          placeholder={s?.hasClientFolder === false ? "Paste the Ad Creatives folder link" : "Found by name in their Drive folder"}
          inputMode="url"
        />
      </label>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${saving || syncing ? "animate-[ai-pulse_1s_ease-in-out_infinite] bg-brand-text" : DOT[tone]}`} />
        <span className={tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-faint"}>{saving ? "Checking the folder…" : status}</span>
        {s?.folderId && (
          <a href={`https://drive.google.com/drive/folders/${s.folderId}`} target="_blank" rel="noreferrer" className="text-muted underline-offset-4 hover:text-fg hover:underline max-md:min-h-10 max-md:px-1">
            Open in Drive
          </a>
        )}
        {s?.source === "found" && <span className="text-faint">· found automatically</span>}
        {s?.source === "set" && <span className="text-faint">· set by hand, kept for this client</span>}
        {!!s?.replaced && <span className="text-faint">· {s.replaced} in _Replaced</span>}
      </span>
      {s?.errorKind === "no_access" && <p className="rounded-[8px] bg-bad/10 px-3 py-2 text-xs text-bad">A Workspace admin needs to allow the Drive scope (https://www.googleapis.com/auth/drive) for Kaizen&apos;s service account, then sync again.</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
      {note && <p className="text-xs text-ok">{note}</p>}
      {exec && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={syncing || demo} onClick={() => sync(false)} className="h-9 rounded-brand border border-line px-3 text-xs text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 max-md:h-11 max-md:flex-1 max-md:text-sm">
            Sync existing files to Drive
          </button>
          <button type="button" disabled={syncing || demo} onClick={() => window.confirm("Copy every client's existing ticket files into their Drive? It runs in the background.") && sync(true)} className="h-9 rounded-brand px-3 text-xs text-faint transition-colors hover:text-fg disabled:opacity-50 max-md:h-11 max-md:text-sm">
            For every client
          </button>
        </div>
      )}
    </div>
  );
}
