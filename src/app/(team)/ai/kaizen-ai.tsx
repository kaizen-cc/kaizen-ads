"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { captureFrames, extractAudio } from "@/lib/uploads/video-prep";
import { pushParams, replaceParams, closeParams, useParam } from "@/lib/url-state";
import { QUICK_ACTIONS, type QuickAction } from "@/lib/kaizen-ai/agents";
import { AGENT_LABEL, CHAT_AGENTS, kindOf, type AiModel, type Attachment, type AttachmentKind, type Card, type ChatAgent, type ChatEvent, type ChatMessage, type Thread, type ToolRun } from "@/lib/kaizen-ai/types";
import type { TeamRole } from "@/lib/roles";
import { deleteTemplate, listTemplates, listThreads, loadThread, saveTemplate, shareThread, teammates, updateThread, uploadSlots, usedTemplate, type Template } from "./actions";
import { CardView, ChatMarkdown, CopyButton, ToolChips } from "./cards";

// Kaizen AI: a chat like Claude's, for the team. Threads on the left (search, pinned, grouped by client, shared with
// me), the conversation in the middle with streaming answers, tool status and cards, and a composer with files,
// quick actions ("/"), saved prompts, the model and who answers. The open thread and the thread list live in the
// address (?t=, ?list=), so back and forward work like everywhere else.

type ClientOpt = { id: string; name: string; slug: string };
type Me = { id: string; first: string; role: TeamRole };
type Pending = { key: string; name: string; kind: AttachmentKind; status: "uploading" | "ready" | "failed"; note?: string; preview?: string; att?: Attachment };
type Live = { thread: string | null; text: string; tools: ToolRun[]; cards: Card[]; agent: { label: string; why: string } | null; error: string | null; busy: boolean };

const MODELS: { key: AiModel; label: string; note: string }[] = [
  { key: "opus", label: "Opus 5.5", note: "Deepest thinking, long context" },
  { key: "sonnet", label: "Sonnet 5.5", note: "Faster, for everyday asks" },
];
const MAX_FRAMES = 48;

const greet = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
// The greeting follows the browser's clock, not the server's: the server renders "Hello" and the browser swaps in its
// own after hydrating, so the two renders never disagree (React #418).
const noSubscribe = () => () => {};
const spread = <T,>(list: T[], n: number) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]));

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const P = {
  plus: "M12 5v14M5 12h14",
  send: "M5 12h14M13 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  clip: "M21 12.5l-8.5 8.5a5 5 0 0 1-7-7L14 5.5a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.5a1.7 1.7 0 0 1-2.3-2.3L15.5 8.6",
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  pin: "M9 4h6l-1 5 3 3H7l3-3zM12 12v8",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
  redo: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  x: "M6 6l12 12M18 6L6 18",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  save: "M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7",
  chevron: "M6 9l6 6 6-6",
};

