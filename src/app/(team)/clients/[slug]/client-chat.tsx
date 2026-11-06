"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { requestAudit } from "@/components/audit-watcher";
import { useFabClear } from "@/components/fab-clear";
import type { ChatTurn } from "@/lib/handoff";
import { ALL_PERMS, type ClientPerms } from "@/lib/chat-permissions";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { askClientAi, clearClientAi, loadClientAi, openClientDoc, undoClientDesk } from "./actions";
import { createClient } from "@/lib/supabase/client";
import { Layer } from "./layer";
import { ChatPlan } from "./chat-plan";
import { LaunchCard } from "./launch-card";
import { GoogleLaunchCard } from "./google-launch-card";
import { CHAT_EVENT } from "./launch-more";
import { warmLaunchRead } from "./launch-more-actions";

// The client desk: a button in the corner that opens a drawer, so the page itself doesn't get longer. Ask a question,
// strategize, get a summary, share files and links (filed in the client's documents and read), tell it what to
// remember or change (it updates the knowledge base and says what it did, each with an undo), or run the account
// audit (the same audit as on the KPI board). Each person has their own thread per client, kept between visits.

export type AuditTarget = { id: string; label: string; status: "none" | "queued" | "running" | "ready" | "failed"; auditId: string | null };
/** The KPI card a chat was opened from: launches and changes that don't name a platform go to its account */
export type ChatScope = { platform: "meta" | "google"; targetId?: string | null };

const CHANGE_STARTER = "Pause the ads that spent with no results this week";
const STARTERS = ["Summarize where this account stands", "What should we test next, and why?", "What has the client told us lately?", CHANGE_STARTER, "Launch a new ad group in Google Ads"];
const LAUNCH_STARTERS = { google: "Launch a new ad group in Google Ads", meta: "Launch ads on Meta from a launch sheet" } as const;
const LAUNCH_DRAFT = { google: "Launch in Google Ads: ", meta: "Launch on Meta (I'm sharing the launch sheet): " } as const;
const MAX_FILE = 50 * 1024 * 1024;
const safe = (n: string) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").slice(-120);

async function openDoc(id: string) {
  const url = await openClientDoc(id);
  if (url) window.open(url, "_blank", "noreferrer");
}

const LEVEL = { quick: { label: "Quick answer", dot: "bg-ink/40" }, standard: { label: "Considered", dot: "bg-[#9aa8ff]" }, deep: { label: "Thought it through", dot: "bg-brand" } } as const;

