"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { disconnectAction, offerFromRegistry, savePersonalTokenAction } from "@/app/(team)/settings/connector-actions";
import { connectHref } from "@/lib/connectors/shared";
import type { ConnectCard, ConnectorConfirmCard, ToolRun } from "@/lib/kaizen-ai/types";
import { closeParams, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { browseConnectors, cancelConnectorAction, chatConnectors, requestConnector, setThreadConnectors, type BrowseItem, type ChatConnector } from "./connector-actions";

// Connectors in the chat: the composer's plug menu (switch each connected service on or off for this chat, Connect,
// Manage connectors, and Browse connectors with Request to enable), the steps a connector's tools took (expandable:
// input and result), the Connect card, and the Run / Cancel card a tool that changes something waits on.

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

/** This chat's address without the menu's own params, so the sign in comes back to the chat itself */
const here = () => {
  const u = new URL(window.location.href);
  for (const k of ["connectors", "connector", "cq", "connected", "connect_error"]) u.searchParams.delete(k);
  return `${u.pathname}${u.search}`;
};

/**
 * Connecting from the chat: the service is switched on in this thread first, so it's on when they come back from the
 * service's sign in (the same chat). A token connector opens Manage connectors on it to paste the token instead.
 */
async function connectFromChat(c: { key: string; auth?: string }) {
  if (c.auth === "token") return pushParams({ connectors: "manage", connector: c.key, cq: null });
  const t = new URLSearchParams(window.location.search).get("t");
  if (t) {
    const r = await chatConnectors(t).catch(() => null);
    if (r?.on && !r.on.includes(c.key)) await setThreadConnectors(t, [...r.on, c.key]).catch(() => null);
  }
  window.location.href = connectHref(c.key, here());
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

// ─── The composer's plug menu ──────────────────────────────────────────────

const SWITCH = (on: boolean) => (
  <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${on ? "bg-brand" : "bg-ink/[0.15]"}`} aria-hidden>
    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
  </span>
);
const Chevron = ({ dir = "right" }: { dir?: "right" | "left" }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={dir === "right" ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
  </svg>
);
const Spinner = () => <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />;
const smallBtn = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-3.5 text-[12.5px] font-medium transition disabled:opacity-40";
const closeMenu = () => closeParams("connectors", "connector", "cq");
const since = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : null);

/**
 * The plug button and its menu, like Claude's: the connectors enabled for this person's role, each with a switch for
 * this chat once connected, or Connect. Manage connectors (reconnect, replace a token, disconnect) and Browse
 * connectors (the whole Directory) are one tap away. Where it's open lives in the address (?connectors=open|manage|
 * browse), so back closes it. For a thread, switches are saved on the thread; before the first message they're kept
 * here (draft) and sent with it. null = never set: every connected service is on.
 */
export function ConnectorsMenu({ threadId, draft, onDraft }: { threadId: string | null; draft: string[] | null; onDraft: (keys: string[] | null) => void }) {
  const view = useParam("connectors");
  const focus = useParam("connector");
  const [items, setItems] = useState<ChatConnector[] | null>(null);
  const [isExec, setIsExec] = useState(false);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let gone = false;
    void chatConnectors(threadId)
      .then((r) => {
        if (gone) return;
        setItems(r.items);
        setSaved(r.on);
        setIsExec(r.isExec);
      })
      .catch(() => !gone && setItems([]));
    return () => {
      gone = true;
    };
  }, [threadId, tick]);

  const list = items ?? [];
  const connected = list.filter((i) => i.state === "connected").map((i) => i.key);
  const chosen = threadId ? saved : draft;
  const on = connected.filter((k) => (chosen ?? connected).includes(k));
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
  const open = view === "open" || view === "manage";
  // Browse is a full-screen sheet: drawn on the page itself (never inside the composer), once in the browser
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? closeMenu() : pushParams({ connectors: "open" }))}
        aria-expanded={open}
        aria-label={`Connectors${on.length ? `, ${on.length} on` : ""}`}
        className={`relative grid h-11 w-11 place-items-center rounded-full transition hover:bg-ink/[0.05] hover:text-fg ${on.length ? "text-fg" : "text-muted"}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
        </svg>
        {on.length ? <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[9.5px] font-semibold text-white">{on.length}</span> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-30 cursor-default" onClick={closeMenu} aria-label="Close" tabIndex={-1} />
          <div
            role="dialog"
            aria-label={view === "manage" ? "Manage connectors" : "Connectors"}
            className="absolute bottom-full left-0 z-40 mb-2 grid max-h-[min(560px,70dvh)] w-[min(360px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[20px] border border-line bg-surface shadow-2xl"
          >
            {view === "manage" ? (
              <ManageView items={list} focus={focus} reload={() => setTick((t) => t + 1)} />
            ) : (
              <>
                <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">Connectors in this chat</p>
                <div className="grid content-start gap-0.5 overflow-y-auto px-1.5 pb-1">
                  {items === null ? (
                    <p className="flex min-h-12 items-center gap-2 px-3 text-[12.5px] text-muted">
                      <Spinner />
                      Loading…
                    </p>
                  ) : !list.length ? (
                    <p className="px-3 py-3 text-[12.5px] leading-relaxed text-muted">
                      {isExec ? "Nothing is enabled for the team yet. Browse connectors to enable one." : "Nothing is enabled for your role yet. Browse connectors to ask for one."}
                    </p>
                  ) : null}
                  {list.map((i) => {
                    const isOn = on.includes(i.key);
                    const ring = focus === i.key ? "ring-2 ring-brand/40" : "";
                    return i.state === "connected" ? (
                      <button
                        key={i.key}
                        type="button"
                        role="switch"
                        aria-checked={isOn}
                        onClick={() => void toggle(i.key)}
                        className={`flex min-h-12 items-center gap-3 rounded-[12px] px-2.5 text-left hover:bg-ink/[0.05] ${ring}`}
                      >
                        <ConnectorIcon name={i.name} url={i.icon_url} />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-[13.5px] text-fg">{i.name}</span>
                          {i.note ? <span className="truncate text-[11.5px] text-faint">{i.note}</span> : null}
                        </span>
                        {SWITCH(isOn)}
                      </button>
                    ) : (
                      <div key={i.key} className={`flex min-h-12 items-center gap-3 rounded-[12px] px-2.5 ${ring}`}>
                        <ConnectorIcon name={i.name} url={i.icon_url} />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-[13.5px] text-fg">{i.name}</span>
                          <span className={`truncate text-[11.5px] ${i.state === "reconnect" ? "text-bad" : "text-faint"}`}>{i.state === "reconnect" ? "Sign in expired" : "Not connected"}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void connectFromChat(i)}
                          className={`${smallBtn} ${focus === i.key ? "bg-brand text-white hover:bg-brand-hover" : "border border-line text-fg hover:border-brand/40"}`}
                        >
                          {i.state === "reconnect" ? "Reconnect" : "Connect"}
                        </button>
                      </div>
                    );
                  })}
                  {err ? <p className="px-3 py-1 text-[12px] text-bad">{err}</p> : null}
                </div>
                <div className="grid gap-0.5 border-t border-line/70 p-1.5">
                  {list.length ? (
                    <button type="button" onClick={() => replaceParams({ connectors: "manage", connector: null })} className="flex min-h-11 items-center gap-3 rounded-[12px] px-2.5 text-left text-[13px] text-fg hover:bg-ink/[0.05]">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="text-muted" aria-hidden>
                        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                        <circle cx="16" cy="7" r="2" />
                        <circle cx="10" cy="17" r="2" />
                      </svg>
                      <span className="flex-1">Manage connectors</span>
                      <Chevron />
                    </button>
                  ) : null}
                  <button type="button" onClick={() => replaceParams({ connectors: "browse", connector: null })} className="flex min-h-11 items-center gap-3 rounded-[12px] px-2.5 text-left text-[13px] text-fg hover:bg-ink/[0.05]">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-muted" aria-hidden>
                      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
                      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
                      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
                      <path d="M16.75 14v5.5M14 16.75h5.5" strokeLinecap="round" />
                    </svg>
                    <span className="flex-1">Browse connectors</span>
                    <Chevron />
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
      {view === "browse" && inBrowser ? createPortal(<BrowseSheet onChanged={() => setTick((t) => t + 1)} />, document.body) : null}
    </div>
  );
}

/** Manage connectors: reconnect, replace a token or disconnect, one connector at a time */
function ManageView({ items, focus, reload }: { items: ChatConnector[]; focus: string | null; reload: () => void }) {
  const [openKey, setOpenKey] = useState<string | null>(focus);
  return (
    <>
      <header className="flex items-center gap-1 border-b border-line/70 px-1.5 py-1.5">
        <button type="button" onClick={() => replaceParams({ connectors: "open", connector: null })} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Back">
          <Chevron dir="left" />
        </button>
        <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">Manage connectors</p>
      </header>
      <ul className="grid content-start gap-0.5 overflow-y-auto p-1.5">
        {items.map((i) => (
          <ManageRow key={i.key} i={i} open={openKey === i.key} onOpen={() => setOpenKey(openKey === i.key ? null : i.key)} reload={reload} />
        ))}
      </ul>
      <p className="border-t border-line/70 px-4 py-2.5 text-[11.5px] leading-relaxed text-faint">Your sign ins are encrypted and only used in your own chats. Anything that would change something asks you first.</p>
    </>
  );
}

function ManageRow({ i, open, onOpen, reload }: { i: ChatConnector; open: boolean; onOpen: () => void; reload: () => void }) {
  const [pasting, setPasting] = useState(open && i.auth === "token" && i.state !== "connected");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const status =
    i.state === "connected"
      ? [i.since ? `Since ${since(i.since)}` : "Connected", i.last4 ? `ending ${i.last4}` : null, i.tools ? `${i.tools} tools` : null].filter(Boolean).join(" · ")
      : i.state === "reconnect"
        ? (i.error ?? "The sign in stopped working.")
        : "Not connected";
  const saveToken = async () => {
    setBusy(true);
    setErr(null);
    const r = await savePersonalTokenAction(i.key, token).catch(() => ({ ok: false as const, error: "Couldn't save the token." }));
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setToken("");
    setPasting(false);
    reload();
  };
  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    const r = await disconnectAction(i.key).catch(() => ({ ok: false as const, error: "Couldn't disconnect." }));
    setBusy(false);
    setSure(false);
    if (!r.ok) return setErr(r.error);
    reload();
  };
  return (
    <li className={`rounded-[14px] ${open ? "bg-ink/[0.03]" : ""}`}>
      <button type="button" onClick={onOpen} aria-expanded={open} className="flex min-h-12 w-full items-center gap-3 rounded-[14px] px-2.5 text-left hover:bg-ink/[0.04]">
        <ConnectorIcon name={i.name} url={i.icon_url} />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[13.5px] text-fg">{i.name}</span>
          <span className={`truncate text-[11.5px] ${i.state === "reconnect" ? "text-bad" : "text-faint"}`}>{status}</span>
        </span>
        {i.state === "connected" ? (
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok text-white" aria-label="Connected">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12l5 5L20 7" />
            </svg>
          </span>
        ) : null}
        <span className={`shrink-0 text-faint transition ${open ? "rotate-90" : ""}`}>
          <Chevron />
        </span>
      </button>
      {open ? (
        <div className="grid gap-2 px-2.5 pb-2.5">
          {pasting ? (
            <div className="grid gap-2">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder={`Your ${i.name} API token`}
                className="min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none placeholder:text-faint focus:border-brand/50"
              />
              <div className="flex justify-end gap-1.5">
                <button type="button" onClick={() => setPasting(false)} className={`${smallBtn} text-muted hover:bg-ink/[0.05] hover:text-fg`}>
                  Cancel
                </button>
                <button type="button" onClick={() => void saveToken()} disabled={busy || token.trim().length < 8} className={`${smallBtn} bg-brand text-white hover:bg-brand-hover`}>
                  {busy ? "Checking…" : "Save token"}
                </button>
              </div>
            </div>
          ) : sure ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-[12px] bg-bad-soft/40 px-2.5 py-1.5">
              <p className="min-w-0 flex-1 text-[12px] text-fg">Disconnect {i.name}? You can connect again any time.</p>
              <button type="button" onClick={() => setSure(false)} className={`${smallBtn} text-muted hover:text-fg`}>
                Keep
              </button>
              <button type="button" onClick={() => void remove()} disabled={busy} className={`${smallBtn} bg-bad text-white`}>
                {busy ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-1.5">
              {i.state !== "not_connected" ? (
                <button type="button" onClick={() => void remove()} className={`${smallBtn} text-bad hover:bg-bad-soft/40`}>
                  Disconnect
                </button>
              ) : null}
              {i.auth === "token" ? (
                <button type="button" onClick={() => setPasting(true)} className={`${smallBtn} border border-line text-fg hover:border-brand/40`}>
                  {i.state === "not_connected" ? "Paste a token" : "Replace token"}
                </button>
              ) : i.auth !== "none" || i.state === "not_connected" ? (
                <button type="button" onClick={() => void connectFromChat(i)} className={`${smallBtn} ${i.state === "connected" ? "border border-line text-fg hover:border-brand/40" : "bg-brand text-white hover:bg-brand-hover"}`}>
                  {i.state === "not_connected" ? "Connect" : "Reconnect"}
                </button>
              ) : null}
            </div>
          )}
          {err ? <p className="text-[12px] text-bad">{err}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

// ─── Browse connectors ─────────────────────────────────────────────────────

const Verified = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" className="shrink-0 text-brand" role="img" aria-label="Verified vendor">
    <path fill="currentColor" d="M12 1.8l2.4 1.8 3-.2 1 2.8 2.6 1.6-.8 2.9.8 2.9-2.6 1.6-1 2.8-3-.2L12 22.2l-2.4-1.8-3 .2-1-2.8L3 16.2l.8-2.9L3 10.4l2.6-1.6 1-2.8 3 .2z" />
    <path d="M8 12.2l2.7 2.7L16.2 9.4" fill="none" stroke="var(--color-surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Browse connectors: the whole Directory inside Kaizen AI, featured first, searchable (?cq= in the address). Each
 * connector says where it stands: Connected, Connect (enabled for you), Requested, or Request to enable with an
 * optional note. Execs enable it right here instead.
 */
function BrowseSheet({ onChanged }: { onChanged: () => void }) {
  const cq = useParam("cq") ?? "";
  const [text, setText] = useState(cq);
  const [limit, setLimit] = useState(60);
  const [data, setData] = useState<{ items: BrowseItem[]; total: number; ready: boolean; isExec: boolean } | null>(null);
  const [got, setGot] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ref: string; text: string; tone: "ok" | "bad"; link?: { href: string; label: string } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const want = `${cq}\n${limit}\n${tick}`;
  const loading = got !== want;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("keydown", onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = was;
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(() => replaceParams({ cq: text.trim() || null }), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    let live = true;
    void browseConnectors(cq, limit)
      .then((r) => {
        if (!live) return;
        setData(r);
        setErr(null);
      })
      .catch(() => live && setErr("The Directory couldn't load. Try again."))
      .finally(() => live && setGot(want));
    return () => {
      live = false;
    };
  }, [cq, limit, want]);

  const send = async (i: BrowseItem) => {
    setBusy(i.ref);
    const r = await requestConnector(i.ref, note).catch(() => ({ ok: false as const, error: "Couldn't send the request. Try again." }));
    setBusy(null);
    if (!r.ok) return setNotice({ ref: i.ref, text: r.error, tone: "bad" });
    setAsking(null);
    setNote("");
    setNotice({ ref: i.ref, text: "Sent. The execs will hear about it, and you will too once it's enabled.", tone: "ok" });
    setTick((t) => t + 1);
  };
  const enable = async (i: BrowseItem) => {
    setBusy(i.ref);
    const r = await offerFromRegistry(i.ref, []).catch(() => ({ ok: false as const, error: "Couldn't enable it. Try again." }));
    setBusy(null);
    if (r.ok) {
      setNotice({ ref: i.ref, text: `${r.name} is enabled for the team. Connect your own account below.`, tone: "ok" });
      setTick((t) => t + 1);
      return onChanged();
    }
    if ("needsClient" in r && r.needsClient)
      return setNotice({
        ref: i.ref,
        text: `${i.title} needs its own Kaizen AI app first, set up once for the whole team.`,
        tone: "bad",
        link: { href: `/settings?tab=connections&section=team&add=client&app=${encodeURIComponent(i.ref)}&appname=${encodeURIComponent(i.title)}`, label: "Set it up" },
      });
    setNotice({ ref: i.ref, text: r.error, tone: "bad" });
  };

  const items = data?.items ?? [];
  const featured = cq ? [] : items.filter((i) => i.featured);
  const rest = cq ? items : items.filter((i) => !i.featured);
  const row = (i: BrowseItem) => (
    <li key={i.ref} className="grid gap-2 rounded-[16px] border border-line bg-bg/50 p-3 transition hover:border-brand/30">
      <div className="flex items-center gap-3">
        <ConnectorIcon name={i.title} url={i.icon_url} size={40} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-fg">{i.title}</span>
            {i.featured ? <Verified /> : null}
          </p>
          {i.description ? <p className="line-clamp-1 text-[12.5px] text-muted">{i.description}</p> : null}
        </div>
        {i.state === "connected" ? (
          <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-ok-soft/70 px-3 text-[12px] font-medium text-fg">Connected</span>
        ) : i.state === "enabled" ? (
          <button type="button" onClick={() => i.key && void connectFromChat({ key: i.key, auth: i.auth ?? undefined })} className={`${smallBtn} bg-brand text-white hover:bg-brand-hover`}>
            Connect
          </button>
        ) : i.state === "requested" ? (
          <span className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-surface-2 px-3 text-[12px] text-muted">Requested</span>
        ) : i.state === "enable" ? (
          <button type="button" disabled={Boolean(busy)} onClick={() => void enable(i)} className={`${smallBtn} gap-1.5 border border-line text-fg hover:border-brand hover:bg-brand hover:text-white`}>
            {busy === i.ref ? <Spinner /> : null}
            Enable
          </button>
        ) : asking !== i.ref ? (
          <button type="button" onClick={() => {
              setAsking(i.ref);
              setNote("");
              setNotice(null);
            }} className={`${smallBtn} border border-line text-fg hover:border-brand/40`}>
            Request to enable
          </button>
        ) : null}
      </div>
      {asking === i.ref ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(i);
          }}
          className="grid gap-2 sm:pl-[52px]"
        >
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="What you'd use it for (optional)"
            className="w-full rounded-[12px] border border-line bg-surface px-3 py-2.5 text-[14px] text-fg outline-none placeholder:text-faint focus:border-brand/50"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setAsking(null)} className={`${smallBtn} text-muted hover:bg-ink/[0.05] hover:text-fg`}>
              Cancel
            </button>
            <button type="submit" disabled={Boolean(busy)} className={`${smallBtn} gap-1.5 bg-brand text-white hover:bg-brand-hover`}>
              {busy === i.ref ? <Spinner /> : null}
              Send request
            </button>
          </div>
        </form>
      ) : null}
      {notice?.ref === i.ref ? (
        <p className={`flex flex-wrap items-center gap-x-2 text-[12.5px] sm:pl-[52px] ${notice.tone === "bad" ? "text-bad" : "text-muted"}`}>
          {notice.text}
          {notice.link ? (
            <a href={notice.link.href} className="font-medium text-fg underline underline-offset-4">
              {notice.link.label}
            </a>
          ) : null}
        </p>
      ) : null}
    </li>
  );

  return (
    <div className="fixed inset-0 z-50 md:grid md:place-items-center md:p-6" role="dialog" aria-modal aria-label="Browse connectors">
      <button type="button" className="absolute inset-0 hidden bg-deep/50 backdrop-blur-[3px] md:block" onClick={closeMenu} aria-label="Close" tabIndex={-1} />
      <div className="relative flex h-dvh w-full flex-col bg-surface md:h-[min(780px,88dvh)] md:max-w-[880px] md:rounded-[24px] md:border md:border-line md:shadow-2xl">
        <header className="flex items-center gap-1 border-b border-line/70 px-2 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] md:px-4 md:pt-3">
          <button type="button" onClick={() => replaceParams({ connectors: "open", cq: null })} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Back to connectors">
            <Chevron dir="left" />
          </button>
          <h2 className="min-w-0 flex-1 truncate font-heading text-[21px] text-fg">Browse connectors</h2>
          <button type="button" onClick={closeMenu} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="grid gap-2 px-4 pb-3 pt-3 md:px-5">
          <label className="relative block">
            <span className="sr-only">Search connectors</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden>
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4 4" />
            </svg>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              type="search"
              placeholder="Search connectors"
              autoComplete="off"
              className="min-h-11 w-full rounded-[12px] border border-line bg-bg pl-10 pr-3 text-[14px] text-fg outline-none placeholder:text-faint focus:border-brand/50"
            />
          </label>
          <p className="px-1 text-[12px] text-faint">
            {data?.isExec ? "Enable one for the team, then connect your own account." : "Ask for one that isn't enabled for you yet. The execs enable it for the team."}
            {err ? <span className="text-bad"> {err}</span> : null}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {data && !data.ready ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">The Directory needs the latest database update first.</p> : null}
          {!data && loading ? (
            <p className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted">
              <Spinner />
              Loading the Directory…
            </p>
          ) : null}
          {data?.ready && !items.length && !loading ? (
            <div className="grid justify-items-center gap-2 px-6 py-16 text-center">
              <p className="font-heading text-[19px] text-fg">{cq ? "Nothing matches" : "The Directory is empty"}</p>
              <p className="max-w-[420px] text-[13px] text-muted">{cq ? "Try a shorter word." : "It fills in once the registry has been read."}</p>
            </div>
          ) : null}
          {featured.length ? (
            <section className="grid gap-2 pb-4">
              <h3 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Featured</h3>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-2">{featured.map(row)}</ul>
            </section>
          ) : null}
          {rest.length ? (
            <section className="grid gap-2">
              {featured.length ? <h3 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">All connectors</h3> : null}
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-2">{rest.map(row)}</ul>
            </section>
          ) : null}
          {data && items.length < data.total ? (
            <div className="flex justify-center pt-4">
              <button type="button" onClick={() => setLimit((n) => Math.min(600, n + 60))} disabled={loading || limit >= 600} className={`${smallBtn} border border-line px-4 text-fg hover:border-brand/40`}>
                {loading ? "Loading…" : limit >= 600 ? "Search to narrow it down" : "Show more"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
