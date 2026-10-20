"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Check, Readiness } from "@/lib/readiness";
import { AssignSelect, type Option } from "../assign-select";
import { checkReadiness, fillReadiness } from "./actions";

// The readiness check on a client that just went live again: what the system still needs to run them (an ad account,
// a target, a buyer, a contact, the channels), each with what stops working without it and a field to fill it right
// there. "Bring everything up" saves it all and switches the cycle back on. It opens on its own for whoever brought
// the client back; "Later" folds it into a bar at the top of the page until it's done.

const input =
  "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-brand/60 focus:shadow-[0_0_0_4px_rgba(200,16,46,0.12)]";

type Team = Record<string, { current: Option | null; options: Option[] }>;

export function ReadinessCheck({ clientId, slug, name, initial, team, autoOpen, stamp }: { clientId: string; slug: string; name: string; initial: Readiness; team: Team; autoOpen: boolean; stamp: string }) {
  const router = useRouter();
  const [r, setR] = useState(initial);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const key = `ready-later:${clientId}:${stamp}`;

  // Opens by itself once per reactivation for whoever did it, unless they chose "Later" this session
  useEffect(() => {
    let later = false;
    try {
      later = sessionStorage.getItem(key) === "1";
    } catch {}
    if (!autoOpen || later) return;
    const t = setTimeout(() => setOpen(true), 400);
    return () => clearTimeout(t);
  }, [autoOpen, key]);
  // A fresh check from the server (after a save elsewhere on the page) replaces the one shown
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setR(initial);
  }

  const needed = r.checks.filter((c) => c.need === "needed");
  const helps = r.checks.filter((c) => c.need === "helps");
  const got = needed.filter((c) => c.ok).length;
  const later = () => {
    try {
      sessionStorage.setItem(key, "1");
    } catch {}
    setOpen(false);
  };
  const refresh = async () => {
    const next = await checkReadiness(clientId);
    if (next) setR(next);
  };
  const submit = () =>
    start(async () => {
      setError(null);
      const res = await fillReadiness(clientId, slug, new FormData(form.current!));
      if (!res.ok) {
        setError(res.error);
        await refresh();
        return;
      }
      setR(res.readiness);
      form.current?.reset();
      if (res.readiness.ready) setDone(true);
      router.refresh();
    });

  if (r.ready && !done) return null;

  return (
    <>
      {!r.ready && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group flex w-full items-center gap-4 rounded-[16px] border border-brand/30 bg-gradient-to-r from-brand/[0.12] via-brand/[0.04] to-transparent px-4 py-3 text-left transition-colors hover:border-brand/60"
        >
          <Ring got={got} of={needed.length} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-fg">{name} is live again. {r.missing === 1 ? "One thing" : `${r.missing} things`} still needed to run them fully</span>
            <span className="block truncate text-xs text-muted">
              {needed
                .filter((c) => !c.ok)
                .map((c) => c.label)
                .join(" · ")}
            </span>
          </span>
          <span className="shrink-0 rounded-full bg-brand px-4 py-1.5 text-xs font-medium text-white shadow-[0_8px_20px_-10px_rgba(200,16,46,0.9)] transition-transform group-hover:translate-x-0.5">Finish setup →</span>
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-[80] flex justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md" onClick={later}>
          <div
            className="relative my-auto grid h-fit w-full max-w-xl gap-6 overflow-hidden rounded-[24px] border border-line bg-surface p-7 shadow-[0_50px_120px_-30px_rgba(0,0,0,0.95)] animate-[sheet-fade_.3s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand/20 blur-[90px]" />

            {done ? (
              <div className="relative grid justify-items-center gap-4 py-6 text-center">
                <span className="grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok shadow-[0_0_0_10px_rgba(34,197,94,0.06)]">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12l5 5L19 7" />
                  </svg>
                </span>
                <div className="grid gap-1">
                  <h2 className="font-heading text-2xl">{name} is fully back</h2>
                  <p className="text-sm text-muted">Everything the system needs is in. It&apos;s coming up now:</p>
                </div>
                <ul className="grid w-full max-w-sm gap-2 text-left text-sm">
                  {["KPIs pulling from the ad accounts", "This week's and this month's reports queued, if still due", "Sprint check-ins back on", "Slack, Drive and the briefing on their next pass"].map((t) => (
                    <li key={t} className="flex items-center gap-2.5 rounded-[10px] bg-white/[0.03] px-3 py-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                      {t}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => setOpen(false)} className="mt-2 h-10 rounded-full bg-fg px-6 text-sm font-medium text-bg">
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="relative flex items-start gap-4">
                  <Ring got={got} of={needed.length} size={56} />
                  <div className="grid min-w-0 gap-1">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-brand-text">Welcome back</p>
                    <h2 className="font-heading text-2xl leading-tight">Bring {name} back fully</h2>
                    <p className="text-sm text-muted">
                      {r.missing === 0 ? "Everything needed is in." : `${r.missing === 1 ? "One thing" : `${r.missing} things`} before the system can run them end to end. Fill what you have; the rest stays here for later.`}
                    </p>
                  </div>
                </div>

                <form
                  ref={form}
                  className="relative grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  {needed.map((c) => (
                    <Row key={c.key} check={c}>
                      <Fields check={c} r={r} clientId={clientId} team={team} onAssigned={refresh} />
                    </Row>
                  ))}
                  {helps.some((c) => !c.ok) && <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-faint">Also worth adding</p>}
                  {helps
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <Row key={c.key} check={c}>
                        <Fields check={c} r={r} clientId={clientId} team={team} onAssigned={refresh} />
                      </Row>
                    ))}
                  <button type="submit" hidden />
                </form>

                {error && <p className="relative rounded-[10px] bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
                <div className="relative flex items-center justify-between gap-3 border-t border-line pt-5">
                  <button type="button" onClick={later} className="h-10 px-2 text-sm text-faint hover:text-fg">
                    Later
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={pending}
                    className="inline-flex h-11 items-center gap-2 rounded-full bg-brand px-6 text-sm font-medium text-white shadow-[0_12px_30px_-12px_rgba(200,16,46,0.95)] transition hover:brightness-110 disabled:opacity-60"
                  >
                    {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                    {pending ? "Bringing it up…" : "Bring everything up"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Progress as a ring: the needed checks that pass */
function Ring({ got, of, size }: { got: number; of: number; size: number }) {
  const r = size / 2 - 4;
  const len = 2 * Math.PI * r;
  const pct = of ? got / of : 1;
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="3.5" className="text-white/[0.08]" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - pct)} className={`transition-[stroke-dashoffset] duration-700 ${pct === 1 ? "text-ok" : "text-brand"}`} />
      </svg>
      <span className={`absolute tabular font-medium ${size > 40 ? "text-sm" : "text-[10px]"}`}>
        {got}/{of}
      </span>
    </span>
  );
}

function Row({ check, children }: { check: Check; children: React.ReactNode }) {
  return (
    <div className={`grid gap-3 rounded-[14px] border p-3.5 transition-colors ${check.ok ? "border-transparent bg-white/[0.02]" : check.need === "needed" ? "border-brand/25 bg-brand/[0.04]" : "border-line"}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${check.ok ? "bg-ok/15 text-ok" : check.need === "needed" ? "bg-brand/20 text-brand-text" : "bg-warn/15 text-warn"}`}>
          {check.ok ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12l5 5L19 7" />
            </svg>
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          )}
        </span>
        <div className="grid min-w-0 gap-0.5">
          <p className={`text-sm font-medium ${check.ok ? "text-muted" : "text-fg"}`}>{check.label}</p>
          {!check.ok && <p className="text-xs text-faint">{check.detail ? `${check.detail}. ` : ""}{check.why}</p>}
        </div>
      </div>
      {!check.ok && <div className="pl-8">{children}</div>}
    </div>
  );
}

function Fields({ check, r, clientId, team, onAssigned }: { check: Check; r: Readiness; clientId: string; team: Team; onAssigned: () => void }) {
  switch (check.key) {
    case "account":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <input name="meta_ad_account_id" className={`${input} tabular`} placeholder="Meta ad account ID" inputMode="numeric" />
          <input name="google_customer_id" className={`${input} tabular`} placeholder="Google Ads ID, 123-456-7890" />
        </div>
      );
    case "target": {
      const open = r.targets.filter((t) => t.target == null);
      if (!open.length) return <p className="text-xs text-faint">Add the ad account first; its target goes here next.</p>;
      return (
        <div className="grid gap-2">
          {open.map((t) => (
            <label key={t.id} className="flex items-center gap-3 text-xs text-muted">
              <span className="w-28 shrink-0 truncate">{t.platform === "google" ? "Google" : "Meta"}{t.label ? ` · ${t.label}` : ""}</span>
              <input name={`target:${t.id}`} className={`${input} tabular`} placeholder="Target: cost per result (or ROAS)" inputMode="decimal" />
            </label>
          ))}
        </div>
      );
    }
    case "meta_buyer":
    case "google_buyer":
      return (
        <span onChange={() => setTimeout(onAssigned, 800)}>
          <AssignSelect clientId={clientId} slot={check.key} label={check.label} current={team[check.key]?.current ?? null} options={team[check.key]?.options ?? []} canEdit size="md" />
        </span>
      );
    case "contact":
      return (
        <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr]">
          <input name="contact_email" type="email" className={input} placeholder="who approves, name@brand.com" />
          <input name="contact_name" className={input} placeholder="Name (optional)" />
        </div>
      );
    case "slack":
      return <input name="slack_channel_id" className={input} placeholder="Channel ID, e.g. C04ABC123" />;
    case "internal_slack":
      return <input name="internal_slack_channel_id" className={input} placeholder="Channel ID, e.g. C04ABC123" />;
    case "drive":
      return <input name="drive_folder_id" className={input} placeholder="Paste the folder link" />;
    case "website":
      return <input name="website" className={input} placeholder="https://" />;
  }
}
