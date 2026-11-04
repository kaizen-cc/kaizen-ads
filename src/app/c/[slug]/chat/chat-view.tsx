"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatFile, ChatMessage, ChatReaction } from "@/lib/portal-chat";
import { createClient } from "@/lib/supabase/client";
import { closeParams, pushParams, useParam } from "@/lib/url-state";

// The client's team chat, like a messaging app: our team on the left, them on the right, day by day, with threads,
// pictures, videos and files. It reads itself every few seconds while it's on screen, loads older history as they
// scroll up, and sends what they write into their Slack channel with Kaizen (under their name). A team member opening
// a client's portal sees it exactly as the client does, without the box to write in (the team answers in Slack).

type Props = { slug: string; brand: string; me: string; team: boolean; hasChannel: boolean; slackLink: string | null; /** Docked beside a page (the floating chat): fills its panel, threads open over it */ compact?: boolean; onClose?: () => void };
type Pending = { id: string; text: string; files: string[]; thread: string | null; error?: string };
type Read = { channel: boolean; messages: ChatMessage[]; hasMore?: boolean; canPost: boolean; canReact?: boolean; team: boolean; error?: string };
type ReactFn = ((ts: string, name: string, on: boolean) => Promise<void>) | null;

/** The reactions the portal offers (Slack's names), and how they look */
const QUICK: [string, string][] = [["+1", "👍"], ["heart", "❤️"], ["joy", "😂"], ["tada", "🎉"], ["raised_hands", "🙌"], ["eyes", "👀"], ["white_check_mark", "✅"], ["fire", "🔥"]];

