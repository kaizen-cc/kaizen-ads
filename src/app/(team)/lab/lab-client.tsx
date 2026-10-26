"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { METRIC_LABEL, SEATS, TURNS_PER_ROUND, type Metric, type Seat } from "@/lib/lab-seats";
import type { ClientNumbers, ProposedTest } from "@/lib/lab";
import { createTest, decideTest, deleteSource, deleteThread, deployLearning, draftDeploy, dropTest, iterateTest, sendToTable, startTest, tableSpeaks, type Attachment } from "./actions";

export type LabClientRow = { id: string; name: string; slug: string; industry: string | null; spend30: number };
export type LabMessage = { id: string; role: "user" | "agent"; seat: Seat | null; author: string | null; body: string; tests: ProposedTest[]; attachments: { id: string; kind: string; title: string; url: string | null; failed?: boolean }[]; at: string };
export type LabSource = { id: string; kind: string; title: string; url: string | null; summary: string | null; status: string; at: string; words: number };
export type LabTest = {
  id: string;
  threadId: string | null;
  title: string;
  hypothesis: string;
  change: string;
  metric: Metric;
  success: string;
  targetLift: number;
  status: "proposed" | "running" | "won" | "lost";
  startedAt: string | null;
  endsAt: string | null;
  verdict: string | null;
  learning: string | null;
  createdAt: string;
  clients: { id: string; before: ClientNumbers | null; now: ClientNumbers | null; change: number | null }[];
  briefs: { waiting: number; approved: number; tickets: number[] };
  deployed: { id: string; change: number | null }[];
  deployedAt: string | null;
};
type Tab = "table" | "tests";

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}%`);
const ago = (iso: string) => {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < 60 ? `${Math.max(1, Math.round(m))}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export function LabClient(props: {
  threads: { id: string; title: string; updatedAt: string }[];
  threadId: string | null;
  messages: LabMessage[];
  sources: LabSource[];
  tests: LabTest[];
  clients: LabClientRow[];
  tab: Tab;
  aiOn: boolean;
}) {
  const [tab, setTab] = useState<Tab>(props.tab);
  // Opening a conversation (e.g. a flop sent back to iterate) shows the table
  const [opened, setOpened] = useState(props.threadId);
  if (props.threadId !== opened) {
    setOpened(props.threadId);
    if (props.threadId) setTab("table");
  }
  const running = props.tests.filter((t) => t.status === "running").length;
  const won = props.tests.filter((t) => t.status === "won").length;
  const deployedClients = new Set(props.tests.flatMap((t) => t.deployed.map((d) => d.id))).size;

  const go = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <p className="text-xs uppercase tracking-[0.18em] text-faint">Execs &amp; leads</p>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">Ads Lab</h1>
          <p className="max-w-2xl text-sm text-muted">Think it through with the whole table, test it on the right clients, and turn what wins into something every agent knows.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill value={running} label="running" />
          <Pill value={won} label="won" />
          <Pill value={deployedClients} label="clients learning from wins" />
        </div>
      </header>

      <nav className="flex gap-1 border-b border-line">
        {(
          [
            ["table", "Round table"],
            ["tests", `Running tests${props.tests.length ? ` · ${props.tests.length}` : ""}`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => go(k)} className={`relative px-4 pb-3 pt-3 text-sm md:pt-0 ${tab === k ? "text-fg" : "text-muted hover:text-fg"}`}>
            {l}
            {tab === k && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        ))}
      </nav>

      {!props.aiOn && <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">The AI isn&apos;t connected in this environment, so the table can&apos;t answer here.</p>}

      {tab === "table" && <RoundTable {...props} />}
      {tab === "tests" && <Tests tests={props.tests} clients={props.clients} />}
    </div>
  );
}

function Pill({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5">
      <span className="tabular text-sm font-semibold">{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function SeatMark({ seat, size = 30 }: { seat: Seat; size?: number }) {
  const s = SEATS[seat];
  return (
    <span className="grid shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ width: size, height: size, background: s.tint }} title={s.name}>
      {s.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)}
    </span>
  );
}

// ─── Round table ────────────────────────────────────────────────────────────

const SHARE_KINDS: Record<Attachment["kind"], string> = { video: "Video", link: "Link", transcript: "Call transcript", doc: "Doc", note: "Note" };
const isVideo = (url: string) => /youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com\/reel|facebook\.com\/.*videos/i.test(url);

function RoundTable({ threads, threadId, messages, tests, clients, sources }: { threads: { id: string; title: string; updatedAt: string }[]; threadId: string | null; messages: LabMessage[]; tests: LabTest[]; clients: LabClientRow[]; sources: LabSource[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [shared, setShared] = useState<Attachment[]>([]);
  const [adding, setAdding] = useState<null | "link" | "paste">(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftDoc, setDraftDoc] = useState({ title: "", body: "", kind: "doc" as Attachment["kind"] });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<ProposedTest | null>(null);
  const [dragging, setDragging] = useState(false);
  // The conversation open here (a new one has an id before the page catches up), and what was said since the page loaded
  const [tid, setTid] = useState(threadId);
  const [local, setLocal] = useState<LabMessage[]>([]);
  // Who's composing right now: a seat, or the whole table while it picks who answers
  const [typing, setTyping] = useState<Seat | "table" | null>(null);
  const [sending, setSending] = useState<null | "sending" | "reading">(null);
  // Go deep: the whole table on its full setting, with a web search, for the next message. mood: how this round was sorted
  const [deep, setDeep] = useState(false);
  const [mood, setMood] = useState<{ level: "quick" | "standard" | "deep"; research: boolean } | null>(null);
  const [seen, setSeen] = useState(threadId);
  const tidRef = useRef(threadId);
  const pageThread = useRef(threadId);
  const round = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const testById = useMemo(() => new Map(tests.map((t) => [t.id, t])), [tests]);

  // Another conversation was opened: start clean (a round still talking in the old one stops after its message)
  if (threadId !== seen) {
    setSeen(threadId);
    if (threadId !== tid) {
      setTid(threadId);
      setLocal([]);
      setTyping(null);
      setSending(null);
      setError(null);
    }
  }
  useEffect(() => {
    tidRef.current = tid;
    pageThread.current = threadId;
  }, [tid, threadId]);

  const thread = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id));
    return tid === threadId ? [...messages, ...local.filter((m) => !ids.has(m.id))] : local;
  }, [messages, local, tid, threadId]);
  const last = thread[thread.length - 1];
  const waiting = Boolean(tid) && last?.role === "user" && !typing && !sending;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [thread.length, typing, sending]);

  const add = (m: LabMessage) => setLocal((l) => [...l.filter((x) => x.id !== m.id), m].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));

  /** The table talks it through, one seat at a time, each message shown as it lands, until it's the exec's turn. */
  const talk = async (id: string) => {
    const mine = ++round.current;
    let seat: Seat | null = null;
    setError(null);
    for (let i = 0; i < TURNS_PER_ROUND; i++) {
      setTyping(seat ?? "table");
      const r = await tableSpeaks(id, seat);
      if (tidRef.current !== id) return;
      if (r.ok && r.message) add({ id: r.message.id, role: "agent", seat: r.message.seat, author: null, body: r.message.body, tests: r.message.tests, attachments: [], at: r.message.at });
      // The exec said something meanwhile: that starts a new round, which carries on from here
      if (round.current !== mine) return;
      if (!r.ok) {
        setError(r.error);
        break;
      }
      if (!r.message?.next) break;
      seat = r.message.next;
    }
    setTyping(null);
    if (pageThread.current === id) router.refresh();
    else router.replace(`/lab?t=${id}`, { scroll: false });
  };

  // Opened on a message the table hasn't answered yet (a test sent back to iterate, or a refresh mid-thought): answer it
  useEffect(() => {
    const m = messages[messages.length - 1];
    if (!threadId || m?.role !== "user" || Date.now() - Date.parse(m.at) > 10 * 60_000) return;
    const t = setTimeout(() => void talk(threadId), 0);
    return () => clearTimeout(t);
    // Only when a conversation opens, not on every refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const addFiles = async (files: FileList | File[]) => {
    const list = [...files].slice(0, 4);
    const read = await Promise.all(
      list.map(async (f) => ({
        kind: (/\.(srt|vtt)$/i.test(f.name) || /transcript|call|meeting/i.test(f.name) ? "transcript" : "doc") as Attachment["kind"],
        title: f.name.replace(/\.[a-z0-9]+$/i, ""),
        url: "",
        body: (await f.text()).slice(0, 200_000),
      })),
    );
    setShared((s) => [...s, ...read.filter((r) => r.body.trim())]);
  };

  // The exec can speak at any time: what they say is saved, and a new round starts that reads everything so far
  const send = async () => {
    const msg = text.trim();
    if ((!msg && !shared.length) || sending) return;
    const out = shared;
    const temp: LabMessage = {
      id: `sending-${Date.now()}`,
      role: "user",
      seat: null,
      author: null,
      body: msg,
      tests: [],
      attachments: out.map((a, i) => ({ id: String(i), kind: a.kind, title: a.title || a.url, url: a.url || null })),
      at: new Date().toISOString(),
    };
    setText("");
    setShared([]);
    setAdding(null);
    setError(null);
    setLocal((l) => [...l, temp]);
    round.current++;
    setSending(out.some((a) => a.url) ? "reading" : "sending");
    const r = await sendToTable(tidRef.current, msg, out, deep);
    setSending(null);
    setDeep(false);
    if (r.ok) setMood(r.message.level ? { level: r.message.level, research: Boolean(r.message.research) } : null);
    if (!r.ok) {
      setLocal((l) => l.filter((m) => m.id !== temp.id));
      setText(msg);
      setShared(out);
      return setError(r.error);
    }
    setLocal((l) => l.map((m) => (m.id === temp.id ? { ...temp, id: r.message.id, body: r.message.body, attachments: r.message.attachments, at: r.message.at } : m)));
    if (r.threadId !== tidRef.current) {
      tidRef.current = r.threadId;
      setTid(r.threadId);
      window.history.replaceState(null, "", `/lab?t=${r.threadId}`);
    }
    void talk(r.threadId);
  };

  const SPARKS = [
    { label: "Share a video", hint: "A YouTube ad breakdown, a creator, a competitor", act: () => setAdding("link") },
    { label: "Drop in a transcript", hint: "A client call, a strategy session", act: () => setAdding("paste") },
    { label: "Bring an idea", hint: "Something you want pressure-tested", act: () => document.getElementById("lab-input")?.focus() },
  ];
  const title = threads.find((t) => t.id === tid)?.title ?? (tid ? "New conversation" : null);

  return (
    <div className="grid gap-4 lg:grid-cols-[272px_minmax(0,1fr)] lg:items-start">
      <aside className="grid min-w-0 content-start gap-5 lg:sticky lg:top-6">
        <Conversations threads={threads} active={tid} />
        {sources.length > 0 && (
          <div className="hidden lg:block">
            <SharedMemory sources={sources} />
          </div>
        )}
      </aside>

      <section
        className={`relative flex h-[calc(100dvh_-_148px_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] min-h-[420px] min-w-0 flex-col md:h-[min(80vh,860px)] md:min-h-[520px] overflow-hidden rounded-[16px] border bg-surface transition-colors ${dragging ? "border-brand" : "border-line"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
          if (!e.dataTransfer.files.length && /^https?:\/\//.test(url)) setShared((s) => [...s, { kind: isVideo(url) ? "video" : "link", title: "", url: url.trim(), body: "" }]);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-bg/80 text-sm text-brand-text backdrop-blur-sm">Drop it on the table</div>
        )}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex shrink-0 -space-x-1.5">
            {(Object.keys(SEATS) as Seat[]).map((s) => (
              <span key={s} className={`rounded-full ring-2 ring-surface transition-opacity ${typing && typing !== "table" && typing !== s ? "opacity-40" : ""}`}>
                <SeatMark seat={s} size={26} />
              </span>
            ))}
          </div>
          <p className="min-w-0 flex-1 truncate text-xs text-faint">{title ?? "Strategy, creative, copy, media, data and accounts, with every winner, test and thing you've shared"}</p>
          {tid && (
            <button
              onClick={async () => {
                if (!confirm("Delete this conversation? Tests started from it stay.")) return;
                await deleteThread(tid);
                router.push("/lab");
              }}
              className="-my-2 shrink-0 py-2 pl-2 text-xs text-faint hover:text-bad md:my-0 md:py-0 md:pl-0"
            >
              Delete
            </button>
          )}
        </div>

        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4 md:p-6">
          {thread.length === 0 && (
            <div className="grid gap-6 py-6 text-center md:py-10">
              <div className="grid gap-2">
                <p className="font-display text-3xl tracking-tight md:text-4xl">What are we testing next?</p>
                <p className="mx-auto max-w-lg text-sm text-muted">
                  Bring the table a spark: an idea you can&apos;t shake, a video worth learning from, a call transcript, a brief that worked. The seats ask what they need to know, talk it through with each other and with you, then turn the best of it into a test.
                </p>
              </div>
              <div className="mx-auto grid w-full max-w-2xl gap-2 sm:grid-cols-3">
                {SPARKS.map((s) => (
                  <button key={s.label} onClick={s.act} className="grid gap-1 rounded-[14px] border border-line bg-bg p-4 text-left transition-colors hover:border-faint">
                    <span className="text-sm font-medium">{s.label}</span>
                    <span className="text-xs text-faint">{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {thread.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-auto grid max-w-[85%] justify-items-end gap-1.5 animate-[step-in_.25s_ease-out] md:max-w-[75%]">
                <p className="text-[11px] text-faint">{m.author ?? "You"}</p>
                {m.attachments.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {m.attachments.map((a) => (
                      <SharedChip key={a.id} kind={a.kind} title={a.title} url={a.url} failed={a.failed} />
                    ))}
                  </div>
                )}
                {m.body.replace(/\n?\[Shared [^\]]+\]/g, "").trim() && (
                  <p className="whitespace-pre-wrap break-words rounded-[14px] rounded-tr-[4px] bg-fg px-4 py-2.5 text-sm text-bg">{m.body.replace(/\n?\[Shared [^\]]+\]/g, "").trim()}</p>
                )}
              </div>
            ) : (
              <div key={m.id} className="grid gap-3 animate-[step-in_.3s_ease-out]">
                <div className="flex max-w-[92%] gap-3 md:max-w-[80%]">
                  {m.seat && <SeatMark seat={m.seat} />}
                  <div className="grid min-w-0 gap-1">
                    <p className="text-[11px] font-medium" style={{ color: m.seat ? SEATS[m.seat].tint : undefined }}>
                      {m.seat ? SEATS[m.seat].name : "The table"}
                    </p>
                    <p className="whitespace-pre-wrap break-words rounded-[14px] rounded-tl-[4px] border border-line bg-bg/60 px-4 py-2.5 text-sm leading-relaxed">{m.body}</p>
                  </div>
                </div>
                {m.tests.map((t, i) => (
                  <ProposalCard key={i} t={t} clients={clients} duplicate={t.duplicateOf ? (testById.get(t.duplicateOf) ?? null) : null} onStart={() => setStarting(t)} />
                ))}
              </div>
            ),
          )}

          {sending === "reading" && (
            <p className="flex items-center gap-2 text-xs text-faint animate-[step-in_.25s_ease-out]">
              <Dots />
              Reading what you shared first, so the table has it in hand…
            </p>
          )}
          {typing && !sending && <Typing seat={typing} mood={mood} />}
          {waiting && (
            <button onClick={() => tid && void talk(tid)} className="w-fit rounded-full border border-line px-3.5 py-2.5 text-xs text-muted transition-colors md:py-1.5 hover:border-faint hover:text-fg">
              Ask the table to answer
            </button>
          )}
          <div ref={end} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="grid gap-2 border-t border-line p-3"
        >
          {error && <p className="px-1 text-xs text-bad">{error}</p>}

          {shared.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {shared.map((a, i) => (
                <SharedChip key={i} kind={a.kind} title={a.title || a.url} url={a.url || null} onRemove={() => setShared(shared.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}

          {adding === "link" && (
            <div className="flex gap-2">
              <input
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                autoFocus
                placeholder="Paste a YouTube video, an article, a competitor's ad library link…"
                className="h-10 flex-1 rounded-[10px] border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint focus:border-faint"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (draftUrl.trim()) setShared([...shared, { kind: isVideo(draftUrl) ? "video" : "link", title: "", url: draftUrl.trim(), body: "" }]);
                    setDraftUrl("");
                    setAdding(null);
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (draftUrl.trim()) setShared([...shared, { kind: isVideo(draftUrl) ? "video" : "link", title: "", url: draftUrl.trim(), body: "" }]);
                  setDraftUrl("");
                  setAdding(null);
                }}
                className="h-10 rounded-[10px] bg-fg px-4 text-sm text-bg"
              >
                Add
              </button>
            </div>
          )}

          {adding === "paste" && (
            <div className="grid gap-2 rounded-[12px] border border-line bg-bg p-3">
              <div className="flex flex-wrap gap-1.5">
                {(["transcript", "doc", "note"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setDraftDoc({ ...draftDoc, kind: k })} className={`h-9 rounded-full px-3 text-xs md:h-7 ${draftDoc.kind === k ? "bg-fg text-bg" : "border border-line text-muted"}`}>
                    {SHARE_KINDS[k]}
                  </button>
                ))}
                <input value={draftDoc.title} onChange={(e) => setDraftDoc({ ...draftDoc, title: e.target.value })} placeholder="Title (optional)" className="h-9 min-w-0 flex-1 md:h-7 rounded-full border border-line bg-transparent px-3 text-xs outline-none placeholder:text-faint" />
              </div>
              <textarea value={draftDoc.body} onChange={(e) => setDraftDoc({ ...draftDoc, body: e.target.value })} rows={6} autoFocus placeholder="Paste it here: a transcript, a brief, a Google Doc's text…" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-faint" />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!draftDoc.body.trim()}
                  onClick={() => {
                    setShared([...shared, { kind: draftDoc.kind, title: draftDoc.title, url: "", body: draftDoc.body }]);
                    setDraftDoc({ title: "", body: "", kind: "doc" });
                    setAdding(null);
                  }}
                  className="h-10 rounded-[10px] bg-fg px-3 text-xs text-bg disabled:opacity-40 md:h-8"
                >
                  Add to the message
                </button>
                <button type="button" onClick={() => setAdding(null)} className="h-10 px-2 text-xs text-faint md:h-8">
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col rounded-[14px] border border-line bg-bg focus-within:border-faint">
              <textarea
                id="lab-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                onPaste={(e) => {
                  const t = e.clipboardData.getData("text");
                  if (/^https?:\/\/\S+$/.test(t.trim()) && !text.trim()) {
                    e.preventDefault();
                    setShared([...shared, { kind: isVideo(t) ? "video" : "link", title: "", url: t.trim(), body: "" }]);
                  }
                }}
                rows={2}
                placeholder={shared.length ? "What should the table look at in this?" : "Share an idea, or paste a link…"}
                className="max-h-48 min-h-[48px] resize-none bg-transparent px-3.5 pt-3 text-sm outline-none placeholder:text-faint"
              />
              <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                <ToolButton onClick={() => setAdding(adding === "link" ? null : "link")} on={adding === "link"} icon="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1">
                  Link or video
                </ToolButton>
                <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-fg md:h-7">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                    <path d="M21 12.5 12.6 21a5 5 0 0 1-7.1-7.1L14 5.4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" />
                  </svg>
                  File
                  <input type="file" multiple accept=".txt,.md,.markdown,.csv,.srt,.vtt,.json,text/plain" className="hidden" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
                </label>
                <ToolButton onClick={() => setAdding(adding === "paste" ? null : "paste")} on={adding === "paste"} icon="M8 4h8v3H8zM6 6H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1M8 12h8M8 16h5">
                  <span className="md:hidden">Paste</span>
                  <span className="hidden md:inline">Paste a transcript or doc</span>
                </ToolButton>
                <button
                  type="button"
                  onClick={() => setDeep((d) => !d)}
                  aria-pressed={deep}
                  title="The whole table on its full setting, with a web search, for this message. Otherwise quick questions get quick answers and big ones the full treatment."
                  className={`ml-auto flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors md:h-7 ${deep ? "bg-brand text-white" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
                >
                  <span aria-hidden>✦</span>
                  Go deep
                </button>
              </div>
            </div>
            <button disabled={(!text.trim() && !shared.length) || Boolean(sending)} className="h-12 shrink-0 rounded-brand bg-brand px-4 text-sm font-medium text-white disabled:opacity-40 md:px-5">
              Send
            </button>
          </div>
        </form>
      </section>

      {starting && <StartDialog t={starting} clients={clients} tests={tests} threadId={tid} onClose={() => setStarting(null)} />}
    </div>
  );
}

/** The conversations: a column beside the table on a wide screen, folded into one row above it on a phone. */
function Conversations({ threads, active }: { threads: { id: string; title: string; updatedAt: string }[]; active: string | null }) {
  const [open, setOpen] = useState(false);
  const list = active && !threads.some((t) => t.id === active) ? [{ id: active, title: "New conversation", updatedAt: new Date().toISOString() }, ...threads] : threads;
  const current = list.find((t) => t.id === active);
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-brand border border-line bg-surface px-3 text-left text-sm md:h-9 lg:hidden" aria-expanded={open}>
          <span className="min-w-0 flex-1 truncate">{current?.title ?? "Conversations"}</span>
          <span className="tabular shrink-0 text-[11px] text-faint">{threads.length}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <p className="hidden flex-1 px-1 text-[11px] uppercase tracking-[0.14em] text-faint lg:block">Conversations</p>
        <Link
          href="/lab"
          onClick={() => setOpen(false)}
          className={`flex h-11 shrink-0 items-center gap-1.5 rounded-brand border px-3 text-sm transition-colors md:h-9 lg:h-8 lg:text-xs ${active ? "border-line text-muted hover:border-faint hover:text-fg" : "border-brand/50 bg-brand-soft text-brand-text"}`}
        >
          <span aria-hidden>+</span> New
        </Link>
      </div>
      <nav className={`${open ? "grid" : "hidden"} max-h-[50vh] gap-0.5 overflow-y-auto rounded-[12px] border border-line bg-surface p-1 lg:grid lg:max-h-[calc(80vh-120px)] lg:border-0 lg:bg-transparent lg:p-0`}>
        {list.length === 0 && <p className="px-3 py-2 text-xs text-faint">Nothing yet. Start one at the table.</p>}
        {list.map((t) => {
          const on = t.id === active;
          return (
            <Link
              key={t.id}
              href={`/lab?t=${t.id}`}
              onClick={() => setOpen(false)}
              aria-current={on ? "page" : undefined}
              className={`relative grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] py-2 pl-3.5 md:min-h-0 pr-3 text-sm transition-colors ${on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg"}`}
            >
              {on && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand" aria-hidden />}
              <span className="truncate">{t.title}</span>
              <span className="tabular text-[11px] text-faint">{ago(t.updatedAt)}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function Dots() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-current animate-[ai-pulse_1.2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 180}ms` }} />
      ))}
    </span>
  );
}

/** A seat composing its message, or the whole table while it works out who answers. */
function Typing({ seat, mood }: { seat: Seat | "table"; mood: { level: "quick" | "standard" | "deep"; research: boolean } | null }) {
  const table = mood?.level === "deep" ? (mood.research ? "The table is checking the market and the web…" : "The table is thinking this through…") : mood?.level === "quick" ? "Quick one: the table is answering…" : "The table is reading this…";
  return (
    <div className="flex items-center gap-3 animate-[step-in_.25s_ease-out]" aria-live="polite">
      {seat === "table" ? (
        <span className="flex -space-x-2">
          {(Object.keys(SEATS) as Seat[]).slice(0, 3).map((s) => (
            <span key={s} className="rounded-full ring-2 ring-surface">
              <SeatMark seat={s} size={26} />
            </span>
          ))}
        </span>
      ) : (
        <span className="relative">
          <span className="absolute -inset-1 rounded-full opacity-40 blur-md" style={{ background: SEATS[seat].tint }} aria-hidden />
          <span className="relative block">
            <SeatMark seat={seat} />
          </span>
        </span>
      )}
      <span className="flex items-center gap-2.5 rounded-[14px] rounded-tl-[4px] border border-line bg-bg/60 px-3.5 py-2.5 text-xs text-faint" style={seat === "table" ? undefined : { color: SEATS[seat].tint }}>
        <Dots />
        <span className="text-faint">{seat === "table" ? table : `${SEATS[seat].name} is ${mood?.level === "deep" ? "thinking it through" : "typing"}…`}</span>
        {mood && (
          <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-faint">
            {mood.level === "deep" ? `Deep${mood.research ? " · web" : ""}` : mood.level === "quick" ? "Quick" : "Considered"}
          </span>
        )}
      </span>
    </div>
  );
}

function ToolButton({ children, icon, onClick, on }: { children: React.ReactNode; icon: string; onClick: () => void; on: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs md:h-7 ${on ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={icon} />
      </svg>
      {children}
    </button>
  );
}

function SharedChip({ kind, title, url, failed, onRemove }: { kind: string; title: string; url: string | null; failed?: boolean; onRemove?: () => void }) {
  const label = SHARE_KINDS[kind as Attachment["kind"]] ?? "Shared";
  const host = url ? url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : null;
  const inner = (
    <>
      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[10px] font-semibold ${kind === "video" ? "bg-[#ff3b30]/15 text-[#ff6b60]" : "bg-surface-2 text-muted"}`}>
        {kind === "video" ? "▶" : kind === "link" ? "↗" : "¶"}
      </span>
      <span className="min-w-0">
        <span className="block max-w-[220px] truncate text-xs">{title || host || label}</span>
        <span className={`block text-[10px] ${failed ? "text-bad" : "text-faint"}`}>{failed ? "Couldn't read it" : host && title ? `${label} · ${host}` : label}</span>
      </span>
    </>
  );
  return (
    <span className="flex items-center gap-2 rounded-[10px] border border-line bg-bg py-1.5 pl-1.5 pr-2.5">
      {url && !onRemove ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2">
          {inner}
        </a>
      ) : (
        inner
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} className="ml-1 text-faint hover:text-fg" aria-label="Remove">
          ×
        </button>
      )}
    </span>
  );
}

/** Everything shared with the table, across conversations: it reads all of it every time. */
function SharedMemory({ sources }: { sources: LabSource[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const reading = sources.some((s) => s.status === "reading");
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [reading, router]);
  const shown = open ? sources : sources.slice(0, 4);
  return (
    <div className="grid gap-2">
      <p className="px-1 text-[11px] uppercase tracking-[0.14em] text-faint">The table remembers</p>
      <div className="grid gap-1">
        {shown.map((s) => (
          <div key={s.id} className="group flex items-start gap-2 rounded-[10px] px-2 py-1.5 hover:bg-surface-2/60" title={s.summary ?? undefined}>
            <span className="mt-0.5 text-[10px] text-faint">{s.kind === "video" ? "▶" : s.kind === "link" ? "↗" : "¶"}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-muted">{s.title}</span>
              {s.status !== "ready" && <span className={`block text-[10px] ${s.status === "failed" ? "text-bad" : "text-brand-text"}`}>{s.status === "failed" ? "Couldn't read it" : "Reading…"}</span>}
            </span>
            <button
              onClick={async () => {
                if (!confirm(`Forget "${s.title}"? The table won't read it again.`)) return;
                await deleteSource(s.id);
                router.refresh();
              }}
              className="text-[10px] text-faint opacity-0 hover:text-bad group-hover:opacity-100"
            >
              Forget
            </button>
          </div>
        ))}
      </div>
      {sources.length > 4 && (
        <button onClick={() => setOpen(!open)} className="w-fit px-2 text-[11px] text-faint hover:text-fg">
          {open ? "Show less" : `All ${sources.length}`}
        </button>
      )}
    </div>
  );
}

function ProposalCard({ t, clients, duplicate, onStart }: { t: ProposedTest; clients: LabClientRow[]; duplicate: LabTest | null; onStart: () => void }) {
  const names = t.clientIds.map((id) => clients.find((c) => c.id === id)?.name).filter(Boolean);
  return (
    <div className="grid gap-3 rounded-[14px] border border-brand/30 md:ml-10 bg-[linear-gradient(135deg,rgba(178,30,44,0.10),transparent_60%)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-brand-text">Proposed test</span>
        <span className="text-xs text-faint">
          {METRIC_LABEL[t.metric]} · aim {Math.round(t.targetLift * 100)}% better
        </span>
      </div>
      <p className="font-heading text-lg leading-snug">{t.title}</p>
      <p className="text-sm text-muted">{t.hypothesis}</p>
      <p className="text-sm">
        <span className="text-faint">What changes: </span>
        {t.change}
      </p>
      <p className="text-xs text-faint">A win: {t.success}</p>
      {names.length > 0 && <p className="text-xs text-muted">On: {names.join(", ")}</p>}
      {duplicate ? (
        <div className="rounded-[10px] border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Already in the lab: &ldquo;{duplicate.title}&rdquo; ({duplicate.status === "lost" ? "flopped" : duplicate.status}).{t.duplicateWhy ? ` ${t.duplicateWhy}` : ""}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button onClick={onStart} className="h-11 rounded-brand bg-fg px-4 text-sm font-medium text-bg md:h-9">
          {duplicate ? "Run it anyway…" : "Set up the test…"}
        </button>
      </div>
    </div>
  );
}

function ClientPicker({ clients, chosen, setChosen, tests, exclude }: { clients: LabClientRow[]; chosen: string[]; setChosen: (ids: string[]) => void; tests: LabTest[]; exclude?: string }) {
  const [q, setQ] = useState("");
  const busy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tests) if (t.status === "running" && t.id !== exclude) for (const c of t.clients) m.set(c.id, [...(m.get(c.id) ?? []), t.title]);
    return m;
  }, [tests, exclude]);
  const term = q.trim().toLowerCase();
  const list = clients
    .filter((c) => !term || c.name.toLowerCase().includes(term) || c.industry?.toLowerCase().includes(term))
    .sort((a, b) => Number(chosen.includes(b.id)) - Number(chosen.includes(a.id)) || b.spend30 - a.spend30);
  return (
    <div className="grid gap-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client or industry" className="h-11 md:h-9 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint" />
      <div className="grid max-h-64 gap-0.5 overflow-y-auto rounded-[10px] border border-line p-1">
        {list.map((c) => {
          const on = chosen.includes(c.id);
          const also = busy.get(c.id);
          return (
            <label key={c.id} className={`flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 text-sm ${on ? "bg-surface-2" : "hover:bg-surface-2/50"}`}>
              <input type="checkbox" checked={on} onChange={() => setChosen(on ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="block truncate text-[11px] text-faint">
                  {c.industry ?? "Industry not set"} · {money(c.spend30)} in 30 days
                </span>
                {also && <span className="block truncate text-[11px] text-warn">Already testing: {also.join(", ")}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A dialog on wider screens; a bottom sheet on a phone, its last child (the actions) pinned at the bottom. */
function Sheet({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return createPortal(
    <div className="fixed inset-0 z-50 grid items-end bg-black/70 backdrop-blur-sm md:place-items-center md:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`grid max-h-[92dvh] w-full gap-4 overflow-y-auto overscroll-contain rounded-t-[20px] border-t border-line bg-bg px-5 pt-5 animate-[sheet-up_.28s_cubic-bezier(.2,.8,.2,1)] md:max-h-[92vh] md:animate-none md:rounded-[18px] md:border md:p-5 ${wide ? "md:max-w-[720px]" : "md:max-w-[560px]"}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** The dialog's buttons: pinned to the bottom of the sheet on a phone, clear of the home indicator. */
const SHEET_ACTIONS = "sticky bottom-0 -mx-5 flex flex-wrap gap-2 border-t border-line bg-bg/95 px-5 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:static md:mx-0 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none";

function StartDialog({ t, clients, tests, threadId, onClose, existing }: { t: ProposedTest; clients: LabClientRow[]; tests: LabTest[]; threadId: string | null; onClose: () => void; existing?: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(t.clientIds);
  const [days, setDays] = useState(14);
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (start: boolean) =>
    act(async () => {
      setError(null);
      const r = existing ? await startTest(existing, chosen, days) : await createTest({ ...t, clientIds: chosen, threadId, days, start });
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    });
  return (
    <Sheet onClose={onClose}>
      <div className="grid gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-brand-text">Set up the test</p>
        <p className="font-heading text-xl leading-snug">{t.title}</p>
        <p className="text-sm text-muted">{t.change}</p>
      </div>
      <ClientPicker clients={clients} chosen={chosen} setChosen={setChosen} tests={tests} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-faint">Read it after</span>
        {[7, 14, 21, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`h-10 rounded-full px-3 text-xs md:h-8 ${days === d ? "bg-fg text-bg" : "border border-line text-muted"}`}>
            {d} days
          </button>
        ))}
      </div>
      <p className="text-xs text-faint">
        Starting takes each client&apos;s last 14 days as the baseline. The strategist writes each client&apos;s brief for the test as a suggestion on Home, so a person approves it before anything is made.
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className={SHEET_ACTIONS}>
        <button onClick={() => go(true)} disabled={busy || !chosen.length} className="h-11 rounded-brand bg-brand px-5 text-sm font-medium text-white disabled:opacity-40 md:h-10">
          {busy ? "Starting…" : `Start on ${chosen.length} ${chosen.length === 1 ? "client" : "clients"}`}
        </button>
        {!existing && (
          <button onClick={() => go(false)} disabled={busy} className="h-11 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-10">
            Keep as an idea
          </button>
        )}
        <button onClick={onClose} className="h-11 px-3 text-sm text-faint hover:text-fg md:h-10">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

function Tests({ tests, clients }: { tests: LabTest[]; clients: LabClientRow[] }) {
  const groups: [LabTest["status"], string, string][] = [
    ["running", "Running", "Live on clients now"],
    ["proposed", "Ideas", "Saved from the table, not started"],
    ["won", "Won", "Deploy the learning to every client it fits"],
    ["lost", "Flopped", "Take it back to the table and iterate"],
  ];
  if (!tests.length)
    return (
      <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
        <p className="font-medium">No tests yet</p>
        <p className="max-w-sm text-sm text-muted">Talk an idea through at the round table. When it&apos;s ready, the table proposes a test you can start on the clients it fits.</p>
      </div>
    );
  return (
    <div className="grid gap-8">
      {groups.map(([status, title, hint]) => {
        const list = tests.filter((t) => t.status === status);
        if (!list.length) return null;
        return (
          <section key={status} className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 md:flex-nowrap">
              <h2 className="font-heading text-xl">
                {title} <span className="text-faint">{list.length}</span>
              </h2>
              <span className="text-xs text-faint">{hint}</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {list.map((t) => (
                <TestCard key={t.id} t={t} clients={clients} tests={tests} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const STATUS_TONE: Record<LabTest["status"], string> = { running: "bg-brand-soft text-brand-text", proposed: "bg-surface-2 text-muted", won: "bg-ok-soft text-ok", lost: "bg-bad-soft text-bad" };
const STATUS_LABEL: Record<LabTest["status"], string> = { running: "Running", proposed: "Idea", won: "Won", lost: "Flopped" };

function TestCard({ t, clients, tests }: { t: LabTest; clients: LabClientRow[]; tests: LabTest[] }) {
  const router = useRouter();
  const [calling, setCalling] = useState<null | "won" | "lost">(null);
  const [note, setNote] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [deploy, setDeploy] = useState<{ learning: string; clients: { id: string; why: string }[] } | null>(null);
  const name = (id: string) => clients.find((c) => c.id === id)?.name ?? "Client";

  const total = t.startedAt && t.endsAt ? Date.parse(t.endsAt) - Date.parse(t.startedAt) : 0;
  const [now] = useState(() => Date.now());
  const progress = total && t.startedAt ? Math.min(1, (now - Date.parse(t.startedAt)) / total) : 0;
  const daysLeft = t.endsAt ? Math.ceil((Date.parse(t.endsAt) - now) / 86_400_000) : null;
  const changes = t.clients.map((c) => c.change).filter((x): x is number => x != null);
  const avg = changes.length ? Math.round((changes.reduce((a, b) => a + b, 0) / changes.length) * 10) / 10 : null;
  const deployAvg = (() => {
    const xs = t.deployed.map((d) => d.change).filter((x): x is number => x != null);
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
  })();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    act(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong.");
      after?.();
      router.refresh();
    });

  return (
    <article className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <span className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
            <span className="text-xs text-faint">{METRIC_LABEL[t.metric]}</span>
          </span>
          <p className="font-heading text-lg leading-snug">{t.title}</p>
        </div>
        {avg != null && t.status !== "proposed" && (
          <span className={`tabular shrink-0 text-right font-display text-2xl ${avg < 0 ? "text-ok" : avg > 0 ? "text-bad" : "text-muted"}`}>
            {pct(avg)}
            <span className="block font-sans text-[10px] text-faint">cost per result</span>
          </span>
        )}
      </div>
      <p className="text-sm text-muted">{t.hypothesis}</p>
      <p className="text-sm">
        <span className="text-faint">Changes: </span>
        {t.change}
      </p>

      {t.status === "running" && total > 0 && (
        <div className="grid gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-[11px] text-faint">{daysLeft != null && daysLeft > 0 ? `${daysLeft} days to read it` : "Ready to read"}</p>
        </div>
      )}

      {t.clients.length > 0 && t.status !== "proposed" && (
        <div className="overflow-hidden rounded-[10px] border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface-2/60 text-faint">
              <tr>
                <th className="px-3 py-1.5 text-left font-normal">Client</th>
                <th className="px-2 py-1.5 text-right font-normal">Before</th>
                <th className="px-2 py-1.5 text-right font-normal">{t.status === "running" ? "Now" : "After"}</th>
                <th className="px-3 py-1.5 text-right font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              {t.clients.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="max-w-[160px] truncate px-3 py-1.5">{name(c.id)}</td>
                  <td className="tabular px-2 py-1.5 text-right text-muted">{money(c.before?.cpr)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{money(c.now?.cpr)}</td>
                  <td className={`tabular px-3 py-1.5 text-right ${c.change == null ? "text-faint" : c.change < 0 ? "text-ok" : "text-bad"}`}>{pct(c.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(t.briefs.waiting > 0 || t.briefs.approved > 0) && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {t.briefs.waiting > 0 && (
            <Link href="/pipeline" className="text-brand-text hover:underline">
              {t.briefs.waiting} {t.briefs.waiting === 1 ? "brief" : "briefs"} waiting on Home
            </Link>
          )}
          {t.briefs.approved > 0 && <span>· {t.briefs.approved} approved</span>}
          {t.briefs.tickets.map((n) => (
            <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 py-0.5 hover:border-faint">
              #{n}
            </Link>
          ))}
        </p>
      )}

      {t.verdict && <p className="rounded-[10px] bg-bg px-3 py-2 text-sm text-muted">&ldquo;{t.verdict}&rdquo;</p>}

      {t.status === "won" && t.deployed.length > 0 && (
        <div className="grid gap-1 rounded-[12px] border border-ok/30 bg-ok/[0.07] p-3">
          <p className="text-sm">{t.learning}</p>
          <p className="text-xs text-muted">
            In {t.deployed.length} {t.deployed.length === 1 ? "client's" : "clients'"} memory
            {deployAvg != null && (
              <>
                {" · "}
                <span className={deployAvg < 0 ? "text-ok" : "text-bad"}>{pct(deployAvg)} cost per result since</span>
              </>
            )}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}

      {calling ? (
        <div className="grid gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder={calling === "won" ? "What happened? (e.g. cheaper leads on 3 of 4, held for two weeks)" : "Why do you think it flopped?"}
            className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint"
          />
          <div className="flex gap-2">
            <button onClick={() => run(() => decideTest(t.id, calling === "won", note), () => setCalling(null))} disabled={busy} className="h-11 md:h-9 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-50">
              {busy ? "Saving…" : calling === "won" ? "Call it a win" : "Call it a flop"}
            </button>
            <button onClick={() => setCalling(null)} className="h-11 md:h-9 px-3 text-sm text-faint">
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          {t.status === "proposed" && (
            <>
              <button onClick={() => setStarting(true)} className="h-11 md:h-9 rounded-brand bg-fg px-4 text-sm text-bg">
                Start…
              </button>
              <button onClick={() => run(() => dropTest(t.id))} disabled={busy} className="h-11 md:h-9 px-3 text-sm text-faint hover:text-bad">
                Drop
              </button>
            </>
          )}
          {t.status === "running" && (
            <>
              <button onClick={() => setCalling("won")} className="h-11 md:h-9 rounded-brand border border-ok/50 px-4 text-sm text-ok hover:bg-ok/10">
                It won
              </button>
              <button onClick={() => setCalling("lost")} className="h-11 md:h-9 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                It flopped
              </button>
            </>
          )}
          {t.status === "won" && (
            <button onClick={() => run(async () => { const r = await draftDeploy(t.id); if (r.ok) setDeploy({ learning: r.learning, clients: r.clients }); return r; })} disabled={busy} className="h-11 md:h-9 rounded-brand bg-ok px-4 text-sm font-medium text-white disabled:opacity-60">
              {busy ? "Finding where it fits…" : t.deployed.length ? "Deploy to more clients" : "Deploy the learning"}
            </button>
          )}
          {t.status === "lost" && (
            <button onClick={() => act(async () => { const r = await iterateTest(t.id); if (!r.ok) return setError(r.error); router.push(`/lab?t=${r.threadId}`); })} disabled={busy} className="h-11 md:h-9 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-60">
              {busy ? "The table is thinking…" : "Iterate with the table"}
            </button>
          )}
          {t.threadId && (
            <Link href={`/lab?t=${t.threadId}`} className="grid h-11 md:h-9 place-items-center px-3 text-sm text-faint hover:text-fg">
              Conversation
            </Link>
          )}
        </div>
      )}

      {starting && (
        <StartDialog
          t={{ title: t.title, hypothesis: t.hypothesis, change: t.change, metric: t.metric, success: t.success, targetLift: t.targetLift, clientIds: t.clients.map((c) => c.id), duplicateOf: null, duplicateWhy: "" }}
          clients={clients}
          tests={tests}
          threadId={t.threadId}
          existing={t.id}
          onClose={() => setStarting(false)}
        />
      )}
      {deploy && <DeployDialog t={t} draft={deploy} clients={clients} onClose={() => setDeploy(null)} />}
    </article>
  );
}

function DeployDialog({ t, draft, clients, onClose }: { t: LabTest; draft: { learning: string; clients: { id: string; why: string }[] }; clients: LabClientRow[]; onClose: () => void }) {
  const router = useRouter();
  const [learning, setLearning] = useState(draft.learning);
  const [chosen, setChosen] = useState<string[]>(draft.clients.map((c) => c.id));
  const [more, setMore] = useState(false);
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const why = new Map(draft.clients.map((c) => [c.id, c.why]));
  return (
    <Sheet onClose={onClose} wide>
      <div className="grid gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-ok">Deploy the learning</p>
        <p className="font-heading text-xl">{t.title}</p>
      </div>
      <label className="grid gap-1.5">
        <span className="text-xs text-faint">The learning, as every agent will read it in client memory</span>
        <textarea value={learning} onChange={(e) => setLearning(e.target.value)} rows={3} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm outline-none" />
      </label>
      <div className="grid gap-2">
        <p className="text-xs text-faint">Where it fits (the tested clients get it too)</p>
        {draft.clients.length === 0 && !more && <p className="text-sm text-muted">The table didn&apos;t find other clients it clearly fits. Add some by hand if you know better.</p>}
        {!more &&
          draft.clients.map((c) => {
            const on = chosen.includes(c.id);
            return (
              <label key={c.id} className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2 text-sm ${on ? "border-ok/40 bg-ok/[0.06]" : "border-line"}`}>
                <input type="checkbox" className="mt-1" checked={on} onChange={() => setChosen(on ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])} />
                <span>
                  {clients.find((x) => x.id === c.id)?.name}
                  <span className="block text-xs text-muted">{why.get(c.id)}</span>
                </span>
              </label>
            );
          })}
        {more ? (
          <ClientPicker clients={clients} chosen={chosen} setChosen={setChosen} tests={[]} />
        ) : (
          <button onClick={() => setMore(true)} className="w-fit text-xs text-muted hover:text-fg">
            + Choose from every client
          </button>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className={SHEET_ACTIONS}>
        <button
          onClick={() =>
            act(async () => {
              setError(null);
              const r = await deployLearning(t.id, learning, chosen);
              if (!r.ok) return setError(r.error);
              onClose();
              router.refresh();
            })
          }
          disabled={busy}
          className="h-11 rounded-brand bg-ok px-5 text-sm font-medium text-white disabled:opacity-50 md:h-10"
        >
          {busy ? "Deploying…" : `Deploy to ${new Set([...chosen, ...t.clients.map((c) => c.id)]).size} clients`}
        </button>
        <button onClick={onClose} className="h-11 px-3 text-sm text-faint hover:text-fg md:h-10">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
