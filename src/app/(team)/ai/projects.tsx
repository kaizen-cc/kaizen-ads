"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { CONNECTORS, KNOWLEDGE_FULL_CHARS, VISIBILITY_LABEL, canDeleteProject, canEditProject, connectorKey, connectorLabel, type MemberRole, type ProjectDetail, type ProjectSummary, type ProjectVisibility } from "@/lib/kaizen-ai/projects";
import { kindOf, type Thread } from "@/lib/kaizen-ai/types";
import { teammates, uploadSlots } from "./actions";
import { addProjectFiles, addProjectText, createProject, deleteProject, listProjects, loadProject, myConnectorKeys, readProjectDoc, removeProjectDoc, shareProject, updateProject } from "./project-actions";

// Kaizen AI projects, like Claude's: the list (search, new project), and a project's page (its instructions and
// knowledge, the chats in it, who can see and change it). Starting a chat on the page uses the composer below it, so
// the chat gets the instructions and knowledge. Everything open lives in the address (?projects=1, ?p=, ?panel=,
// ?doc=, ?pnew=1), so back returns to it.

type ClientOpt = { id: string; name: string; slug: string };
type Chat = Thread & { owner: string | null };

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const P = {
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  menu: "M4 6h16M4 12h16M4 18h16",
  x: "M6 6l12 12M18 6L6 18",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  people: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  text: "M5 6h14M5 12h14M5 18h9",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  back: "M15 6l-6 6 6 6",
  chat: "M4 5h16v11H8l-4 4z",
  plug: "M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
};

