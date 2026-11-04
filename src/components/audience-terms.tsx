"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { checkAudienceTerms, type TermsRow } from "@/app/(team)/settings/meta-write-actions";

type Loaded = { rows: TermsRow[]; tokenMissing: string[] };

/**
 * Can Kaizen Ads change each Meta ad account? Per account: is our system user assigned with Manage campaigns (or only
 * view, or not at all), and has the account accepted Meta's Custom Audience terms (without them Meta refuses any change
 * to an ad set that targets a customer list, pausing too). Plus the token's own permissions, once.
 * One client's accounts (the live-changes widget) or every client's (Sync health).
 */
export function AudienceTermsCheck({ clientId }: { clientId?: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOk, setShowOk] = useState(false);
  const apply = useCallback((r: Awaited<ReturnType<typeof checkAudienceTerms>>) => {
    if (r.ok) {
      setData({ rows: r.rows, tokenMissing: r.tokenMissing });
      setError(null);
    } else setError(r.error);
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    const r = await checkAudienceTerms(clientId).catch(() => ({ ok: false as const, error: "Couldn't reach Meta. Try again." }));
    setBusy(false);
    apply(r);
  }, [clientId, apply]);
  useEffect(() => {
    let live = true;
    checkAudienceTerms(clientId)
      .catch(() => ({ ok: false as const, error: "Couldn't reach Meta. Try again." }))
      .then((r) => {
        if (live) apply(r);
      });
    return () => {
      live = false;
    };
  }, [clientId, apply]);

  const rows = data?.rows ?? null;
  const all = !clientId;
  const good = (r: TermsRow) => r.access === "manage" && r.accepted === true;
  const issues = (rows ?? []).filter((r) => !good(r));
  const ok = (rows ?? []).filter(good);
  const n = (k: (r: TermsRow) => boolean) => (rows ?? []).filter(k).length;
  const unassigned = n((r) => r.access === "none");
  const viewOnly = n((r) => r.access === "view");
  const terms = n((r) => r.access === "manage" && r.accepted === false);

  const pill = (tone: "ok" | "warn" | "bad", text: string) => (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}>{text}</span>
  );
  const button = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-full bg-brand px-3.5 text-[12.5px] font-medium text-white hover:bg-brand-hover">
      {label} ↗
    </a>
  );

  const row = (r: TermsRow) => (
    <li key={r.account} className="grid gap-2 rounded-[12px] border border-line bg-bg/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${good(r) ? "bg-ok" : r.access === "none" ? "bg-bad" : "bg-warn"}`} />
        <span className="min-w-0 flex-1 text-[13px]">
          {all && r.client && (r.slug ? <Link href={`/clients/${r.slug}?tab=team`} className="font-medium hover:underline">{r.client}</Link> : <span className="font-medium">{r.client}</span>)}
          {all && r.live && <span className="ml-2 rounded-full bg-ok-soft px-2 py-0.5 text-[10.5px] font-medium text-ok">Live changes on</span>}
          <span className={`block truncate text-[12px] ${all ? "text-faint" : "text-muted"}`}>
            {r.name ?? "Ad account"} · {r.account}
            {r.owner ? ` · owned by ${r.owner}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap gap-1.5">
          {r.access === "none" ? pill("bad", "Not assigned") : r.access === "view" ? pill("warn", "View only") : pill("ok", "Can make changes")}
          {r.access !== "none" && (r.accepted ? pill("ok", "Audience terms accepted") : pill("warn", "Audience terms missing"))}
        </span>
      </div>
      {r.access === "none" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">Our system user can&rsquo;t see this account, so nothing can be read or changed. Assign it: Business settings › Ad accounts › this account › Assign people › the system user › Manage campaigns. If the account belongs to the client, they first share it with our Business Manager as a partner (with Manage campaigns).</p>
          {button(r.assignUrl, "Assign the system user")}
        </div>
      )}
      {r.access === "view" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">Assigned, but only to view performance, so Meta refuses every change. Turn on Manage campaigns for the system user on this account{r.owner ? ` (if ${r.owner} shares it with us as a partner, their share needs Manage campaigns first)` : ""}.</p>
          {button(r.assignUrl, "Give Manage campaigns")}
        </div>
      )}
      {r.access !== "none" && r.accepted === false && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">Meta&rsquo;s Custom Audience terms aren&rsquo;t accepted, so Meta refuses changes to ad sets that target a customer list (pausing too). An admin of the account accepts them once{r.owner ? `; if it belongs to ${r.owner}, one of their admins` : ""}.</p>
          {button(r.url, "Accept the terms")}
        </div>
      )}
    </li>
  );

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Meta access for changes</p>
        <button type="button" disabled={busy} onClick={() => void load()} className="min-h-8 rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg disabled:opacity-60">
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      {!data && !error && <div className="h-12 animate-pulse rounded-[12px] bg-surface-2" />}
      {data && data.tokenMissing.length > 0 && (
        <p className="rounded-[12px] border border-bad/30 bg-bad-soft/40 px-3 py-2 text-[12.5px] leading-relaxed">
          The system user&rsquo;s token is missing {data.tokenMissing.join(", ")}, so changes fail on every account. In Business Manager: Users › System users › Generate new token with those ticked, then replace META_SYSTEM_USER_TOKEN in Vercel and redeploy.
        </p>
      )}
      {rows && !rows.length && <p className="text-[12.5px] text-muted">No Meta ad account is set up {all ? "for any client" : "for this client"} yet.</p>}
      {rows && rows.length > 0 && (
        <>
          {issues.length > 0 ? (
            <p className="text-[12.5px] leading-relaxed text-muted">
              {all ? `${issues.length} of ${rows.length} ad accounts can't take every change yet: ` : "Not every change will go through yet: "}
              {[unassigned && `${unassigned} not assigned to the system user`, viewOnly && `${viewOnly} view only`, terms && `${terms} missing the Custom Audience terms`].filter(Boolean).join(" · ")}. Fix each with its button, then Check again.
            </p>
          ) : (
            <p className="text-[12.5px] text-ok">{all ? `All ${rows.length} ad accounts are assigned with Manage campaigns and have accepted the Custom Audience terms.` : "Ready: the system user can make changes here and the Custom Audience terms are accepted."}</p>
          )}
          <ul className="grid gap-1.5">
            {issues.map(row)}
            {(!all || showOk) && ok.map(row)}
          </ul>
          {all && ok.length > 0 && (
            <button type="button" onClick={() => setShowOk((v) => !v)} className="justify-self-start text-[12px] text-muted hover:text-fg">
              {showOk ? "Hide the ready ones" : `Show the ${ok.length} ready`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
