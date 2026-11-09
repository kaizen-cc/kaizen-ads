"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { AudienceTermsCheck } from "@/components/audience-terms";
import { MetaBusinessConnections } from "@/components/meta-business-connections";
import { checkGoogleAccess, type GoogleAccessResult } from "../../settings/meta-write-actions";

type Result = { ok: true } | { ok: false; error: string };
type Platform = "meta" | "google";

/** An ad account a switch opens: read from the client's KPI targets, the same way the write gates read them */
export type WriteAccountView = { account: string; label: string | null; targetId: string; active: boolean };

export type LiveWritesData = {
  meta: { on: boolean; by: string | null; at: string | null; globalOn: boolean; accounts: WriteAccountView[]; field: string | null; sandboxAccount: string };
  google: { on: boolean; by: string | null; at: string | null; accounts: WriteAccountView[] };
};

/** Google shows customer IDs as 123-456-7890 */
export const googleId = (a: string) => a.replace(/\D/g, "").replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");

const day = (at: string | null) => (at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null);

/**
 * Live changes in this client's ad accounts, one switch per platform: an exec switches Meta and Google Ads on
 * separately, client by client. Under each switch, exactly which accounts changes are written to (from the KPI board,
 * as the gates read it), any mismatch, and the platform's own access check.
 */
export function LiveWritesPanel({ clientId, slug, data, canEdit, toggle }: { clientId: string; slug?: string; data: LiveWritesData; canEdit: boolean; toggle: (platform: Platform, on: boolean) => Promise<Result> }) {
  const [google, setGoogle] = useState<GoogleAccessResult | null>(null);
  const names = new Map(google?.ok ? google.rows.map((r) => [r.account, r.name] as const) : []);
  const m = data.meta;
  const metaLive = m.globalOn || m.on;
  const fieldOnBoard = !m.field || m.accounts.some((a) => a.account === m.field);
  return (
    <div className="grid gap-4">
      <PlatformSwitch
        platform="meta"
        title="Live changes in Meta"
        on={m.on}
        globalOn={m.globalOn}
        by={m.by}
        at={m.at}
        canEdit={canEdit}
        toggle={toggle}
        about="Approved audit, sprint and chat changes (pauses, budgets, moves) and the launcher write straight into their Meta ad accounts. Meta checks every change first and new ads go in paused. Off, everything stays a plan to do by hand."
      >
        <Destination
          live={metaLive}
          name="Meta"
          lines={m.accounts.map((a) => ({ key: a.account, text: `${a.label ?? "Meta ad account"} · ${a.account}`, inactive: !a.active }))}
          empty="No Meta ad account is on the KPI board for them, so nothing can be written."
          off={`Nothing is written to their accounts. The launcher builds into Kaizen's own account · ${m.sandboxAccount}`}
        />
        {!fieldOnBoard && (
          <p className="rounded-[12px] border border-warn/35 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg">
            The Meta ad account ID in Details ({m.field}) isn&rsquo;t one of their accounts on the KPI board ({m.accounts.map((a) => a.account).join(", ") || "none"}). Changes only go into accounts on the KPI board, and the
            launcher uses the Details ID, so launches stay in Kaizen&rsquo;s own account until the two match.
          </p>
        )}
        {!m.field && m.accounts.length > 0 && <p className="text-[12.5px] text-warn">No Meta ad account ID in Details: the launcher can&rsquo;t launch into their account until it&rsquo;s set.</p>}
        <AudienceTermsCheck clientId={clientId} />
        {canEdit && <MetaBusinessConnections clientId={clientId} slug={slug} />}
      </PlatformSwitch>

      <PlatformSwitch
        platform="google"
        title="Live changes in Google Ads"
        on={data.google.on}
        globalOn={false}
        by={data.google.by}
        at={data.google.at}
        canEdit={canEdit}
        toggle={toggle}
        about="Approved audit, sprint, policy and chat changes (pauses, budgets, targets, negative keywords) and pushed ideas and keywords write straight into their Google Ads account. Google checks every change first and new ads and keywords go in paused. Off, nothing is written: every change stays a plan to do by hand in Google Ads."
      >
        <Destination
          live={data.google.on}
          name="Google Ads"
          lines={data.google.accounts.map((a) => ({ key: a.account, text: `${names.get(a.account) ?? a.label ?? "Google Ads account"} · ${googleId(a.account)}`, inactive: !a.active }))}
          empty="No Google Ads account is on the KPI board for them, so nothing can be written."
          off="Nothing is written to their Google Ads account."
        />
        <GoogleAccessCheck clientId={clientId} has={data.google.accounts.length > 0} result={google} setResult={setGoogle} />
      </PlatformSwitch>
    </div>
  );
}

