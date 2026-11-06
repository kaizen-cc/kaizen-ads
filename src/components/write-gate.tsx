"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLiveAdWrites } from "@/app/(team)/clients/[slug]/actions";
import { managerHref, switchHref, type WriteStatus } from "@/lib/write-status-core";

// What stands in for an "Apply in Meta / Google" button when nothing would be written: says so before anyone presses
// it, with who can switch it on and where. Execs get the switch right here (and the link to the client's Team & setup);
// everyone gets Ads Manager / Google Ads to do the change by hand from the checklist.

const WHERE = { meta: "Ads Manager", google: "Google Ads" } as const;

/** A small chip for a plan card's header: live or not, at a glance */
export function WriteChip({ status }: { status: WriteStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${status.live ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`} title={status.reason ?? "Changes here are made in the live account."}>
      <span className={`h-1.5 w-1.5 rounded-full ${status.live ? "bg-ok" : "bg-warn"}`} />
      {status.live ? "Live" : status.off === "client" ? "Live changes off" : "Can't write"}
    </span>
  );
}

/**
 * The disabled state in place of an apply button: "Live changes are off for <Client>", what to do about it, and the
 * by-hand route. onLive: called once an exec switches it on here, so the button can come back without a reload.
 */
export function WriteOff({ status, canSwitch = false, account, onLive, compact = false }: { status: WriteStatus; canSwitch?: boolean; account?: string | null; onLive?: () => void; compact?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status.live) return null;
  const hand = managerHref(status.platform, account ?? null);
  const switchable = canSwitch && status.off === "client" && status.client;
  const sw = () =>
    start(async () => {
      if (!status.client) return;
      setError(null);
      const r = await setLiveAdWrites(status.client.id, status.client.slug, status.platform, true);
      if (!r.ok) return setError(r.error);
      setAsking(false);
      onLive?.();
      router.refresh();
    });
  return (
    <div role="status" className={`grid min-w-0 gap-2 rounded-[12px] border border-warn/35 bg-warn-soft/40 ${compact ? "px-3 py-2" : "px-3.5 py-3"}`}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span aria-hidden className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-warn/15 text-warn">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
          </svg>
        </span>
        <div className="grid min-w-0 gap-0.5">
          <p className="text-[13px] font-medium text-fg">{status.reason}</p>
          <p className="text-[12px] leading-relaxed text-muted">
            {status.off === "client"
              ? canSwitch
                ? "Nothing will be written to the account until it's on. Switch it on here or in Team & setup, or do it by hand from the checklist."
                : "Ask an exec to switch them on in Team & setup. Until then, do it by hand from the checklist."
              : "Do it by hand from the checklist for now."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-0 sm:pl-[34px]">
        {switchable &&
          (asking ? (
            <>
              <button type="button" onClick={sw} disabled={pending} className="min-h-11 rounded-full bg-fg px-4 text-[12.5px] font-medium text-bg disabled:opacity-60 md:min-h-8">
                {pending ? "Switching on…" : `Yes, switch on for ${status.client!.name}`}
              </button>
              <button type="button" onClick={() => setAsking(false)} disabled={pending} className="min-h-11 rounded-full border border-line px-3.5 text-[12.5px] text-muted hover:text-fg md:min-h-8">
                Not yet
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setAsking(true)} className="min-h-11 rounded-full border border-warn/40 px-4 text-[12.5px] font-medium text-fg hover:bg-warn/10 md:min-h-8">
              Switch on live changes in {status.platform === "google" ? "Google Ads" : "Meta"}
            </button>
          ))}
        {status.client && status.off === "client" && (
          <Link href={switchHref(status)} className="inline-flex min-h-11 items-center rounded-full px-3 text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline md:min-h-8">
            Team &amp; setup
          </Link>
        )}
        {hand && (
          <a href={hand} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-[12.5px] text-muted hover:text-fg md:min-h-8">
            Open {WHERE[status.platform]} <span aria-hidden>↗</span>
          </a>
        )}
      </div>
      {asking && <p className="text-[11.5px] text-faint">Approved changes for this client will then be made in {status.platform === "google" ? "Google Ads" : "Meta"}, each checked by the platform first. The other platform keeps its own switch.</p>}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}
