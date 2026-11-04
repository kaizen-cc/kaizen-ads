"use client";

import { useState, useTransition } from "react";
import { AudienceTermsCheck } from "@/components/audience-terms";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Live changes in this client's ad accounts: while the global switch is off, an exec turns them on for one client at a
 * time to prove the recommendations and the launcher on real accounts before everyone gets them.
 */
export function LiveWritesPanel({ clientId, on, by, at, globalOn, canEdit, toggle }: { clientId: string; on: boolean; by: string | null; at: string | null; globalOn: boolean; canEdit: boolean; toggle: (on: boolean) => Promise<Result> }) {
  const [live, setLive] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const when = at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-[13px] font-medium ${globalOn || live ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>
          <span className={`h-2 w-2 rounded-full ${globalOn || live ? "bg-ok" : "bg-faint"}`} />
          {globalOn ? "Live for every client" : live ? "Live for this client" : "Off: suggestions only"}
        </span>
        {!globalOn && by && when && <span className="text-[12.5px] text-faint">{live ? "Switched on" : "Switched off"} by {by} · {when}</span>}
      </div>
      <p className="text-[13px] leading-relaxed text-muted">
        When it&rsquo;s on, approved audit and sprint changes (pauses, budgets, moves) and the launcher write straight into this client&rsquo;s Meta and Google Ads accounts. Every change is still checked by Meta or Google first, and new ads go in paused. Off, everything stays a suggestion to apply by hand.
      </p>
      {canEdit && !globalOn && (
        <div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!live && !confirm("Switch on live changes in this client's ad accounts? Approved changes will be made in Meta and Google Ads.")) return;
              start(async () => {
                const r = await toggle(!live);
                if (r.ok) {
                  setLive(!live);
                  setError(null);
                } else setError(r.error);
              });
            }}
            className={`min-h-11 rounded-full px-5 text-[14px] font-medium disabled:opacity-60 ${live ? "border border-line text-muted hover:text-fg" : "bg-brand text-white hover:bg-brand-hover"}`}
          >
            {pending ? "Saving…" : live ? "Switch off for this client" : "Switch on for this client"}
          </button>
          {error && <p className="mt-2 text-[12.5px] text-bad">{error}</p>}
        </div>
      )}
      <AudienceTermsCheck clientId={clientId} />
    </div>
  );
}