function PlatformSwitch({ platform, title, on, globalOn, by, at, canEdit, toggle, about, children }: { platform: Platform; title: string; on: boolean; globalOn: boolean; by: string | null; at: string | null; canEdit: boolean; toggle: (platform: Platform, on: boolean) => Promise<Result>; about: string; children: ReactNode }) {
  const [live, setLive] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const where = platform === "google" ? "Google Ads" : "Meta";
  const when = day(at);
  const shown = globalOn || live;
  return (
    <section className="grid min-w-0 gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="font-heading text-[16px]">{title}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`inline-flex min-h-7 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium ${shown ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>
              <span className={`h-2 w-2 rounded-full ${shown ? "bg-ok" : "bg-faint"}`} />
              {globalOn ? "Live for every client" : live ? "Live for this client" : "Off: plans only"}
            </span>
            {!globalOn && by && when && (
              <span className="text-[12px] text-faint">
                {live ? "Switched on" : "Switched off"} by {by} · {when}
              </span>
            )}
            {!globalOn && !by && !live && <span className="text-[12px] text-faint">Never switched on</span>}
          </div>
        </div>
        {canEdit && !globalOn && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!live && !confirm(`Switch on live changes in ${where} for this client? Approved changes will be made in their ${where} account.`)) return;
              start(async () => {
                const r = await toggle(platform, !live);
                if (r.ok) {
                  setLive(!live);
                  setError(null);
                } else setError(r.error);
              });
            }}
            className={`min-h-11 w-full rounded-full px-5 text-[14px] font-medium disabled:opacity-60 sm:w-auto ${live ? "border border-line text-muted hover:text-fg" : "bg-brand text-white hover:bg-brand-hover"}`}
          >
            {pending ? "Saving…" : live ? "Switch off" : "Switch on"}
          </button>
        )}
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <p className="text-[13px] leading-relaxed text-muted">{about}</p>
      {globalOn && <p className="text-[12.5px] text-faint">The Meta sandbox is off in Settings, so Meta changes are live for every client.</p>}
      {children}
    </section>
  );
}

/** Where changes go: the exact accounts, or that nothing is written while it's off */
function Destination({ live, name, lines, empty, off }: { live: boolean; name: string; lines: { key: string; text: string; inactive: boolean }[]; empty: string; off: string }) {
  return (
    <div className="grid gap-1.5 rounded-[12px] border border-line bg-bg/50 px-3.5 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{live ? "Changes are written to" : "Changes would be written to"}</p>
      {lines.length ? (
        <ul className="grid gap-1">
          {lines.map((l) => (
            <li key={l.key} className="tabular break-words text-[13.5px]">
              <span className="text-muted">{name}:</span> <span className="font-medium">{l.text}</span>
              {l.inactive && <span className="text-[12px] text-faint"> (KPI target paused)</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-warn">{empty}</p>
      )}
      {!live && <p className="text-[12px] text-faint">{off}</p>}
    </div>
  );
}

/**
 * Can our Google Ads sign-in make changes in each of their accounts? Under our manager account, readable, and a dry
 * run of a change (Google checks it and creates nothing).
 */
function GoogleAccessCheck({ clientId, has, result, setResult }: { clientId: string; has: boolean; result: GoogleAccessResult | null; setResult: (r: GoogleAccessResult) => void }) {
  const [busy, start] = useTransition();
  const run = () =>
    start(async () => {
      setResult(await checkGoogleAccess(clientId).catch(() => ({ ok: false as const, error: "Couldn't check with Google." })));
    });
  useEffect(() => {
    if (has) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, has]);
  if (!has) return null;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Google Ads access for changes</p>
        <button
          type="button"
          disabled={busy}
          onClick={run}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-fg/30 hover:text-fg disabled:opacity-60 md:min-h-9"
        >
          {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {!result && <div className="h-14 animate-pulse rounded-[14px] bg-surface-2" aria-label="Checking with Google" />}
      {result && !result.ok && <p className="text-[13px] text-bad">{result.error}</p>}
      {result?.ok && (
        <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
          {result.rows.map((r) => (
            <li key={r.account} className="grid gap-1.5 px-4 py-3">
              <p className="tabular break-words text-[13.5px]">
                <span className="font-medium">{r.name ?? r.label ?? "Google Ads account"}</span> <span className="text-muted">· {googleId(r.account)}</span>
                {r.status && r.status !== "ENABLED" && <span className="text-[12px] text-warn"> · {r.status.toLowerCase()}</span>}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Chip ok={r.linked} yes="Under our manager account" no="Not under our manager account" />
                <Chip ok={r.read} yes="Readable" no="Can't read it" />
                {r.write !== null && <Chip ok={r.write} yes="Can make changes" no="Can't make changes" />}
              </div>
              {r.error && <p className="break-words text-[12px] text-bad">{r.error}</p>}
              {!r.linked && r.read && <p className="text-[12px] text-faint">Read directly through the signed-in user, not through our manager account.</p>}
            </li>
          ))}
        </ul>
      )}
      {result?.ok && <p className="text-[11px] text-faint">The change check is a dry run of creating a shared budget: Google checks our access and nothing is created.</p>}
    </div>
  );
}

function Chip({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={`inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium ${ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-ok" : "bg-bad"}`} />
      {ok ? yes : no}
    </span>
  );
}

/** For Details › Connections: their Google Ads accounts, or how to link one (on the KPI board, where the account lives) */
export function GoogleConnection({ accounts }: { accounts: WriteAccountView[] }) {
  if (!accounts.length)
    return (
      <p className="text-[12.5px] text-muted">
        No Google Ads account linked.{" "}
        <Link href="/kpis" className="text-fg underline underline-offset-2">
          Add a Google target with their customer ID on the KPI board
        </Link>
        .
      </p>
    );
  return (
    <ul className="grid gap-1.5">
      {accounts.map((a) => (
        <li key={a.account} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border border-line bg-bg/50 px-3 py-2">
          <span className="tabular min-w-0 break-words text-[13.5px]">
            <span className="font-medium">{googleId(a.account)}</span>
            {a.label && <span className="text-muted"> · {a.label}</span>}
            {!a.active && <span className="text-[12px] text-faint"> (KPI target paused)</span>}
          </span>
          <Link href={`/kpis?target=${a.targetId}`} className="inline-flex min-h-11 items-center text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline md:min-h-0">
            Change on the KPI board
          </Link>
        </li>
      ))}
    </ul>
  );
}
