"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { checkAudienceTerms, type TermsRow } from "@/app/(team)/settings/meta-write-actions";

/**
 * Meta's Custom Audience terms, per ad account: until they're accepted, Meta refuses any change to an ad set that
 * targets a customer list (pausing too). One client's accounts (the live-changes widget) or every client's (Sync health).
 */
export function AudienceTermsCheck({ clientId }: { clientId?: string }) {
  const [rows, setRows] = useState<TermsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOk, setShowOk] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const r = await checkAudienceTerms(clientId).catch(() => ({ ok: false as const, error: "Couldn't reach Meta. Try again." }));
    setBusy(false);
    if (r.ok) {
      setRows(r.rows);
      setError(null);
    } else setError(r.error);
  }, [clientId]);
  useEffect(() => {
    let live = true;
    checkAudienceTerms(clientId)
      .catch(() => ({ ok: false as const, error: "Couldn't reach Meta. Try again." }))
      .then((r) => {
        if (!live) return;
        if (r.ok) setRows(r.rows);
        else setError(r.error);
      });
    return () => {
      live = false;
    };
  }, [clientId]);

  const missing = (rows ?? []).filter((r) => r.accepted === false);
  const unknown = (rows ?? []).filter((r) => r.accepted === null);
  const ok = (rows ?? []).filter((r) => r.accepted === true);
  const all = !clientId;

  const row = (r: TermsRow) => (
    <li key={r.account} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] border border-line bg-bg/40 px-3 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${r.accepted ? "bg-ok" : r.accepted === false ? "bg-warn" : "bg-faint"}`} />
      <span className="min-w-0 flex-1 text-[13px]">
        {all && r.client && (r.slug ? <Link href={`/clients/${r.slug}?tab=team`} className="font-medium hover:underline">{r.client}</Link> : <span className="font-medium">{r.client}</span>)}
        {all && r.live && <span className="ml-2 rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-medium text-ok">Live changes on</span>}
        <span className={`block truncate text-[12px] ${all ? "text-faint" : "text-muted"}`}>
          {r.name ?? "Ad account"} · {r.account}
          {r.accepted === null && r.error ? ` · couldn't read: ${r.error}` : ""}
        </span>
      </span>
      {r.accepted ? (
        <span className="text-[12px] text-ok">Accepted</span>
      ) : (
        <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-full bg-brand px-3.5 text-[12.5px] font-medium text-white hover:bg-brand-hover">
          Accept the terms ↗
        </a>
      )}
    </li>
  );

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Meta Custom Audience terms</p>
        <button type="button" disabled={busy} onClick={() => void load()} className="min-h-8 rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg disabled:opacity-60">
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      {rows === null && !error && <div className="h-12 animate-pulse rounded-[12px] bg-surface-2" />}
      {rows && !rows.length && <p className="text-[12.5px] text-muted">No Meta ad account is set up {all ? "for any client" : "for this client"} yet.</p>}
      {rows && rows.length > 0 && (
        <>
          {missing.length > 0 ? (
            <p className="rounded-[12px] border border-warn/30 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed">
              {all ? `${missing.length} of ${rows.length} ad accounts haven't` : missing.length === 1 ? "This ad account hasn't" : "These ad accounts haven't"} accepted Meta&rsquo;s Custom Audience terms. Until they do, Meta refuses any change to an ad set that targets a customer list, pausing included. Open the link signed in to Facebook as an admin of the account (if it belongs to the client&rsquo;s Business Manager, one of their admins has to accept), then Check again.
            </p>
          ) : (
            !unknown.length && <p className="text-[12.5px] text-ok">{all ? `All ${rows.length} ad accounts have accepted the Custom Audience terms.` : "Accepted: Meta will let us change ad sets that use customer lists here."}</p>
          )}
          <ul className="grid gap-1.5">
            {missing.map(row)}
            {unknown.map(row)}
            {(!all || showOk) && ok.map(row)}
          </ul>
          {all && ok.length > 0 && (
            <button type="button" onClick={() => setShowOk((v) => !v)} className="justify-self-start text-[12px] text-muted hover:text-fg">
              {showOk ? "Hide accepted" : `Show the ${ok.length} accepted`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
