"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  loadBusinessTokens,
  recheckClientBusinessToken,
  removeClientBusinessToken,
  saveClientBusinessToken,
  type BusinessTokenView,
  type BusinessTokensResult,
} from "@/app/(team)/settings/meta-token-actions";

type Loaded = Extract<BusinessTokensResult, { ok: true }>;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null);
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

const STATUS = {
  active: { label: "Working", chip: "bg-ok-soft text-ok", dot: "bg-ok" },
  invalid: { label: "Stopped working", chip: "bg-bad-soft text-bad", dot: "bg-bad" },
  revoked: { label: "Removed", chip: "bg-surface-2 text-muted", dot: "bg-faint" },
} as const;

/**
 * Client Business Manager connections (execs only). On a client's Team & setup: connect the client's own Business
 * Manager with a token from a system user there, for ad accounts Kaizen's system user can't reach. In Sync health:
 * every connection, its status, the accounts it reaches and its last check. The token goes in once and never
 * comes back: only its business, last 4 characters, permissions and expiry are shown.
 */
export function MetaBusinessConnections({ clientId, slug }: { clientId?: string; slug?: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ replaceId: string | null; name: string | null } | null>(null);
  const reload = useCallback(() => {
    loadBusinessTokens(clientId)
      .catch(() => ({ ok: false as const, error: "Couldn't load the connections." }))
      .then((r) => {
        if (r.ok) {
          setData(r);
          setError(null);
        } else setError(r.error);
      });
  }, [clientId]);
  useEffect(() => {
    let live = true;
    loadBusinessTokens(clientId)
      .catch(() => ({ ok: false as const, error: "Couldn't load the connections." }))
      .then((r) => {
        if (!live) return;
        if (r.ok) setData(r);
        else setError(r.error);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const onClient = Boolean(clientId);
  const tokens = data?.tokens ?? [];
  const kpi = data?.kpiAccounts ?? [];
  const covered = new Map<string, BusinessTokenView>();
  for (const t of tokens) if (t.status === "active") for (const a of t.accounts) if (kpi.includes(a.account) && !covered.has(a.account)) covered.set(a.account, t);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className={onClient ? "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint" : "font-heading text-lg"}>{onClient ? "Client's own Business Manager" : "Client business connections"}</p>
          <p className="text-[12px] text-faint">
            {onClient ? "For ad accounts in their Business Manager that Kaizen's system user can't be given." : "Tokens from system users in clients' own Business Managers. Checked with Meta every day."}
          </p>
        </div>
        {onClient && data?.encryption && !form && (
          <button
            type="button"
            onClick={() => setForm({ replaceId: null, name: null })}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-brand px-4 text-[13px] font-medium text-white hover:bg-brand-hover sm:w-auto md:min-h-9"
          >
            Connect this client&rsquo;s Business Manager
          </button>
        )}
      </div>

      {error && <p className="text-[13px] text-bad">{error}</p>}
      {!data && !error && <div className="h-14 animate-pulse rounded-[14px] bg-surface-2" aria-label="Loading connections" />}
      {data && !data.encryption && (
        <p className="rounded-[12px] border border-warn/35 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg">
          Add TOKEN_ENCRYPTION_KEY in Vercel first: a client&rsquo;s token can only be stored encrypted. Everything else keeps working with Kaizen&rsquo;s own token.
        </p>
      )}

      {onClient && data && kpi.length > 0 && (
        <ul className="grid gap-1 rounded-[12px] border border-line bg-bg/50 px-3.5 py-3">
          <li className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Their Meta ad accounts are reached</li>
          {kpi.map((a) => {
            const t = covered.get(a);
            return (
              <li key={a} className="tabular break-words text-[13px]">
                <span className="font-medium">{a}</span> <span className="text-muted">· {t ? `via ${t.businessName ?? t.label ?? "the client"}'s business` : "via Kaizen's business"}</span>
              </li>
            );
          })}
        </ul>
      )}

      {form && clientId && (
        <ConnectForm
          clientId={clientId}
          slug={slug ?? null}
          replaceId={form.replaceId}
          replacing={form.name}
          onDone={() => {
            setForm(null);
            reload();
          }}
          onCancel={() => setForm(null)}
        />
      )}

      {data && tokens.length > 0 && (
        <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
          {tokens.map((t) => (
            <Connection key={t.id} t={t} kpi={kpi} slug={slug ?? null} canReplace={onClient && data.encryption} onReplace={() => setForm({ replaceId: t.id, name: t.businessName ?? t.label })} onChanged={reload} />
          ))}
        </ul>
      )}
      {data && !tokens.length && (
        <p className="text-[13px] text-muted">{onClient ? "Not connected. Their accounts use Kaizen's own token." : "No client business is connected. Connect one from the client's Team & setup."}</p>
      )}

      <HowTo />
    </div>
  );
}

function ConnectForm({ clientId, slug, replaceId, replacing, onDone, onCancel }: { clientId: string; slug: string | null; replaceId: string | null; replacing: string | null; onDone: () => void; onCancel: () => void }) {
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await saveClientBusinessToken({ clientId, token, label: label.trim() || null, replaceId, slug }).catch(() => ({ ok: false as const, error: "Couldn't save. Try again." }));
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
      className="grid gap-3 rounded-[14px] border border-line bg-surface p-4"
      autoComplete="off"
    >
      <p className="text-[14px] font-medium">{replaceId ? `Replace the token for ${replacing ?? "this business"}` : "Connect this client's Business Manager"}</p>
      <label className="grid gap-1">
        <span className="text-[12px] text-muted">System user token</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="Paste the token generated in their Business Manager"
          className="h-11 w-full rounded-[12px] border border-line bg-bg px-3 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-faint focus:border-brand/60"
        />
      </label>
      {!replaceId && (
        <label className="grid gap-1">
          <span className="text-[12px] text-muted">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder="e.g. Their main Business Manager"
            className="h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] outline-none placeholder:text-faint focus:border-brand/60"
          />
        </label>
      )}
      <p className="text-[12px] leading-relaxed text-faint">Meta checks it first: Kaizen&rsquo;s app, ads_management, ads_read and business_management, and which ad accounts it reaches. It&rsquo;s stored encrypted and never shown again.</p>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !token.trim()} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60 sm:flex-none md:min-h-9">
          {pending ? "Checking with Meta…" : replaceId ? "Replace" : "Connect"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="inline-flex min-h-11 items-center justify-center rounded-full border border-line px-5 text-[14px] text-muted hover:text-fg disabled:opacity-60 md:min-h-9">
          Cancel
        </button>
      </div>
    </form>
  );
}

function Connection({ t, kpi, slug, canReplace, onReplace, onChanged }: { t: BusinessTokenView; kpi: string[]; slug: string | null; canReplace: boolean; onReplace: () => void; onChanged: () => void }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const s = STATUS[t.status];
  const name = t.businessName ?? t.label ?? "Client business";
  const manage = t.accounts.filter((a) => a.canManage).length;
  return (
    <li className="grid min-w-0 gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-0.5">
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words text-[14.5px] font-medium">{name}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.chip}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
              {s.label}
            </span>
          </p>
          <p className="tabular break-words text-[12px] text-faint">
            {[t.label && t.businessName ? t.label : null, t.businessId ? `Business ${t.businessId}` : null, t.last4 ? `token ending ${t.last4}` : null, t.systemUser ? `system user ${t.systemUser}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              start(async () => {
                const r = await recheckClientBusinessToken(t.id, slug).catch(() => ({ ok: false as const, error: "Couldn't reach Meta." }));
                setError(r.ok ? null : r.error);
                onChanged();
              })
            }
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-60 sm:flex-none md:min-h-9"
          >
            {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
            Check again
          </button>
          {canReplace && (
            <button type="button" disabled={busy} onClick={onReplace} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-60 sm:flex-none md:min-h-9">
              Replace
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm(`Remove the connection to ${name}? The saved token is deleted, and its ad accounts go back to Kaizen's own token (which may not reach them).`)) return;
              start(async () => {
                const r = await removeClientBusinessToken(t.id, slug).catch(() => ({ ok: false as const, error: "Couldn't remove it." }));
                setError(r.ok ? null : r.error);
                onChanged();
              });
            }}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-bad/30 px-3.5 text-[12.5px] text-bad hover:bg-bad-soft disabled:opacity-60 sm:flex-none md:min-h-9"
          >
            Remove
          </button>
        </div>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-faint">Permissions</dt>
        <dd className="text-muted [overflow-wrap:anywhere]">{t.scopes.length ? t.scopes.join(", ") : "None read"}</dd>
        <dt className="text-faint">Expires</dt>
        <dd className="text-muted">{t.expiresAt ? when(t.expiresAt) : "Never"}</dd>
        <dt className="text-faint">Last checked</dt>
        <dd className="text-muted">{ago(t.lastCheckedAt)}</dd>
        <dt className="text-faint">Connected</dt>
        <dd className="text-muted">
          {when(t.createdAt)}
          {t.createdBy ? ` by ${t.createdBy}` : ""}
        </dd>
      </dl>
      {(t.lastError || error) && <p className="break-words text-[12.5px] text-bad">{error ?? t.lastError}</p>}

      <div className="grid gap-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Reaches {t.accounts.length} ad {t.accounts.length === 1 ? "account" : "accounts"}
          {t.accounts.length ? ` · can change ${manage}` : ""}
        </p>
        {t.accounts.length > 0 && (
          <ul className="grid gap-1">
            {t.accounts.map((a) => (
              <li key={a.account} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                <span className="tabular break-words">
                  <span className="font-medium">{a.name ?? "Ad account"}</span> <span className="text-muted">· {a.account}</span>
                </span>
                {kpi.includes(a.account) && <span className="rounded-full bg-brand/10 px-1.5 py-px text-[10.5px] font-medium text-brand-text">This client&rsquo;s KPI account</span>}
                <span className={`rounded-full px-1.5 py-px text-[10.5px] font-medium ${a.canManage ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{a.canManage ? "Can change" : "View only"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function HowTo() {
  return (
    <details className="group rounded-[12px] border border-line bg-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-fg">
        How to connect a client&rsquo;s Business Manager
        <span className="text-faint transition-transform group-open:rotate-180" aria-hidden>
          ⌄
        </span>
      </summary>
      <ol className="mt-2 grid list-decimal gap-1.5 pl-5">
        <li>Give the client&rsquo;s business access to Kaizen&rsquo;s app: from their Business Manager, Request access to an app ID (Kaizen&rsquo;s app), or from Kaizen&rsquo;s Business Manager, the app › Assign partners › their business ID.</li>
        <li>In the client&rsquo;s Business Manager: Users › System users › Add (Admin).</li>
        <li>Assign that system user their ad accounts with Manage campaigns (full control is fine), their Pages, and Kaizen&rsquo;s app.</li>
        <li>Generate new token for the system user, with Kaizen&rsquo;s app selected, set to never expire, with ads_management, ads_read and business_management (plus pages_read_engagement and pages_show_list).</li>
        <li>Paste it here with Connect. Kaizen Ads checks it with Meta and lists the accounts it reaches.</li>
      </ol>
      <p className="mt-2 text-faint">Don&rsquo;t use Connect an app ID in their Business Manager: it can move the app&rsquo;s ownership to them.</p>
    </details>
  );
}