export function KaizenAi({ me, on, initialThreads, initialTemplates, clients, groups, homeAgent }: { me: Me; on: boolean; initialThreads: Thread[]; initialTemplates: Template[]; clients: ClientOpt[]; groups: QuickAction["group"][]; homeAgent: { key: ChatAgent; label: string } }) {
  const t = useParam("t");
  const listOpen = useParam("list") === "1";
  const [threads, setThreads] = useState(initialThreads);
  const [templates, setTemplates] = useState(initialTemplates);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ model: AiModel; agent: ChatAgent | null; client: ClientOpt | null }>({ model: "opus", agent: null, client: null });
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const streamingThread = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const readOnly = Boolean(thread && thread.profile_id !== me.id);
  const model: AiModel = thread?.model ?? draft.model;
  const agentPick: ChatAgent | null = thread ? ((thread.agent_key as ChatAgent | null) ?? null) : draft.agent;
  const client: ClientOpt | null = thread?.client_id ? (clients.find((c) => c.id === thread.client_id) ?? (thread.clients ? { id: thread.client_id, name: thread.clients.name, slug: thread.clients.slug } : null)) : draft.client;

  const refreshThreads = useCallback(() => void listThreads().then(setThreads), []);

  // ─── The open thread ───
  useEffect(() => {
    if (!t) {
      setThread(null);
      setMessages([]);
      setOwner(null);
      return;
    }
    if (streamingThread.current === t) return;
    let gone = false;
    setLoading(true);
    void loadThread(t).then((r) => {
      if (gone) return;
      setLoading(false);
      if (!r) {
        setNotice("That thread isn't there any more.");
        replaceParams({ t: null });
        return;
      }
      setThread(r.thread);
      setMessages(r.messages);
      setOwner(r.owner);
      setUrls(r.urls);
      setEditing(null);
    });
    return () => {
      gone = true;
    };
  }, [t]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, live?.text, live?.tools.length, live?.cards.length]);

  // ─── Files: straight to storage as they're picked (videos watched here first: frames and audio) ───
  const attach = async (list: FileList | File[]) => {
    const supabase = createClient();
    for (const file of Array.from(list).slice(0, 10)) {
      const kind = kindOf(file.type, file.name);
      const key = `${file.name}-${file.size}-${Date.now()}`;
      if (!kind) {
        setNotice(`${file.name}: pictures, PDFs, Word, Excel, PowerPoint, CSV, text and video only.`);
        continue;
      }
      const preview = kind === "image" ? URL.createObjectURL(file) : undefined;
      setFiles((f) => [...f, { key, name: file.name, kind, status: "uploading", preview, note: kind === "video" ? "Watching the video…" : undefined }]);
      try {
        let frames: { ms: number; blob: Blob }[] = [];
        let audio: Blob | null = null;
        if (kind === "video") {
          const url = URL.createObjectURL(file);
          frames = spread(await captureFrames(url).catch(() => []), MAX_FRAMES);
          setFiles((f) => f.map((x) => (x.key === key ? { ...x, note: "Listening…" } : x)));
          audio = await extractAudio(url).catch(() => null);
          URL.revokeObjectURL(url);
          setFiles((f) => f.map((x) => (x.key === key ? { ...x, note: "Uploading…" } : x)));
        }
        const specs = [
          { name: file.name, mime: file.type || "application/octet-stream", bytes: file.size },
          ...frames.map((fr, i) => ({ name: `${i}.jpg`, mime: "image/jpeg", bytes: fr.blob.size, role: "frame" as const })),
          ...(audio ? [{ name: "audio.wav", mime: "audio/wav", bytes: audio.size, role: "audio" as const }] : []),
        ];
        const r = await uploadSlots(specs);
        if (!r.ok) throw new Error(r.error);
        const blobs: Blob[] = [file, ...frames.map((f) => f.blob), ...(audio ? [audio] : [])];
        for (let i = 0; i < blobs.length; i += 6)
          await Promise.all(
            blobs.slice(i, i + 6).map(async (b, j) => {
              const s = r.slots[i + j];
              const { error } = await supabase.storage.from("ai-files").uploadToSignedUrl(s.path, s.token, b, { contentType: specs[i + j].mime });
              if (error && i + j === 0) throw new Error("The upload didn't go through.");
            }),
          );
        const att: Attachment = {
          path: r.slots[0].path,
          name: file.name,
          mime: file.type || "application/octet-stream",
          bytes: file.size,
          kind,
          ...(kind === "video" ? { frames: frames.map((f, i) => ({ ms: f.ms, path: r.slots[i + 1].path })), audio: audio ? r.slots[r.slots.length - 1].path : null } : {}),
        };
        setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: "ready", note: undefined, att } : x)));
      } catch (e) {
        setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: "failed", note: e instanceof Error ? e.message : "Upload failed" } : x)));
      }
    }
  };

  // ─── A turn: sent, the answer streamed back ───
  const run = async (mode: "send" | "regenerate" | "edit", body: string) => {
    if (live?.busy || !on) return;
    const ready = files.filter((f) => f.status === "ready" && f.att).map((f) => f.att!);
    if (mode === "send" && !body.trim() && !ready.length) return;
    if (files.some((f) => f.status === "uploading")) {
      setNotice("Wait for the files to finish uploading.");
      return;
    }
    setNotice(null);
    const ac = new AbortController();
    abort.current = ac;
    streamingThread.current = thread?.id ?? null;
    const now = new Date().toISOString();
    // What the person sees right away
    setMessages((ms) => {
      if (mode === "send") return [...ms, { id: `tmp-${now}`, role: "user", content: body, attachments: ready, tools: [], cards: [], agent_key: null, model: null, error: null, stopped: false, created_at: now }];
      const lastUser = ms.map((m) => m.role).lastIndexOf("user");
      const kept = ms.slice(0, lastUser + 1);
      if (mode === "edit" && kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], content: body };
      return kept;
    });
    if (mode === "send") {
      setText("");
      setFiles([]);
    }
    setEditing(null);
    setLive({ thread: thread?.id ?? null, text: "", tools: [], cards: [], agent: null, error: null, busy: true });
    let threadId = thread?.id ?? null;
    const payload = {
      threadId,
      text: body,
      attachments: mode === "send" ? ready : [],
      model,
      mode,
      ...(thread ? {} : { agent: draft.agent, clientId: draft.client?.id ?? undefined }),
    };
    const handle = (e: ChatEvent) => {
      if (e.t === "thread") {
        threadId = e.id;
        streamingThread.current = e.id;
        if (e.created) {
          const fresh: Thread = { id: e.id, title: e.title, client_id: draft.client?.id ?? null, client_confirmed: Boolean(draft.client), agent_key: draft.agent, model, pinned: false, shared_with: [], last_message_at: now, profile_id: me.id, clients: draft.client ? { name: draft.client.name, slug: draft.client.slug } : null };
          setThread(fresh);
          setThreads((ts) => [fresh, ...ts]);
          replaceParams({ t: e.id });
        }
        setLive((l) => (l ? { ...l, thread: e.id } : l));
      } else if (e.t === "client") setThread((th) => (th ? { ...th, client_id: e.id, client_confirmed: e.confirmed, clients: { name: e.name, slug: e.slug } } : th));
      else if (e.t === "agent") setLive((l) => (l ? { ...l, agent: { label: e.label, why: e.why } } : l));
      else if (e.t === "text") setLive((l) => (l ? { ...l, text: l.text + e.d } : l));
      else if (e.t === "tool") setLive((l) => (l ? { ...l, tools: l.tools.some((x) => x.id === e.run.id) ? l.tools.map((x) => (x.id === e.run.id ? e.run : x)) : [...l.tools, e.run] } : l));
      else if (e.t === "card") setLive((l) => (l ? { ...l, cards: [...l.cards, e.card] } : l));
      else if (e.t === "error") setLive((l) => (l ? { ...l, error: e.message } : l));
    };
    try {
      const res = await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(res.status === 401 || res.redirected ? "Sign in again." : "Kaizen AI couldn't answer right now.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) handle(JSON.parse(line) as ChatEvent);
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setLive((l) => (l ? { ...l, error: e instanceof Error ? e.message : "Something went wrong." } : l));
    }
    // Saved on the server: read it back (ids, picture links), then the thread list
    if (threadId) {
      // A stop lets the server save what it had first
      if (ac.signal.aborted) await new Promise((r) => setTimeout(r, 900));
      const r = await loadThread(threadId);
      if (r) {
        setThread(r.thread);
        setMessages(r.messages);
        setUrls(r.urls);
      }
    }
    streamingThread.current = null;
    setLive((l) => (l?.error ? { ...l, busy: false } : null));
    abort.current = null;
    refreshThreads();
  };

  const stop = () => abort.current?.abort();

  // ─── Thread settings ───
  const patchThread = async (p: Parameters<typeof updateThread>[1], local: Partial<Thread>) => {
    if (!thread) return;
    setThread({ ...thread, ...local });
    setThreads((ts) => ts.map((x) => (x.id === thread.id ? { ...x, ...local } : x)));
    const r = await updateThread(thread.id, p);
    if (!r.ok) setNotice(r.error);
  };
  const setModel = (m: AiModel) => (thread ? void patchThread({ model: m }, { model: m }) : setDraft((d) => ({ ...d, model: m })));
  const setAgent = (a: ChatAgent | null) => (thread ? void patchThread({ agent: a }, { agent_key: a }) : setDraft((d) => ({ ...d, agent: a })));
  const setClient = (c: ClientOpt | null) =>
    thread ? void patchThread({ clientId: c?.id ?? null }, { client_id: c?.id ?? null, client_confirmed: Boolean(c), clients: c ? { name: c.name, slug: c.slug } : null }) : setDraft((d) => ({ ...d, client: c }));

  const newChat = () => {
    if (live?.busy) return;
    setDraft({ model: thread?.model ?? draft.model, agent: null, client: null });
    pushParams({ t: null, list: null });
    setTimeout(() => input.current?.focus(), 50);
  };

  const applyPrompt = (prompt: string, templateId?: string) => {
    const filled = prompt.replace(/\{client\}/g, client?.name ?? "[client]");
    setText(filled);
    if (templateId) void usedTemplate(templateId);
    setTimeout(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(filled.length, filled.length);
    }, 30);
  };

  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id ?? null;
  const lastAssistantId = messages.at(-1)?.role === "assistant" ? messages.at(-1)!.id : null;
  const shownAgent = live?.agent?.label ?? (agentPick ? AGENT_LABEL[agentPick] : null);

  return (
    <div className="-mx-4 -mt-6 flex h-[calc(100dvh-88px-env(safe-area-inset-bottom)-56px)] min-h-[480px] md:-mx-10 md:-my-8 md:h-[100dvh]">
      {/* Threads */}
      <Rail
        open={listOpen}
        threads={threads}
        active={thread?.id ?? null}
        meId={me.id}
        onNew={newChat}
        onPick={(id) => pushParams({ t: id, list: null })}
        onClose={() => closeParams("list")}
        onChanged={refreshThreads}
      />

      {/* The conversation */}
      <section className="flex min-w-0 flex-1 flex-col bg-bg">
        <Header
          thread={thread}
          readOnly={readOnly}
          owner={owner}
          client={client}
          clients={clients}
          model={model}
          onModel={setModel}
          onClient={setClient}
          onConfirmClient={() => void patchThread({ confirmClient: true }, { client_confirmed: true })}
          onList={() => pushParams({ list: "1" })}
          onNew={newChat}
          onShared={refreshThreads}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[820px] gap-7 px-4 pb-6 pt-6 md:px-8">
            {!thread && !messages.length && !live ? (
              <Empty first={me.first} on={on} groups={groups} templates={templates} client={client} homeAgent={homeAgent.label} onUse={applyPrompt} />
            ) : null}
            {loading && !messages.length ? <p className="py-10 text-center text-[13px] text-faint">Opening the thread…</p> : null}
            {messages.map((m) =>
              m.role === "user" ? (
                <UserBubble
                  key={m.id}
                  m={m}
                  urls={urls}
                  canEdit={!readOnly && m.id === lastUserId && !live?.busy}
                  editing={editing === m.id}
                  onEdit={() => setEditing(m.id)}
                  onCancel={() => setEditing(null)}
                  onSave={(v) => void run("edit", v)}
                />
              ) : (
                <AssistantBlock key={m.id} m={m} canRegenerate={!readOnly && m.id === lastAssistantId && !live?.busy} onRegenerate={() => void run("regenerate", "")} />
              ),
            )}
            {live && (live.thread === null || live.thread === thread?.id) ? <LiveBlock live={live} onRetry={() => void run("regenerate", "")} /> : null}
            <div ref={bottom} />
          </div>
        </div>

        {readOnly ? (
          <p className="border-t border-line px-4 py-4 text-center text-[13px] text-muted">Shared with you by {owner ?? "a teammate"} · read only</p>
        ) : (
          <Composer
            input={input}
            text={text}
            setText={setText}
            files={files}
            setFiles={setFiles}
            onAttach={attach}
            busy={Boolean(live?.busy)}
            on={on}
            notice={notice}
            onDismiss={() => setNotice(null)}
            onSend={() => void run("send", text)}
            onStop={stop}
            agent={agentPick}
            shownAgent={shownAgent}
            homeAgent={homeAgent.label}
            onAgent={setAgent}
            templates={templates}
            onUse={applyPrompt}
            onTemplatesChanged={() => void listTemplates().then(setTemplates)}
            groups={groups}
          />
        )}
      </section>
    </div>
  );
}

