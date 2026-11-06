"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { batches, notImported, ownChats, parseConversations, parseProjects, partsOf, suggestClient, type ImportedConversation, type ImportedProject, type ImportItem } from "@/lib/kaizen-ai/claude-import";
import { readClaudeExport } from "@/lib/kaizen-ai/claude-import-file";
import { claudeImportState, deleteClaudeImport, finishClaudeImport, startClaudeImport, type ClaudeImport } from "./actions";

// Import from Claude: the person exports their data from claude.ai, drops the ZIP here, picks the chats (each with the
// client it's about, suggested from its title and opening), and they come in as their own private threads, in
// batches, while they keep using Kaizen AI. Their file is read in the browser; only what they pick is sent.

type ClientOpt = { id: string; name: string; slug: string };
export type ImportJob = { importId: string; total: number; done: number; created: number; skipped: number; failed: number; running: boolean; error: string | null; firstThread: string | null };

const CLAUDE_EXPORT_URL = "https://claude.ai/settings/data-privacy-controls";
/** Where an org's owner exports (owners don't get the personal Export data button) */
const CLAUDE_ORG_EXPORT_URL = "https://claude.ai/admin-settings/data-privacy-controls";
const SHOW = 150;

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The import running in the background (kept by the chat screen, so closing the sheet doesn't stop it) */
export function useClaudeImport(onProgress: () => void) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const running = useRef(false);
  const start = useCallback(
    async (fileName: string, items: ImportItem[], conversations: number, sourceAccount: string | null = null) => {
      if (running.current) return;
      const s = await startClaudeImport(fileName, conversations);
      if (!s.ok) {
        setJob({ importId: "", total: conversations, done: 0, created: 0, skipped: 0, failed: 0, running: false, error: s.error, firstThread: null });
        return;
      }
      running.current = true;
      const total = items.filter((i) => i.last).length;
      let state: ImportJob = { importId: s.id, total, done: 0, created: 0, skipped: 0, failed: 0, running: true, error: null, firstThread: null };
      setJob(state);
      let sinceRefresh = 0;
      for (const batch of batches(items)) {
        let res: { results: { uuid: string; status: string; threadId?: string }[] } | null = null;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          try {
            const r = await fetch("/api/ai/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: s.id, items: batch, ...(sourceAccount ? { sourceAccount } : {}) }) });
            if (r.ok) res = await r.json();
            else if (r.status < 500) break;
          } catch {
            // Network: tried again after a moment
          }
          if (!res) await new Promise((w) => setTimeout(w, 1500 * (attempt + 1)));
        }
        const finals = batch.filter((i) => i.last);
        if (!res) {
          state = { ...state, done: state.done + finals.length, failed: state.failed + finals.length };
        } else {
          const byUuid = new Map(res.results.map((r) => [r.uuid, r]));
          let created = 0;
          let skipped = 0;
          let failed = 0;
          for (const it of finals) {
            const r = byUuid.get(it.uuid);
            if (!r || r.status === "failed") failed++;
            else if (r.status === "skipped" && it.part === 0) skipped++;
            else created++;
          }
          const first = state.firstThread ?? res.results.find((r) => r.threadId && r.status !== "skipped")?.threadId ?? null;
          state = { ...state, done: state.done + finals.length, created: state.created + created, skipped: state.skipped + skipped, failed: state.failed + failed, firstThread: first };
        }
        setJob(state);
        if (++sinceRefresh >= 4) {
          sinceRefresh = 0;
          onProgress();
        }
      }
      await finishClaudeImport(s.id);
      running.current = false;
      state = { ...state, running: false };
      setJob(state);
      onProgress();
    },
    [onProgress],
  );
  return { job, start, clear: () => setJob((j) => (j?.running ? j : null)) };
}

