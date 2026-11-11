"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectorIcon } from "@/app/(team)/ai/connectors-ui";
import type { RequestGroup } from "@/lib/connectors/requests-core";
import { appSetupFor, appStepText, AUTH_KINDS, browseHref, chatConnectHref, connectionsHref, keyFrom, type AuthKind, type Connector } from "@/lib/connectors/shared";
import { ROLES } from "@/lib/roles";
import { closeThen, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { addCustomConnector, checkConnectorUrl, declineRequest, deleteConnector, directory, enableRequest, markCatalogSeen, offerFromRegistry, saveConnector, type DirectoryItem } from "./connector-actions";

// Connectors, laid out like Claude's organization settings. Execs enable connectors for the team: the team's requests
// (Enable or Decline), Enable connector (the Directory of verified servers, or a custom connector from a name and a
// URL), Edit for roles and the finer settings, and Refresh now for the catalog. Everyone else's connecting lives in
// Kaizen AI's plug menu; Your accounts is a short list that points there. Every sheet and screen lives in the address
// (add=directory|custom|client, edit=<id>, request=<ref>), so back closes it.

export type AdminItem = Connector & { hasSecret: boolean; registered: boolean; people: number; /** Its registry entry went away (it keeps working until turned off) */ removed: boolean };
export type MineItem = {
  key: string;
  name: string;
  icon_url: string | null;
  note: string | null;
  auth: AuthKind;
  state: "connected" | "reconnect" | "not_connected";
  since: string | null;
  lastUsed: string | null;
  last4: string | null;
  error: string | null;
  tools: number;
  writes: number;
};

const authLabel = (a: AuthKind) => AUTH_KINDS.find((x) => x.key === a)?.label ?? a;
const roleNames = (roles: string[] | null) => (!roles?.length ? "Everyone" : roles.map((r) => ROLES.find((x) => x.value === r)?.label ?? r).join(", "));
// New York time, as the rest of Settings: the server renders in UTC and the browser in its own zone
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
const whenTime = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const field = "min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none transition placeholder:text-faint focus:border-brand/50";
const primary = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40";
const quiet = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-line px-4 text-[13px] text-fg transition hover:border-brand/40 disabled:opacity-40";
const ghost = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-4 text-[13px] text-muted transition hover:bg-ink/[0.05] hover:text-fg disabled:opacity-40";
const REDIRECT = `${(process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "")}/api/connectors/callback`;

function Pill({ tone, children }: { tone: "ok" | "warn" | "off"; children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">
      <span className={`h-2 w-2 rounded-full ${tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-faint"}`} aria-hidden />
      {children}
    </span>
  );
}

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
/** The verified tick on a featured vendor's own server */
const Verified = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" className="shrink-0 text-brand" role="img" aria-label="Verified vendor">
    <path fill="currentColor" d="M12 1.8l2.4 1.8 3-.2 1 2.8 2.6 1.6-.8 2.9.8 2.9-2.6 1.6-1 2.8-3-.2L12 22.2l-2.4-1.8-3 .2-1-2.8L3 16.2l.8-2.9L3 10.4l2.6-1.6 1-2.8 3 .2z" />
    <path d="M8 12.2l2.7 2.7L16.2 9.4" fill="none" stroke="var(--color-surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ─── Refresh now ───────────────────────────────────────────────────────────

type Refresh = { busy: boolean; note: string | null; run: () => Promise<void> };

/** The catalog sync on demand: called again while it isn't complete (each call reads for up to four minutes) */
function useRefresh(): Refresh {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setNote("Reading the registry…");
    let last: { complete?: boolean; catalog?: number; error?: string | null; skipped?: string } = {};
    for (let i = 0; i < 6; i++) {
      last = await fetch("/api/connectors/refresh", { method: "POST" })
        .then((r) => r.json() as Promise<typeof last>)
        .catch(() => ({ error: "The refresh didn't finish. What came in is saved; try again." }));
      if (last.skipped || (last.error && last.catalog === undefined)) break;
      if (last.complete) break;
      setNote(`${(last.catalog ?? 0).toLocaleString("en-US")} connectors so far, still reading…`);
    }
    setBusy(false);
    setNote(
      last.skipped ??
        (last.complete
          ? `Up to date: ${(last.catalog ?? 0).toLocaleString("en-US")} connectors.`
          : last.error
            ? `Stopped early: ${last.error} What came in is saved.`
            : `${(last.catalog ?? 0).toLocaleString("en-US")} connectors so far. Refresh again to carry on.`),
    );
    router.refresh();
  };
  return { busy, note, run };
}

// ─── Execs: what's offered to the team ─────────────────────────────────────

