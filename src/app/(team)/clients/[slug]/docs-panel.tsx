"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ClientDoc } from "@/lib/client-docs";
import { addClientDocs, openClientDoc } from "./actions";

// The client's documents: every file and link shared about them (here or in the client desk), newest first, with
// what the AI read in it and who shared it when. Drop files or paste a link to add more; they're read and summarized,
// and every agent reads them from then on. Nothing is removed.

const MAX_FILE = 50 * 1024 * 1024;
const safe = (n: string) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(-120);
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const size = (n: number | null) => (n == null ? "" : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const ICON = (d: ClientDoc) => (d.kind === "link" ? "↗" : d.mime?.startsWith("image/") ? "🖼" : d.mime === "application/pdf" || d.name.toLowerCase().endsWith(".pdf") ? "PDF" : "📄");

export function DocsPanel({ clientId, slug, docs, live }: { clientId: string; slug: string; docs: ClientDoc[]; live: boolean }) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [link, setLink] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const add = (files: File[], links: string[]) =>
    start(async () => {
      setError(null);
      const ok = files.filter((f) => f.size <= MAX_FILE);
      const supabase = createClient();
      const up: { path: string; name: string; mime: string; bytes: number }[] = [];
      for (const f of ok) {
        const path = `${clientId}/${crypto.randomUUID()}-${safe(f.name)}`;
        const { error: e } = await supabase.storage.from("client-docs").upload(path, f, { contentType: f.type || "application/octet-stream" });
        if (!e) up.push({ path, name: f.name, mime: f.type, bytes: f.size });
      }
      const r = await addClientDocs(clientId, slug, up, links);
      if (!r.ok) return setError(r.error);
      if (up.length < files.length) setError(`${files.length - up.length} file${files.length - up.length === 1 ? "" : "s"} couldn't be added (over 50 MB, or the upload failed).`);
      setLink("");
      router.refresh();
      // The summaries arrive a moment later
      setTimeout(() => router.refresh(), 12_000);
    });

  const shown = q.trim() ? docs.filter((d) => `${d.name} ${d.title ?? ""} ${d.summary ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : docs;

  return (
    <section className="grid gap-4 rounded-[16px] border border-line bg-surface p-5 max-md:p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-heading text-lg">Documents</h2>
          <p className="text-sm text-muted">Every file and link shared about {docs.length ? "this client" : "this client, here or in the client desk"}: read by the AI, summarized, and used whenever it works on them.</p>
        </div>
        {docs.length > 6 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents" className="h-10 w-full rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 md:w-56" />
        )}
      </div>

      {live && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            add([...e.dataTransfer.files], []);
          }}
          className={`grid gap-3 rounded-[12px] border border-dashed p-4 transition-colors ${over ? "border-brand-text bg-brand-soft" : "border-line"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center rounded-brand bg-fg px-4 text-sm font-medium text-bg max-md:h-11 max-md:w-full max-md:justify-center">
              {busy ? "Adding…" : "Add files"}
              <input
                type="file"
                multiple
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const list = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (list.length) add(list, []);
                }}
              />
            </label>
            <span className="text-xs text-faint max-md:hidden">or drop them here · PDF, Word, PowerPoint, Excel, text and pictures are read</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim()) add([], [link.trim()]);
            }}
            className="flex gap-2"
          >
            <input value={link} onChange={(e) => setLink(e.target.value)} type="url" placeholder="Or paste a link (Google Doc, Drive file, web page)" className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 max-md:h-11" />
            <button type="submit" disabled={busy || !link.trim()} className="h-10 shrink-0 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-40 max-md:h-11">
              Add
            </button>
          </form>
          {error && <p className="text-sm text-bad">{error}</p>}
        </div>
      )}

      {shown.length ? (
        <ul className="grid gap-2">
          {shown.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={async () => { const u = await openClientDoc(d.id); if (u) window.open(u, "_blank", "noreferrer"); }} className="group flex w-full items-start gap-3 rounded-[12px] bg-surface-2/60 px-4 py-3 text-left transition-colors hover:bg-surface-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] bg-bg text-[11px] font-semibold text-muted">{ICON(d)}</span>
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate text-sm font-medium group-hover:underline">{d.title ?? d.name}</span>
                    {d.title && d.title !== d.name && <span className="truncate text-xs text-faint">{d.name}</span>}
                  </span>
                  {d.status === "reading" ? (
                    <span className="text-xs text-faint">Reading it…</span>
                  ) : d.summary ? (
                    <span className="line-clamp-3 text-xs leading-relaxed text-muted">{d.summary}</span>
                  ) : (
                    <span className="text-xs text-faint">{d.note ?? "Kept, not read"}</span>
                  )}
                  <span className="text-[11px] text-faint">
                    {d.by ?? "Someone"} · {when(d.at)} · {d.via === "chat" ? "in the client desk" : "on this page"}
                    {d.bytes ? ` · ${size(d.bytes)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 self-center text-xs text-faint group-hover:text-fg">Open ↗</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">{q ? "Nothing matches." : "Nothing shared yet. Files and links dropped into the client desk land here too."}</p>
      )}
    </section>
  );
}