// ─── The thread rail ────────────────────────────────────────────────────────

function Rail({ open, threads, active, meId, onNew, onPick, onClose, onChanged }: { open: boolean; threads: Thread[]; active: string | null; meId: string; onNew: () => void; onPick: (id: string) => void; onClose: () => void; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? threads.filter((x) => x.title.toLowerCase().includes(s) || (x.clients?.name ?? "").toLowerCase().includes(s)) : threads;
  }, [q, threads]);
  const mine = shown.filter((x) => x.profile_id === meId);
  const pinned = mine.filter((x) => x.pinned);
  const shared = shown.filter((x) => x.profile_id !== meId);
  const byClient = new Map<string, Thread[]>();
  for (const x of mine.filter((y) => !y.pinned)) {
    const k = x.clients?.name ?? "";
    byClient.set(k, [...(byClient.get(k) ?? []), x]);
  }
  // Groups in order of their newest thread; threads without a client under "Everything else"
  const groups = [...byClient].sort((a, b) => (b[1][0]?.last_message_at ?? "").localeCompare(a[1][0]?.last_message_at ?? ""));

  const body = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-4">
        <button type="button" onClick={onNew} className="flex min-h-11 flex-1 items-center gap-2 rounded-full bg-brand px-4 text-[14px] font-medium text-white shadow-sm transition hover:bg-brand-hover">
          <Icon d={P.plus} size={16} />
          New chat
        </button>
        <button type="button" onClick={onClose} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] md:hidden" aria-label="Close">
          <Icon d={P.x} />
        </button>
      </div>
      <label className="mx-3 mb-2 flex min-h-10 items-center gap-2 rounded-full bg-ink/[0.04] px-3 text-faint focus-within:ring-2 focus-within:ring-brand/30">
        <Icon d={P.search} size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" className="w-full bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint" />
      </label>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {pinned.length ? <RailGroup title="Pinned" items={pinned} active={active} onPick={onPick} onChanged={onChanged} mine /> : null}
        {groups.map(([name, items]) => (
          <RailGroup key={name || "none"} title={name || "Everything else"} items={items} active={active} onPick={onPick} onChanged={onChanged} mine />
        ))}
        {shared.length ? <RailGroup title="Shared with me" items={shared} active={active} onPick={onPick} onChanged={onChanged} mine={false} /> : null}
        {!threads.length ? <p className="px-3 py-6 text-[13px] text-faint">Your chats show here.</p> : null}
      </nav>
    </div>
  );
  return (
    <>
      <aside className="hidden w-[280px] shrink-0 border-r border-line bg-surface md:block">{body}</aside>
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal>
          <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={onClose} aria-label="Close" />
          <div className="absolute inset-y-0 left-0 w-[86vw] max-w-[340px] bg-surface shadow-2xl">{body}</div>
        </div>
      ) : null}
    </>
  );
}

