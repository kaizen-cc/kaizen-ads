"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { field } from "@/components/ui";
import { useParam } from "@/lib/url-state";
import { disconnectTikTokAction, linkTikTokAccount, loadTikTok, syncTikTokNow, type TikTokView } from "@/app/(team)/settings/tiktok-actions";

type Ready = Extract<TikTokView, { state: "ready" }>;
type Advertiser = Ready["advertisers"][number];

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const btn = "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg disabled:opacity-60 sm:flex-none md:min-h-9";
const primary = "inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-brand px-4 text-[12.5px] font-medium text-white hover:bg-brand-hover sm:flex-none md:min-h-9";

/**
 * Settings › Sync health › TikTok (execs). Before Kaizen's TikTok app is approved and its keys are in Vercel, only the
 * waiting state. Then: connect with TikTok (OAuth), the ad accounts the grant reaches, and the client each belongs to
 * (linked by name when it's clear, otherwise picked here, with the likeliest clients first). Read only: Kaizen Ads pulls
 * TikTok's numbers and changes nothing there.
 */
export function TikTokConnection() {
  const [data, setData] = useState<TikTokView | null>(null);
  const notice = useParam("tiktok");
  const reload = useCallback(() => {
    loadTikTok()
      .catch((): TikTokView => ({ state: "not_ready", error: "Couldn't load TikTok." }))
      .then(setData);
  }, []);
  useEffect(() => {
    let live = true;
    loadTikTok()
      .catch((): TikTokView => ({ state: "not_ready", error: "Couldn't load TikTok." }))
      .then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid min-w-0 gap-0.5">
        <p className="font-heading text-lg">TikTok Ads</p>
        <p className="text-[12.5px] leading-relaxed text-faint">TikTok&rsquo;s numbers on the KPI board, client pages, reports and the AI. Read only: nothing is changed in TikTok from Kaizen Ads.</p>
      </div>
      {notice && <Notice text={notice} />}
      {!data && <div className="h-14 animate-pulse rounded-[14px] bg-surface-2" aria-label="Loading TikTok" />}
      {data?.state === "waiting" && (
        <div className="grid gap-1.5 rounded-[14px] border border-dashed border-line bg-surface px-4 py-4">
          <p className="flex items-center gap-2 text-[14px] font-medium">
            <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
            Waiting on TikTok approval: add TIKTOK_APP_ID and TIKTOK_APP_SECRET in Vercel
          </p>
          <p className="text-[12.5px] leading-relaxed text-faint">Nothing runs until both are set: no syncs, no TikTok on the KPI board.</p>
        </div>
      )}
      {data?.state === "not_ready" && <p className="rounded-[12px] border border-bad/30 bg-bad-soft/40 px-3 py-2 text-[12.5px] text-bad">{data.error}</p>}
      {data?.state === "ready" && <Ready data={data} onChanged={reload} />}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  const ok = text.startsWith("connected");
  const n = ok ? Number(text.split(":")[1] ?? 0) : 0;
  return (
    <p className={`rounded-[12px] px-3 py-2 text-[12.5px] ${ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`} role="status">
      {ok ? `TikTok connected: ${n} ad ${n === 1 ? "account" : "accounts"} found. The first 90 days are being pulled.` : text}
    </p>
  );
}

function Ready({ data, onChanged }: { data: Ready; onChanged: () => void }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const active = data.connections.filter((c) => c.status === "active");
  const linked = data.advertisers.filter((a) => a.clientId);
  const unlinked = data.advertisers.filter((a) => !a.clientId);
  return (
    <div className="grid min-w-0 gap-4">
      {!data.encryption && (
        <p className="rounded-[12px] border border-warn/35 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg">Add TOKEN_ENCRYPTION_KEY in Vercel first: TikTok&rsquo;s token can only be stored encrypted.</p>
      )}

      <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <p className="flex items-center gap-2 text-[14.5px] font-medium">
              <span className={`h-2 w-2 rounded-full ${active.length ? "bg-ok" : data.connections.length ? "bg-bad" : "bg-faint"}`} aria-hidden />
              {active.length ? "Connected" : data.connections.length ? "Stopped working" : "Not connected"}
            </p>
            <p className="tabular text-[12px] text-faint">
              {data.advertisers.length} ad {data.advertisers.length === 1 ? "account" : "accounts"} found · {linked.length} linked to clients
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
            {data.encryption && (
              <a href="/api/tiktok/connect" className={active.length ? btn : primary}>
                {active.length ? "Reconnect" : data.connections.length ? "Reconnect TikTok" : "Connect TikTok"}
              </a>
            )}
            {active.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    const r = await syncTikTokNow().catch(() => ({ ok: false as const, error: "Couldn't reach TikTok." }));
                    setError(r.ok ? null : r.error);
                    onChanged();
                  })
                }
                className={btn}
              >
                {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
                {busy ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
        </div>
        {data.connections.length > 0 && (
          <ul className="grid divide-y divide-line overflow-hidden rounded-[12px] border border-line">
            {data.connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[12.5px]">
                <span className="grid min-w-0 gap-0.5">
                  <span className={c.status === "active" ? "text-fg" : "text-bad"}>
                    {c.status === "active" ? "Working" : "TikTok refused this token: reconnect"} · token ending {c.last4 ?? "????"}
                  </span>
                  <span className="tabular text-faint [overflow-wrap:anywhere]">
                    {c.advertisers} ad {c.advertisers === 1 ? "account" : "accounts"} · connected {when(c.connectedAt)}
                    {c.by ? ` by ${c.by}` : ""}
                    {c.scopes.length ? ` · ${c.scopes.length} permissions` : ""}
                  </span>
                  {c.error && <span className="break-words text-bad">{c.error}</span>}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm("Disconnect this TikTok grant? Its token is deleted; the numbers already pulled stay.")) return;
                    start(async () => {
                      const r = await disconnectTikTokAction(c.id).catch(() => ({ ok: false as const, error: "Couldn't disconnect." }));
                      setError(r.ok ? null : r.error);
                      onChanged();
                    });
                  }}
                  className="inline-flex min-h-11 items-center rounded-full border border-bad/30 px-3.5 text-[12.5px] text-bad hover:bg-bad-soft disabled:opacity-60 md:min-h-9"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="break-words text-[12.5px] text-bad">{error}</p>}
      </section>

      {unlinked.length > 0 && (
        <section className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
            Not linked to a client <span className="tabular">· {unlinked.length}</span>
          </p>
          <ul className="grid gap-2">
            {unlinked.map((a) => (
              <AdvertiserRow key={a.id} a={a} clients={data.clients} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}
      {linked.length > 0 && (
        <section className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
            Linked <span className="tabular">· {linked.length}</span>
          </p>
          <ul className="grid gap-2">
            {linked.map((a) => (
              <AdvertiserRow key={a.id} a={a} clients={data.clients} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One TikTok ad account: whose it is (save on change), with the likeliest clients one tap away when it's not linked */
function AdvertiserRow({ a, clients, onChanged }: { a: Advertiser; clients: { id: string; name: string }[]; onChanged: () => void }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const link = (clientId: string | null) =>
    start(async () => {
      const r = await linkTikTokAccount(a.id, clientId).catch(() => ({ ok: false as const, error: "Couldn't save." }));
      setError(r.ok ? null : r.error);
      onChanged();
    });
  return (
    <li className={`grid min-w-0 gap-2 rounded-[12px] border border-line bg-surface px-4 py-3 transition-opacity sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center ${busy ? "opacity-60" : ""}`}>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-sm">{a.name ?? a.id}</span>
        <span className="tabular text-[11.5px] text-faint [overflow-wrap:anywhere]">
          {a.id} · {a.currency ?? "?"} · {a.timezone ?? "?"} · {a.status}
          {a.clientId ? ` · synced ${ago(a.lastSynced)}` : ""}
        </span>
        {a.error && <span className="break-words text-[11.5px] text-bad">{a.error}</span>}
        {error && <span className="break-words text-[11.5px] text-bad">{error}</span>}
      </span>
      <span className="grid min-w-0 gap-1.5">
        {!a.clientId && a.suggestions.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {a.suggestions.map((s) => (
              <button key={s.id} type="button" disabled={busy} onClick={() => link(s.id)} className="inline-flex min-h-11 items-center rounded-full border border-brand/40 bg-brand-soft px-3 text-[12px] text-brand-text hover:border-brand md:min-h-8">
                Link to {s.name}
              </button>
            ))}
          </span>
        )}
        <select aria-label={`Client for ${a.name ?? a.id}`} value={a.clientId ?? ""} disabled={busy} onChange={(e) => link(e.target.value || null)} className={`${field} min-w-0`}>
          <option value="">{a.clientId ? "Unlink" : "Whose account is this?"}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </span>
    </li>
  );
}
