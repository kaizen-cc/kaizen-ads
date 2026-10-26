"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Check, Readiness } from "@/lib/readiness";
import { AssignSelect, type Option } from "../assign-select";
import { checkReadiness, fillReadiness, setClientService } from "./actions";
import { SERVICES } from "@/lib/services";
import { ServiceIcon } from "./services-panel";
import { Layer } from "./layer";

// The readiness check on a client that just went live again: what the system still needs to run them (an ad account,
// a target, a buyer, a contact, the channels), each with what stops working without it and a field to fill it right
// there. "Bring everything up" saves it all and switches the cycle back on. It opens on its own for whoever brought
// the client back; "Later" folds it into a bar at the top of the page until it's done.

const input =
  "h-11 w-full min-w-0 rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-brand/60 focus:shadow-[0_0_0_4px_rgba(200,16,46,0.12)] md:h-10";

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
          className="group flex w-full flex-wrap items-center gap-x-4 gap-y-3 rounded-[16px] md:flex-nowrap border border-brand/30 bg-gradient-to-r from-brand/[0.12] via-brand/[0.04] to-transparent px-4 py-3 text-left transition-colors hover:border-brand/60"
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
          <span className="shrink-0 basis-full rounded-full bg-brand px-4 py-3 text-center text-xs font-medium md:basis-auto md:py-1.5 text-white shadow-[0_8px_20px_-10px_rgba(200,16,46,0.9)] transition-transform group-hover:translate-x-0.5">Finish setup →</span>
        </button>
      )}

      {open && (
        <Layer>
        <div className="fixed inset-0 z-[80] flex justify-center overflow-y-auto overscroll-contain bg-black/70 backdrop-blur-md md:p-4" onClick={later}>
          <div
            className="relative grid min-h-full w-full gap-6 overflow-clip max-md:flex max-md:flex-col bg-surface px-5 pt-[calc(1.5rem+env(safe-area-inset-top))] shadow-[0_50px_120px_-30px_rgba(0,0,0,0.95)] animate-[sheet-fade_.3s_ease-out] md:my-auto md:h-fit md:min-h-0 md:max-w-xl md:overflow-hidden md:rounded-[24px] md:border md:border-line md:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand/20 blur-[90px]" />

            {done ? (
              <div className="relative grid justify-items-center gap-4 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-center md:pb-6">
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
                  {["A full sync: ad accounts, Slack, email and Drive, from when we stopped", "This week's and this month's reports queued, if still due", "Sprint check-ins back on", "A comeback brief for each buyer: where we left it and how to restart"].map((t) => (
                    <li key={t} className="flex items-center gap-2.5 rounded-[10px] bg-white/[0.03] px-3 py-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                      {t}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => setOpen(false)} className="mt-2 h-11 w-full rounded-full bg-fg px-6 text-sm font-medium text-bg md:h-10 md:w-auto">
                  Done
                </button>
              </div>
            ) : (
              <>
                <header className="relative grid gap-4">
                  <div className="grid gap-1.5">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-brand-text">Welcome back</p>
                    <h2 className="font-heading text-[26px] leading-tight [overflow-wrap:anywhere]">Bring {name} back fully</h2>
                    <p className="max-w-[46ch] text-sm leading-relaxed text-muted">
                      {r.missing === 0 ? "Everything needed is in." : `${r.missing === 1 ? "One thing" : `${r.missing} things`} before the system can run them end to end. Fill what you have; the rest waits here.`}
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="shrink-0 text-muted">
                        <span className="tabular font-medium text-fg">{got}</span> of {needed.length} ready
                      </span>
                      {needed.some((c) => c.ok) && (
                        <span className="flex flex-wrap justify-end gap-1.5">
                          {needed
                            .filter((c) => c.ok)
                            .map((c) => (
                              <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-2 py-0.5 text-[11px] text-ok">
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M5 12l5 5L19 7" />
                                </svg>
                                {c.label.replace(/^An? /, "").replace(/^./, (x) => x.toUpperCase())}
                              </span>
                            ))}
                        </span>
                      )}
                    </div>
                    <span className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
                      <span className="block h-full rounded-full bg-gradient-to-r from-brand to-[#ff5a6e] transition-[width] duration-700" style={{ width: `${needed.length ? (got / needed.length) * 100 : 100}%` }} />
                    </span>
                  </div>
                </header>

                <form
                  ref={form}
                  className="relative grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  {needed
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <Row key={c.key} check={c}>
                        <Fields check={c} r={r} clientId={clientId} slug={slug} team={team} onChanged={refresh} />
                      </Row>
                    ))}
                  {helps.some((c) => !c.ok) && <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-faint">Also worth adding</p>}
                  {helps
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <Row key={c.key} check={c}>
                        <Fields check={c} r={r} clientId={clientId} slug={slug} team={team} onChanged={refresh} />
                      </Row>
                    ))}
                  <button type="submit" hidden />
                </form>

                {error && <p className="relative rounded-[10px] bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}
                <div className="sticky bottom-0 -mx-5 mt-auto flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-md md:relative md:-mx-7 md:-mb-7 md:mt-0 md:bg-white/[0.015] md:px-7 md:py-5 md:backdrop-blur-none">
                  <button type="button" onClick={later} className="h-11 px-2 text-sm text-faint hover:text-fg md:h-10">
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
        </Layer>
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
  const needed = check.need === "needed";
  return (
    <div className={`grid gap-3.5 rounded-[16px] border p-4 ${needed ? "border-brand/25 bg-brand/[0.035]" : "border-line bg-white/[0.015]"}`}>
      <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
        <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full ${needed ? "bg-brand/20 text-brand-text" : "bg-warn/15 text-warn"}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
        </span>
        <div className="grid min-w-0 gap-1">
          <p className="text-sm font-medium leading-5 text-fg">{check.label}</p>
          <p className="text-xs leading-relaxed text-faint">
            {check.detail ? <span className="text-muted">{check.detail}. </span> : null}
            {check.why}
          </p>
        </div>
      </div>
      <div className="md:pl-8">{children}</div>
    </div>
  );
}

function Fields({ check, r, clientId, slug, team, onChanged }: { check: Check; r: Readiness; clientId: string; slug: string; team: Team; onChanged: () => void }) {
  switch (check.key) {
    case "services":
      return <ServicePick clientId={clientId} slug={slug} onChanged={onChanged} />;
    case "account":
      return (
        <div className={`grid gap-2 ${r.platforms.meta && r.platforms.google ? "sm:grid-cols-2" : ""}`}>
          {r.platforms.meta && <input name="meta_ad_account_id" className={`${input} tabular`} placeholder="Meta ad account ID, from Ads Manager" inputMode="numeric" />}
          {r.platforms.google && <input name="google_customer_id" className={`${input} tabular`} placeholder="Google Ads ID, 123-456-7890" />}
        </div>
      );
    case "target": {
      const open = r.targets.filter((t) => t.target == null);
      if (!open.length) return <p className="text-xs text-faint">Add the ad account first; its target goes here next.</p>;
      return (
        <div className="grid gap-2">
          {open.map((t) => (
            <label key={t.id} className="flex items-center gap-3 text-xs text-muted">
              <span className="w-24 shrink-0 truncate md:w-28">{t.platform === "google" ? "Google" : "Meta"}{t.label ? ` · ${t.label}` : ""}</span>
              <input name={`target:${t.id}`} className={`${input} tabular`} placeholder="Target: cost per result (or ROAS)" inputMode="decimal" />
            </label>
          ))}
        </div>
      );
    }
    case "meta_buyer":
    case "google_buyer":
      return (
        <span onChange={() => setTimeout(onChanged, 800)}>
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

/** Which services they buy, when nothing's on file: each tap saves; "Done" updates the list (which ad accounts to ask for). */
function ServicePick({ clientId, slug, onChanged }: { clientId: string; slug: string; onChanged: () => void }) {
  const [on, setOn] = useState<string[]>([]);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {SERVICES.map((s) => {
        const active = on.includes(s.slug);
        return (
          <button
            key={s.slug}
            type="button"
            disabled={pending}
            aria-pressed={active}
            onClick={() =>
              start(async () => {
                setOn((o) => (active ? o.filter((x) => x !== s.slug) : [...o, s.slug]));
                const res = await setClientService(clientId, slug, s.slug, !active);
                if (!res.ok) setOn((o) => (active ? [...o, s.slug] : o.filter((x) => x !== s.slug)));
              })
            }
            className={`inline-flex h-11 items-center gap-1.5 rounded-full px-3.5 text-xs transition-colors md:h-8 md:px-3 ${active ? "border border-brand/50 bg-brand/15 text-fg" : "border border-line text-muted hover:text-fg"}`}
          >
            <ServiceIcon slug={s.slug} className="h-3.5 w-3.5" />
            {s.short}
          </button>
        );
      })}
      {on.length > 0 && (
        <button type="button" onClick={onChanged} disabled={pending} className="h-11 px-2 text-xs font-medium text-brand-text hover:underline disabled:opacity-50 md:h-8">
          Done →
        </button>
      )}
    </div>
  );
}