function Bubble({ t, onUndo, launchLatest = true }: { t: ChatTurn; onUndo?: (i: number) => void; launchLatest?: boolean }) {
  const me = t.role === "user";
  return (
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 ${me ? "justify-items-end" : ""}`}>
      {t.attachments && t.attachments.length > 0 && (
        <span className={`flex max-w-[92%] flex-wrap gap-1.5 ${me ? "justify-end" : ""}`}>
          {t.attachments.map((a) => (
            <button key={a.id} type="button" onClick={() => void openDoc(a.id)} className="inline-flex min-h-9 max-md:h-11 max-w-full items-center gap-1.5 truncate rounded-full border border-ink/10 bg-ink/[0.04] px-3 text-[11.5px] text-ink/75 hover:text-fg md:min-h-7" title="Open it (it's in the client's documents)">
              <span aria-hidden>{a.kind === "link" ? "↗" : "📄"}</span>
              <span className="truncate">{a.name}</span>
            </button>
          ))}
        </span>
      )}
      {t.text && <p className={`max-w-[92%] whitespace-pre-wrap rounded-[14px] [overflow-wrap:anywhere] px-3.5 py-2.5 text-[13.5px] leading-relaxed ${me ? "bg-fg text-bg" : "border border-ink/[0.06] bg-ink/[0.04] text-fg"}`}>{t.text}</p>}
      {/* What it changed in the knowledge base, each with an undo */}
      {!me && t.done && t.done.length > 0 && (
        <ul className="grid w-full max-w-[92%] gap-1">
          {t.done.map((d, i) => (
            <li key={i} className={`flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12px] ${d.undone ? "border-ink/[0.05] text-ink/35 line-through" : "border-[#5be3a5]/25 bg-[#5be3a5]/[0.06] text-ink/80"}`}>
              <span className={`mt-0.5 shrink-0 ${d.undone ? "" : "text-[#5be3a5]"}`}>✓</span>
              <span className="min-w-0 flex-1">{d.label}</span>
              {d.undo && !d.undone && onUndo && (
                <button type="button" onClick={() => onUndo(i)} className="-my-1 shrink-0 rounded-full px-2 py-1 text-[11px] text-ink/55 no-underline hover:bg-ink/10 hover:text-fg max-md:min-h-9">
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Where the answer points (the sprint the suggestions went on, the buyer's tasks) */}
      {!me && t.link && (
        <Link href={t.link.href} className="inline-flex min-h-9 w-fit items-center rounded-full border border-ink/10 px-3 text-[12px] text-brand-text hover:border-brand/40 max-md:min-h-11">
          {t.link.label} →
        </Link>
      )}
      {/* A change in the ad account (or the buyer) it planned: check the exact objects, then confirm */}
      {!me && t.plan && <ChatPlan id={t.plan.id} />}
      {/* A launch from a shared launch sheet: the full card on its latest turn, a pointer to it on earlier ones */}
      {!me && t.launch && (t.launch.platform === "google" ? <GoogleLaunchCard id={t.launch.id} compact={!launchLatest} /> : <LaunchCard id={t.launch.id} compact={!launchLatest} />)}
      {!me && t.level && (
        <span className="flex items-center gap-1.5 px-1 text-[10px] text-ink/40">
          <span className={`h-1.5 w-1.5 rounded-full ${LEVEL[t.level].dot}`} />
          {LEVEL[t.level].label}
          {t.researched && " · checked the web"}
        </span>
      )}
    </div>
  );
}

/**
 * floating: the corner button on the client page (the thread comes with the page). inline: a button where it's placed
 * (a KPI card), which loads the thread when opened. Either way it's the same thread, so a conversation started on the
 * KPI board is there on the client page and the other way round.
 */
export function ClientChat({
  clientId,
  client,
  initial,
  targets,
  live,
  variant = "floating",
  scope = null,
  perms = ALL_PERMS,
}: {
  clientId: string;
  client: string;
  initial?: ChatTurn[];
  targets: AuditTarget[];
  live: boolean;
  variant?: "floating" | "inline";
  scope?: ChatScope | null;
  /** What this person may do on this client (src/lib/chat-permissions.ts): the chat only offers what's theirs */
  perms?: ClientPerms;
}) {
  const router = useRouter();
  // Starters: only the ones this person may act on (a change, a launch on their own platform)
  const mayChange = perms.change.meta || perms.change.google;
  const starters = (scope && perms.launch[scope.platform] ? [LAUNCH_STARTERS[scope.platform], ...STARTERS.filter((x) => x !== LAUNCH_STARTERS.google)] : STARTERS).filter(
    (s) => (s !== CHANGE_STARTER || mayChange) && (s !== LAUNCH_STARTERS.google || perms.launch.google) && (s !== LAUNCH_STARTERS.meta || perms.launch.meta),
  );
  const canLaunchHere = Boolean(scope && perms.launch[scope.platform]);
  const mayLaunch = perms.launch.meta || perms.launch.google;
  // On the client page the open chat is in the address (?chat=1), so back closes it and a link opens it. The inline
  // button sits on cards that can share a page, so it keeps its own.
  const floating = variant === "floating";
  // The "Ask about" pill owns the bottom-right corner: the feedback bubble sits above it
  useFabClear(72, floating);
  const inAddress = useParam("chat") === "1";
  const [openHere, setOpenHere] = useState(false);
  const open = floating ? inAddress : openHere;
  const setOpen = (v: boolean) => (!floating ? setOpenHere(v) : v ? pushParams({ chat: "1" }) : closeParams("chat"));
  const [chat, setChat] = useState<ChatTurn[]>(initial ?? []);
  const [loaded, setLoaded] = useState(Boolean(initial));
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    void loadClientAi(clientId).then((turns) => {
      if (!live) return;
      setChat(turns);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [open, loaded, clientId]);
  // Turns added from a launch card (suggest more, do it now) show in the thread at once
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ clientId: string; chat: ChatTurn[] }>).detail;
      if (d?.clientId === clientId && Array.isArray(d.chat)) setChat(d.chat);
    };
    window.addEventListener(CHAT_EVENT, on);
    return () => window.removeEventListener(CHAT_EVENT, on);
  }, [clientId]);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // Go deep: the next answer gets the full model, the market and the web, whatever the question looks like
  const [deep, setDeep] = useState(false);
  const [pendingDeep, setPendingDeep] = useState(false);
  const [slow, setSlow] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);

  // Braces: newer browsers return a promise from scrollIntoView, which React would take for a cleanup
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [chat, pending, open]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (floating) closeParams("chat");
      else setOpenHere(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, floating]);

  // Phones: the drawer fills the visible area, so the box stays right above the keyboard when it opens
  useEffect(() => {
    const v = window.visualViewport;
    const el = panel.current;
    if (!open || !v || !el) return;
    const fit = () => {
      el.style.setProperty("--vvh", `${v.height}px`);
      el.style.setProperty("--vvt", `${v.offsetTop}px`);
    };
    fit();
    v.addEventListener("resize", fit);
    v.addEventListener("scroll", fit);
    return () => {
      v.removeEventListener("resize", fit);
      v.removeEventListener("scroll", fit);
    };
  }, [open]);

  // Files to share with the next message (dropped, picked or pasted)
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (list: File[]) => {
    const ok = list.filter((f) => f.size <= MAX_FILE);
    if (ok.length < list.length) setError("Files over 50 MB were left out.");
    setFiles((cur) => [...cur, ...ok].slice(0, 6));
  };

  const ask = async (text: string) => {
    if ((!text.trim() && !files.length) || pending) return;
    setError(null);
    const sending = files;
    setPending(text || `Shared ${sending.length} file${sending.length === 1 ? "" : "s"}`);
    setPendingDeep(deep);
    setQ("");
    setFiles([]);
    // Past a few seconds it's a question that earned the full treatment: say so
    const t = setTimeout(() => setSlow(true), 7000);
    // Files go straight to the client's folder; the desk files and reads them
    const supabase = createClient();
    const uploaded: { path: string; name: string; mime: string; bytes: number }[] = [];
    for (const f of sending) {
      const path = `${clientId}/${crypto.randomUUID()}-${safe(f.name)}`;
      const { error: e } = await supabase.storage.from("client-docs").upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (!e) uploaded.push({ path, name: f.name, mime: f.type, bytes: f.size });
    }
    const r = await askClientAi(clientId, text, deep, uploaded, scope);
    clearTimeout(t);
    setSlow(false);
    setPending(null);
    setDeep(false);
    if (r.ok) {
      setChat(r.chat);
      if (uploaded.length < sending.length) setError(`${sending.length - uploaded.length} file${sending.length - uploaded.length === 1 ? "" : "s"} didn't upload.`);
      router.refresh();
    } else {
      setError(r.error);
      setQ(text);
      setFiles(sending);
    }
  };
  const undo = async (turnAt: string, i: number) => {
    setChat(await undoClientDesk(clientId, turnAt, i));
    router.refresh();
  };

  const audit = async (t: AuditTarget) => {
    setStarting(t.id);
    await requestAudit({ targetId: t.id }, client);
    setStarting(null);
    router.refresh();
  };

  return (
    <>
      {variant === "inline" ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 max-md:h-11 shrink-0 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:border-brand/50 hover:text-fg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          Ask about {client}
        </button>
      ) : null}
      {variant === "inline" && scope && canLaunchHere && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setQ((cur) => cur || LAUNCH_DRAFT[scope.platform]);
            // The account read starts now, while they type what to launch (Google: Meta's launch is read from its sheet)
            if (scope.platform === "google") void warmLaunchRead(clientId, scope.targetId ?? null).catch(() => undefined);
          }}
          title={`Tell the chat what to launch in ${scope.platform === "google" ? "Google Ads" : "Meta"}, or share the sheet: it asks what it needs, shows every object it will create and deploys it paused when you say so`}
          className="inline-flex h-9 max-md:h-11 shrink-0 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:border-brand/50 hover:text-fg"
        >
          <span aria-hidden>↗</span>
          Launch with the chat
        </button>
      )}
      {variant === "inline" ? null : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-full md:bottom-6 md:right-6 md:max-w-none border border-ink/10 bg-deep-2 py-2.5 pl-3 pr-5 text-sm shadow-[0_20px_50px_-15px_rgba(200,16,46,0.55)] transition duration-300 hover:-translate-y-0.5 hover:border-ink/25 ${open ? "pointer-events-none opacity-0" : ""}`}
      >
        <span className="relative grid h-8 w-8 place-items-center rounded-full bg-brand text-white">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-brand/40 [animation-duration:2.6s]" />
        </span>
        <span className="min-w-0 truncate">Ask about {client}</span>
      </button>
      )}

      <Layer>
      {open && <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />}
      <aside
        ref={panel}
        aria-hidden={!open}
        className={`fixed right-0 top-[var(--vvt,0px)] z-50 grid h-[var(--vvh,100dvh)] w-full grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden bg-deep shadow-[-30px_0_80px_-30px_rgba(0,0,0,0.9)] transition-transform duration-300 ease-out md:inset-y-0 md:h-auto md:max-w-[460px] md:border-l md:border-ink/[0.07] ${open ? "translate-x-0 translate-y-0" : "pointer-events-none translate-y-full md:translate-x-full md:translate-y-0"}`}
      >
        <span aria-hidden className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-[rgba(200,16,46,0.35)] blur-[90px]" />
        <header className="relative flex items-start justify-between gap-3 px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top))] md:px-5 md:pt-5">
          <div className="grid min-w-0 gap-1">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink/50">Client desk</p>
            <h2 className="font-display text-2xl leading-tight tracking-tight [overflow-wrap:anywhere]">{client}</h2>
            <p className="text-xs text-ink/50">
              Ask anything, share files and links (they&apos;re filed in the client&apos;s documents), tell it what to remember
              {mayChange ? `, ask for a change in the ${perms.change.meta && perms.change.google ? "ad account" : perms.change.meta ? "Meta account" : "Google Ads account"}` : ""}
              {mayLaunch
                ? `, or launch something new: ${perms.launch.google ? "tell it what to launch in Google Ads, or drop " : "drop "}${perms.launch.meta && perms.launch.google ? "a launch sheet or keyword sheet" : perms.launch.meta ? "a launch sheet" : "a keyword sheet"} (it shows exactly what it will create or touch for you to confirm).`
                : "."}
            </p>
          </div>
          <span className="flex shrink-0 gap-1.5">
            {chat.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  await clearClientAi(clientId);
                  setChat([]);
                }}
                className="h-11 rounded-full border border-ink/10 px-3.5 text-xs text-ink/55 hover:text-fg md:h-8 md:px-3"
              >
                New chat
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full border border-ink/10 text-lg text-ink/55 hover:text-fg md:h-8 md:w-8 md:text-base">
              ×
            </button>
          </span>
        </header>

        {/* The account audit, the same one as on the KPI board */}
        <div className="relative mx-4 mb-3 grid gap-2 rounded-[14px] md:mx-5 border border-ink/[0.07] bg-ink/[0.03] p-3">
          {targets.length === 0 ? (
            <p className="text-xs text-ink/50">An audit needs a KPI with an ad account. Set one on the KPI board.</p>
          ) : (
            targets.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3">
                <span className="grid min-w-0">
                  <span className="truncate text-[13px]">Audit · {t.label}</span>
                  <span className="text-[11px] text-ink/45">
                    {t.status === "running" ? "Running now, follow it on the page" : t.status === "queued" ? "Queued for a free slot" : t.status === "ready" ? "Last audit ready" : t.status === "failed" ? "The last one didn't finish" : "Never audited"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {/* Opening the audit is the main thing; running it again is a quiet text link (or the button when there's nothing to open) */}
                  {(() => {
                    const canOpen = Boolean(t.auditId && t.status === "ready");
                    const off = !live || starting === t.id || t.status === "running" || t.status === "queued";
                    const label = starting === t.id ? "Starting…" : t.status === "none" ? "Run an audit" : "Run again";
                    return canOpen ? (
                      <>
                        <button type="button" disabled={off} onClick={() => audit(t)} className="min-h-10 px-1 text-[11.5px] text-ink/50 underline-offset-2 hover:text-fg hover:underline disabled:opacity-40 md:min-h-8">
                          {label}
                        </button>
                        <Link href={`/kpis/audit/${t.auditId}`} className="grid h-10 place-items-center rounded-full bg-fg px-4 text-xs font-medium text-bg md:h-8">
                          Open the audit
                        </Link>
                      </>
                    ) : (
                      <button type="button" disabled={off} onClick={() => audit(t)} className="h-10 rounded-full bg-fg px-3 text-xs text-bg disabled:opacity-40 md:h-8">
                        {label}
                      </button>
                    );
                  })()}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="relative grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-2 md:px-5">
          {!loaded && <p className="animate-pulse text-xs text-ink/50">Loading your conversation about {client}…</p>}
          {loaded && !chat.length && !pending && (
            <div className="grid gap-2">
              {starters.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="min-h-11 rounded-[12px] border border-ink/[0.08] px-3.5 py-2.5 text-left text-[13px] md:min-h-0 text-ink/70 transition-colors hover:border-brand/50 hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          )}
          {chat.map((t, i) => (
            <Bubble key={i} t={t} onUndo={t.role === "assistant" ? (n) => void undo(t.at, n) : undefined} launchLatest={!t.launch || !chat.slice(i + 1).some((x) => x.launch?.id === t.launch?.id)} />
          ))}
          {pending && (
            <>
              <Bubble t={{ role: "user", text: pending, at: "" }} />
              <p className="flex items-center gap-2 text-xs text-ink/50">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                {pendingDeep ? "Thinking it through · checking the market and the web…" : pending.startsWith("Shared ") || slow ? "Reading what you shared…" : "Reading the account…"}
              </p>
            </>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
          <div ref={end} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            addFiles([...e.dataTransfer.files]);
          }}
          className={`relative grid gap-2 border-t px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 transition-colors md:p-4 ${over ? "border-brand/60 bg-brand/[0.08]" : "border-ink/[0.07]"}`}
        >
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink/10 bg-ink/[0.05] py-1 pl-3 pr-1 text-[11.5px] text-ink/80">
                  <span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="grid h-7 max-md:h-11 w-7 max-md:w-11 place-items-center rounded-full text-ink/50 hover:bg-ink/10 hover:text-fg md:h-5 md:w-5">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {over && <p className="text-center text-xs text-ink/70">Drop to share with the desk: it&apos;s filed in the client&apos;s documents and read</p>}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setDeep((d) => !d)}
              aria-pressed={deep}
              title="The full model, the client's market and a web search for this answer"
              className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[11px] transition-colors md:h-7 md:px-3 ${deep ? "bg-brand text-white shadow-[0_6px_20px_-8px_rgba(200,16,46,0.9)]" : "border border-ink/10 text-ink/55 hover:text-white"}`}
            >
              <span aria-hidden>✦</span>
              Go deep
            </button>
            <span className="min-w-0 text-right text-[10px] text-ink/35 md:text-left">{deep ? "Full model, the market and the web for this one" : "Quick questions get quick answers; big ones get the full treatment"}</span>
          </div>
          <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            aria-label="Share a file"
            title="Share files (PDF, Word, PowerPoint, Excel, text, pictures): filed in the client's documents and read"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-ink/10 text-ink/60 hover:border-ink/25 hover:text-fg"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
            </svg>
          </button>
          <textarea data-chat
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(q);
              }
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            rows={2}
            placeholder="Ask, make a change, paste a link or drop a file…"
            className="min-h-[46px] min-w-0 flex-1 resize-none rounded-[12px] border border-ink/10 bg-ink/[0.03] px-3 py-2.5 text-[13.5px] outline-none placeholder:text-ink/35 focus:border-brand/50"
          />
          <button type="submit" disabled={(!q.trim() && !files.length) || Boolean(pending)} className="h-11 shrink-0 rounded-full bg-fg px-5 text-sm text-bg disabled:opacity-40">
            {files.length && !q.trim() ? "Share" : "Send"}
          </button>
          </div>
        </form>
      </aside>
      </Layer>
    </>
  );
}