const VIS_ICON: Record<ProjectVisibility, string> = { private: P.lock, people: P.people, everyone: P.globe };
const ago = (iso: string) => {
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const size = (chars: number) => (chars >= 1000 ? `${Math.round(chars / 1000)}k characters` : `${chars} characters`);
const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-[14px] transition";
const primary = `${btn} bg-brand font-medium text-white hover:bg-brand-hover disabled:opacity-50`;
const quiet = `${btn} border border-line text-fg hover:bg-ink/[0.04] disabled:opacity-50`;

/** A sheet: from the bottom on a phone, centered on a desktop */
function Sheet({ title, sub, onClose, children, wide }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal aria-label={title}>
      <button type="button" className="absolute inset-0 bg-deep/50 backdrop-blur-[2px]" onClick={onClose} aria-label="Close" />
      <div className={`relative flex max-h-[92dvh] w-full flex-col rounded-t-[26px] border border-line bg-surface shadow-2xl md:rounded-[26px] ${wide ? "max-w-[720px]" : "max-w-[480px]"}`}>
        <div className="flex items-start gap-3 px-5 pb-2 pt-5">
          <div className="min-w-0 flex-1">
            <p className="font-heading text-[20px] leading-tight text-fg">{title}</p>
            {sub ? <p className="mt-1 text-[13px] text-muted">{sub}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="-mr-2 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <Icon d={P.x} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-[max(20px,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}

// ─── All projects ────────────────────────────────────────────────────────────

export function ProjectsHome({ clients, onMenu }: { clients: ClientOpt[]; onMenu: () => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const creating = useParam("pnew") === "1";
  useEffect(() => {
    void listProjects().then(setList);
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = (list ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s) || (p.client?.name ?? "").toLowerCase().includes(s));
    return sort === "name" ? [...l].sort((a, b) => a.name.localeCompare(b.name)) : l;
  }, [list, q, sort]);
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg">
      <header className="flex min-h-14 items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur md:px-6">
        <button type="button" onClick={onMenu} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] md:hidden" aria-label="Chats">
          <Icon d={P.menu} />
        </button>
        <p className="flex-1 truncate text-[15px] font-semibold text-fg">Projects</p>
        <button type="button" onClick={() => pushParams({ pnew: "1" })} className={primary}>
          <Icon d={P.plus} size={16} /> New project
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[960px] gap-5 px-4 pb-10 pt-6 md:px-8 md:pt-10">
          <div className="grid gap-1">
            <h1 className="font-heading text-[28px] leading-tight tracking-tight text-fg md:text-[34px]">Projects</h1>
            <p className="max-w-[560px] text-[14px] text-muted">A place for related chats, with instructions and knowledge every chat in it reads. Make one for a client, a campaign or a way of working, and share it with the team.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-11 min-w-[220px] flex-1 items-center gap-2 rounded-full border border-line bg-surface px-4 text-faint focus-within:border-brand/40">
              <Icon d={P.search} size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" className="w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-faint" />
            </label>
            <select value={sort} onChange={(e) => setSort(e.target.value as "recent" | "name")} className="min-h-11 rounded-full border border-line bg-surface px-4 text-[13.5px] text-fg" aria-label="Sort">
              <option value="recent">Recent activity</option>
              <option value="name">Name</option>
            </select>
          </div>
          {list === null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[132px] animate-pulse rounded-[20px] border border-line bg-surface" />
              ))}
            </div>
          ) : shown.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {shown.map((p) => (
                <button key={p.id} type="button" onClick={() => pushParams({ p: p.id, projects: null })} className="group grid min-h-[132px] content-start gap-2 rounded-[20px] border border-line bg-surface p-4 text-left shadow-[var(--lift-1)] transition hover:-translate-y-px hover:border-brand/40 hover:shadow-[var(--lift-2)]">
                  <span className="flex items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-brand-soft text-brand-text">
                      <Icon d={P.folder} size={18} />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-[15px] font-semibold text-fg">{p.name}</span>
                      <span className="flex items-center gap-1.5 text-[12px] text-faint">
                        <Icon d={VIS_ICON[p.visibility]} size={12} /> {VISIBILITY_LABEL[p.visibility]}
                        {p.role !== "owner" ? ` · ${p.role === "editor" ? "you can edit" : "view only"}` : ""}
                      </span>
                    </span>
                  </span>
                  {p.description ? <span className="line-clamp-2 text-[13px] text-muted">{p.description}</span> : null}
                  <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[12px] text-faint">
                    {p.client ? <span className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-fg/80">{p.client.name}</span> : null}
                    <span>{p.chats === 1 ? "1 chat" : `${p.chats} chats`}</span>
                    <span>{p.docs === 1 ? "1 doc" : `${p.docs} docs`}</span>
                    {p.imported ? <span>From Claude</span> : null}
                    <span className="ml-auto">Updated {ago(p.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid justify-items-center gap-3 rounded-[24px] border border-dashed border-line px-6 py-14 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-brand-soft text-brand-text">
                <Icon d={P.folder} size={22} />
              </span>
              <p className="text-[15px] font-semibold text-fg">{q ? "No project by that name" : "No projects yet"}</p>
              <p className="max-w-[380px] text-[13.5px] text-muted">{q ? "Try another word, or start a new one." : "Start one, or import your Claude projects from the menu next to New chat."}</p>
              {!q ? (
                <button type="button" onClick={() => pushParams({ pnew: "1" })} className={primary}>
                  <Icon d={P.plus} size={16} /> New project
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {creating ? <NewProject clients={clients} onClose={() => closeParams("pnew")} onCreated={(id) => replaceParams({ pnew: null, projects: null, p: id })} /> : null}
    </section>
  );
}

function NewProject({ clients, onClose, onCreated }: { clients: ClientOpt[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [clientId, setClientId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    const r = await createProject({ name, description, clientId: clientId || null });
    setSaving(false);
    if (r.ok) onCreated(r.id);
    else setError(r.error);
  };
  return (
    <Sheet title="New project" sub="Private to you until you share it. Add instructions and knowledge next." onClose={onClose}>
      <div className="grid gap-3 pt-2">
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">What are you working on?</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your project" maxLength={120} className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[15px] text-fg outline-none focus:border-brand/50" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">What are you trying to achieve?</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Describe the project, its goals, the subject" className="resize-none rounded-[12px] border border-line bg-bg px-3 py-2.5 text-[14px] text-fg outline-none focus:border-brand/50" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">About one client? (optional)</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg">
            <option value="">No client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-faint">Every chat in it then reads the client&rsquo;s context, as a chat pinned to them does.</span>
        </label>
        {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={`${btn} text-muted hover:text-fg`}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim() || saving} onClick={() => void save()} className={primary}>
            {saving ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** Put one of your chats in a project (or take it out): every project you can see is offered */
export function MoveToProject({ current, onClose, onMove }: { current: string | null; onClose: () => void; onMove: (projectId: string | null) => Promise<string | null> }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void listProjects().then(setList);
  }, []);
  const s = q.trim().toLowerCase();
  const shown = (list ?? []).filter((p) => !s || p.name.toLowerCase().includes(s));
  const pick = async (id: string | null) => {
    const e = await onMove(id);
    if (e) setError(e);
    else onClose();
  };
  return (
    <Sheet title="Move to a project" sub="The chat then reads the project's instructions and knowledge." onClose={onClose}>
      <div className="grid gap-2 pt-2">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none focus:border-brand/50" />
        {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
        <div className="grid gap-0.5 pb-2">
          {current ? (
            <button type="button" onClick={() => void pick(null)} className="min-h-11 rounded-[12px] px-3 text-left text-[14px] text-muted hover:bg-ink/[0.05]">
              Take it out of its project
            </button>
          ) : null}
          {shown.map((p) => (
            <button key={p.id} type="button" disabled={p.id === current} onClick={() => void pick(p.id)} className="flex min-h-12 items-center gap-3 rounded-[12px] px-3 text-left hover:bg-ink/[0.05] disabled:opacity-50">
              <span className="text-brand-text">
                <Icon d={P.folder} size={16} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{p.name}</span>
              {p.id === current ? <span className="text-[12px] text-faint">Here now</span> : null}
            </button>
          ))}
          {list === null ? <p className="px-3 py-3 text-[13px] text-faint">Loading…</p> : !shown.length ? <p className="px-3 py-3 text-[13px] text-faint">No projects yet. Make one from Projects.</p> : null}
        </div>
      </div>
    </Sheet>
  );
}

// ─── One project ─────────────────────────────────────────────────────────────

export function useProject(id: string | null) {
  // Kept with the id it's for, so another project's page never shows the last one's
  const [got, setGot] = useState<{ id: string; value: { project: ProjectDetail; chats: Chat[] } | "missing" } | null>(null);
  const reload = useCallback(() => {
    if (!id) return;
    void loadProject(id).then((r) => setGot({ id, value: r ?? "missing" }));
  }, [id]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data: got && got.id === id ? got.value : null, reload };
}

export function ProjectView({ data, meId, clients, onOpenChat, onChanged }: { data: { project: ProjectDetail; chats: Chat[] }; meId: string; clients: ClientOpt[]; onOpenChat: (id: string) => void; onChanged: () => void }) {
  const { project: p, chats } = data;
  const panel = useParam("panel");
  const docId = useParam("doc");
  const edit = canEditProject(p.role);
  const [connected, setConnected] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.connectors.length) void myConnectorKeys().then(setConnected);
  }, [p.connectors.length]);
  const missing = connected ? p.connectors.filter((k) => !connected.includes(k)) : [];
  const fill = Math.min(100, Math.round((p.knowledgeChars / KNOWLEDGE_FULL_CHARS) * 100));
  const mine = chats.filter((c) => c.profile_id === meId);
  const shared = chats.filter((c) => c.profile_id !== meId);

  const upload = async (list: File[]) => {
    const files = list.filter((f) => {
      const k = kindOf(f.type, f.name);
      return k === "pdf" || k === "doc" || k === "text";
    });
    if (!files.length) return setNotice("PDFs, Word, PowerPoint, Excel, CSV and text files can be added as knowledge.");
    setNotice(null);
    setUploading(files.map((f) => f.name));
    try {
      const r = await uploadSlots(files.map((f) => ({ name: f.name, mime: f.type || "application/octet-stream", bytes: f.size })));
      if (!r.ok) throw new Error(r.error);
      const supabase = createClient();
      const done: { path: string; name: string; mime: string; bytes: number }[] = [];
      await Promise.all(
        files.map(async (f, i) => {
          const s = r.slots[i];
          const { error } = await supabase.storage.from("ai-files").uploadToSignedUrl(s.path, s.token, f, { contentType: f.type || "application/octet-stream" });
          if (!error) done.push({ path: s.path, name: f.name, mime: f.type || "application/octet-stream", bytes: f.size });
        }),
      );
      if (!done.length) throw new Error("The upload didn't go through. Try again.");
      const a = await addProjectFiles(p.id, done);
      if (!a.ok) throw new Error(a.error);
      const unread = a.docs.filter((d) => d.note && !d.chars);
      if (unread.length) setNotice(`${unread.map((d) => d.name).join(", ")}: ${unread[0].note}`);
      onChanged();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't add those files.");
    }
    setUploading([]);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8">
      {/* The project and its chats */}
      <div className="grid min-w-0 content-start gap-6">
        <div className="grid gap-2">
          <button type="button" onClick={() => pushParams({ projects: "1", p: null })} className="-ml-2 inline-flex min-h-11 items-center gap-1 justify-self-start rounded-full px-2 text-[13px] text-muted hover:text-fg">
            <Icon d={P.back} size={15} /> All projects
          </button>
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 font-heading text-[28px] leading-tight tracking-tight text-fg md:text-[34px]">{p.name}</h1>
            {edit ? (
              <button type="button" onClick={() => pushParams({ panel: "details" })} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Project settings">
                <Icon d={P.gear} size={18} />
              </button>
            ) : null}
          </div>
          {p.description ? <p className="max-w-[640px] whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{p.description}</p> : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={() => pushParams({ panel: "share" })} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] text-fg hover:border-brand/40">
              <Icon d={VIS_ICON[p.visibility]} size={14} /> {VISIBILITY_LABEL[p.visibility]}
              {p.visibility === "people" ? ` · ${p.members.length + 1}` : ""}
            </button>
            {p.client ? (
              <Link href={`/clients/${p.client.slug}`} className="inline-flex min-h-11 items-center rounded-full bg-ink/[0.05] px-3.5 text-[13px] text-fg hover:bg-ink/[0.08]">
                {p.client.name}
              </Link>
            ) : null}
            {p.imported ? <span className="inline-flex min-h-8 items-center rounded-full bg-ink/[0.05] px-3 text-[12px] text-faint">Imported from Claude</span> : null}
          </div>
          <p className="text-[12.5px] text-faint">
            Created by {p.creator.id === meId ? "you" : p.creator.name} · {p.editors.length > 1 ? `Editors: ${p.editors.join(", ")}` : `Only ${p.creator.id === meId ? "you" : p.creator.name} can edit`}
            {!edit ? " · You can read its knowledge and start chats in it" : ""}
          </p>
        </div>

        {missing.length ? (
          <div className="grid gap-2">
            {missing.map((k) => (
              <Link key={k} href="/settings?tab=connections&section=yours" className="flex min-h-12 items-center gap-3 rounded-[16px] border border-warn/30 bg-warn-soft/50 px-4 py-2 text-[13.5px] text-fg hover:border-warn/60">
                <Icon d={P.plug} size={16} />
                <span className="flex-1">Connect {connectorLabel(k)} to use this project fully</span>
                <span className="text-[12.5px] font-medium text-brand-text">Settings › Connections</span>
              </Link>
            ))}
          </div>
        ) : null}

        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Your chats in this project</p>
          {mine.length ? (
            <ul className="grid gap-1.5">
              {mine.map((c) => (
                <ChatRow key={c.id} c={c} onOpen={() => onOpenChat(c.id)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-[13.5px] text-muted">Start a chat below. It reads the project&rsquo;s instructions and knowledge{p.client ? ` and ${p.client.name}'s context` : ""}. Your chats stay private to you unless you share them.</p>
          )}
          {shared.length ? (
            <>
              <p className="pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Shared with you</p>
              <ul className="grid gap-1.5">
                {shared.map((c) => (
                  <ChatRow key={c.id} c={c} onOpen={() => onOpenChat(c.id)} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {/* Instructions and knowledge */}
      <aside className="grid content-start gap-4">
        <div className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 shadow-[var(--lift-1)]">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[14px] font-semibold text-fg">Instructions</p>
            <button type="button" onClick={() => pushParams({ panel: "instructions" })} className="min-h-11 rounded-full px-3 text-[13px] text-brand-text hover:bg-brand-soft/40">
              {edit ? (p.instructions ? "Edit" : "Add") : "View"}
            </button>
          </div>
          {p.instructions ? <p className="line-clamp-4 whitespace-pre-line text-[13px] leading-relaxed text-muted">{p.instructions}</p> : <p className="text-[13px] text-faint">{edit ? "Tell Kaizen AI how to work in this project: the tone, the format, what to always check." : "No instructions yet."}</p>}
        </div>

        <div className="grid gap-3 rounded-[20px] border border-line bg-surface p-4 shadow-[var(--lift-1)]">
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[14px] font-semibold text-fg">Knowledge</p>
            {edit ? (
              <>
                <button type="button" disabled={uploading.length > 0} onClick={() => fileInput.current?.click()} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg disabled:opacity-50" aria-label="Upload files" title="Upload files">
                  <Icon d={P.upload} size={17} />
                </button>
                <button type="button" onClick={() => pushParams({ panel: "text" })} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Add text" title="Add text">
                  <Icon d={P.text} size={17} />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  multiple
                  accept=".pdf,.docx,.pptx,.xlsx,.csv,.tsv,.txt,.md,.json,.html"
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    if (files.length) void upload(files);
                    e.target.value = "";
                  }}
                />
              </>
            ) : null}
          </div>
          {p.docs.length ? (
            <div className="grid gap-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.07]">
                <span className={`block h-full rounded-full ${fill >= 100 ? "bg-warn" : "bg-brand"}`} style={{ width: `${Math.max(2, fill)}%` }} />
              </div>
              <p className="text-[12px] text-faint">{fill >= 100 ? "More than fits in one chat: each message reads the parts that matter to it." : `${fill}% of what each chat reads whole`}</p>
            </div>
          ) : null}
          {notice ? <p className="rounded-[12px] bg-warn-soft/60 px-3 py-2 text-[12.5px] text-fg">{notice}</p> : null}
          {uploading.length ? <p className="animate-pulse text-[12.5px] text-muted">Reading {uploading.join(", ")}…</p> : null}
          {p.docs.length ? (
            <ul className="grid gap-1">
              {p.docs.map((d) => (
                <li key={d.id} className="group flex items-center gap-1">
                  <button type="button" onClick={() => pushParams({ doc: d.id })} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[12px] px-2 text-left hover:bg-ink/[0.04]">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-ink/[0.05] text-muted">
                      <Icon d={P.doc} size={15} />
                    </span>
                    <span className="grid min-w-0">
                      <span className="truncate text-[13.5px] text-fg">{d.name}</span>
                      <span className={`truncate text-[11.5px] ${d.note && !d.chars ? "text-warn" : "text-faint"}`}>{d.note && !d.chars ? d.note : size(d.chars)}</span>
                    </span>
                  </button>
                  {edit ? <RemoveDoc projectId={p.id} docId={d.id} name={d.name} onDone={onChanged} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-faint">{edit ? "Add PDFs, documents, spreadsheets or text. Every chat in the project reads them." : "No knowledge yet."}</p>
          )}
        </div>
      </aside>

      {panel === "instructions" ? <InstructionsSheet p={p} onClose={() => closeParams("panel")} onSaved={onChanged} /> : null}
      {panel === "text" && edit ? <TextSheet projectId={p.id} onClose={() => closeParams("panel")} onSaved={onChanged} /> : null}
      {panel === "share" ? <ShareProject p={p} meId={meId} onClose={() => closeParams("panel")} onSaved={onChanged} /> : null}
      {panel === "details" && edit ? <DetailsSheet p={p} clients={clients} onClose={() => closeParams("panel")} onSaved={onChanged} /> : null}
      {docId ? <DocSheet projectId={p.id} docId={docId} onClose={() => closeParams("doc")} /> : null}
    </div>
  );
}

function ChatRow({ c, onOpen }: { c: Chat; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-2.5 text-left transition hover:border-brand/40">
        <span className="text-faint">
          <Icon d={P.chat} size={16} />
        </span>
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[14px] text-fg">{c.title}</span>
          <span className="truncate text-[12px] text-faint">
            {c.owner ? `${c.owner} · ` : ""}Last message {ago(c.last_message_at)}
            {c.source ? " · from Claude" : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function RemoveDoc({ projectId, docId, name, onDone }: { projectId: string; docId: string; name: string; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!sure) {
          setSure(true);
          setTimeout(() => setSure(false), 3000);
          return;
        }
        setBusy(true);
        await removeProjectDoc(projectId, docId);
        setBusy(false);
        onDone();
      }}
      className={`grid h-11 min-w-11 shrink-0 place-items-center rounded-full px-2 text-[12px] transition ${sure ? "bg-bad-soft text-bad" : "text-faint opacity-0 hover:text-bad group-hover:opacity-100 max-md:opacity-100"}`}
      aria-label={`Remove ${name}`}
    >
      {sure ? "Remove?" : <Icon d={P.trash} size={15} />}
    </button>
  );
}

function InstructionsSheet({ p, onClose, onSaved }: { p: ProjectDetail; onClose: () => void; onSaved: () => void }) {
  const edit = canEditProject(p.role);
  const [v, setV] = useState(p.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    const r = await updateProject(p.id, { instructions: v });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };
  return (
    <Sheet title="Instructions" sub={edit ? "Every chat in this project follows these. Write them the way you'd brief a sharp colleague." : "Every chat in this project follows these."} onClose={onClose} wide>
      {edit ? (
        <div className="grid gap-3 pt-2">
          <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)} rows={14} maxLength={40_000} placeholder="For example: answer as a senior media buyer, lead with the numbers, always check the client's KPI target before suggesting budget changes." className="min-h-[260px] resize-y rounded-[14px] border border-line bg-bg px-3.5 py-3 text-[14px] leading-relaxed text-fg outline-none focus:border-brand/50" />
          {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[12px] tabular-nums text-faint">{v.length.toLocaleString()} / 40,000</span>
            <button type="button" onClick={onClose} className={`${btn} text-muted hover:text-fg`}>
              Cancel
            </button>
            <button type="button" disabled={saving || v === p.instructions} onClick={() => void save()} className={primary}>
              {saving ? "Saving…" : "Save instructions"}
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-line pb-2 pt-2 text-[14px] leading-relaxed text-fg">{p.instructions || "No instructions yet."}</p>
      )}
    </Sheet>
  );
}

function TextSheet({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    const r = await addProjectText(projectId, { name, text });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };
  return (
    <Sheet title="Add text to the knowledge" sub="Paste notes, a brief, a transcript or anything the chats should know." onClose={onClose} wide>
      <div className="grid gap-3 pt-2">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Title" maxLength={200} className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none focus:border-brand/50" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder="Content" className="min-h-[240px] resize-y rounded-[14px] border border-line bg-bg px-3.5 py-3 text-[14px] leading-relaxed text-fg outline-none focus:border-brand/50" />
        {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btn} text-muted hover:text-fg`}>
            Cancel
          </button>
          <button type="button" disabled={saving || !text.trim()} onClick={() => void save()} className={primary}>
            {saving ? "Adding…" : "Add to knowledge"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function DocSheet({ projectId, docId, onClose }: { projectId: string; docId: string; onClose: () => void }) {
  const [doc, setDoc] = useState<{ name: string; text: string; note: string | null } | null | "missing">(null);
  useEffect(() => {
    void readProjectDoc(projectId, docId).then((d) => setDoc(d ?? "missing"));
  }, [projectId, docId]);
  return (
    <Sheet title={doc && doc !== "missing" ? doc.name : "Knowledge"} sub={doc && doc !== "missing" && doc.note ? doc.note : undefined} onClose={onClose} wide>
      {doc === null ? <p className="py-6 text-[13px] text-faint">Opening…</p> : doc === "missing" ? <p className="py-6 text-[13px] text-muted">That document isn&rsquo;t there any more.</p> : <pre className="whitespace-pre-wrap break-words pb-4 pt-2 font-sans text-[13.5px] leading-relaxed text-fg">{doc.text || "No text could be read from it."}</pre>}
    </Sheet>
  );
}

function ShareProject({ p, meId, onClose, onSaved }: { p: ProjectDetail; meId: string; onClose: () => void; onSaved: () => void }) {
  const edit = canEditProject(p.role);
  const [visibility, setVisibility] = useState<ProjectVisibility>(p.visibility);
  const [everyoneCanEdit, setEveryoneCanEdit] = useState(p.everyoneCanEdit);
  const [members, setMembers] = useState<{ id: string; name: string; role: MemberRole }[]>(p.members);
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (edit) void teammates().then(setPeople);
  }, [edit]);
  const s = q.trim().toLowerCase();
  const matches = s ? (people ?? []).filter((x) => x.id !== p.creator.id && !members.some((m) => m.id === x.id) && x.name.toLowerCase().includes(s)).slice(0, 6) : [];
  const save = async () => {
    setSaving(true);
    const r = await shareProject(p.id, { visibility, everyoneCanEdit, members: members.map((m) => ({ id: m.id, role: m.role })) });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };
  const options: { key: ProjectVisibility; note: string }[] = [
    { key: "private", note: "Only you (and execs, who can see every project)" },
    { key: "people", note: "The people you add, each a viewer or an editor" },
    { key: "everyone", note: "Everyone at Kaizen can find it and start chats in it" },
  ];
  return (
    <Sheet title={edit ? "Share project" : "Who has access"} sub="Chats people start in it stay their own, private unless they share them." onClose={onClose}>
      <div className="grid gap-4 pt-2">
        {edit ? (
          <div className="grid gap-1.5" role="radiogroup" aria-label="Who can see it">
            {options.map((o) => (
              <label key={o.key} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[14px] border px-3 py-2 transition ${visibility === o.key ? "border-brand/50 bg-brand-soft/30" : "border-line hover:bg-ink/[0.03]"}`}>
                <input type="radio" name="visibility" checked={visibility === o.key} onChange={() => setVisibility(o.key)} className="h-4 w-4 accent-[var(--brand)]" />
                <span className="text-muted">
                  <Icon d={VIS_ICON[o.key]} size={16} />
                </span>
                <span className="grid">
                  <span className="text-[14px] font-medium text-fg">{VISIBILITY_LABEL[o.key]}</span>
                  <span className="text-[12.5px] text-muted">{o.note}</span>
                </span>
              </label>
            ))}
            {visibility === "everyone" ? (
              <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[14px] px-3">
                <span className="text-[13.5px] text-fg">Everyone can also edit it</span>
                <input type="checkbox" checked={everyoneCanEdit} onChange={(e) => setEveryoneCanEdit(e.target.checked)} className="h-5 w-5 accent-[var(--brand)]" />
              </label>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-fg">
            <Icon d={VIS_ICON[p.visibility]} size={16} /> {VISIBILITY_LABEL[p.visibility]}
            {p.visibility === "everyone" ? (p.everyoneCanEdit ? ", everyone can edit" : ", everyone can view") : ""}
          </p>
        )}

        {visibility !== "private" ? (
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">People</p>
            <div className="flex min-h-12 items-center gap-3 rounded-[12px] px-2">
              <span className="flex-1 truncate text-[14px] text-fg">
                {p.creator.name}
                {p.creator.id === meId ? " (you)" : ""}
              </span>
              <span className="text-[12.5px] text-faint">Owner</span>
            </div>
            {members.map((m) => (
              <div key={m.id} className="flex min-h-12 items-center gap-2 rounded-[12px] px-2">
                <span className="flex-1 truncate text-[14px] text-fg">
                  {m.name}
                  {m.id === meId ? " (you)" : ""}
                </span>
                {edit ? (
                  <>
                    <select value={m.role} onChange={(e) => setMembers((l) => l.map((x) => (x.id === m.id ? { ...x, role: e.target.value as MemberRole } : x)))} className="min-h-11 rounded-full border border-line bg-surface px-3 text-[13px] text-fg" aria-label={`${m.name}'s access`}>
                      <option value="viewer">Can view</option>
                      <option value="editor">Can edit</option>
                    </select>
                    <button type="button" onClick={() => setMembers((l) => l.filter((x) => x.id !== m.id))} className="grid h-11 w-11 place-items-center rounded-full text-faint hover:bg-ink/[0.05] hover:text-bad" aria-label={`Remove ${m.name}`}>
                      <Icon d={P.x} size={15} />
                    </button>
                  </>
                ) : (
                  <span className="text-[12.5px] text-faint">{m.role === "editor" ? "Can edit" : "Can view"}</span>
                )}
              </div>
            ))}
            {edit ? (
              <div className="relative">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a teammate" className="min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none focus:border-brand/50" />
                {matches.length ? (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 grid gap-0.5 rounded-[14px] border border-line bg-surface p-1 shadow-xl">
                    {matches.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => {
                          setMembers((l) => [...l, { id: x.id, name: x.name, role: "viewer" }]);
                          setQ("");
                        }}
                        className="min-h-11 rounded-[10px] px-3 text-left text-[14px] text-fg hover:bg-ink/[0.05]"
                      >
                        {x.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
        {edit ? (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={`${btn} text-muted hover:text-fg`}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={() => void save()} className={primary}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function DetailsSheet({ p, clients, onClose, onSaved }: { p: ProjectDetail; clients: ClientOpt[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [clientId, setClientId] = useState(p.client?.id ?? "");
  const [connectors, setConnectors] = useState<string[]>(p.connectors);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: string) => setConnectors((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));
  const save = async () => {
    setSaving(true);
    const r = await updateProject(p.id, { name, description, clientId: clientId || null, connectors });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!sure) return setSure(true);
    setSaving(true);
    const r = await deleteProject(p.id);
    setSaving(false);
    if (!r.ok) return setError(r.error);
    replaceParams({ panel: null, p: null, projects: "1" });
  };
  const extra = connectors.filter((k) => !CONNECTORS.some((c) => c.key === k));
  return (
    <Sheet title="Project settings" onClose={onClose} wide>
      <div className="grid gap-4 pt-2">
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[15px] text-fg outline-none focus:border-brand/50" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="resize-none rounded-[12px] border border-line bg-bg px-3 py-2.5 text-[14px] text-fg outline-none focus:border-brand/50" />
        </label>
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg">
            <option value="">No client</option>
            {p.client && !clients.some((c) => c.id === p.client!.id) ? <option value={p.client.id}>{p.client.name}</option> : null}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-2">
          <span className="text-[12.5px] font-medium text-muted">Connectors this project expects</span>
          <span className="-mt-1 text-[12px] text-faint">People without them connected see a note pointing to Settings › Connections.</span>
          <div className="flex flex-wrap gap-2">
            {[...CONNECTORS.map((c) => c.key), ...extra].map((k) => (
              <button key={k} type="button" onClick={() => toggle(k)} aria-pressed={connectors.includes(k)} className={`min-h-11 rounded-full border px-3.5 text-[13px] transition ${connectors.includes(k) ? "border-brand/50 bg-brand-soft/40 text-fg" : "border-line text-muted hover:text-fg"}`}>
                {connectorLabel(k)}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const k = connectorKey(custom);
              if (k && !connectors.includes(k)) setConnectors((l) => [...l, k]);
              setCustom("");
            }}
          >
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Another connector" className="min-h-11 flex-1 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none focus:border-brand/50" />
            <button type="submit" disabled={!connectorKey(custom)} className={quiet}>
              Add
            </button>
          </form>
        </div>
        {error ? <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
          {canDeleteProject(p.role) ? (
            <button type="button" disabled={saving} onClick={() => void remove()} className={`${btn} mr-auto ${sure ? "bg-bad-soft text-bad" : "text-faint hover:text-bad"}`}>
              <Icon d={P.trash} size={15} /> {sure ? "Delete for good? Chats stay with their people" : "Delete project"}
            </button>
          ) : null}
          <button type="button" onClick={onClose} className={`${btn} text-muted hover:text-fg`}>
            Cancel
          </button>
          <button type="button" disabled={saving || !name.trim()} onClick={() => void save()} className={primary}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
