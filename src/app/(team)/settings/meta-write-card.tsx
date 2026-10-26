"use client";

import { useState, useTransition } from "react";
import { checkMetaWrite, setMetaSandbox } from "./meta-write-actions";

// Writing to Meta: the sandbox switch (on until an exec turns it off, after confirming) and a one-click check that
// Kaizen Ads can write to an account, which is a dry run with Meta that creates nothing.

export function MetaWriteCard({ sandbox, sandboxAccount, canEdit, updated }: { sandbox: boolean; sandboxAccount: string; canEdit: boolean; updated: string | null }) {
  const [on, setOn] = useState(sandbox);
  const [confirm, setConfirm] = useState(false);
  const [account, setAccount] = useState(sandboxAccount);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const flip = (next: boolean) =>
    start(async () => {
      setError(null);
      const r = await setMetaSandbox(next);
      if (!r.ok) return setError(r.error);
      setOn(next);
      setConfirm(false);
    });

  return (
    <section className={`grid min-w-0 gap-4 rounded-[18px] border p-4 md:p-5 ${on ? "border-ok/30 bg-ok/[0.04]" : "border-warn/40 bg-warn-soft/30"}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid max-w-[60ch] gap-1">
          <p className="flex items-center gap-2 font-heading text-lg">
            <span className={`h-2 w-2 rounded-full ${on ? "bg-ok" : "bg-warn"}`} />
            Writing to Meta · {on ? "sandbox" : "live"}
          </p>
          <p className="text-sm text-muted">
            {on
              ? `Kaizen Ads can only create or change ads in Kaizen's own ad account (${sandboxAccount}). The launcher and audit changes refuse every client account until this is switched off.`
              : "Kaizen Ads can create ads (paused) and apply approved audit changes in any client account the system user manages. Every write is checked with Meta first and confirmed by a person."}
          </p>
          {updated && <p className="text-[11px] text-faint">Last changed {updated}</p>}
        </div>
        {canEdit &&
          (on ? (
            confirm ? (
              <span className="grid w-full gap-2 rounded-[12px] border border-warn/40 bg-surface p-3 text-xs md:w-auto md:max-w-xs">
                <span>Switch to live? Approved changes and launches will reach client ad accounts.</span>
                <span className="flex gap-2">
                  <button type="button" disabled={pending} onClick={() => flip(false)} className="h-11 flex-1 rounded-full bg-warn px-3 font-medium text-bg disabled:opacity-60 md:h-8 md:flex-none">
                    Yes, go live
                  </button>
                  <button type="button" onClick={() => setConfirm(false)} className="h-11 px-3 text-muted hover:text-fg md:h-8 md:px-2">
                    Not yet
                  </button>
                </span>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirm(true)} className="h-11 w-full rounded-full border border-line bg-surface px-4 text-sm text-muted hover:text-fg md:h-9 md:w-auto">
                Switch to live…
              </button>
            )
          ) : (
            <button type="button" disabled={pending} onClick={() => flip(true)} className="h-11 w-full rounded-full bg-fg px-4 text-sm font-medium text-bg disabled:opacity-60 md:h-9 md:w-auto">
              Back to sandbox
            </button>
          ))}
      </div>

      {canEdit && (
        <div className="grid gap-2 border-t border-line pt-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Check write access</p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Ad account ID" className="tabular h-11 w-full min-w-0 flex-1 rounded-[10px] md:h-9 md:w-56 md:flex-none border border-line bg-bg px-3 text-sm outline-none focus:border-brand/60" />
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setResult(null);
                  setResult(await checkMetaWrite(account));
                })
              }
              className="h-11 shrink-0 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60 md:h-9"
            >
              {pending ? "Checking with Meta…" : "Check"}
            </button>
          </div>
          {result && (
            <p className={`text-sm ${result.ok ? "text-ok" : "text-bad"}`}>
              {result.ok ? "✓ " : "× "}
              {result.detail}
            </p>
          )}
          <p className="text-[11px] text-faint">A dry run of creating a paused campaign: Meta checks the permission and the system user&apos;s role on the account, and nothing is created.</p>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </section>
  );
}
