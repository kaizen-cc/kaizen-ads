"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectorIcon } from "@/app/(team)/ai/connectors-ui";
import { AUTH_KINDS, connectHref, connectionsHref, keyFrom, type AuthKind, type Connector } from "@/lib/connectors/shared";
import { ROLES } from "@/lib/roles";
import { closeThen, pushParams, replaceParams, useParam } from "@/lib/url-state";
import { checkConnectorUrl, deleteConnector, disconnectAction, markCatalogSeen, offerFromRegistry, saveConnector, savePersonalTokenAction } from "./connector-actions";

// Connectors: the catalog execs keep (a sheet per connector, opened from the address so back closes it) and each
// person's own connections (Connect, Reconnect, Disconnect, or a pasted token).

export type AdminItem = Connector & { hasSecret: boolean; registered: boolean; people: number; /** Its registry entry went away (it keeps working until turned off) */ removed: boolean };
export type CatalogItem = {
  name: string;
  title: string | null;
  description: string | null;
  url: string;
  transport: string;
  version: string | null;
  icon_url: string | null;
  website_url: string | null;
  first_seen_at: string;
  changed_at: string | null;
  badge: "new" | "updated" | null;
  offered: "on" | "off" | null;
};
export type MineItem = {
  key: string;
  name: string;
  icon_url: string | null;
  note: string | null;
  auth: AuthKind;
  state: "connected" | "reconnect" | "not_connected" | "open";
  since: string | null;
  lastUsed: string | null;
  last4: string | null;
  error: string | null;
  tools: number;
  writes: number;
};

const authLabel = (a: AuthKind) => AUTH_KINDS.find((x) => x.key === a)?.label ?? a;
const roleNames = (roles: string[] | null) => (!roles?.length ? "Everyone" : roles.map((r) => ROLES.find((x) => x.value === r)?.label ?? r).join(", "));
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const field = "min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none transition placeholder:text-faint focus:border-brand/50";

function Pill({ tone, children }: { tone: "ok" | "warn" | "off"; children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">
      <span className={`h-2 w-2 rounded-full ${tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-faint"}`} aria-hidden />
      {children}
    </span>
  );
}

// ─── Execs: the catalog ────────────────────────────────────────────────────