async function sendReaction(slug: string, ts: string, name: string, on: boolean) {
  const res = await fetch(`/api/portal-chat/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "react", ts, name, on }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't react.");
}

const POLL = 4000;

async function read(slug: string, q: Record<string, string>) {
  const res = await fetch(`/api/portal-chat/${slug}?${new URLSearchParams(q)}`, { cache: "no-store" });
  const body = (await res.json().catch(() => ({ error: "The chat couldn't load right now." }))) as Read;
  if (!res.ok) throw new Error(body.error ?? "The chat couldn't load right now.");
  return body;
}

/** The newest page from the server replaces what we had from its first message on (edits, deletions, reply counts) */
function merge(had: ChatMessage[], page: ChatMessage[]) {
  if (!page.length) return had;
  const from = page[0]!.ts;
  return [...had.filter((m) => m.ts < from), ...page];
}

export function ChatView({ slug, brand, me, team, hasChannel, slackLink, compact = false, onClose }: Props) {
  const thread = useParam("thread");
  const [canReact, setCanReact] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [older, setOlder] = useState(false);
  const [below, setBelow] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const keep = useRef<number | null>(null);

  const scrollDown = (smooth = false) => list.current?.scrollTo({ top: list.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });

  const refresh = useCallback(async () => {
    try {
      const r = await read(slug, {});
      setMessages((had) => {
        const next = merge(had, r.messages);
        if (!atBottom.current) {
          const fresh = next.filter((m) => !m.mine && !had.some((h) => h.ts === m.ts)).length;
          if (fresh) setBelow((n) => n + fresh);
        }
        return next;
      });
      setLoaded((was) => {
        if (!was) setHasMore(Boolean(r.hasMore));
        return true;
      });
      setCanReact(Boolean(r.canReact));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The chat couldn't load right now.");
      setLoaded(true);
    }
  }, [slug]);

  // Kept up to date while it's on screen
  useEffect(() => {
    if (!hasChannel) return;
    void refresh();
    const tick = () => document.visibilityState === "visible" && void refresh();
    const t = setInterval(tick, POLL);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [hasChannel, refresh]);

  // New messages keep the view at the bottom (if it was there); older ones loaded above keep the place they were reading
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (keep.current != null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const loadOlder = useCallback(async () => {
    if (older || !hasMore || !messages.length) return;
    setOlder(true);
    try {
      const r = await read(slug, { before: messages[0]!.ts });
      keep.current = (list.current?.scrollHeight ?? 0) - (list.current?.scrollTop ?? 0);
      setMessages((had) => [...r.messages.filter((m) => !had.some((h) => h.ts === m.ts)), ...had]);
      setHasMore(Boolean(r.hasMore) && r.messages.length > 0);
    } catch {
      /* tried again on the next scroll */
    }
    setOlder(false);
  }, [older, hasMore, messages, slug]);

  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && void loadOlder(), { root: list.current, rootMargin: "300px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadOlder]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current && below) setBelow(0);
  };

  const send = async (text: string, files: File[], inThread: string | null) => {
    const id = crypto.randomUUID();
    setPending((p) => [...p, { id, text, files: files.map((f) => f.name), thread: inThread }]);
    atBottom.current = true;
    try {
      await post(slug, text, files, inThread);
      await refresh();
      setPending((p) => p.filter((x) => x.id !== id));
      return true;
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, error: e instanceof Error ? e.message : "Didn't send." } : x)));
      return false;
    }
  };

  const react: ReactFn = canReact
    ? async (ts, name, on) => {
        await sendReaction(slug, ts, name, on).catch((e) => setError(e instanceof Error ? e.message : "Couldn't react."));
        void refresh();
      }
    : null;

  if (!hasChannel)
    return (
      <div className={`grid place-items-center ${compact ? "h-full px-6" : "min-h-[60vh]"}`}>
        <div className="max-w-md text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand/10 text-2xl">💬</span>
          <h1 className="mt-4 font-heading text-2xl">Your team chat is almost here</h1>
          <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{team ? `${brand} has no client Slack channel linked yet. Link it on their client page and this becomes their chat with you.` : "We're setting up your chat with the Kaizen team. As soon as it's ready, everything you'd say to us lives right here."}</p>
          {team && (
            <Link href={`/clients/${slug}?tab=team`} className="mt-5 inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-[14px] font-medium text-bg">
              Connect their Slack channel
            </Link>
          )}
        </div>
      </div>
    );

  const shown = messages;
  return (
    <div className={compact ? "relative flex h-full min-h-0" : "-mx-4 flex h-[calc(100dvh-115px-env(safe-area-inset-bottom))] min-h-[420px] md:-mx-8 lg:mx-0 lg:h-[calc(100dvh-3rem)] lg:gap-4"}>
      <section className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg ${compact ? `lg:bg-surface ${thread ? "hidden" : ""}` : `lg:rounded-[24px] lg:border lg:border-line lg:bg-surface ${thread ? "max-lg:hidden" : ""}`}`}>
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-5">
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close the chat" className="-ml-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:text-fg lg:order-last lg:-mr-2 lg:ml-0">
              <span className="text-[20px] leading-none lg:hidden">←</span>
              <span className="hidden text-[22px] leading-none lg:inline">×</span>
            </button>
          )}
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand font-heading text-[15px] text-white">K</span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[16px] leading-tight">Kaizen × {brand}</p>
            <p className="truncate text-[12px] text-faint">{team ? "What the client sees. Reply in Slack." : "Your team, all in one place"}</p>
          </div>
          {slackLink && !compact && (
            <a href={slackLink} target="_blank" rel="noreferrer" className="inline-flex min-h-10 shrink-0 items-center rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg">
              {team ? "Open in Slack ↗" : "Prefer Slack? ↗"}
            </a>
          )}
        </header>

        <div ref={list} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-5">
          <div ref={top} />
          {older && <p className="py-2 text-center text-[12px] text-faint">Loading earlier messages…</p>}
          {!hasMore && loaded && shown.length > 0 && <p className="py-3 text-center text-[12px] text-faint">The start of your chat with Kaizen</p>}
          {!loaded && <Skeleton />}
          {loaded && !shown.length && !pending.length && !error && (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <p className="font-heading text-[18px]">Say hello 👋</p>
                <p className="mt-1 text-[13.5px] text-muted">{team ? "Nothing in this channel yet." : "Ask anything, share files and screenshots. Your team sees it right away."}</p>
              </div>
            </div>
          )}
          <Messages slug={slug} messages={shown} onThread={(ts) => pushParams({ thread: ts })} react={react} />
          {pending
            .filter((p) => !p.thread)
            .map((p) => (
              <PendingBubble key={p.id} p={p} me={me} onDismiss={() => setPending((x) => x.filter((y) => y.id !== p.id))} />
            ))}
          {error && <p className="mt-3 rounded-[12px] bg-bad-soft px-3 py-2 text-center text-[12.5px] text-bad">{error}</p>}
        </div>

        {below > 0 && (
          <button
            type="button"
            onClick={() => {
              setBelow(0);
              scrollDown(true);
            }}
            className="absolute bottom-24 left-1/2 min-h-10 -translate-x-1/2 rounded-full bg-fg px-4 text-[12.5px] font-medium text-bg shadow-lg"
          >
            {below} new {below === 1 ? "message" : "messages"} ↓
          </button>
        )}

        {team ? (
          <p className="border-t border-line px-4 py-3 text-center text-[12.5px] text-faint">You&rsquo;re seeing the client&rsquo;s view. Answer them in Slack and it shows here.</p>
        ) : (
          <Composer onSend={(t, f) => send(t, f, null)} placeholder={`Message the Kaizen team`} />
        )}
      </section>

      {thread && <Thread slug={slug} ts={thread} me={me} team={team} compact={compact} react={react} pending={pending.filter((p) => p.thread === thread)} onSend={(t, f) => send(t, f, thread)} />}
    </div>
  );
}

