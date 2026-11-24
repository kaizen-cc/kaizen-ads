"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { remindTomorrow } from "@/app/(team)/connect-actions";
import { buttonLabel, connectHref, itemTitle, LABEL, missingOf, NEEDS, stateText, WHY, type Gaps, type Need } from "@/lib/connect-required-core";

// Everyone connects their own Slack and Asana (src/lib/connect-required-core.ts). Two shapes:
//   item: a critical card at the top of the Overview, one-tap Connect per account, gone the moment they're connected
//   gate: the first-run screen over the whole OS until they connect, skippable only with "Remind me tomorrow"

function Button({ n, state, next, primary }: { n: Need; state: Gaps[Need]; next: string; primary: boolean }) {
  const { href, post } = connectHref(n, state, next);
  const cls = `inline-flex min-h-11 items-center justify-center rounded-full px-5 text-[14px] font-medium transition active:scale-[0.98] md:min-h-10 ${primary ? "bg-brand text-white hover:bg-brand-hover" : "border border-line text-fg hover:border-faint"}`;
  return post ? (
    <form action={href} method="post">
      <button type="submit" className={cls}>
        {buttonLabel(n, state)}
      </button>
    </form>
  ) : (
    <a href={href} className={cls}>
      {buttonLabel(n, state)}
    </a>
  );
}

function Rows({ gaps, next }: { gaps: Gaps; next: string }) {
  const missing = missingOf(gaps);
  return (
    <ul className="grid gap-2.5">
      {NEEDS.map((n) => {
        const ok = gaps[n] === "ok";
        return (
          <li key={n} className={`grid gap-2 rounded-[16px] border p-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${ok ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface"}`}>
            <span className="grid min-w-0 gap-0.5">
              <span className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                <span aria-hidden className={`h-2 w-2 rounded-full ${ok ? "bg-ok" : "bg-bad"}`} />
                {LABEL[n]}
                <span className="text-[12.5px] font-normal text-faint">{stateText(gaps[n])}</span>
              </span>
              {!ok && <span className="text-[13px] leading-snug text-muted">Connect it {WHY[n]}.</span>}
            </span>
            {!ok && <Button n={n} state={gaps[n]} next={next} primary={n === missing[0]} />}
          </li>
        );
      })}
    </ul>
  );
}

/** The Overview's critical item */
export function ConnectItem({ gaps }: { gaps: Gaps }) {
  const next = usePathname() || "/pipeline";
  const missing = missingOf(gaps);
  if (!missing.length) return null;
  return (
    <section aria-label="Connect your accounts" className="relative isolate grid gap-3 overflow-hidden rounded-[22px] border border-bad/40 bg-surface p-4 shadow-sm md:p-5">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 -z-10 h-48 w-48 rounded-full bg-bad/15 blur-[70px]" />
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-bad">
        <span className="relative grid h-2 w-2 place-items-center">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bad opacity-60" />
          <span className="relative h-2 w-2 rounded-full bg-bad" />
        </span>
        Critical · for you
      </span>
      <h2 className="font-heading text-[19px] leading-snug text-fg [overflow-wrap:anywhere] md:text-[21px]">{itemTitle(missing)}</h2>
      <Rows gaps={gaps} next={next} />
    </section>
  );
}

/** The first-run screen: before the rest of the OS, until they connect or choose "Remind me tomorrow" */
export function ConnectGate({ gaps, name }: { gaps: Gaps; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busy, start] = useTransition();
  const next = usePathname() || "/pipeline";
  const missing = missingOf(gaps);
  if (!open || !missing.length) return null;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-end bg-black/70 backdrop-blur-[3px] md:place-items-center" role="dialog" aria-modal="true" aria-label="Connect your accounts">
      <div className="grid max-h-[94dvh] w-full gap-5 overflow-y-auto rounded-t-[28px] border border-line bg-bg px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-6 shadow-2xl animate-[sheet-up_.32s_cubic-bezier(.2,.8,.2,1)] md:w-[520px] md:rounded-[28px] md:p-8">
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">First things first</p>
          <h2 className="font-heading text-[24px] leading-tight text-fg md:text-[28px]">Hi {name}, connect your {missing.map((n) => LABEL[n]).join(" and ")}</h2>
          <p className="text-[14px] leading-relaxed text-muted">Kaizen OS works for you through your own accounts: your assistant reads and posts as you, and your Asana changes go in as you, never as someone else. It takes about a minute. Google is already connected through Kaizen&apos;s workspace.</p>
        </div>
        <Rows gaps={gaps} next={next} />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              await remindTomorrow();
              setOpen(false);
              router.refresh();
            })
          }
          className="justify-self-center rounded-full px-4 py-2 text-[13px] text-faint hover:text-fg disabled:opacity-50 min-h-11"
        >
          {busy ? "…" : "Remind me tomorrow"}
        </button>
      </div>
    </div>
  );
}