export function ConnectorsAdmin({
  items,
  ready,
  encryption,
  catalog,
  catalogTotal,
  lastSync,
  syncError,
}: {
  items: AdminItem[];
  ready: boolean;
  encryption: boolean;
  catalog: CatalogItem[];
  catalogTotal: number;
  lastSync: string | null;
  syncError: string | null;
}) {
  const router = useRouter();
  const edit = useParam("edit");
  const view = useParam("view") === "catalog" ? "catalog" : "offered";
  const open = edit === "new" ? null : items.find((i) => i.id === edit);
  const tabs = (
    <div className="flex gap-1.5" role="tablist">
      {(
        [
          ["offered", `Offered to the team${items.length ? ` (${items.length})` : ""}`],
          ["catalog", `Live catalog${catalogTotal ? ` (${catalogTotal.toLocaleString("en-US")})` : ""}`],
        ] as const
      ).map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={view === k}
          onClick={() => router.push(k === "offered" ? "/settings?tab=connections&section=team" : "/settings?tab=connections&section=team&view=catalog", { scroll: false })}
          className={`min-h-11 rounded-full px-4 text-[13px] transition ${view === k ? "bg-fg text-bg" : "bg-surface text-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
  if (view === "catalog") return <Catalog tabs={tabs} items={catalog} total={catalogTotal} lastSync={lastSync} syncError={syncError} ready={ready} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {tabs}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[680px] text-sm text-muted">
          The services the team can connect in Kaizen AI, like the connectors your organization turned on in Claude. Each person signs in with their own account in Connections, Your accounts,
          then switches it on in a chat. Add the service&apos;s remote MCP server URL; Check tells you how it signs in.
        </p>
        <button
          type="button"
          disabled={!ready}
          onClick={() => pushParams({ edit: "new" })}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40"
        >
          Add a connector
        </button>
      </div>
      {!ready ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">Connectors need the latest database update before the first one can be added.</p> : null}
      {!encryption ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">Add TOKEN_ENCRYPTION_KEY in Vercel first: people&apos;s sign ins are stored encrypted with it.</p> : null}
      {ready && !items.length ? (
        <div className="grid justify-items-center gap-2 rounded-[18px] border border-dashed border-line px-6 py-12 text-center">
          <p className="font-heading text-[18px] text-fg">No connectors yet</p>
          <p className="max-w-[420px] text-[13px] text-muted">Add Shopify, Google Drive, Asana or any service with a remote MCP server, and choose which roles see it.</p>
        </div>
      ) : null}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => pushParams({ edit: c.id })}
              className="grid h-full w-full content-start gap-3 rounded-[18px] border border-line bg-surface p-4 text-left transition hover:-translate-y-px hover:border-brand/40 hover:shadow-md md:p-5"
            >
              <div className="flex items-center gap-3">
                <ConnectorIcon name={c.name} url={c.icon_url} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading text-[17px] leading-tight text-fg">{c.name}</p>
                  <p className="truncate text-[12px] text-faint">{c.key}</p>
                </div>
                <Pill tone={c.enabled ? "ok" : "off"}>{c.enabled ? "On" : "Off"}</Pill>
              </div>
              {c.removed ? (
                <p className="rounded-[10px] bg-warn-soft/60 px-3 py-2 text-[12.5px] text-fg">
                  Gone from the registry. It keeps working for people who connected it until you turn it off.
                </p>
              ) : null}
              {c.note ? <p className="line-clamp-2 text-[13px] text-muted">{c.note}</p> : null}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
                <dt className="text-faint">Sign in</dt>
                <dd className="text-muted">{authLabel(c.auth)}</dd>
                <dt className="text-faint">Offered to</dt>
                <dd className="truncate text-muted">{roleNames(c.roles)}</dd>
                <dt className="text-faint">Connected</dt>
                <dd className="text-muted">{c.auth === "none" ? "Nothing to connect" : `${c.people} ${c.people === 1 ? "person" : "people"}`}</dd>
              </dl>
            </button>
          </li>
        ))}
      </ul>
      {edit === "new" || open ? <Editor key={edit} c={open ?? null} /> : null}
    </div>
  );
}

// ─── Execs: the live catalog (Anthropic's MCP registry, synced daily) ──────

function Catalog({ tabs, items, total, lastSync, syncError, ready }: { tabs: React.ReactNode; items: CatalogItem[]; total: number; lastSync: string | null; syncError: string | null; ready: boolean }) {
  const router = useRouter();
  const q = useParam("q") ?? "";
  const offer = useParam("offer");
  const [text, setText] = useState(q);
  const picked = items.find((i) => i.name === offer) ?? null;
  // Seen when they leave the catalog: the next visit's "New" and "Updated" count from then (this visit keeps showing them)
  useEffect(() => () => void markCatalogSeen().catch(() => {}), []);
  const search = (v: string) => router.replace(`/settings?tab=connections&section=team&view=catalog${v.trim() ? `&q=${encodeURIComponent(v.trim())}` : ""}`, { scroll: false });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {tabs}
      <div className="grid gap-2 sm:flex sm:items-end sm:justify-between">
        <p className="max-w-[640px] text-sm text-muted">
          Remote MCP servers from Anthropic&apos;s registry, checked every day. Offer one and it shows up in Your accounts for the roles you pick; it keeps its URL and version current by itself.
        </p>
        <p className="text-[12px] text-faint">{lastSync ? `Synced ${when(lastSync)}` : "Not synced yet"}{syncError ? " · last sync had a problem" : ""}</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(text);
        }}
        className="flex gap-2"
      >
        <input value={text} onChange={(e) => setText(e.target.value)} type="search" placeholder="Search the catalog" aria-label="Search the catalog" className={field} />
        <button type="submit" className="min-h-11 shrink-0 rounded-full border border-line px-4 text-[13px] text-fg hover:border-brand/40">
          Search
        </button>
      </form>
      {!ready ? <p className="rounded-[14px] bg-warn-soft/60 px-4 py-3 text-[13px] text-fg">The catalog needs the latest database update first.</p> : null}
      {ready && !items.length ? (
        <div className="grid justify-items-center gap-2 rounded-[18px] border border-dashed border-line px-6 py-12 text-center">
          <p className="font-heading text-[18px] text-fg">{q ? "Nothing matches" : "The catalog is empty"}</p>
          <p className="max-w-[440px] text-[13px] text-muted">{q ? "Try a shorter word." : total ? "" : "The daily sync hasn't brought any remote servers in yet. You can still add a connector by its URL under Offered to the team."}</p>
        </div>
      ) : null}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <li key={i.name} className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-4">
            <div className="flex items-start gap-3">
              <ConnectorIcon name={i.title ?? i.name} url={i.icon_url} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-fg">{i.title ?? i.name}</p>
                <p className="truncate text-[11.5px] text-faint">
                  {i.name}
                  {i.version ? ` · v${i.version}` : ""}
                  {i.transport === "sse" ? " · SSE" : ""}
                </p>
              </div>
              {i.badge ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] ${i.badge === "new" ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted"}`}>{i.badge === "new" ? "New" : "Updated"}</span> : null}
            </div>
            {i.description ? <p className="line-clamp-3 text-[12.5px] text-muted">{i.description}</p> : null}
            <div className="mt-auto flex items-center justify-between gap-2">
              {i.website_url ? (
                <a href={i.website_url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[12.5px] text-faint hover:text-fg">
                  Website
                </a>
              ) : (
                <span />
              )}
              {i.offered === "on" ? (
                <Pill tone="ok">Offered</Pill>
              ) : (
                <button type="button" onClick={() => pushParams({ offer: i.name })} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-fg hover:border-brand/40">
                  Offer to the team
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {picked ? <OfferSheet key={picked.name} item={picked} /> : null}
    </div>
  );
}

function OfferSheet({ item }: { item: CatalogItem }) {
  const router = useRouter();
  const [roles, setRoles] = useState<string[]>([]);
  const [needsClient, setNeedsClient] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = (refresh = false) => closeThen(() => refresh && router.refresh(), "offer");
  const go = async () => {
    setBusy(true);
    setErr(null);
    const r = await offerFromRegistry(item.name, roles, needsClient ? { id: clientId, secret } : undefined);
    setBusy(false);
    if (r.ok) return close(true);
    if (r.needsClient) setNeedsClient(true);
    setErr(r.error);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal aria-label={`Offer ${item.title ?? item.name}`}>
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={() => close()} aria-label="Close" />
      <div className="relative grid max-h-[92dvh] w-full max-w-[520px] gap-4 overflow-y-auto rounded-t-[24px] border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl md:rounded-[24px]">
        <div className="flex items-center gap-3">
          <ConnectorIcon name={item.title ?? item.name} url={item.icon_url} size={40} />
          <div className="min-w-0">
            <p className="truncate font-heading text-[20px] text-fg">Offer {item.title ?? item.name}</p>
            <p className="truncate text-[12px] text-faint">{item.url}</p>
          </div>
        </div>
        <p className="text-[13px] text-muted">How people sign in is read from the server when you offer it. Each person connects their own account.</p>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-[12.5px] text-muted">Offered to</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={!roles.length} onClick={() => setRoles([])} className={`min-h-10 rounded-full border px-3.5 text-[12.5px] ${!roles.length ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted"}`}>
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
                  className={`min-h-10 rounded-full border px-3.5 text-[12.5px] ${on ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted hover:text-fg"}`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        {needsClient ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Client id</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" className={field} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Client secret</span>
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" className={field} />
            </label>
            <p className="text-[12px] text-faint sm:col-span-2">
              Redirect URL to register: <span className="select-all text-muted">{`${(process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "")}/api/connectors/callback`}</span>
            </p>
          </div>
        ) : null}
        {err ? <p className="text-[12.5px] text-bad">{err}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => close()} className="min-h-11 rounded-full px-4 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg">
            Cancel
          </button>
          <button type="button" onClick={() => void go()} disabled={busy || (needsClient && !clientId.trim())} className="min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40">
            {busy ? "Checking the server…" : "Offer to the team"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Editor({ c }: { c: AdminItem | null }) {
  const router = useRouter();
  const [name, setName] = useState(c?.name ?? "");
  const [key, setKey] = useState(c?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(Boolean(c));
  const [url, setUrl] = useState(c?.url ?? "");
  const [auth, setAuth] = useState<AuthKind>(c?.auth ?? "oauth");
  const [clientId, setClientId] = useState(c?.client_id ?? "");
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [scopes, setScopes] = useState(c?.scopes ?? "");
  const [roles, setRoles] = useState<string[]>(c?.roles ?? []);
  const [note, setNote] = useState(c?.note ?? "");
  const [icon, setIcon] = useState(c?.icon_url ?? "");
  const [enabled, setEnabled] = useState(c?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const shownKey = keyTouched ? key : keyFrom(name || "");
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
          ? "It signs in with OAuth and registers Kaizen Ads on its own. Nothing else to add."
          : r.suggested === "oauth_client"
            ? "It signs in with OAuth but doesn't register apps itself: register an app with the service and paste its client id and secret."
            : "It asks for a sign in but has no OAuth details: people paste a personal token.",
    );
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    const r = await saveConnector({ id: c?.id ?? null, key: shownKey, name, icon_url: icon, url, auth, client_id: clientId, client_secret: secret, scopes, note, roles, enabled });
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    close(true);
  };

  const remove = async () => {
    if (!c) return;
    if (!sure) return setSure(true);
    setBusy(true);
    const r = await deleteConnector(c.id);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    close(true);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end md:place-items-center" role="dialog" aria-modal aria-label={c ? `Edit ${c.name}` : "Add a connector"}>
      <button type="button" className="absolute inset-0 bg-deep/40 backdrop-blur-[2px]" onClick={() => close()} aria-label="Close" />
      <div className="relative grid max-h-[92dvh] w-full max-w-[560px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-t-[24px] border border-line bg-surface shadow-2xl md:rounded-[24px]">
        <header className="flex items-center gap-3 border-b border-line/70 px-5 py-4">
          <ConnectorIcon name={name || "?"} url={icon || null} size={36} />
          <p className="min-w-0 flex-1 truncate font-heading text-[20px] text-fg">{c ? c.name : "Add a connector"}</p>
          <button type="button" onClick={() => close()} className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-ink/[0.05] hover:text-fg" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className="grid content-start gap-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shopify" className={field} />
            </label>
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Key</span>
              <input
                value={shownKey}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value.toLowerCase());
                }}
                placeholder="shopify"
                className={field}
              />
            </label>
          </div>
          <label className="grid gap-1.5">
            <span className="text-[12.5px] text-muted">Remote MCP server URL</span>
            <div className="flex gap-2">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" inputMode="url" className={field} />
              <button type="button" onClick={() => void runCheck()} disabled={!url.trim()} className="min-h-11 shrink-0 rounded-full border border-line px-4 text-[13px] text-fg hover:border-brand/40 disabled:opacity-40">
                Check
              </button>
            </div>
            {check ? <span className="text-[12.5px] text-muted">{check}</span> : <span className="text-[12px] text-faint">Streamable HTTP or SSE. In Claude, it&apos;s the URL in the connector&apos;s settings.</span>}
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
                <span className="text-[12.5px] text-muted">Client id</span>
                <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" className={field} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[12.5px] text-muted">Client secret</span>
                <input type="password" value={secret ?? ""} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={c?.hasSecret ? "Saved (type to replace)" : "Optional for public clients"} className={field} />
              </label>
              <p className="text-[12px] text-faint sm:col-span-2">
                Redirect URL to register with the service: <span className="select-all text-muted">{`${(process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "")}/api/connectors/callback`}</span>
              </p>
            </div>
          ) : null}
          {auth === "oauth" || auth === "oauth_client" ? (
            <label className="grid gap-1.5">
              <span className="text-[12.5px] text-muted">Scopes (optional)</span>
              <input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="What the server asks for" className={field} />
            </label>
          ) : null}
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[12.5px] text-muted">Offered to</legend>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={!roles.length} onClick={() => setRoles([])} className={`min-h-10 rounded-full border px-3.5 text-[12.5px] ${!roles.length ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted"}`}>
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
                    className={`min-h-10 rounded-full border px-3.5 text-[12.5px] ${on ? "border-brand bg-brand-soft/40 text-fg" : "border-line text-muted hover:text-fg"}`}
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
          <label className="grid gap-1.5">
            <span className="text-[12.5px] text-muted">Icon URL (optional)</span>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="https://…/icon.png" inputMode="url" className={field} />
          </label>
          <button type="button" role="switch" aria-checked={enabled} onClick={() => setEnabled(!enabled)} className="flex min-h-11 items-center justify-between gap-3 rounded-[12px] px-1 text-left">
            <span className="text-[13.5px] text-fg">Offered in Kaizen AI</span>
            <span className={`relative h-6 w-10 shrink-0 rounded-full transition ${enabled ? "bg-brand" : "bg-ink/[0.15]"}`} aria-hidden>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${enabled ? "left-[18px]" : "left-0.5"}`} />
            </span>
          </button>
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line/70 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {err ? <p className="w-full text-[12.5px] text-bad">{err}</p> : null}
          {c ? (
            <button type="button" onClick={() => void remove()} disabled={busy} className={`min-h-11 rounded-full px-4 text-[13px] ${sure ? "bg-bad text-white" : "text-bad hover:bg-bad-soft/40"}`}>
              {sure ? "Remove for everyone" : "Remove"}
            </button>
          ) : null}
          <button type="button" onClick={() => close()} className="ml-auto min-h-11 rounded-full px-4 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !url.trim()} className="min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ─── Everyone: their own connections ───────────────────────────────────────

