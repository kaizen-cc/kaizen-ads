"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { field } from "@/components/ui";
import {
  connectBusinessManager,
  loadBusinessManagers,
  loadClientBusinessManager,
  recheckBusinessManager,
  removeBusinessManagerToken,
  addBusinessManagerAction,
  retireBusinessManagerAction,
  setClientBusinessManagerAction,
  type BusinessManagerView,
  type BusinessManagersResult,
  type ClientBusinessManager,
} from "@/app/(team)/settings/meta-token-actions";

type Loaded = Extract<BusinessManagersResult, { ok: true }>;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null);
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const STATUS = {
  active: { label: "Working", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  invalid: { label: "Stopped working", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  not_connected: { label: "Not connected", chip: "bg-surface-2 text-muted", dot: "bg-faint" },
  revoked: { label: "Removed", chip: "bg-surface-2 text-muted", dot: "bg-faint" },
} as const;

const SETTINGS_HREF = "/settings?tab=sync&view=meta";

/**
 * Settings › Sync health (execs): the four Business Managers Kaizen works through. Kaizen's uses its system user's
 * token in Vercel; each partner's (ZenChange, Get Me Friends, Blue Cherry Group) is pasted here once, checked with
 * Meta, stored encrypted and never shown again: only its status, last 4 characters, permissions, expiry, the ad
 * accounts it reaches and the clients on it.
 */
export function BusinessManagers() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string; name: string; replacing: boolean } | null>(null);
  const reload = useCallback(() => {
    loadBusinessManagers()
      .catch(() => ({ ok: false as const, error: "Couldn't load the Business Managers." }))
      .then((r) => {
        if (r.ok) {
          setData(r);
          setError(null);
        } else setError(r.error);
      });
  }, []);
  useEffect(() => {
    let live = true;
    loadBusinessManagers()
      .catch(() => ({ ok: false as const, error: "Couldn't load the Business Managers." }))
      .then((r) => {
        if (!live) return;
        if (r.ok) setData(r);
        else setError(r.error);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="font-heading text-lg">Business Managers</p>
        <p className="text-[12.5px] leading-relaxed text-faint">
          Each client&rsquo;s metrics are pulled and its changes made through the Business Manager picked in its Team &amp; setup. Kaizen is the default; partner tokens are checked with Meta every day.
        </p>
      </div>

      {error && <p className="text-[13px] text-bad">{error}</p>}
      {!data && !error && <div className="h-14 animate-pulse rounded-[14px] bg-surface-2" aria-label="Loading Business Managers" />}
      {data && !data.encryption && (
        <p className="rounded-[12px] border border-warn/35 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg">
          Add TOKEN_ENCRYPTION_KEY in Vercel first: a partner&rsquo;s token can only be stored encrypted. Until then every client runs through Kaizen&rsquo;s own token.
        </p>
      )}

      {data && (
        <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
          {data.managers.map((m) => (
            <Manager
              key={m.id}
              m={m}
              canConnect={data.encryption}
              form={form?.id === m.id ? form : null}
              onConnect={(replacing) => setForm({ id: m.id, name: m.name, replacing })}
              onCancel={() => setForm(null)}
              onChanged={() => {
                setForm(null);
                reload();
              }}
            />
          ))}
        </ul>
      )}
      {data && <AddManager onAdded={reload} />}

      <HowTo />
    </div>
  );
}

function Manager({
  m,
  canConnect,
  form,
  onConnect,
  onCancel,
  onChanged,
}: {
  m: BusinessManagerView;
  canConnect: boolean;
  form: { id: string; name: string; replacing: boolean } | null;
  onConnect: (replacing: boolean) => void;
  onCancel: () => void;
  onChanged: () => void;
}) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const s = STATUS[m.status];
  const connected = m.isDefault || m.status === "active" || m.status === "invalid";
  const manage = m.accounts.filter((a) => a.canManage).length;
  const btn = "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-60 sm:flex-none md:min-h-9";
  const meta = m.isDefault
    ? ["Uses Kaizen's system user (Vercel)", m.businessId ? `Business ${m.businessId}` : null, m.last4 ? `token ending ${m.last4}` : null]
    : [m.businessName && m.businessName !== m.name ? m.businessName : null, m.businessId ? `Business ${m.businessId}` : null, m.last4 ? `token ending ${m.last4}` : null, m.systemUser ? `system user ${m.systemUser}` : null];
  return (
    <li className="grid min-w-0 gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words text-[14.5px] font-medium">{m.name}</span>
            {m.isDefault && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand-text">Default</span>}
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.chip}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
              {s.label}
            </span>
          </p>
          <p className="tabular break-words text-[12px] text-faint">{meta.filter(Boolean).join(" · ") || "No token yet"}</p>
        </div>
        <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
          {!m.isDefault && !connected && canConnect && !form && (
            <button type="button" onClick={() => onConnect(false)} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-brand px-4 text-[12.5px] font-medium text-white hover:bg-brand-hover sm:flex-none md:min-h-9">
              Connect
            </button>
          )}
          {connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const r = await recheckBusinessManager(m.id).catch(() => ({ ok: false as const, error: "Couldn't reach Meta." }));
                  setError(r.ok ? null : r.error);
                  onChanged();
                })
              }
              className={btn}
            >
              {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
              {busy ? "Checking…" : "Check again"}
            </button>
          )}
          {!m.isDefault && connected && canConnect && !form && (
            <button type="button" disabled={busy} onClick={() => onConnect(true)} className={btn}>
              Replace
            </button>
          )}
          {!m.isDefault && connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const who = m.clientCount ? ` ${m.clientCount} ${m.clientCount === 1 ? "client goes" : "clients go"} back to Kaizen's own token, which may not reach their ad accounts.` : "";
                if (!confirm(`Remove ${m.name}'s token? The saved token is deleted.${who}`)) return;
                start(async () => {
                  const r = await removeBusinessManagerToken(m.id).catch(() => ({ ok: false as const, error: "Couldn't remove it." }));
                  setError(r.ok ? null : r.error);
                  onChanged();
                });
              }}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-bad/30 px-3.5 text-[12.5px] text-bad hover:bg-bad-soft disabled:opacity-60 sm:flex-none md:min-h-9"
            >
              Remove
            </button>
          )}
          {!m.isDefault && !form && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const who = m.clientCount ? ` ${m.clientCount} ${m.clientCount === 1 ? "client goes" : "clients go"} back to Kaizen.` : "";
                if (!confirm(`End the partnership with ${m.name}? It comes off the list and every client's picker, its token is deleted.${who}`)) return;
                start(async () => {
                  const r = await retireBusinessManagerAction(m.id).catch(() => ({ ok: false as const, error: "Couldn't remove it." }));
                  setError(r.ok ? null : r.error);
                  onChanged();
                });
              }}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-[12.5px] text-faint hover:text-bad disabled:opacity-60 sm:flex-none md:min-h-9"
            >
              End partnership
            </button>
          )}
        </div>
      </div>

      {form && <ConnectForm bmId={m.id} name={m.name} replacing={form.replacing} onDone={onChanged} onCancel={onCancel} />}

      {connected && (
        <dl className="grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-faint">Permissions</dt>
          <dd className="text-muted [overflow-wrap:anywhere]">{m.scopes.length ? m.scopes.join(", ") : "Not checked yet"}</dd>
          <dt className="text-faint">Expires</dt>
          <dd className="text-muted">{m.scopes.length ? (m.expiresAt ? when(m.expiresAt) : "Never") : "Not checked yet"}</dd>
          <dt className="text-faint">Last checked</dt>
          <dd className="text-muted">{ago(m.lastCheckedAt)}</dd>
          {!m.isDefault && m.connectedAt && (
            <>
              <dt className="text-faint">Connected</dt>
              <dd className="text-muted">
                {when(m.connectedAt)}
                {m.connectedBy ? ` by ${m.connectedBy}` : ""}
              </dd>
            </>
          )}
        </dl>
      )}
      {(m.lastError || error) && <p className="break-words text-[12.5px] text-bad">{error ?? m.lastError}</p>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="tabular">
          {m.clientCount} {m.clientCount === 1 ? "client" : "clients"} on it
        </span>
        {(connected || m.accounts.length > 0) && (
          <span className="tabular">
            Reaches {m.accounts.length} ad {m.accounts.length === 1 ? "account" : "accounts"}
            {m.accounts.length ? ` · can change ${manage}` : ""}
          </span>
        )}
      </div>
      {m.clients.length > 0 && (
        <p className="break-words text-[12.5px] leading-relaxed">
          {m.clients.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="text-faint">, </span>}
              <Link href={`/clients/${c.slug}?tab=team`} className="text-fg underline-offset-2 hover:underline">
                {c.name}
              </Link>
            </span>
          ))}
        </p>
      )}
      {m.accounts.length > 0 && (
        <details className="group text-[12.5px]">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-muted hover:text-fg">
            Ad accounts it reaches
            <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>
              ⌄
            </span>
          </summary>
          <ul className="mt-1 grid gap-1">
            {m.accounts.map((a) => (
              <li key={a.account} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="tabular break-words">
                  <span className="font-medium">{a.name ?? "Ad account"}</span> <span className="text-muted">· {a.account}</span>
                </span>
                <span className={`rounded-full px-1.5 py-px text-[10.5px] font-medium ${a.canManage ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{a.canManage ? "Can change" : "View only"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function ConnectForm({ bmId, name, replacing, onDone, onCancel }: { bmId: string; name: string; replacing: boolean; onDone: () => void; onCancel: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await connectBusinessManager({ bmId, token }).catch(() => ({ ok: false as const, error: "Couldn't save. Try again." }));
      // The field is cleared either way: the token is never kept on the page
      setToken("");
      if (r.ok) onDone();
      else setError(r.error);
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) submit();
      }}
      className="grid gap-3 rounded-[14px] border border-line bg-bg/50 p-4"
      autoComplete="off"
    >
      <p className="text-[14px] font-medium">{replacing ? `Replace ${name}'s token` : `Connect ${name}`}</p>
      <label className="grid gap-1">
        <span className="text-[12px] text-muted">System user token from {name}&rsquo;s Business Manager</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="Paste the token"
          className="h-11 w-full rounded-[12px] border border-line bg-bg px-3 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-faint focus:border-brand/60"
        />
      </label>
      <p className="text-[12px] leading-relaxed text-faint">Meta checks it first: Kaizen&rsquo;s app, ads_management, ads_read and business_management, and which ad accounts it reaches. It&rsquo;s stored encrypted and never shown again.</p>
      {error && <p className="break-words text-[12.5px] text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !token.trim()} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60 sm:flex-none md:min-h-9">
          {pending ? "Checking with Meta…" : replacing ? "Replace" : "Connect"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-5 text-[14px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
          Cancel
        </button>
      </div>
    </form>
  );
}

function HowTo() {
  return (
    <details className="group rounded-[12px] border border-line bg-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-fg">
        How to connect a partner&rsquo;s Business Manager
        <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      <ol className="mt-2 grid list-decimal gap-1.5 pl-5">
        <li>Give the partner&rsquo;s business access to Kaizen&rsquo;s app: from their Business Manager, Request access to an app ID (Kaizen&rsquo;s app), or from Kaizen&rsquo;s Business Manager, the app › Assign partners › their business ID.</li>
        <li>In the partner&rsquo;s Business Manager: Users › System users › Add (Admin).</li>
        <li>Assign that system user the client ad accounts with Manage campaigns (full control is fine), their Pages, and Kaizen&rsquo;s app.</li>
        <li>Generate new token for the system user, with Kaizen&rsquo;s app selected, set to never expire, with ads_management, ads_read, business_management, pages_read_engagement and pages_show_list.</li>
        <li>Paste it here with Connect. Kaizen Ads checks it with Meta and lists the accounts it reaches. Then pick the Business Manager in each of its clients&rsquo; Team &amp; setup.</li>
      </ol>
      <p className="mt-2 text-faint">Never use Connect an app ID in their Business Manager: it can move the app&rsquo;s ownership to them.</p>
    </details>
  );
}

/**
 * A client's Team & setup: which Business Manager its metrics are pulled and changes made through. One dropdown,
 * saved on change, execs only; everyone sees it. Under it, whether that Business Manager's token reaches each of the
 * client's Meta KPI accounts.
 */
export function ClientBusinessManagerSelect({ clientId, slug, canEdit }: { clientId: string; slug?: string; canEdit: boolean }) {
  const [data, setData] = useState<ClientBusinessManager | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const load = useCallback(
    () =>
      loadClientBusinessManager(clientId)
        .catch(() => ({ ok: false as const, error: "Couldn't load the Business Manager." }))
        .then((r) => {
          if (r.ok) {
            setData(r.data);
            setError(null);
          } else setError(r.error);
          return r;
        }),
    [clientId],
  );
  useEffect(() => {
    let live = true;
    loadClientBusinessManager(clientId)
      .catch(() => ({ ok: false as const, error: "Couldn't load the Business Manager." }))
      .then((r) => {
        if (!live) return;
        if (r.ok) setData(r.data);
        else setError(r.error);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const def = data?.options.find((o) => o.isDefault);
  const value = data?.selected ?? def?.id ?? "";
  const chosen = data?.options.find((o) => o.id === value);
  const notConnected = data?.options.some((o) => !o.isDefault && o.status !== "active") ?? false;

  return (
    <div className="grid min-w-0 gap-2.5 rounded-[12px] border border-line bg-bg/50 px-3.5 py-3">
      <label className="grid gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Business Manager</span>
        {data ? (
          <select
            value={value}
            disabled={!canEdit || pending}
            onChange={(e) => {
              const next = e.target.value;
              const prev = data;
              const pick = data.options.find((o) => o.id === next);
              setData({ ...data, selected: pick && !pick.isDefault ? next : null });
              setSaveError(null);
              setSaved(false);
              start(async () => {
                const r = await setClientBusinessManagerAction(clientId, pick && !pick.isDefault ? next : null, slug).catch(() => ({ ok: false as const, error: "Couldn't save. Try again." }));
                if (r.ok) {
                  setSaved(true);
                  await load();
                } else {
                  setData(prev);
                  setSaveError(r.error);
                }
              });
            }}
            className={`${field} max-w-md disabled:opacity-70`}
          >
            {data.options.map((o) => {
              const off = !o.isDefault && o.status !== "active";
              return (
                <option key={o.id} value={o.id} disabled={off && o.id !== value}>
                  {o.name}
                  {o.isDefault ? " (default)" : o.status === "invalid" ? " (stopped working)" : off ? " (not connected)" : ""}
                </option>
              );
            })}
          </select>
        ) : (
          !error && <div className="h-10 max-w-md animate-pulse rounded-[10px] bg-surface-2" aria-label="Loading" />
        )}
      </label>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      {saveError && <p className="text-[12.5px] text-bad">{saveError}</p>}
      {pending && <p className="text-[12px] text-faint">Saving…</p>}
      {!pending && saved && <p className="text-[12px] text-ok">Saved. Their metrics and changes now go through {chosen?.name ?? "it"}.</p>}
      {data && (
        <p className="text-[12px] leading-relaxed text-faint">
          Their metrics are pulled and changes made through {chosen && !chosen.isDefault ? `${chosen.name}'s` : "Kaizen's"} token.
          {canEdit && notConnected && (
            <>
              {" "}
              <Link href={SETTINGS_HREF} className="text-muted underline underline-offset-2 hover:text-fg">
                Connect a Business Manager in Settings
              </Link>
              .
            </>
          )}
          {!canEdit && " An exec changes it."}
        </p>
      )}
      {data && data.accounts.length > 0 && (
        <ul className="grid gap-1">
          {data.accounts.map((a) => (
            <li key={a.account} className="flex min-w-0 items-start gap-2 text-[12.5px]">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${a.ok ? "bg-ok" : "bg-warn"}`} aria-hidden />
              <span className="min-w-0 break-words">
                <span className="tabular font-medium">
                  {a.label ? `${a.label} · ` : ""}
                  {a.account}
                </span>{" "}
                <span className={a.ok ? "text-muted" : "text-warn"}>· {a.text}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && !data.accounts.length && <p className="text-[12px] text-faint">No Meta ad account is on the KPI board for them yet.</p>}
    </div>
  );
}

/** A new partner Business Manager: added by name, then connected with its token */
function AddManager({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 justify-self-start rounded-full border border-dashed border-line px-4 text-[12.5px] text-muted hover:border-brand/50 hover:text-fg md:min-h-9">
        + Add a Business Manager
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addBusinessManagerAction(name).catch(() => ({ ok: false as const, error: "Couldn't add it." }));
          if (!r.ok) return setError(r.error);
          setName("");
          setError(null);
          setOpen(false);
          onAdded();
        });
      }}
      className="grid gap-2 rounded-[14px] border border-line bg-surface p-3.5"
    >
      <label className="grid gap-1 text-[12.5px] text-muted">
        The partner&rsquo;s name (as the team calls it)
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="e.g. ZenChange" className="h-11 rounded-[10px] border border-line bg-bg px-3 text-[16px] text-fg outline-none focus:border-brand/60 md:h-9 md:text-sm" />
      </label>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || name.trim().length < 2} className="min-h-11 rounded-full bg-brand px-4 text-[12.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-50 md:min-h-9">
          {busy ? "Adding…" : "Add"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-full px-3 text-[12.5px] text-muted hover:text-fg md:min-h-9">
          Cancel
        </button>
      </div>
      <p className="text-[11.5px] text-faint">It shows in every client&rsquo;s Business Manager picker once it&rsquo;s connected with its token.</p>
    </form>
  );
}