type Step = { at: "drop" } | { at: "reading"; pct: number } | { at: "preview"; fileName: string; convs: ImportedConversation[]; projects: ImportedProject[]; already: number; account: string | null; notice: string | null };
type Problem = { text: string; emails?: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ClaudeImportSheet({ clients, email, job, onStart, onClose, onOpenThread, onChanged }: { clients: ClientOpt[]; /** Their Kaizen email: an organization's export is narrowed to the member with this email */ email: string; job: ImportJob | null; onStart: (fileName: string, items: ImportItem[], conversations: number, sourceAccount: string | null) => void; onClose: () => void; onOpenThread: (id: string) => void; onChanged: () => void }) {
  const [step, setStep] = useState<Step>({ at: "drop" });
  const [error, setProblem] = useState<Problem | null>(null);
  const setError = (e: string | Problem | null) => setProblem(typeof e === "string" ? { text: e } : e);
  const [state, setState] = useState<{ imported: string[]; imports: ClaudeImport[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => void claudeImportState().then(setState), []);
  useEffect(() => {
    refresh();
  }, [refresh, job?.running]);

  // Escape closes
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const read = async (file: File) => {
    setError(null);
    if (!/\.(zip|json)$/i.test(file.name)) return setError("Drop the ZIP from Claude's export email, or conversations.json from inside it.");
    setStep({ at: "reading", pct: 0 });
    try {
      const raw = await readClaudeExport(file, (d, t) => setStep({ at: "reading", pct: Math.round((d / t) * 100) }));
      // Only their own: an organization's export is narrowed to their chats here, before anything is shown or sent
      const own = ownChats(raw, email);
      if (!own.ok) {
        setStep({ at: "drop" });
        setError({ text: own.message, emails: own.emails });
        return;
      }
      const all = parseConversations(own.conversations);
      if (!all.length) throw new Error(own.kind === "org" ? "You don't have any chats in this export." : "No conversations found in that file.");
      const known = state?.imported ?? (await claudeImportState()).imported;
      const convs = notImported(all, known);
      const projects = notImported(
        parseProjects(own.projects).map((p) => ({ ...p, uuid: `project:${p.uuid}` })),
        known,
      ).map((p) => ({ ...p, uuid: p.uuid.slice("project:".length) }));
      const notice =
        own.kind === "org"
          ? `This is your organization's export: only your own ${plural(all.length, "chat is", "chats are")} shown; the other ${plural(own.otherPeople, "person's", "people's")} chats are skipped and never leave your browser.`
          : null;
      setStep({ at: "preview", fileName: file.name, convs, projects, already: all.length - convs.length, account: own.account, notice });
    } catch (e) {
      setStep({ at: "drop" });
      setError(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };

  const running = Boolean(job?.running);

  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal aria-label="Import from Claude">
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={onClose} aria-label="Close" />
      <div className="relative flex max-h-[92dvh] w-full max-w-[680px] flex-col overflow-hidden rounded-t-[24px] border border-line bg-surface shadow-2xl md:rounded-[24px]">
        <div className="flex items-start gap-3 border-b border-line/70 px-5 pb-4 pt-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-brand to-deep text-white shadow-sm">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[20px] leading-tight text-fg">Import from Claude</p>
            <p className="mt-0.5 text-[13px] text-muted">Bring your Claude chats here and keep going where you left off. They stay private to you.</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {job && (running || step.at !== "preview") ? <JobCard job={job} onOpenThread={onOpenThread} /> : null}

          {step.at === "preview" && !running ? (
            <Preview
              step={step}
              clients={clients}
              onBack={() => setStep({ at: "drop" })}
              onStart={(items, n) => {
                onStart(step.fileName, items, n, step.account);
                setStep({ at: "drop" });
              }}
            />
          ) : (
            <div className="grid gap-5 px-5 py-5">
              <ol className="grid gap-3">
                {[
                  <>
                    Open{" "}
                    <a href={CLAUDE_EXPORT_URL} target="_blank" rel="noreferrer" className="font-medium text-brand-text underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
                      Claude&rsquo;s settings
                    </a>{" "}
                    › <span className="font-medium text-fg">Privacy</span> › <span className="font-medium text-fg">Export data</span>.
                    <span className="mt-1 block text-[13px] text-muted">
                      Don&rsquo;t see it? You&rsquo;re probably the org&rsquo;s owner: export from{" "}
                      <a href={CLAUDE_ORG_EXPORT_URL} target="_blank" rel="noreferrer" className="font-medium text-brand-text underline decoration-brand/30 underline-offset-2 hover:decoration-brand">
                        Admin settings › Data and privacy
                      </a>{" "}
                      instead; Kaizen AI keeps only your own chats.
                    </span>
                  </>,
                  <>Claude emails you a download link (it can take a few minutes). Download the ZIP.</>,
                  <>Drop the ZIP below. It&rsquo;s read on your device; only the chats you pick are saved.</>,
                ].map((s, i) => (
                  <li key={i} className="flex gap-3 text-[14px] leading-relaxed text-fg/90">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-text">{i + 1}</span>
                    <span className="pt-0.5">{s}</span>
                  </li>
                ))}
              </ol>

              <button
                type="button"
                disabled={step.at === "reading" || running}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  const f = e.dataTransfer.files[0];
                  if (f && step.at !== "reading" && !running) void read(f);
                }}
                className={`grid min-h-[150px] place-items-center rounded-[20px] border-2 border-dashed px-4 py-6 text-center transition disabled:cursor-default ${drag ? "border-brand bg-brand-soft/40" : "border-line hover:border-brand/40 hover:bg-ink/[0.02]"}`}
              >
                {step.at === "reading" ? (
                  <span className="grid w-full max-w-[320px] gap-2">
                    <span className="text-[14px] font-medium text-fg">Reading your export…</span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
                      <span className="block h-full rounded-full bg-brand transition-[width]" style={{ width: `${step.pct}%` }} />
                    </span>
                  </span>
                ) : running ? (
                  <span className="text-[13.5px] text-muted">One import at a time. This one keeps going while Kaizen AI is open.</span>
                ) : (
                  <span className="grid gap-1">
                    <span className="text-[15px] font-medium text-fg">Drop the ZIP here, or tap to choose it</span>
                    <span className="text-[12.5px] text-faint">The export ZIP (up to 1.5 GB), or conversations.json from inside it</span>
                  </span>
                )}
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept=".zip,.json,application/zip,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void read(f);
                  e.target.value = "";
                }}
              />
              {error ? (
                <div className="grid gap-1.5 rounded-[12px] bg-bad-soft/50 px-3 py-2 text-[13px] text-bad">
                  <p>{error.text}</p>
                  {error.emails?.length ? (
                    <div className="grid gap-0.5">
                      <p className="text-[12px] text-muted">The accounts in this export:</p>
                      <ul className="max-h-[140px] overflow-y-auto text-fg/80">
                        {error.emails.map((e) => (
                          <li key={e} className="truncate text-[12.5px]">
                            {e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <p className="text-[12.5px] leading-relaxed text-faint">
                What comes over: each chat&rsquo;s messages with their dates, and the text Claude read from files you attached. Claude Projects&rsquo; knowledge files aren&rsquo;t in the export, except the docs listed in its projects.json, which you can bring as private notes. Imported chats are never shared or used to teach Kaizen&rsquo;s agents.
              </p>

              {state?.imports.length ? <PastImports imports={state.imports} onChanged={() => {
                    refresh();
                    onChanged();
                  }}
                /> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function JobCard({ job, onOpenThread }: { job: ImportJob; onOpenThread: (id: string) => void }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="mx-5 mt-5 grid gap-2 rounded-[18px] border border-line bg-ink/[0.02] px-4 py-3">
      {job.error ? (
        <p className="text-[13px] text-bad">{job.error}</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[14px] font-medium text-fg">{job.running ? "Importing your chats…" : "Import finished"}</p>
            <p className="text-[12.5px] tabular-nums text-muted">
              {job.done} of {job.total}
            </p>
          </div>
          <span className="h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
            <span className={`block h-full rounded-full transition-[width] ${job.failed && !job.running ? "bg-warn" : "bg-brand"}`} style={{ width: `${pct}%` }} />
          </span>
          <p className="text-[12.5px] text-muted">
            {job.created} imported
            {job.skipped ? ` · ${job.skipped} already here` : ""}
            {job.failed ? ` · ${job.failed} didn't come over (import again to retry them)` : ""}
            {job.running ? " · you can close this and keep chatting" : ""}
          </p>
          {!job.running && job.firstThread ? (
            <button type="button" onClick={() => onOpenThread(job.firstThread!)} className="min-h-10 justify-self-start rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover">
              Open the newest
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function PastImports({ imports, onChanged }: { imports: ClaudeImport[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const shown = imports.filter((i) => !gone.includes(i.id));
  if (!shown.length) return null;
  return (
    <div className="grid gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Your imports</p>
      {shown.map((i) => (
        <div key={i.id} className="flex min-h-12 items-center gap-3 rounded-[14px] border border-line px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] text-fg">{i.fileName ?? "Claude export"}</p>
            <p className="text-[12px] text-faint">
              {day(i.createdAt)} · {i.threads} {i.threads === 1 ? "chat" : "chats"}
              {i.status === "running" ? " · didn't finish" : ""}
            </p>
          </div>
          <button
            type="button"
            disabled={busy === i.id}
            onClick={async () => {
              if (!window.confirm(`Delete this import and its ${i.threads} ${i.threads === 1 ? "chat" : "chats"} for good?`)) return;
              setBusy(i.id);
              setGone((g) => [...g, i.id]);
              const r = await deleteClaudeImport(i.id);
              setBusy(null);
              if (!r.ok) setGone((g) => g.filter((x) => x !== i.id));
              onChanged();
            }}
            className="min-h-10 rounded-full px-3 text-[12.5px] text-bad hover:bg-bad-soft/40 disabled:opacity-50"
          >
            Delete import
          </button>
        </div>
      ))}
    </div>
  );
}

function Preview({ step, clients, onBack, onStart }: { step: Extract<Step, { at: "preview" }>; clients: ClientOpt[]; onBack: () => void; onStart: (items: ImportItem[], conversations: number) => void }) {
  const { convs, projects, already, notice } = step;
  // Suggested clients, worked out once
  const suggested = useMemo(() => new Map(convs.map((c) => [c.uuid, suggestClient(c, clients)?.id ?? null])), [convs, clients]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set([...convs.map((c) => c.uuid), ...projects.map((p) => `project:${p.uuid}`)]));
  const [client, setClient] = useState<Record<string, string | null>>({});
  const [q, setQ] = useState("");
  const [more, setMore] = useState(SHOW);
  const [menu, setMenu] = useState<string | null>(null);
  const byId = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const clientOf = (uuid: string) => (uuid in client ? client[uuid] : (suggested.get(uuid) ?? null));
  const s = q.trim().toLowerCase();
  const shown = s ? convs.filter((c) => c.title.toLowerCase().includes(s) || (byId.get(clientOf(c.uuid) ?? "")?.name ?? "").toLowerCase().includes(s)) : convs;
  const n = convs.filter((c) => picked.has(c.uuid)).length;
  const np = projects.filter((p) => picked.has(`project:${p.uuid}`)).length;
  const matched = convs.filter((c) => suggested.get(c.uuid)).length;
  const toggle = (k: string) =>
    setPicked((p) => {
      const x = new Set(p);
      if (x.has(k)) x.delete(k);
      else x.add(k);
      return x;
    });

  const go = () => {
    const now = new Date().toISOString();
    const docsOf = new Map(projects.filter((p) => picked.has(`project:${p.uuid}`)).map((p) => [p.uuid, p.docs]));
    const items: ImportItem[] = [
      ...convs
        .filter((c) => picked.has(c.uuid))
        .flatMap((c) => partsOf({ uuid: c.uuid, kind: "chat", title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, clientId: clientOf(c.uuid), notes: (c.projectUuid && docsOf.get(c.projectUuid)) || [], account: c.account }, c.messages)),
      ...projects
        .filter((p) => picked.has(`project:${p.uuid}`))
        .flatMap((p) => partsOf({ uuid: `project:${p.uuid}`, kind: "project", title: `${p.name} · project docs`, createdAt: now, updatedAt: now, clientId: suggestClient({ title: p.name, messages: [] }, clients)?.id ?? null, notes: p.docs, account: p.creator }, [])),
    ];
    if (items.length) onStart(items, n + np);
  };

  return (
    <div className="grid">
      <div className="sticky top-0 z-10 grid gap-3 border-b border-line/70 bg-surface px-5 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
          <span className="font-medium text-fg">
            {convs.length} {convs.length === 1 ? "chat" : "chats"} to import
          </span>
          {already ? <span>· {already} already imported, skipped</span> : null}
          {matched ? <span>· {matched} matched to a client</span> : null}
        </div>
        {notice ? <p className="rounded-[12px] bg-brand-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg/90">{notice}</p> : null}
        <div className="flex items-center gap-2">
          <label className="flex min-h-11 flex-1 items-center gap-2 rounded-full bg-ink/[0.04] px-3 text-faint focus-within:ring-2 focus-within:ring-brand/30">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats or clients" className="w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-faint" />
          </label>
          <button type="button" onClick={() => setPicked((p) => new Set([...p, ...shown.map((c) => c.uuid)]))} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg">
            All
          </button>
          <button
            type="button"
            onClick={() =>
              setPicked((p) => {
                const x = new Set(p);
                for (const c of shown) x.delete(c.uuid);
                return x;
              })
            }
            className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg"
          >
            None
          </button>
        </div>
      </div>

      {!convs.length && !projects.length ? <p className="px-5 py-10 text-center text-[14px] text-muted">Everything in this export is already in Kaizen AI.</p> : null}

      {projects.length ? (
        <div className="grid gap-1 border-b border-line/70 px-3 py-3">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Project docs, as private notes</p>
          {projects.map((p) => (
            <label key={p.uuid} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[12px] px-2 hover:bg-ink/[0.03]">
              <input type="checkbox" checked={picked.has(`project:${p.uuid}`)} onChange={() => toggle(`project:${p.uuid}`)} className="h-4 w-4 shrink-0 accent-[var(--brand)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-fg">{p.name}</span>
                <span className="block truncate text-[12px] text-faint">
                  {p.docs.length} {p.docs.length === 1 ? "doc" : "docs"}: {p.docs.map((d) => d.name).join(", ")}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <ul className="grid gap-0.5 px-3 py-2">
        {shown.slice(0, more).map((c) => {
          const cid = clientOf(c.uuid);
          const cl = cid ? byId.get(cid) : null;
          return (
            <li key={c.uuid} className="relative flex min-h-14 items-center gap-3 rounded-[12px] px-2 hover:bg-ink/[0.03]">
              <input type="checkbox" checked={picked.has(c.uuid)} onChange={() => toggle(c.uuid)} className="h-4 w-4 shrink-0 accent-[var(--brand)]" aria-label={`Import ${c.title}`} />
              <button type="button" onClick={() => toggle(c.uuid)} className="min-w-0 flex-1 py-2 text-left">
                <span className="block truncate text-[14px] text-fg">{c.title}</span>
                <span className="block text-[12px] text-faint">
                  {day(c.updatedAt)} · {c.messages.length} {c.messages.length === 1 ? "message" : "messages"}
                </span>
              </button>
              <button type="button" onClick={() => setMenu(menu === c.uuid ? null : c.uuid)} className={`flex min-h-9 max-w-[42%] shrink-0 items-center gap-1 rounded-full border px-3 text-[12.5px] ${cl ? "border-brand/30 bg-brand-soft/25 text-fg" : "border-line text-faint"}`}>
                <span className="truncate">{cl?.name ?? "No client"}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {menu === c.uuid ? (
                <ClientMenu
                  clients={clients}
                  current={cid}
                  onPick={(id) => {
                    setClient((x) => ({ ...x, [c.uuid]: id }));
                    setMenu(null);
                  }}
                  onClose={() => setMenu(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {shown.length > more ? (
        <button type="button" onClick={() => setMore((m) => m + SHOW)} className="mx-5 mb-3 min-h-11 rounded-full border border-line text-[13px] text-muted hover:text-fg">
          Show {Math.min(SHOW, shown.length - more)} more of {shown.length - more}
        </button>
      ) : null}

      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line/70 bg-surface px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button type="button" onClick={onBack} className="min-h-11 rounded-full px-4 text-[14px] text-muted hover:text-fg">
          Back
        </button>
        <button type="button" disabled={!n && !np} onClick={go} className="ml-auto min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40">
          Import {n} {n === 1 ? "chat" : "chats"}
          {np ? ` + ${np} ${np === 1 ? "project" : "projects"}` : ""}
        </button>
      </div>
    </div>
  );
}

function ClientMenu({ clients, current, onPick, onClose }: { clients: ClientOpt[]; current: string | null; onPick: (id: string | null) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
  return (
    <>
      <button type="button" className="fixed inset-0 z-30 cursor-default" onClick={onClose} aria-label="Close" />
      <div className="absolute right-2 top-full z-40 mt-1 w-[min(300px,80vw)] rounded-[16px] border border-line bg-surface p-2 shadow-2xl">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" className="mb-1 min-h-10 w-full rounded-[10px] bg-ink/[0.04] px-3 text-[13.5px] outline-none" />
        <div className="max-h-[260px] overflow-y-auto">
          <button type="button" onClick={() => onPick(null)} className={`min-h-10 w-full rounded-[10px] px-3 text-left text-[13px] hover:bg-ink/[0.05] ${current ? "text-muted" : "font-semibold text-fg"}`}>
            No client
          </button>
          {list.map((c) => (
            <button key={c.id} type="button" onClick={() => onPick(c.id)} className={`min-h-10 w-full truncate rounded-[10px] px-3 text-left text-[13.5px] hover:bg-ink/[0.05] ${c.id === current ? "font-semibold text-fg" : "text-fg/90"}`}>
              {c.name}
            </button>
          ))}
          {!list.length ? <p className="px-3 py-3 text-[13px] text-faint">No client by that name.</p> : null}
        </div>
      </div>
    </>
  );
}