export function MyConnections({ items, isExec }: { items: MineItem[]; isExec: boolean }) {
  const focus = useParam("connector");
  const connected = useParam("connected");
  const error = useParam("connect_error");
  const flash = error ?? (connected ? `${items.find((i) => i.key === connected)?.name ?? "It"} is connected. Switch it on in any Kaizen AI chat from the plug button.` : null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <p className="max-w-[680px] text-sm text-muted">
        Connect your own accounts to use them in Kaizen AI, the same way you do in Claude. Your sign ins are stored encrypted and only ever used for your own chats; anything that would change
        something in a service asks you first.
      </p>
      {flash ? (
        <div className={`flex items-center justify-between gap-3 rounded-[14px] px-4 py-3 text-[13px] text-fg ${error ? "bg-bad-soft/50" : "bg-ok-soft/60"}`}>
          {flash}
          <button type="button" onClick={() => replaceParams({ connected: null, connect_error: null })} className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-ink/[0.05]" aria-label="Dismiss">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ) : null}
      {!items.length ? (
        <div className="grid justify-items-center gap-2 rounded-[18px] border border-dashed border-line px-6 py-12 text-center">
          <p className="font-heading text-[18px] text-fg">Nothing to connect yet</p>
          <p className="max-w-[420px] text-[13px] text-muted">{isExec ? "Add the services the team uses in Settings, Connectors." : "When an exec adds a service for your role, it shows up here."}</p>
        </div>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
          {items.map((i) => (
            <Row key={i.key} i={i} focused={focus === i.key} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ i, focused }: { i: MineItem; focused: boolean }) {
  const router = useRouter();
  const [pasting, setPasting] = useState(focused && i.auth === "token" && i.state !== "connected");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const back = connectionsHref(i.key);
  const pill =
    i.state === "connected" ? <Pill tone="ok">Connected</Pill> : i.state === "reconnect" ? <Pill tone="warn">Sign in expired</Pill> : i.state === "open" ? <Pill tone="ok">Ready</Pill> : <Pill tone="off">Not connected</Pill>;

  const saveToken = async () => {
    setBusy(true);
    setErr(null);
    const r = await savePersonalTokenAction(i.key, token);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    setToken("");
    setPasting(false);
    router.refresh();
  };
  const remove = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    const r = await disconnectAction(i.key);
    setBusy(false);
    setSure(false);
    if (!r.ok) return setErr(r.error);
    router.refresh();
  };
  const primary = "inline-flex min-h-11 items-center rounded-full bg-brand px-5 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-40";
  const quiet = "inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg hover:border-brand/40 disabled:opacity-40";

  return (
    <li className={`grid content-start gap-3 rounded-[18px] border bg-surface p-4 md:p-5 ${focused ? "border-brand/50 ring-4 ring-brand/10" : "border-line"}`}>
      <div className="flex items-start gap-3">
        <ConnectorIcon name={i.name} url={i.icon_url} size={40} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-heading text-[17px] leading-tight text-fg">{i.name}</p>
          {i.note ? <p className="text-[12.5px] text-muted">{i.note}</p> : null}
        </div>
        {pill}
      </div>
      {i.state === "connected" || i.state === "reconnect" ? (
        <p className="text-[12px] text-faint">
          {i.since ? `Connected ${when(i.since)}` : null}
          {i.last4 ? ` · ending ${i.last4}` : null}
          {i.tools ? ` · ${i.tools} tools${i.writes ? `, ${i.writes} ask you first` : ""}` : null}
          {i.lastUsed ? ` · last used ${when(i.lastUsed)}` : null}
        </p>
      ) : null}
      {i.state === "reconnect" && i.error ? <p className="text-[12.5px] text-bad">{i.error}</p> : null}
      {pasting ? (
        <div className="grid gap-2">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder={`Your ${i.name} API token`} className={field} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPasting(false)} className="min-h-11 rounded-full px-4 text-[13px] text-muted hover:bg-ink/[0.05] hover:text-fg">
              Cancel
            </button>
            <button type="button" onClick={() => void saveToken()} disabled={busy || token.trim().length < 8} className={primary}>
              {busy ? "Checking…" : "Save token"}
            </button>
          </div>
        </div>
      ) : null}
      {err ? <p className="text-[12.5px] text-bad">{err}</p> : null}
      {i.state !== "open" && !pasting ? (
        <div className="flex flex-wrap justify-end gap-2">
          {i.state !== "not_connected" ? (
            <button type="button" onClick={() => void remove()} disabled={busy} className={`min-h-11 rounded-full px-4 text-[13px] ${sure ? "bg-bad text-white" : "text-muted hover:bg-ink/[0.05] hover:text-fg"}`}>
              {sure ? "Disconnect for good" : "Disconnect"}
            </button>
          ) : null}
          {i.state !== "connected" || i.auth === "token" ? (
            i.auth === "token" ? (
              <button type="button" onClick={() => setPasting(true)} className={i.state === "connected" ? quiet : primary}>
                {i.state === "connected" ? "Replace token" : i.state === "reconnect" ? "Paste a new token" : "Paste token"}
              </button>
            ) : (
              <a href={connectHref(i.key, back)} className={primary}>
                {i.state === "reconnect" ? "Reconnect" : "Connect"}
              </a>
            )
          ) : (
            <a href={connectHref(i.key, back)} className={quiet}>
              Reconnect
            </a>
          )}
        </div>
      ) : null}
    </li>
  );
}