/** Where the Directory's connectors come from (the server action; a sample in the design preview) */
export type DirectoryLoader = (q: string, limit: number) => Promise<{ items: DirectoryItem[]; total: number; ready: boolean }>;

/** A connector waiting on its one-time app: from the Directory, from a request (name is the request's ref), or custom */
type Pending = { kind: "registry" | "request"; name: string; title: string; icon: string | null; url: string | null } | { kind: "custom"; name: string; url: string };

export function ConnectorsAdmin({
  items,
  ready,
  encryption,
  catalogTotal,
  lastSync,
  syncError,
  syncPartial,
  loadDirectory = directory,
  requests = [],
}: {
  items: AdminItem[];
  requests?: RequestGroup[];
  ready: boolean;
  encryption: boolean;
  catalogTotal: number;
  lastSync: string | null;
  syncError: string | null;
  syncPartial: boolean;
  loadDirectory?: DirectoryLoader;
}) {
  const router = useRouter();
  const edit = useParam("edit");
  const add = useParam("add");
  const legacyView = useParam("view");
  const open = items.find((i) => i.id === edit) ?? null;
  const refresh = useRefresh();
  const [pending, setPending] = useState<Pending | null>(null);
  const [flash, setFlash] = useState<{ name: string; key: string } | null>(null);
  // Links from before the Directory (the Live catalog view) open it
  useEffect(() => {
    if (legacyView === "catalog") replaceParams({ view: null, q: null, offer: null, add: "directory" });
  }, [legacyView]);
  const added = (r: { name: string; key: string }) => {
    setFlash(r);
    closeThen(() => router.refresh(), "add", "dq", "app", "appname");
  };
  const flashed = flash ? items.find((i) => i.key === flash.key) : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[640px] text-sm text-muted">
          Enable the services the team can use in Kaizen AI, like the connectors an organization turns on in Claude. People connect their own account from the plug button in any chat, and can
          ask for one that isn&apos;t enabled yet.
        </p>
        <button type="button" disabled={!ready} onClick={() => pushParams({ add: "directory" })} className={`${primary} gap-2`}>
          <PlusIcon />
          Enable connector
        </button>
      </div>
      {!ready ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">Connectors need the latest database update before the first one can be added.</p> : null}
      {!encryption ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">Add TOKEN_ENCRYPTION_KEY in Vercel first: people&apos;s sign ins are stored encrypted with it.</p> : null}
      {flash ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-ok-soft/60 px-4 py-2.5 text-[13px] text-fg">
          <span className="min-w-0 flex-1">{flash.name} is enabled for everyone. People connect it from the plug button in Kaizen AI.</span>
          {flashed ? (
            <button type="button" onClick={() => pushParams({ edit: flashed.id })} className="min-h-11 rounded-full px-3 text-[13px] font-medium text-fg underline-offset-4 hover:underline">
              Choose roles
            </button>
          ) : null}
          <button type="button" onClick={() => setFlash(null)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05]" aria-label="Dismiss">
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <Requests
        groups={requests}
        onNeedsApp={(p) => {
          setPending(p);
          pushParams({ add: "client" });
        }}
      />
      {requests.length && items.length ? <h2 className="-mb-2 font-heading text-[19px] text-fg">Enabled</h2> : null}
      {ready && !items.length ? (
        <div className="grid justify-items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading text-[20px] text-fg">Nothing enabled yet</p>
          <p className="max-w-[420px] text-[13px] text-muted">Enable Canva, Notion, Zapier or any verified service from the Directory, or add one by its URL.</p>
          <button type="button" onClick={() => pushParams({ add: "directory" })} className={quiet}>
            Browse the Directory
          </button>
        </div>
      ) : null}
      {items.length ? (
        <ul className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[20px] border border-line bg-surface">
          {items.map((c) => (
            <li key={c.id} className="border-b border-line/70 last:border-b-0">
              <button type="button" onClick={() => pushParams({ edit: c.id })} className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition hover:bg-ink/[0.03] md:px-5">
                <ConnectorIcon name={c.name} url={c.icon_url} size={40} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-fg">{c.name}</span>
                    {c.enabled ? <Pill tone="ok">Enabled</Pill> : <Pill tone="off">Off</Pill>}
                  </span>
                  {c.note ? <span className="line-clamp-1 text-[13px] text-muted">{c.note}</span> : null}
                  <span className="truncate text-[12px] text-faint">
                    {authLabel(c.auth)} · {roleNames(c.roles)} · {c.people} connected
                  </span>
                  {c.removed ? <span className="text-[12px] text-bad">Gone from the registry. It keeps working until you turn it off.</span> : null}
                </span>
                <span className="hidden min-h-11 shrink-0 items-center rounded-full border border-line px-4 text-[13px] text-fg sm:inline-flex">Edit</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] bg-surface-2/60 px-4 py-2.5">
        <p className="min-w-0 text-[12.5px] text-muted">
          {refresh.note ??
            (catalogTotal
              ? `Directory: ${catalogTotal.toLocaleString("en-US")} verified connectors${lastSync ? `, checked ${whenTime(lastSync)}` : ""}${syncPartial ? ". Still reading the registry" : ""}${syncError ? ". The last check had a problem" : ""}.`
              : lastSync
                ? `The Directory is empty so far (checked ${whenTime(lastSync)}). Refresh now reads the registry.`
                : "The Directory hasn't been read yet. Refresh now reads the registry.")}
        </p>
        <button type="button" onClick={() => void refresh.run()} disabled={refresh.busy || !ready} className={`${ghost} gap-2`}>
          {refresh.busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-brand border-t-transparent" aria-hidden /> : null}
          {refresh.busy ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {add ? <AddSheet screen={add} pending={pending} setPending={setPending} onAdded={added} refresh={refresh} load={loadDirectory} /> : null}
      {open ? <Editor key={open.id} c={open} /> : null}
    </div>
  );
}

// ─── Add connector: the Directory, Add custom connector, and the client step ─

const closeAdd = () => closeThen(() => {}, "add", "dq", "app", "appname");

function AddSheet({
  screen,
  pending,
  setPending,
  onAdded,
  refresh,
  load,
}: {
  screen: string;
  pending: Pending | null;
  setPending: (p: Pending | null) => void;
  onAdded: (r: { name: string; key: string }) => void;
  refresh: Refresh;
  load: DirectoryLoader;
}) {
  const close = closeAdd;
  const view = screen === "custom" ? "custom" : screen === "client" ? "client" : "directory";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAdd();
    window.addEventListener("keydown", onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = was;
    };
  }, []);
  const title = view === "custom" ? "Add custom connector" : view === "client" ? "One-time app" : "Enable a connector";
  return (
    <div className="fixed inset-0 z-50 md:grid md:place-items-center md:p-6" role="dialog" aria-modal aria-label={title}>
      <button type="button" className="absolute inset-0 hidden bg-deep/50 backdrop-blur-[3px] md:block" onClick={close} aria-label="Close" tabIndex={-1} />
      <div
        className={`relative flex h-dvh w-full flex-col bg-surface md:h-auto md:max-h-[88dvh] md:rounded-[24px] md:border md:border-line md:shadow-2xl ${view === "directory" ? "md:h-[min(780px,88dvh)] md:max-w-[920px]" : "md:max-w-[520px]"}`}
      >
        <header className="flex items-center gap-2 border-b border-line/70 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5 md:pt-4">
          {view !== "directory" ? (
            <button type="button" onClick={() => replaceParams({ add: view === "client" && pending?.kind === "custom" ? "custom" : "directory" })} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Back">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
          ) : null}
          <h2 className={`min-w-0 flex-1 truncate font-heading text-[21px] text-fg ${view === "directory" ? "pl-2 md:pl-0" : ""}`}>{title}</h2>
          {view === "directory" ? (
            <button type="button" onClick={() => pushParams({ add: "custom" })} className={`${ghost} hidden gap-1.5 sm:inline-flex`}>
              <PlusIcon size={14} />
              Add custom connector
            </button>
          ) : null}
          <button type="button" onClick={close} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        {view === "directory" ? <DirectoryScreen setPending={setPending} onAdded={onAdded} refresh={refresh} load={load} /> : null}
        {view === "custom" ? <CustomScreen setPending={setPending} onAdded={onAdded} onCancel={close} /> : null}
        {view === "client" ? <ClientScreen pending={pending} onAdded={onAdded} /> : null}
      </div>
    </div>
  );
}

function DirectoryScreen({ setPending, onAdded, refresh, load }: { setPending: (p: Pending | null) => void; onAdded: (r: { name: string; key: string }) => void; refresh: Refresh; load: DirectoryLoader }) {
  const dq = useParam("dq") ?? "";
  const [text, setText] = useState(dq);
  const [limit, setLimit] = useState(60);
  const [data, setData] = useState<{ items: DirectoryItem[]; total: number; ready: boolean } | null>(null);
  const [got, setGot] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const want = `${dq}
${limit}
${refresh.busy}`;
  const loading = got !== want;
  // Seen when they leave: the next visit's "New" and "Updated" count from then (this visit keeps showing them)
  useEffect(() => () => void markCatalogSeen().catch(() => {}), []);
  // Typing: the address follows (no new history entry) and the list follows a moment later
  useEffect(() => {
    const t = setTimeout(() => replaceParams({ dq: text.trim() || null }), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    let live = true;
    void load(dq, limit)
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
  }, [dq, limit, want, load]);

  const offer = async (i: DirectoryItem) => {
    setBusy(i.name);
    setErr(null);
    const r = await offerFromRegistry(i.name, []).catch(() => ({ ok: false as const, error: "Couldn't enable it. Try again." }));
    setBusy(null);
    if (r.ok) return onAdded({ name: r.name, key: r.key });
    if ("needsClient" in r && r.needsClient) {
      setPending({ kind: "registry", name: i.name, title: i.title, icon: i.icon_url, url: i.url });
      return pushParams({ add: "client" });
    }
    setErr(`${i.title}: ${r.error}`);
  };

  const items = data?.items ?? [];
  const featured = dq ? [] : items.filter((i) => i.featured);
  const rest = dq ? items : items.filter((i) => !i.featured);
  const card = (i: DirectoryItem) => (
    <li key={i.name} className="flex items-center gap-3 rounded-[16px] border border-line bg-bg/50 p-3 transition hover:border-brand/30">
      <ConnectorIcon name={i.title} url={i.icon_url} size={44} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[14.5px] font-semibold text-fg">{i.title}</span>
          {i.featured ? <Verified /> : null}
          {i.badge === "new" ? <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-text">New</span> : null}
        </p>
        <p className="line-clamp-1 text-[12.5px] text-muted">{i.description ?? i.url}</p>
      </div>
      {i.offered === "on" ? (
        <span className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-ok-soft/70 px-3 text-[12px] font-medium text-fg">
          <CheckIcon size={12} />
          Enabled
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void offer(i)}
          disabled={Boolean(busy)}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-fg transition hover:border-brand hover:bg-brand hover:text-white disabled:opacity-40"
          aria-label={i.offered === "off" ? `Enable ${i.title} again for the team` : `Enable ${i.title} for the team`}
        >
          {busy === i.name ? <span className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden /> : <PlusIcon />}
        </button>
      )}
    </li>
  );

  return (
    <>
      <div className="grid gap-2 px-4 pb-3 pt-3 md:px-5">
        <label className="relative block">
          <span className="sr-only">Search connectors</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4 4" />
          </svg>
          <input value={text} onChange={(e) => setText(e.target.value)} type="search" placeholder="Search connectors" className={`${field} pl-10`} autoComplete="off" />
        </label>
        <p className="px-1 text-[12px] text-faint">
          {data?.total ? `${data.total.toLocaleString("en-US")} ${dq ? "match" : "verified remote servers from the MCP registry"}` : loading ? "Loading…" : ""}
          {err ? <span className="text-bad"> · {err}</span> : null}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-5">
        {data && !data.ready ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">The Directory needs the latest database update first.</p> : null}
        {data?.ready && !items.length && !loading ? (
          <div className="grid justify-items-center gap-3 px-6 py-16 text-center">
            <p className="font-heading text-[19px] text-fg">{dq ? "Nothing matches" : "The Directory is empty"}</p>
            <p className="max-w-[420px] text-[13px] text-muted">{dq ? "Try a shorter word, or add it as a custom connector by its URL." : "The registry hasn't been read yet. Refresh now fills it in a minute or two."}</p>
            {!dq ? (
              <button type="button" onClick={() => void refresh.run()} disabled={refresh.busy} className={quiet}>
                {refresh.busy ? (refresh.note ?? "Refreshing…") : "Refresh now"}
              </button>
            ) : null}
          </div>
        ) : null}
        {featured.length ? (
          <section className="grid gap-2 pb-4">
            <h3 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Featured</h3>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-2">{featured.map(card)}</ul>
          </section>
        ) : null}
        {rest.length ? (
          <section className="grid gap-2">
            {featured.length ? <h3 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">All connectors</h3> : null}
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 md:grid-cols-2">{rest.map(card)}</ul>
          </section>
        ) : null}
        {data && items.length < data.total ? (
          <div className="flex justify-center pt-4">
            <button type="button" onClick={() => setLimit((n) => Math.min(600, n + 60))} disabled={loading || limit >= 600} className={quiet}>
              {loading ? "Loading…" : limit >= 600 ? "Search to narrow it down" : "Show more"}
            </button>
          </div>
        ) : null}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-line/70 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:px-5">
        <p className="min-w-0 text-[12.5px] text-muted">Don&apos;t see it? Any remote MCP server works.</p>
        <button type="button" onClick={() => pushParams({ add: "custom" })} className={`${quiet} gap-1.5`}>
          <PlusIcon size={14} />
          Add custom connector
        </button>
      </footer>
    </>
  );
}

function CustomScreen({ setPending, onAdded, onCancel }: { setPending: (p: Pending | null) => void; onAdded: (r: { name: string; key: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    const r = await addCustomConnector({ name, url }).catch(() => ({ ok: false as const, error: "Couldn't add it. Try again." }));
    setBusy(false);
    if (r.ok) return onAdded({ name: r.name, key: r.key });
    if ("needsClient" in r && r.needsClient) {
      setPending({ kind: "custom", name: name.trim(), url: url.trim() });
      return pushParams({ add: "client" });
    }
    setErr(r.error);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 py-5">
        <label className="grid gap-1.5">
          <span className="text-[13.5px] font-medium text-fg">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} autoComplete="off" maxLength={60} />
          <span className="text-[12px] text-faint">Shown in the connectors list</span>
        </label>
        <label className="grid gap-1.5">
          <span className="text-[13.5px] font-medium text-fg">MCP server URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} className={field} />
          <span className="text-[12px] text-faint">The HTTPS address where the server accepts MCP requests, for example https://mcp.example.com/mcp</span>
        </label>
        <p className="rounded-[14px] bg-surface-2/70 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
          Only use connectors from developers you trust. Kaizen Ads doesn&apos;t control which tools a server offers or check what it does, and it can read whatever each person connects.
        </p>
        {err ? <p className="text-[12.5px] text-bad">{err}</p> : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line/70 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button type="button" onClick={onCancel} className={ghost}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim() || !url.trim()} className={primary}>
          {busy ? "Checking the server…" : "Continue"}
        </button>
      </footer>
    </form>
  );
}

function ClientScreen({ pending: given, onAdded }: { pending: Pending | null; onAdded: (r: { name: string; key: string }) => void }) {
  // A link from Kaizen AI's Browse connectors (?app=<registry name>&appname=<title>) opens this step on its own
  const app = useParam("app");
  const appName = useParam("appname");
  const pending: Pending | null = given ?? (app ? { kind: "registry", name: app, title: appName || app.split("/").pop() || app, icon: null, url: null } : null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [withSecret, setWithSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!pending)
    return (
      <div className="grid flex-1 content-start justify-items-start gap-3 px-5 py-6">
        <p className="text-[13.5px] text-muted">Start from the Directory or Add custom connector again.</p>
        <button type="button" onClick={() => replaceParams({ add: "directory" })} className={quiet}>
          Back to the Directory
        </button>
      </div>
    );
  const label = pending.kind === "custom" ? pending.name : pending.title;
  const setup = pending.url ? appSetupFor(pending.url) : null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    const client = { id: clientId.trim(), secret: withSecret ? secret.trim() : "" };
    const r = await (pending.kind === "custom"
      ? addCustomConnector({ name: pending.name, url: pending.url, client })
      : pending.kind === "request"
        ? enableRequest({ ref: pending.name, client })
        : offerFromRegistry(pending.name, [], client)
    ).catch(() => ({
      ok: false as const,
      error: "Couldn't enable it. Try again.",
    }));
    setBusy(false);
    if (r.ok) return onAdded({ name: r.name, key: r.key });
    setErr(r.error);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 py-5">
        <div className="flex items-center gap-3">
          <ConnectorIcon name={label} url={pending.kind === "custom" ? null : pending.icon} size={40} />
          <div className="grid min-w-0">
            <p className="truncate text-[15px] font-semibold text-fg">{label}</p>
            <p className="text-[12px] text-faint">Once for the whole team, not per person</p>
          </div>
        </div>
        <p className="text-[13.5px] leading-relaxed text-muted">{appStepText(label)}</p>
        {setup ? (
          <a href={setup.url} target="_blank" rel="noreferrer" className={`${quiet} w-fit gap-1.5`}>
            Open {setup.vendor}&apos;s developer page
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 17 17 7M8 7h9v9" />
            </svg>
          </a>
        ) : null}
        <div className="grid gap-1.5">
          <span className="text-[12.5px] text-muted">Redirect URL</span>
          <p className="select-all break-all rounded-[12px] bg-surface-2/70 px-3 py-2.5 text-[13px] text-fg">{REDIRECT}</p>
        </div>
        <label className="grid gap-1.5">
          <span className="text-[13.5px] font-medium text-fg">Client ID</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} className={field} />
        </label>
        {withSecret ? (
          <label className="grid gap-1.5">
            <span className="text-[13.5px] font-medium text-fg">Client secret</span>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" className={field} />
            <span className="text-[12px] text-faint">Stored encrypted. Nobody can read it back.</span>
          </label>
        ) : (
          <button type="button" onClick={() => setWithSecret(true)} className="-mt-2 w-fit min-h-11 text-left text-[12.5px] text-muted underline-offset-4 hover:text-fg hover:underline">
            The app also gave a client secret
          </button>
        )}
        {err ? <p className="text-[12.5px] text-bad">{err}</p> : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line/70 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button type="submit" disabled={busy || !clientId.trim()} className={primary}>
          {busy ? "Enabling…" : "Enable connector"}
        </button>
      </footer>
    </form>
  );
}

// ─── Execs: Edit (roles, scopes, note, on or off, and the rest) ────────────

function Editor({ c }: { c: AdminItem }) {
  const router = useRouter();
  const [name, setName] = useState(c.name);
  const [key, setKey] = useState(c.key);
  const [url, setUrl] = useState(c.url);
  const [auth, setAuth] = useState<AuthKind>(c.auth);
  const [clientId, setClientId] = useState(c.client_id ?? "");
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [scopes, setScopes] = useState(c.scopes ?? "");
  const [roles, setRoles] = useState<string[]>(c.roles ?? []);
  const [note, setNote] = useState(c.note ?? "");
  const [icon, setIcon] = useState(c.icon_url ?? "");
  const [enabled, setEnabled] = useState(c.enabled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const close = (refresh = false) => closeThen(() => refresh && router.refresh(), "edit");

  const runCheck = async () => {
    setCheck("Checking…");
    const r = await checkConnectorUrl(url);
    if (!r.ok) return setCheck(r.error);
    if (!r.reachable) return setCheck("The server didn't answer. Check the URL.");
    setAuth(r.suggested);
    setCheck(
      r.suggested === "none"
        ? "It answered without asking anyone to sign in."
        : r.suggested === "oauth"
          ? "People just sign in, like in Claude. Nothing else to set up."
          : r.suggested === "oauth_client"
            ? "It needs its own Kaizen AI app, set up once for the whole team: create it in the service's developer settings and paste its client ID."
            : "It asks for a sign in but has no OAuth details: people paste a personal token.",
    );
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    const r = await saveConnector({ id: c.id, key: key || keyFrom(name), name, icon_url: icon, url, auth, client_id: clientId, client_secret: secret, scopes, note, roles, enabled });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    close(true);
  };

  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    const r = await deleteConnector(c.id);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    close(true);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal aria-label={`Edit ${c.name}`}>
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={() => close()} aria-label="Close" />
      <div className="relative grid max-h-[92dvh] w-full max-w-[560px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-t-[24px] border border-line bg-surface shadow-2xl md:rounded-[24px]">
        <header className="flex items-center gap-3 border-b border-line/70 px-5 py-4">
          <ConnectorIcon name={name || "?"} url={icon || null} size={36} />
          <p className="min-w-0 flex-1 truncate font-heading text-[20px] text-fg">{c.name}</p>
          <button type="button" onClick={() => close()} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="grid content-start gap-4 overflow-y-auto px-5 py-4">
          <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled(!enabled)} className="flex min-h-11 items-center justify-between gap-3 rounded-[12px] px-1 text-left">
            <span className="text-[13.5px] text-fg">Enabled in Kaizen AI</span>
            <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${enabled ? "bg-brand" : "bg-ink/[0.15]"}`} aria-hidden>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${enabled ? "left-[18px]" : "left-0.5"}`} />
            </span>
          </button>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[12.5px] text-muted">Enabled for</legend>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={!roles.length} onClick={() => setRoles([])} className={`min-h-11 rounded-full border px-3.5 text-[12.5px] ${!roles.length ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted"}`}>
                Everyone
              </button>
              {ROLES.map((r) => {
                const on = roles.includes(r.value);
                return (
                  <button
                    key={r.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setRoles((x) => (on ? x.filter((y) => y !== r.value) : [...x, r.value]))}
                    className={`min-h-11 rounded-full border px-3.5 text-[12.5px] ${on ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted hover:text-fg"}`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="grid gap-1.5">
            <span className="text-[12.5px] text-muted">What it&apos;s for</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Orders, products and customers for the client stores you manage" className={`${field} py-2.5`} />
          </label>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Key</span>
              <input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className={field} />
            </label>
          </div>
          <label className="grid gap-1.5">
            <span className="text-[12.5px] text-muted">MCP server URL</span>
            <div className="flex gap-2">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" inputMode="url" className={field} />
              <button type="button" onClick={() => void runCheck()} disabled={!url.trim()} className={quiet}>
                Check
              </button>
            </div>
            {check ? <span className="text-[12.5px] text-muted">{check}</span> : null}
          </label>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[12.5px] text-muted">How people sign in</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {AUTH_KINDS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  aria-pressed={auth === a.key}
                  onClick={() => setAuth(a.key)}
                  className={`grid min-h-11 content-start gap-0.5 rounded-[14px] border px-3 py-2.5 text-left transition ${auth === a.key ? "border-brand bg-brand-soft/40" : "border-line hover:border-brand/30"}`}
                >
                  <span className="text-[13.5px] font-medium text-fg">{a.label}</span>
                  <span className="text-[11.5px] leading-snug text-muted">{a.about}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {auth === "oauth_client" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-[12.5px] text-muted">Client ID</span>
                <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" className={field} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[12.5px] text-muted">Client secret</span>
                <input type="password" value={secret ?? ""} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={c.hasSecret ? "Saved (type to replace)" : "Only if the app has one"} className={field} />
              </label>
              <p className="text-[12px] text-faint sm:col-span-2">
                Redirect URL to register with the service: <span className="select-all text-muted">{REDIRECT}</span>
              </p>
            </div>
          ) : null}
          {auth === "oauth" || auth === "oauth_client" ? (
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Scopes (optional)</span>
              <input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="What the server asks for" className={field} />
            </label>
          ) : null}
          <label className="grid gap-1.5">
            <span className="text-[12.5px] text-muted">Icon URL (optional)</span>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="https://…/icon.png" inputMode="url" className={field} />
          </label>
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line/70 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {err ? <p className="w-full text-[12.5px] text-bad">{err}</p> : null}
          <button type="button" onClick={() => void remove()} disabled={busy} className={`min-h-11 rounded-full px-4 text-[13px] ${sure ? "bg-bad text-white" : "text-bad hover:bg-bad-soft/40"}`}>
            {sure ? "Remove for everyone" : "Remove"}
          </button>
          <button type="button" onClick={() => close()} className={`${ghost} ml-auto`}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !url.trim()} className={primary}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Execs: requests to enable ─────────────────────────────────────────────

const ago = (iso: string) => {
  const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : when(iso);
};

/**
 * What the team asked to enable, one card per connector with who asked (by role), their notes and when. Enable turns
 * it on for them and tells them it's ready to connect; Decline sends the reason back. ?request=<ref> opens on one.
 */
function Requests({ groups, onNeedsApp }: { groups: RequestGroup[]; onNeedsApp: (p: Pending) => void }) {
  const router = useRouter();
  const focus = useParam("request");
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<{ ref: string; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (focus) document.getElementById(`request-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);
  if (!groups.length) return null;
  const enable = async (g: RequestGroup) => {
    setBusy(g.ref);
    setErr(null);
    const r = await enableRequest({ ref: g.ref }).catch(() => ({ ok: false as const, error: "Couldn't enable it. Try again." }));
    setBusy(null);
    if (r.ok) {
      setDone(`${r.name} is enabled. ${g.people.length === 1 ? "The person who asked was" : `The ${g.people.length} people who asked were`} told it's ready to connect.`);
      return router.refresh();
    }
    if ("needsClient" in r && r.needsClient) return onNeedsApp({ kind: "request", name: g.ref, title: g.title, icon: g.icon_url, url: r.url ?? null });
    setErr({ ref: g.ref, text: r.error });
  };
  const decline = async (g: RequestGroup) => {
    setBusy(g.ref);
    setErr(null);
    const r = await declineRequest(g.ref, reason).catch(() => ({ ok: false as const, error: "Couldn't decline it. Try again." }));
    setBusy(null);
    if (!r.ok) return setErr({ ref: g.ref, text: r.error });
    setDeclining(null);
    setReason("");
    setDone(`Declined. ${g.people.length === 1 ? "The person who asked hears" : "Everyone who asked hears"} why.`);
    router.refresh();
  };
  return (
    <section className="grid gap-2.5" aria-label="Requests to enable">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-[19px] text-fg">Requests</h2>
        <p className="text-[12.5px] text-faint">{groups.reduce((n, g) => n + g.people.length, 0)} waiting</p>
      </div>
      {done ? <p className="rounded-[14px] bg-ok-soft/60 px-4 py-2.5 text-[13px] text-fg">{done}</p> : null}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {groups.map((g) => (
          <li key={g.ref} id={`request-${g.ref}`} className={`grid gap-3 rounded-[20px] border bg-surface px-4 py-3.5 md:px-5 ${focus === g.ref ? "border-brand/50 ring-2 ring-brand/20" : "border-line"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <ConnectorIcon name={g.title} url={g.icon_url} size={40} />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="truncate text-[15px] font-semibold text-fg">{g.title}</p>
                <p className="truncate text-[12.5px] text-muted">
                  {[...new Set(g.people.map((p) => p.role))].join(", ")} asked · {ago(g.first)}
                </p>
              </div>
              {declining !== g.ref ? (
                <div className="flex w-full shrink-0 justify-end gap-1.5 sm:w-auto">
                  <button type="button" onClick={() => setDeclining(g.ref)} disabled={Boolean(busy)} className={ghost}>
                    Decline
                  </button>
                  <button type="button" onClick={() => void enable(g)} disabled={Boolean(busy)} className={`${primary} gap-2`}>
                    {busy === g.ref ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden /> : null}
                    Enable
                  </button>
                </div>
              ) : null}
            </div>
            {g.people.some((p) => p.note) ? (
              <ul className="grid gap-1.5 sm:pl-[54px]">
                {g.people
                  .filter((p) => p.note)
                  .map((p) => (
                    <li key={p.id} className="rounded-[12px] bg-surface-2/70 px-3 py-2 text-[13px] leading-relaxed text-fg">
                      &ldquo;{p.note}&rdquo;
                      <span className="block text-[11.5px] text-faint">
                        {p.name}, {p.role} · {ago(p.at)}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : null}
            {declining === g.ref ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void decline(g);
                }}
                className="grid gap-2 sm:pl-[54px]"
              >
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Why not, for the people who asked (optional)" className={`${field} py-2.5`} />
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => setDeclining(null)} className={ghost}>
                    Cancel
                  </button>
                  <button type="submit" disabled={Boolean(busy)} className="inline-flex min-h-11 items-center rounded-full bg-bad px-4 text-[13px] font-medium text-white disabled:opacity-40">
                    {busy === g.ref ? "Declining…" : "Decline"}
                  </button>
                </div>
              </form>
            ) : null}
            {err?.ref === g.ref ? <p className="text-[12.5px] text-bad sm:pl-[54px]">{err.text}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Everyone: their own accounts (connecting lives in Kaizen AI) ──────────

/**
 * Your accounts: what you've connected, at a glance. Connecting, reconnecting and disconnecting live in Kaizen AI's plug
 * menu now (like Claude), so each row opens it there. Links from before (?connector=, ?connected=) still land here.
 */
export function MyConnections({ items, isExec }: { items: MineItem[]; isExec: boolean }) {
  const focus = useParam("connector");
  const connected = useParam("connected");
  const error = useParam("connect_error");
  const flash = error ?? (connected ? `${items.find((i) => i.key === connected)?.name ?? "It"} is connected. Switch it on in any Kaizen AI chat from the plug button.` : null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[620px] text-sm text-muted">
          The services you use in Kaizen AI. Connect, reconnect or disconnect them from the plug button in any chat, the same way you do in Claude.
        </p>
        <a href={connectionsHref()} className={quiet}>
          Open in Kaizen AI
        </a>
      </div>
      {flash ? (
        <div className={`flex items-center justify-between gap-3 rounded-[14px] px-4 py-2.5 text-[13px] text-fg ${error ? "bg-bad-soft/50" : "bg-ok-soft/60"}`}>
          {flash}
          <button type="button" onClick={() => replaceParams({ connected: null, connect_error: null })} className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-ink/[0.05]" aria-label="Dismiss">
            <CloseIcon />
          </button>
        </div>
      ) : null}
      {!items.length ? (
        <div className="grid justify-items-center gap-3 rounded-[20px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading text-[19px] text-fg">Nothing enabled for you yet</p>
          <p className="max-w-[420px] text-[13px] text-muted">{isExec ? "Enable the services the team uses in Team connectors." : "Browse connectors in Kaizen AI and ask for the one you need."}</p>
          <a href={isExec ? "/settings?tab=connections&section=team" : browseHref()} className={quiet}>
            {isExec ? "Team connectors" : "Browse connectors"}
          </a>
        </div>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[20px] border border-line bg-surface">
          {items.map((i) => (
            <li key={i.key} className={`border-b border-line/70 last:border-b-0 ${focus === i.key ? "bg-brand-soft/20" : ""}`}>
              <a href={i.state === "connected" ? connectionsHref(i.key) : chatConnectHref(i.key)} className="flex min-h-[64px] items-center gap-3.5 px-4 py-3 transition hover:bg-ink/[0.03] md:px-5">
                <ConnectorIcon name={i.name} url={i.icon_url} size={36} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-[14.5px] font-semibold text-fg">{i.name}</span>
                  <span className={`truncate text-[12px] ${i.state === "reconnect" ? "text-bad" : "text-faint"}`}>
                    {i.state === "connected"
                      ? [i.since ? `Connected ${when(i.since)}` : "Connected", i.tools ? `${i.tools} tools${i.writes ? `, ${i.writes} ask first` : ""}` : null].filter(Boolean).join(" · ")
                      : i.state === "reconnect"
                        ? "Sign in expired"
                        : "Not connected"}
                  </span>
                </span>
                <span className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-line px-4 text-[13px] text-fg">{i.state === "connected" ? "Manage" : i.state === "reconnect" ? "Reconnect" : "Connect"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