function RailGroup({ title, items, active, onPick, onChanged, mine }: { title: string; items: Thread[]; active: string | null; onPick: (id: string) => void; onChanged: () => void; mine: boolean }) {
  return (
    <div className="mt-3">
      <p className="truncate px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{title}</p>
      <ul className="grid gap-0.5">
        {items.map((x) => (
          <RailItem key={x.id} x={x} active={x.id === active} onPick={onPick} onChanged={onChanged} mine={mine} />
        ))}
      </ul>
    </div>
  );
}

function RailItem({ x, active, onPick, onChanged, mine }: { x: Thread; active: boolean; onPick: (id: string) => void; onChanged: () => void; mine: boolean }) {
  const [menu, setMenu] = useState(false);
  const act = async (p: Parameters<typeof updateThread>[1]) => {
    setMenu(false);
    await updateThread(x.id, p);
    onChanged();
  };
  return (
    <li className="group relative">
      <button type="button" onClick={() => onPick(x.id)} className={`flex min-h-10 w-full items-center gap-2 rounded-[12px] py-2 pl-3 pr-9 text-left text-[13.5px] transition ${active ? "bg-ink/[0.07] text-fg" : "text-muted hover:bg-ink/[0.04] hover:text-fg"}`}>
        {x.pinned ? <span className="text-brand-text"><Icon d={P.pin} size={13} /></span> : null}
        <span className="truncate">{x.title}</span>
      </button>
      {mine ? (
        <button type="button" onClick={() => setMenu(!menu)} className={`absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-faint hover:bg-ink/[0.06] hover:text-fg ${menu || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-md:opacity-100"}`} aria-label="Thread options">
          <Icon d={P.dots} size={16} />
        </button>
      ) : null}
      {menu ? (
        <div className="absolute right-1 top-full z-20 mt-1 grid w-44 gap-0.5 rounded-[14px] border border-line bg-surface p-1 shadow-xl">
          <button type="button" className="min-h-10 rounded-[10px] px-3 text-left text-[13px] hover:bg-ink/[0.05]" onClick={() => void act({ pinned: !x.pinned })}>
            {x.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            className="min-h-10 rounded-[10px] px-3 text-left text-[13px] hover:bg-ink/[0.05]"
            onClick={() => {
              const title = window.prompt("Rename the chat", x.title);
              if (title?.trim()) void act({ title });
              else setMenu(false);
            }}
          >
            Rename
          </button>
          <button type="button" className="min-h-10 rounded-[10px] px-3 text-left text-[13px] text-bad hover:bg-bad-soft/40" onClick={() => void act({ archived: true })}>
            Archive
          </button>
        </div>
      ) : null}
    </li>
  );
}

// ─── The header: title, client, model, share ───────────────────────────────

function Header({
  thread,
  readOnly,
  owner,
  client,
  clients,
  model,
  onModel,
  onClient,
  onConfirmClient,
  onList,
  onNew,
  onShared,
}: {
  thread: Thread | null;
  readOnly: boolean;
  owner: string | null;
  client: ClientOpt | null;
  clients: ClientOpt[];
  model: AiModel;
  onModel: (m: AiModel) => void;
  onClient: (c: ClientOpt | null) => void;
  onConfirmClient: () => void;
  onList: () => void;
  onNew: () => void;
  onShared: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  const detected = Boolean(thread?.client_id && !thread.client_confirmed);
  return (
    <header className="flex min-h-14 items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur md:px-6">
      <button type="button" onClick={onList} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] md:hidden" aria-label="Chats">
        <Icon d={P.menu} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-fg">{thread?.title ?? "Kaizen AI"}</p>
        {readOnly ? <p className="text-[12px] text-faint">Shared by {owner}</p> : null}
      </div>
      {detected && client && !readOnly ? (
        <div className="hidden items-center gap-1 rounded-full border border-brand/30 bg-brand-soft/30 py-1 pl-3 pr-1 text-[12.5px] sm:flex">
          <span className="text-muted">About</span>
          <span className="font-medium text-fg">{client.name}?</span>
          <button type="button" onClick={onConfirmClient} className="min-h-8 rounded-full bg-brand px-3 text-white">
            Yes
          </button>
          <button type="button" onClick={() => onClient(null)} className="min-h-8 rounded-full px-2 text-muted hover:text-fg">
            No
          </button>
        </div>
      ) : (
        <ClientPicker client={client} clients={clients} onPick={onClient} disabled={readOnly} />
      )}
      {!readOnly ? (
        <select value={model} onChange={(e) => onModel(e.target.value as AiModel)} className="min-h-10 max-w-[104px] rounded-full border border-line bg-surface px-2 text-[12.5px] text-fg sm:max-w-none sm:px-3 sm:text-[13px]" aria-label="Model">
          {MODELS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      ) : null}
      {thread && !readOnly ? (
        <button type="button" onClick={() => setSharing(true)} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Share">
          <Icon d={P.share} size={17} />
        </button>
      ) : null}
      <button type="button" onClick={onNew} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg md:hidden" aria-label="New chat">
        <Icon d={P.plus} />
      </button>
      {sharing && thread ? (
        <ShareSheet
          thread={thread}
          onClose={() => {
            setSharing(false);
            onShared();
          }}
        />
      ) : null}
    </header>
  );
}

function ClientPicker({ client, clients, onPick, disabled }: { client: ClientOpt | null; clients: ClientOpt[]; onPick: (c: ClientOpt | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
  return (
    <div className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen(!open)} className={`flex min-h-10 max-w-[180px] items-center gap-1.5 rounded-full border px-3 text-[13px] ${client ? "border-brand/30 bg-brand-soft/25 text-fg" : "border-line text-muted"} disabled:opacity-70`}>
        <span className="truncate">{client?.name ?? "Pin a client"}</span>
        {!disabled ? <Icon d={P.chevron} size={14} /> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} aria-label="Close" />
          <div className="absolute right-0 top-full z-40 mt-2 w-[min(320px,86vw)] rounded-[16px] border border-line bg-surface p-2 shadow-2xl">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" className="mb-1 min-h-10 w-full rounded-[10px] bg-ink/[0.04] px-3 text-[13.5px] outline-none" />
            <div className="max-h-[300px] overflow-y-auto">
              {client ? (
                <button
                  type="button"
                  className="min-h-10 w-full rounded-[10px] px-3 text-left text-[13px] text-muted hover:bg-ink/[0.05]"
                  onClick={() => {
                    onPick(null);
                    setOpen(false);
                  }}
                >
                  No client
                </button>
              ) : null}
              {list.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`min-h-10 w-full truncate rounded-[10px] px-3 text-left text-[13.5px] hover:bg-ink/[0.05] ${c.id === client?.id ? "font-semibold text-fg" : "text-fg/90"}`}
                  onClick={() => {
                    onPick(c);
                    setOpen(false);
                    setQ("");
                  }}
                >
                  {c.name}
                </button>
              ))}
              {!list.length ? <p className="px-3 py-3 text-[13px] text-faint">No client by that name.</p> : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ShareSheet({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [picked, setPicked] = useState<string[]>(thread.shared_with ?? []);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void teammates().then(setPeople);
  }, []);
  const save = async () => {
    setSaving(true);
    await shareThread(thread.id, picked);
    setSaving(false);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal>
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={onClose} aria-label="Close" />
      <div className="relative w-full max-w-[440px] rounded-t-[24px] border border-line bg-surface p-5 shadow-2xl md:rounded-[24px]">
        <p className="font-heading text-[20px] text-fg">Share this chat</p>
        <p className="mt-1 text-[13px] text-muted">Teammates you pick can read it (not write in it). They get a notification.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a teammate" className="mt-4 min-h-11 w-full rounded-[12px] bg-ink/[0.04] px-3 text-[14px] outline-none" />
        <div className="mt-2 max-h-[300px] overflow-y-auto">
          {(people ?? [])
            .filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
            .map((p) => (
              <label key={p.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2 hover:bg-ink/[0.04]">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} className="h-4 w-4 accent-[var(--brand)]" />
                <span className="text-[14px] text-fg">{p.name}</span>
              </label>
            ))}
          {!people ? <p className="px-2 py-3 text-[13px] text-faint">Loading…</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-full px-4 text-[14px] text-muted hover:text-fg">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-60">
            {saving ? "Saving…" : picked.length ? `Share with ${picked.length}` : "Stop sharing"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

function Attachments({ list, urls }: { list: Attachment[]; urls: Record<string, string> }) {
  if (!list?.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {list.map((a) => {
        const img = a.kind === "image" ? urls[a.path] : a.kind === "video" && a.frames?.[0] ? urls[a.frames[0].path] : null;
        return img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={a.path} src={img} alt={a.name} className="h-24 w-24 rounded-[14px] border border-line object-cover" />
        ) : (
          <span key={a.path} className="inline-flex min-h-10 max-w-[240px] items-center gap-2 rounded-[12px] border border-line bg-surface px-3 text-[12.5px] text-muted">
            <span className="rounded-[6px] bg-ink/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]">{a.name.split(".").pop()}</span>
            <span className="truncate">{a.name}</span>
          </span>
        );
      })}
    </div>
  );
}

function UserBubble({ m, urls, canEdit, editing, onEdit, onCancel, onSave }: { m: ChatMessage; urls: Record<string, string>; canEdit: boolean; editing: boolean; onEdit: () => void; onCancel: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(m.content);
  if (editing)
    return (
      <div className="ml-auto grid w-full max-w-[85%] gap-2">
        <textarea value={v} onChange={(e) => setV(e.target.value)} rows={Math.min(10, Math.max(3, v.split("\n").length))} className="w-full rounded-[18px] border border-brand/40 bg-surface px-4 py-3 text-[15px] leading-relaxed text-fg outline-none ring-2 ring-brand/20" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="min-h-10 rounded-full px-4 text-[13px] text-muted hover:text-fg">
            Cancel
          </button>
          <button type="button" onClick={() => onSave(v)} className="min-h-10 rounded-full bg-brand px-4 text-[13px] font-medium text-white">
            Send again
          </button>
        </div>
      </div>
    );
  return (
    <div className="group ml-auto grid max-w-[85%] justify-items-end gap-2">
      <Attachments list={m.attachments} urls={urls} />
      {m.content ? <div className="whitespace-pre-wrap rounded-[20px] rounded-br-[6px] bg-ink/[0.06] px-4 py-2.5 text-[15px] leading-relaxed text-fg">{m.content}</div> : null}
      <div className="flex gap-1 opacity-0 transition group-hover:opacity-100 max-md:opacity-100">
        <CopyButton text={m.content} label="" />
        {canEdit ? (
          <button type="button" onClick={onEdit} className="inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-faint hover:bg-ink/[0.05] hover:text-fg">
            <Icon d={P.edit} size={13} /> Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-deep text-white shadow-sm">
      <Icon d={P.spark} size={15} />
    </span>
  );
}

function AssistantBlock({ m, canRegenerate, onRegenerate }: { m: ChatMessage; canRegenerate: boolean; onRegenerate: () => void }) {
  return (
    <div className="group flex gap-3">
      <Avatar />
      <div className="grid min-w-0 flex-1 gap-3">
        {m.agent_key && m.agent_key in AGENT_LABEL ? <p className="text-[12px] text-faint">{AGENT_LABEL[m.agent_key as ChatAgent]}</p> : null}
        <ToolChips runs={(m.tools ?? []).filter((r) => r.ok !== null)} />
        {m.content ? <ChatMarkdown text={m.content} /> : null}
        {(m.cards ?? []).map((c, i) => (
          <CardView key={i} card={c} />
        ))}
        {m.stopped ? <p className="text-[12.5px] text-faint">Stopped.</p> : null}
        {m.error ? <p className="rounded-[12px] bg-bad-soft/40 px-3 py-2 text-[13px] text-bad">{m.error}</p> : null}
        <div className="flex gap-1 opacity-0 transition group-hover:opacity-100 max-md:opacity-100">
          {m.content ? <CopyButton text={m.content} /> : null}
          {canRegenerate ? (
            <button type="button" onClick={onRegenerate} className="inline-flex min-h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-faint hover:bg-ink/[0.05] hover:text-fg">
              <Icon d={P.redo} size={13} /> Regenerate
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LiveBlock({ live, onRetry }: { live: Live; onRetry: () => void }) {
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="grid min-w-0 flex-1 gap-3">
        {live.agent ? (
          <p className="text-[12px] text-faint">
            {live.agent.label} <span className="text-faint/70">· {live.agent.why}</span>
          </p>
        ) : null}
        <ToolChips runs={live.tools} />
        {live.text ? <ChatMarkdown text={live.text} /> : null}
        {live.cards.map((c, i) => (
          <CardView key={i} card={c} />
        ))}
        {live.busy && !live.text && !live.tools.some((t) => t.ok === null) ? (
          <span className="flex h-6 items-center gap-1" aria-label="Thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </span>
        ) : null}
        {live.error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-bad-soft/40 px-3 py-2 text-[13px] text-bad">
            {live.error}
            {!live.busy ? (
              <button type="button" onClick={onRetry} className="min-h-8 rounded-full px-2 underline">
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── The empty state: quick actions for the person's role ───────────────────

function Empty({ first, on, groups, templates, client, homeAgent, onUse }: { first: string; on: boolean; groups: QuickAction["group"][]; templates: Template[]; client: ClientOpt | null; homeAgent: string; onUse: (p: string, id?: string) => void }) {
  const actions = groups.flatMap((g) => QUICK_ACTIONS.filter((a) => a.group === g));
  const name = (s: string) => s.replace(/\{client\}/g, client?.name ?? "a client");
  const hello = useSyncExternalStore(noSubscribe, greet, () => "Hello");
  return (
    <div className="grid gap-8 pt-6 md:pt-16">
      <div className="grid justify-items-center gap-3 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-gradient-to-br from-brand to-deep text-white shadow-lg">
          <Icon d={P.spark} size={26} />
        </span>
        <h1 className="font-heading text-[30px] leading-tight tracking-tight text-fg md:text-[38px]">
          {hello}
          {first ? `, ${first}` : ""}
        </h1>
        <p className="max-w-[520px] text-[14.5px] text-muted">
          Ask anything about your clients, accounts and creative. It reads the client&rsquo;s context, pulls live numbers, writes copy and briefs, and plans changes for you to confirm. Answering as your {homeAgent} unless the ask is about something else.
        </p>
        {!on ? <p className="rounded-full bg-warn-soft/60 px-3 py-1 text-[12.5px] text-fg">AI isn&rsquo;t connected yet.</p> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.slice(0, 8).map((a) => (
          <button key={a.id} type="button" onClick={() => onUse(a.prompt)} className="group grid min-h-[72px] content-start gap-1 rounded-[18px] border border-line bg-surface px-4 py-3 text-left transition hover:-translate-y-px hover:border-brand/40 hover:shadow-md">
            <span className="text-[14px] font-semibold text-fg">{name(a.title)}</span>
            <span className="line-clamp-2 text-[12.5px] text-muted">{name(a.prompt)}</span>
          </button>
        ))}
      </div>
      {templates.length ? (
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Saved prompts</p>
          <div className="flex flex-wrap gap-2">
            {templates.slice(0, 10).map((t) => (
              <button key={t.id} type="button" onClick={() => onUse(t.prompt, t.id)} className="min-h-10 rounded-full border border-line bg-surface px-4 text-[13px] text-fg hover:border-brand/40">
                {t.title}
                {!t.mine && t.by ? <span className="ml-1.5 text-faint">· {t.by.split(" ")[0]}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── The composer ───────────────────────────────────────────────────────────

function Composer({
  input,
  text,
  setText,
  files,
  setFiles,
  onAttach,
  busy,
  on,
  notice,
  onDismiss,
  onSend,
  onStop,
  agent,
  shownAgent,
  homeAgent,
  onAgent,
  templates,
  onUse,
  onTemplatesChanged,
  groups,
}: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (v: string) => void;
  files: Pending[];
  setFiles: React.Dispatch<React.SetStateAction<Pending[]>>;
  onAttach: (f: FileList | File[]) => void;
  busy: boolean;
  on: boolean;
  notice: string | null;
  onDismiss: () => void;
  onSend: () => void;
  onStop: () => void;
  agent: ChatAgent | null;
  shownAgent: string | null;
  homeAgent: string;
  onAgent: (a: ChatAgent | null) => void;
  templates: Template[];
  onUse: (p: string, id?: string) => void;
  onTemplatesChanged: () => void;
  groups: QuickAction["group"][];
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [agentMenu, setAgentMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  // "/" opens the quick actions and saved prompts, filtered by what follows it
  const slash = /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const ordered = [...groups.flatMap((g) => QUICK_ACTIONS.filter((a) => a.group === g)), ...QUICK_ACTIONS.filter((a) => !groups.includes(a.group))];
  const options =
    slash === null
      ? []
      : [...templates.map((t) => ({ key: `t-${t.id}`, title: t.title, prompt: t.prompt, id: t.id as string | undefined, saved: true, mine: t.mine })), ...ordered.map((a) => ({ key: a.id, title: a.title.replace("{client}", "a client"), prompt: a.prompt, id: undefined, saved: false, mine: false }))].filter(
          (o) => o.title.toLowerCase().includes(slash),
        );

  const canSend = on && !busy && (text.trim().length > 0 || files.some((f) => f.status === "ready")) && slash === null;

  return (
    <div
      className="border-t border-line/60 bg-bg px-3 pb-3 pt-2 md:px-6 md:pb-5"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) onAttach(e.dataTransfer.files);
      }}
    >
      <div className="relative mx-auto w-full max-w-[820px]">
        {notice ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-[12px] bg-warn-soft/50 px-3 py-2 text-[13px] text-fg">
            {notice}
            <button type="button" onClick={onDismiss} className="grid h-8 w-8 place-items-center rounded-full hover:bg-ink/[0.05]" aria-label="Dismiss">
              <Icon d={P.x} size={14} />
            </button>
          </div>
        ) : null}
        {options.length ? (
          <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[320px] overflow-y-auto rounded-[18px] border border-line bg-surface p-1.5 shadow-2xl">
            {options.slice(0, 14).map((o) => (
              <div key={o.key} className="group flex items-center">
                <button type="button" onClick={() => onUse(o.prompt, o.id)} className="flex min-h-11 flex-1 items-center gap-2 rounded-[12px] px-3 text-left hover:bg-ink/[0.05]">
                  <span className="text-[13.5px] text-fg">{o.title}</span>
                  {o.saved ? <span className="rounded-full bg-brand-soft/50 px-2 text-[10.5px] text-brand-text">saved</span> : null}
                </button>
                {o.saved && o.mine && o.id ? (
                  <button
                    type="button"
                    onClick={() => void deleteTemplate(o.id!).then(onTemplatesChanged)}
                    className="grid h-9 w-9 place-items-center rounded-full text-faint opacity-0 hover:text-bad group-hover:opacity-100 max-md:opacity-100"
                    aria-label="Delete saved prompt"
                  >
                    <Icon d={P.x} size={14} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className={`rounded-[24px] border bg-surface shadow-[0_8px_30px_-12px_rgba(0,0,0,0.18)] transition ${drag ? "border-brand ring-4 ring-brand/15" : "border-line focus-within:border-brand/40"}`}>
          {files.length ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {files.map((f) => (
                <span key={f.key} className={`relative inline-flex min-h-12 max-w-[220px] items-center gap-2 rounded-[12px] border px-2 py-1.5 text-[12.5px] ${f.status === "failed" ? "border-bad/40 text-bad" : "border-line text-muted"}`}>
                  {f.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.preview} alt="" className="h-9 w-9 rounded-[8px] object-cover" />
                  ) : (
                    <span className="grid h-9 w-9 place-items-center rounded-[8px] bg-ink/[0.06] text-[10px] font-semibold uppercase">{f.name.split(".").pop()?.slice(0, 4)}</span>
                  )}
                  <span className="grid min-w-0">
                    <span className="truncate text-fg">{f.name}</span>
                    <span className="truncate text-[11px] text-faint">{f.status === "uploading" ? (f.note ?? "Uploading…") : f.status === "failed" ? (f.note ?? "Failed") : f.kind}</span>
                  </span>
                  {f.status === "uploading" ? <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-brand border-t-transparent" /> : null}
                  <button type="button" onClick={() => setFiles((l) => l.filter((x) => x.key !== f.key))} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-faint hover:bg-ink/[0.06] hover:text-fg" aria-label={`Remove ${f.name}`}>
                    <Icon d={P.x} size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                onAttach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (options.length) onUse(options[0].prompt, options[0].id);
                else if (canSend) onSend();
              }
              if (e.key === "Escape" && slash !== null) setText("");
            }}
            rows={1}
            placeholder={on ? "Ask Kaizen AI…  ( / for quick actions)" : "AI isn't connected yet"}
            className="block max-h-[260px] min-h-[52px] w-full resize-none [field-sizing:content] bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx,.xlsx,.pptx,.csv,.tsv,.txt,.md,.json,video/*"
              onChange={(e) => {
                if (e.target.files) onAttach(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" onClick={() => fileInput.current?.click()} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Attach files">
              <Icon d={P.clip} />
            </button>
            <div className="relative">
              <button type="button" onClick={() => setAgentMenu(!agentMenu)} className="flex min-h-10 max-w-[230px] items-center gap-1.5 rounded-full px-3 text-[12.5px] text-muted hover:bg-ink/[0.05] hover:text-fg">
                <span className="truncate">
                  Answering as: <span className="font-medium text-fg">{agent ? AGENT_LABEL[agent] : (shownAgent ?? `Auto (${homeAgent})`)}</span>
                </span>
                <Icon d={P.chevron} size={13} />
              </button>
              {agentMenu ? (
                <>
                  <button type="button" className="fixed inset-0 z-30 cursor-default" onClick={() => setAgentMenu(false)} aria-label="Close" />
                  <div className="absolute bottom-full left-0 z-40 mb-2 grid w-60 gap-0.5 rounded-[16px] border border-line bg-surface p-1.5 shadow-2xl">
                    {[null, ...CHAT_AGENTS].map((k) => (
                      <button
                        key={k ?? "auto"}
                        type="button"
                        onClick={() => {
                          onAgent(k);
                          setAgentMenu(false);
                        }}
                        className={`min-h-10 rounded-[10px] px-3 text-left text-[13px] hover:bg-ink/[0.05] ${k === agent ? "font-semibold text-fg" : "text-fg/90"}`}
                      >
                        {k ? AGENT_LABEL[k] : "Automatic (by what you ask)"}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-1">
              {text.trim().length > 12 && slash === null ? (
                <button type="button" onClick={() => setSaving(true)} className="hidden h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-faint hover:bg-ink/[0.05] hover:text-fg sm:flex" title="Save as a prompt">
                  <Icon d={P.save} size={14} /> Save prompt
                </button>
              ) : null}
              {busy ? (
                <button type="button" onClick={onStop} className="grid h-11 w-11 place-items-center rounded-full bg-fg text-bg transition hover:opacity-90" aria-label="Stop">
                  <Icon d={P.stop} size={14} />
                </button>
              ) : (
                <button type="button" disabled={!canSend} onClick={onSend} className="grid h-11 w-11 place-items-center rounded-full bg-brand text-white transition hover:bg-brand-hover disabled:opacity-35" aria-label="Send">
                  <Icon d={P.send} size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-1.5 hidden text-center text-[11px] text-faint md:block">Kaizen AI can be wrong. It never changes an ad account or messages a client without you confirming.</p>
        {saving ? (
          <SaveTemplate
            prompt={text}
            onClose={(saved) => {
              setSaving(false);
              if (saved) onTemplatesChanged();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function SaveTemplate({ prompt, onClose }: { prompt: string; onClose: (saved: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(prompt);
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const r = await saveTemplate({ title, prompt: body, shared });
    if (!r.ok) return setError(r.error);
    onClose(true);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal>
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={() => onClose(false)} aria-label="Close" />
      <div className="relative grid w-full max-w-[520px] gap-3 rounded-t-[24px] border border-line bg-surface p-5 shadow-2xl md:rounded-[24px]">
        <p className="font-heading text-[20px] text-fg">Save as a prompt</p>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name it (e.g. Weekly Google check)" className="min-h-11 rounded-[12px] bg-ink/[0.04] px-3 text-[14px] outline-none" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="rounded-[12px] bg-ink/[0.04] px-3 py-2 text-[13.5px] leading-relaxed outline-none" />
        <p className="text-[12px] text-faint">Write {"{client}"} where the client&rsquo;s name goes; it&rsquo;s filled in from the pinned client.</p>
        <label className="flex min-h-11 items-center gap-3 text-[14px] text-fg">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
          Share it with the team
        </label>
        {error ? <p className="text-[13px] text-bad">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onClose(false)} className="min-h-11 rounded-full px-4 text-[14px] text-muted hover:text-fg">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
