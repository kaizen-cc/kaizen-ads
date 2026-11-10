"use client";

import { useEffect, useState } from "react";
import { connectHref, connectionsHref } from "@/lib/connectors/shared";
import type { ConnectCard, ConnectorConfirmCard, ToolRun } from "@/lib/kaizen-ai/types";
import { cancelConnectorAction, chatConnectors, setThreadConnectors, type ChatConnector } from "./connector-actions";

// Connectors in the chat: the composer's connections menu (switch each connected service on or off for this chat),
// the steps a connector's tools took (expandable: input and result), the Connect card, and the Run / Cancel card a
// tool that changes something waits on.

/** Run on a confirm card: Kaizen AI sends the confirmation as the next message (see kaizen-ai.tsx) */
export const RUN_EVENT = "kz-connector-run";
export type RunDetail = { id: string; text: string };

export function ConnectorIcon({ name, url, size = 28 }: { name: string; url: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)} className="shrink-0 rounded-[8px] bg-surface-2 object-contain" style={{ width: size, height: size }} />;
  return (
    <span className="grid shrink-0 place-items-center rounded-[8px] bg-brand-soft font-semibold text-brand-text" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const here = () => `${window.location.pathname}${window.location.search}`;

/** Connecting from the chat: the service is switched on in this thread first, so it's on when they come back */
async function connectFromChat(c: { key: string; auth?: string }) {
  const t = new URLSearchParams(window.location.search).get("t");
  if (t) {
    const r = await chatConnectors(t).catch(() => null);
    if (r?.on && !r.on.includes(c.key)) await setThreadConnectors(t, [...r.on, c.key]).catch(() => null);
  }
  window.location.href = c.auth === "token" ? connectionsHref(c.key) : connectHref(c.key, here());
}

// ─── Steps ─────────────────────────────────────────────────────────────────

export function ConnectorSteps({ runs }: { runs: ToolRun[] }) {
  if (!runs.length) return null;
  return (
    <div className="grid gap-1.5">
      {runs.map((r) => (
        <details key={r.id} className="group overflow-hidden rounded-[14px] border border-line bg-surface open:shadow-sm">
          <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 text-[13px] ${r.ok === false ? "text-bad" : "text-muted"} [&::-webkit-details-marker]:hidden`}>
            {r.ok === null ? (
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-brand border-t-transparent" aria-hidden />
            ) : r.ok ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="shrink-0 text-ok" aria-hidden>
                <path d="M5 12l5 5L20 7" />
              </svg>
            ) : (
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-bad-soft text-[10px] font-bold text-bad" aria-hidden>
                !
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              <span className="text-fg">{r.ok === null ? r.label : r.label.replace(/…$/, "")}</span>
              {r.summary ? <span className="text-faint"> · {r.summary}</span> : null}
            </span>
            {r.input || r.output ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-faint transition group-open:rotate-180" aria-hidden>
                <path d="M6 9l6 6 6-6" />
              </svg>
            ) : null}
          </summary>
          {r.input || r.output ? (
            <div className="grid gap-2 border-t border-line/70 px-3 py-2.5">
              {r.input ? (
                <div className="grid gap-1">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Input</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-ink/[0.04] px-2.5 py-2 text-[12px] leading-relaxed text-fg/90">{r.input}</pre>
                </div>
              ) : null}
              {r.output ? (
                <div className="grid gap-1">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Result</p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-ink/[0.04] px-2.5 py-2 text-[12px] leading-relaxed text-fg/90">{r.output}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </details>
      ))}
    </div>
  );
}

// ─── Cards ─────────────────────────────────────────────────────────────────

export function ConnectCardView({ c }: { c: ConnectCard }) {
  const [going, setGoing] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-surface px-4 py-3">
      <ConnectorIcon name={c.name} url={null} size={36} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-[14px] font-semibold text-fg">{c.reconnect ? `Reconnect ${c.name}` : `Connect ${c.name}`}</p>
        <p className="text-[12.5px] text-muted">{c.reason}</p>
      </div>
      <button
        type="button"
        disabled={going}
        onClick={() => {
          setGoing(true);
          void connectFromChat(c);
        }}
        className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50"
      >
        {going ? "Opening…" : c.reconnect ? "Reconnect" : "Connect"}
      </button>
    </div>
  );
}

export function ConfirmCardView({ c }: { c: ConnectorConfirmCard }) {
  const [status, setStatus] = useState(c.status);
  const [err, setErr] = useState<string | null>(null);
  const pending = status === "pending";
  return (
    <section className="overflow-hidden rounded-[18px] border border-line bg-surface">
      <header className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
        <ConnectorIcon name={c.name} url={null} size={30} />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-fg">{c.summary || `Run ${c.tool}`}</p>
          <p className="text-[12px] text-faint">
            {c.name} · {c.tool.replace(/[_-]+/g, " ")}
          </p>
        </div>
        {!pending ? <span className={`rounded-full px-2.5 py-1 text-[11.5px] ${status === "approved" ? "bg-ok-soft text-fg" : "bg-surface-2 text-muted"}`}>{status === "approved" ? "Confirmed" : "Cancelled"}</span> : null}
      </header>
      <details className="group px-4 py-2">
        <summary className="flex min-h-10 cursor-pointer list-none items-center text-[12.5px] text-muted [&::-webkit-details-marker]:hidden">Exactly what it will send</summary>
        <pre className="mb-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-ink/[0.04] px-2.5 py-2 text-[12px] leading-relaxed text-fg/90">{pretty(c.input)}</pre>
      </details>
      {pending ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line/70 px-4 py-3">
          {err ? <p className="mr-auto text-[12.5px] text-bad">{err}</p> : <p className="mr-auto text-[12.5px] text-faint">Nothing changes in {c.name} until you press Run.</p>}
          <button
            type="button"
            onClick={async () => {
              setStatus("cancelled");
              const r = await cancelConnectorAction(c.id);
              if (!r.ok) {
                setStatus("pending");
                setErr(r.error);
              }
            }}
            className="min-h-11 rounded-full px-4 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus("approved");
              window.dispatchEvent(new CustomEvent<RunDetail>(RUN_EVENT, { detail: { id: c.id, text: `Run it: ${c.summary || c.tool}` } }));
            }}
            className="min-h-11 rounded-full bg-brand px-5 text-[13px] font-medium text-white transition hover:bg-brand-hover"
          >
            Run
          </button>
        </div>
      ) : null}
    </section>
  );
}

const pretty = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

// ─── The composer's connections menu ───────────────────────────────────────

/**
 * The plug button and its menu. For a thread, switches are saved on the thread; before the first message they're kept
 * here (draft) and sent with it. null = never set: every connected service is on.
 */
export function ConnectorsMenu({ threadId, draft, onDraft }: { threadId: string | null; draft: string[] | null; onDraft: (keys: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChatConnector[] | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void chatConnectors(threadId)
      .then((r) => {
        if (gone) return;
        setItems(r.items);
        setSaved(r.on);
      })
      .catch(() => !gone && setItems([]));
    return () => {
      gone = true;
    };
  }, [threadId]);

  if (!items?.length) return null;
  const connected = items.filter((i) => i.state === "connected").map((i) => i.key);
  const list = threadId ? saved : draft;
  const on = connected.filter((k) => (list ?? connected).includes(k));
  const toggle = async (k: string) => {
    const next = on.includes(k) ? on.filter((x) => x !== k) : [...on, k];
    setErr(null);
    if (!threadId) return onDraft(next);
    const before = saved;
    setSaved(next);
    const r = await setThreadConnectors(threadId, next);
    if (!r.ok) {
      setSaved(before);
      setErr(r.error);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Connections${on.length ? `, ${on.length} on` : ""}`}
        className={`relative grid h-11 w-11 place-items-center rounded-full transition hover:bg-ink/[0.05] hover:text-fg ${on.length ? "text-fg" : "text-muted"}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
        </svg>
        {on.length ? <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[9.5px] font-semibold text-white">{on.length}</span> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} aria-label="Close" />
          <div className="absolute bottom-full left-0 z-40 mb-2 grid w-[min(320px,calc(100vw-32px))] gap-0.5 rounded-[18px] border border-line bg-surface p-1.5 shadow-2xl">
            <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Connections in this chat</p>
            {items.map((i) => {
              const isOn = on.includes(i.key);
              return i.state === "connected" ? (
                <button
                  key={i.key}
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  onClick={() => void toggle(i.key)}
                  className="flex min-h-12 items-center gap-3 rounded-[12px] px-3 text-left hover:bg-ink/[0.05]"
                >
                  <ConnectorIcon name={i.name} url={i.icon_url} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-[13.5px] text-fg">{i.name}</span>
                    {i.note ? <span className="truncate text-[11.5px] text-faint">{i.note}</span> : null}
                  </span>
                  <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${isOn ? "bg-brand" : "bg-ink/[0.15]"}`} aria-hidden>
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${isOn ? "left-[18px]" : "left-0.5"}`} />
                  </span>
                </button>
              ) : (
                <div key={i.key} className="flex min-h-12 items-center gap-3 rounded-[12px] px-3">
                  <ConnectorIcon name={i.name} url={i.icon_url} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-[13.5px] text-fg">{i.name}</span>
                    <span className="truncate text-[11.5px] text-faint">{i.state === "reconnect" ? "Sign in expired" : "Not connected"}</span>
                  </span>
                  <button type="button" onClick={() => void connectFromChat(i)} className="min-h-10 shrink-0 rounded-full border border-line px-3 text-[12.5px] text-fg hover:border-brand/40">
                    {i.state === "reconnect" ? "Reconnect" : "Connect"}
                  </button>
                </div>
              );
            })}
            {err ? <p className="px-3 py-1 text-[12px] text-bad">{err}</p> : null}
            <a href={connectionsHref()} className="mt-1 flex min-h-11 items-center rounded-[12px] border-t border-line/70 px-3 text-[12.5px] text-muted hover:bg-ink/[0.05] hover:text-fg">
              Manage connections
            </a>
          </div>
        </>
      ) : null}
    </div>
  );
}