// ─── Sending ───

async function post(slug: string, text: string, files: File[], thread: string | null) {
  let paths: { path: string; name: string; mime: string }[] = [];
  if (files.length) {
    const res = await fetch(`/api/portal-chat/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "slots", files: files.map((f) => ({ name: f.name, bytes: f.size, mime: f.type })) }) });
    const body = (await res.json()) as { slots?: { path: string; token: string }[]; error?: string };
    if (!res.ok || !body.slots) throw new Error(body.error ?? "Couldn't upload. Try again.");
    const supabase = createClient();
    for (let i = 0; i < files.length; i++) {
      const { error } = await supabase.storage.from("client-docs").uploadToSignedUrl(body.slots[i]!.path, body.slots[i]!.token, files[i]!, { contentType: files[i]!.type || "application/octet-stream" });
      if (error) throw new Error(`${files[i]!.name} didn't upload. Try again.`);
    }
    paths = files.map((f, i) => ({ path: body.slots![i]!.path, name: f.name, mime: f.type }));
  }
  const res = await fetch(`/api/portal-chat/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, thread, paths }) });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Didn't send. Try again.");
}

function Composer({ onSend, placeholder }: { onSend: (text: string, files: File[]) => Promise<boolean>; placeholder: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const add = (list: FileList | File[]) => setFiles((f) => [...f, ...Array.from(list)].slice(0, 6));
  const go = async () => {
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    const t = text;
    const f = files;
    setText("");
    setFiles([]);
    const ok = await onSend(t, f);
    if (!ok) {
      setText(t);
      setFiles(f);
    }
    setBusy(false);
  };
  return (
    <div className="border-t border-line bg-bg px-3 pb-3 pt-2 lg:bg-surface">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 text-[12px]">
              <span className="truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted hover:text-fg">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-[22px] border border-line bg-surface px-2 py-1.5 focus-within:border-brand-text/50">
        <button type="button" onClick={() => pick.current?.click()} aria-label="Attach files" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
          </svg>
        </button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => e.target.files && add(e.target.files)} />
        <textarea
          data-chat
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void go();
            }
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              add(pasted);
            }
          }}
          placeholder={placeholder}
          className="min-h-11 flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-snug outline-none placeholder:text-faint md:text-[15px]"
        />
        <button type="button" onClick={() => void go()} disabled={busy || (!text.trim() && !files.length)} aria-label="Send" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-white transition-opacity disabled:opacity-40">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14 M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── A thread: beside the chat on a computer, the whole screen on a phone ───

function Thread({ slug, ts, me, team, compact, react, pending, onSend }: { slug: string; ts: string; me: string; team: boolean; compact: boolean; react: ReactFn; pending: Pending[]; onSend: (t: string, f: File[]) => Promise<boolean> }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      read(slug, { thread: ts })
        .then((r) => live && setMessages(r.messages))
        .catch(() => live && setMessages((m) => m ?? []));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), POLL);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [slug, ts, nonce]);
  // A reaction in the thread: read the thread again right after
  const reactHere: ReactFn = react ? (t, name, on) => react(t, name, on).then(() => setNonce((n) => n + 1)) : null;
  useLayoutEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages, pending]);
  return (
    <aside className={compact ? "absolute inset-0 z-10 flex flex-col bg-bg lg:bg-surface" : "fixed inset-0 z-40 flex flex-col bg-bg lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:overflow-hidden lg:rounded-[24px] lg:border lg:border-line lg:bg-surface"}>
      <header className={`flex items-center gap-2 border-b border-line px-2 py-2 lg:px-4 ${compact ? "" : "pt-safe"}`}>
        <button type="button" onClick={() => closeParams("thread")} aria-label="Back to the chat" className={`grid h-11 w-11 place-items-center rounded-full text-muted hover:text-fg ${compact ? "" : "lg:hidden"}`}>
          ←
        </button>
        <p className="flex-1 font-heading text-[16px]">Thread</p>
        {!compact && (
          <button type="button" onClick={() => closeParams("thread")} aria-label="Close the thread" className="hidden h-10 w-10 place-items-center rounded-full text-muted hover:text-fg lg:grid">
            ×
          </button>
        )}
      </header>
      <div ref={box} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-4">
        {messages == null ? <Skeleton /> : <Messages slug={slug} messages={messages} inThread react={reactHere} />}
        {pending.map((p) => (
          <PendingBubble key={p.id} p={p} me={me} />
        ))}
      </div>
      {!team && <Composer onSend={onSend} placeholder="Reply in the thread" />}
      {!compact && <div className="pb-[env(safe-area-inset-bottom)] lg:hidden" />}
    </aside>
  );
}

// ─── Messages ───

const dayOf = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function Messages({ slug, messages, onThread, inThread, react = null }: { slug: string; messages: ChatMessage[]; onThread?: (ts: string) => void; inThread?: boolean; react?: ReactFn }) {
  return (
    <div className="grid gap-0.5">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || dayOf(prev.at) !== dayOf(m.at);
        // The same person within a few minutes: one group, one name and picture
        const grouped = !newDay && prev && prev.author === m.author && prev.side === m.side && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000 && !prev.replyCount;
        const right = m.side === "client";
        return (
          <Fragment key={m.ts}>
            {newDay && (
              <div className="my-3 flex items-center gap-3">
                <span className="h-px flex-1 bg-line" />
                <span className="text-[11.5px] font-medium text-faint">{dayLabel(m.at)}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <div className={`flex items-end gap-2 ${right ? "flex-row-reverse" : ""} ${grouped ? "mt-0.5" : "mt-3"}`}>
              <span className="w-8 shrink-0">{!grouped && <Avatar name={m.author} src={m.avatar} team={m.side === "team"} />}</span>
              <div className={`flex min-w-0 max-w-[82%] flex-col md:max-w-[68%] ${right ? "items-end" : "items-start"}`}>
                {!grouped && (
                  <p className={`mb-1 flex items-baseline gap-2 px-1 text-[12px] ${right ? "flex-row-reverse" : ""}`}>
                    <span className="font-medium text-fg">{m.mine ? "You" : m.author}</span>
                    {m.side === "team" && <span className="text-[10.5px] uppercase tracking-[0.12em] text-brand-text">Kaizen</span>}
                    <span className="text-faint">{timeOf(m.at)}</span>
                  </p>
                )}
                {m.text.trim() && (
                  <div className={`whitespace-pre-wrap break-words rounded-[18px] px-3.5 py-2.5 text-[14.5px] leading-relaxed ${right ? (m.mine ? "rounded-br-[6px] bg-brand text-white" : "rounded-br-[6px] bg-ink/[0.08]") : "rounded-bl-[6px] border border-line bg-surface lg:bg-surface-2"}`}>
                    <RichText text={m.text} light={right && m.mine} />
                    {m.edited && <span className={`ml-1.5 text-[11px] ${right && m.mine ? "text-white/70" : "text-faint"}`}>(edited)</span>}
                  </div>
                )}
                {m.files.length > 0 && (
                  <div className={`mt-1 grid gap-1.5 ${right ? "justify-items-end" : ""}`}>
                    {m.files.map((f) => (
                      <FileView key={f.id} slug={slug} f={f} />
                    ))}
                  </div>
                )}
                {(m.reactions.length > 0 || react) && <Reactions key={JSON.stringify(m.reactions)} ts={m.ts} list={m.reactions} react={react} right={right} />}
                {!inThread && m.replyCount > 0 && onThread && (
                  <button type="button" onClick={() => onThread(m.ts)} className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-[12.5px] font-medium text-brand-text hover:bg-brand/10">
                    {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
                    {m.latestReply && <span className="font-normal text-faint">· {timeOf(new Date(Number(m.latestReply) * 1000).toISOString())}</span>}
                  </button>
                )}
                {!inThread && !m.replyCount && onThread && (
                  <button type="button" onClick={() => onThread(m.ts)} className="mt-0.5 inline-flex min-h-8 items-center rounded-full px-2 text-[11.5px] text-faint opacity-80 hover:text-fg">
                    Reply
                  </button>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A message's reactions: each emoji with its count, theirs highlighted. Tapping one of the portal's reactions adds or
 * takes off theirs (it shows in Slack as from the Kaizen app); the + opens the few the portal offers.
 */
function Reactions({ ts, list: initial, react, right }: { ts: string; list: ChatReaction[]; react: ReactFn; right: boolean }) {
  const [list, setList] = useState(initial);
  const [picking, setPicking] = useState(false);
  const quick = new Map(QUICK);
  const toggle = (name: string) => {
    if (!react || !quick.has(name)) return;
    const had = list.find((r) => r.name === name);
    const on = !had?.mine;
    // Shown at once; the next read brings Slack's own counts
    setList((l) => {
      const x = l.find((r) => r.name === name);
      if (!x) return [...l, { name, emoji: quick.get(name) ?? null, count: 1, mine: true }];
      return l.map((r) => (r.name === name ? { ...r, mine: on, count: Math.max(0, r.count + (on ? 1 : -1)) } : r)).filter((r) => r.count > 0);
    });
    setPicking(false);
    void react(ts, name, on);
  };
  return (
    <div className={`relative mt-1 flex flex-wrap items-center gap-1 ${right ? "justify-end" : ""}`}>
      {list.map((r) => (
        <button
          key={r.name}
          type="button"
          disabled={!react || !quick.has(r.name)}
          onClick={() => toggle(r.name)}
          title={r.mine ? "You reacted (shows in Slack as from the Kaizen app)" : undefined}
          className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2 text-[12.5px] transition-colors disabled:cursor-default ${r.mine ? "border-brand/50 bg-brand/10 text-fg" : "border-line bg-surface text-muted enabled:hover:border-faint"}`}
        >
          <span className="text-[14px] leading-none">{r.emoji ?? `:${r.name}:`}</span>
          <span className="tabular">{r.count}</span>
        </button>
      ))}
      {react && (
        <button type="button" onClick={() => setPicking((p) => !p)} aria-label="Add a reaction" aria-expanded={picking} className="grid h-8 w-8 place-items-center rounded-full text-[14px] text-faint opacity-70 hover:bg-surface-2 hover:text-fg hover:opacity-100">
          ☺<span className="sr-only">+</span>
        </button>
      )}
      {picking && react && (
        <div className={`absolute top-full z-20 mt-1 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-lg ${right ? "right-0" : "left-0"}`}>
          {QUICK.map(([name, e]) => (
            <button key={name} type="button" onClick={() => toggle(name)} aria-label={name.replace(/_/g, " ")} className="grid h-10 w-10 place-items-center rounded-full text-[19px] hover:bg-surface-2">
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ name, src, team }: { name: string; src: string | null; team: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  // Slack's own pictures are public; ours (the initials) come from our own route
  if (src && /^https:\/\//.test(src))
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-8 w-8 rounded-full object-cover" loading="lazy" />;
  return <span className={`grid h-8 w-8 place-items-center rounded-full text-[11.5px] font-semibold ${team ? "bg-brand text-white" : "bg-surface-2 text-muted"}`}>{initials || "?"}</span>;
}

/** Slack's links (<url|label>, <url>), bare links and *bold*, safely: text nodes only, links checked to be http(s) */
function RichText({ text, light }: { text: string; light: boolean }) {
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const parts: React.ReactNode[] = [];
  const re = /<(https?:\/\/[^|>\s]+)(?:\|([^>]+))?>|(https?:\/\/[^\s<]+)|\*([^*\n]+)\*/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(decode(text.slice(last, m.index)));
    const href = m[1] ?? m[3];
    if (href)
      parts.push(
        <a key={k++} href={decode(href)} target="_blank" rel="noreferrer noopener" className={`underline underline-offset-2 ${light ? "text-white" : "text-brand-text"}`}>
          {decode(m[2] ?? href)}
        </a>,
      );
    else parts.push(<b key={k++}>{decode(m[4]!)}</b>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(decode(text.slice(last)));
  return <>{parts}</>;
}

const sizeOf = (b: number) => (b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);

function FileView({ slug, f }: { slug: string; f: ChatFile }) {
  const src = `/api/portal-chat/${slug}/file/${encodeURIComponent(f.id)}`;
  if (f.kind === "image")
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[16px] border border-line bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${src}?thumb=1`} alt={f.name} loading="lazy" className="max-h-[320px] w-auto max-w-full object-contain" style={f.w && f.h ? { aspectRatio: `${f.w} / ${f.h}` } : undefined} />
      </a>
    );
  if (f.kind === "video")
    return (
      <video src={src} controls playsInline preload="metadata" className="max-h-[360px] max-w-full rounded-[16px] border border-line bg-black" style={f.w && f.h ? { aspectRatio: `${f.w} / ${f.h}` } : undefined} />
    );
  return (
    <a href={`${src}?download=1`} className="flex min-h-12 max-w-[280px] items-center gap-3 rounded-[14px] border border-line bg-surface px-3 py-2 hover:border-faint">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand/10 text-[11px] font-semibold uppercase text-brand-text">{(f.name.split(".").pop() ?? "file").slice(0, 4)}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px]">{f.name}</span>
        <span className="block text-[11.5px] text-faint">{sizeOf(f.size)} · Download</span>
      </span>
    </a>
  );
}

function PendingBubble({ p, me, onDismiss }: { p: Pending; me: string; onDismiss?: () => void }) {
  return (
    <div className="mt-3 flex flex-row-reverse items-end gap-2">
      <span className="w-8 shrink-0" />
      <div className="flex max-w-[82%] flex-col items-end md:max-w-[68%]">
        <p className="mb-1 px-1 text-[12px] text-faint">{p.error ? "Didn't send" : "Sending…"}</p>
        {p.text.trim() && <div className={`whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] px-3.5 py-2.5 text-[14.5px] ${p.error ? "border border-bad/40 bg-bad-soft text-fg" : "bg-brand/70 text-white"}`}>{p.text}</div>}
        {p.files.map((f) => (
          <span key={f} className="mt-1 rounded-full border border-line px-3 py-1 text-[12px] text-muted">
            📎 {f}
          </span>
        ))}
        {p.error && (
          <p className="mt-1 flex items-center gap-2 px-1 text-[12px] text-bad">
            {p.error}
            {onDismiss && (
              <button type="button" onClick={onDismiss} className="min-h-8 underline">
                Dismiss
              </button>
            )}
          </p>
        )}
        <span className="sr-only">{me}</span>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-4 py-2" aria-hidden>
      {[60, 40, 72, 50].map((w, i) => (
        <div key={i} className={`flex items-end gap-2 ${i % 2 ? "flex-row-reverse" : ""}`}>
          <span className="h-8 w-8 animate-pulse rounded-full bg-surface-2" />
          <span className="h-12 animate-pulse rounded-[18px] bg-surface-2" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
