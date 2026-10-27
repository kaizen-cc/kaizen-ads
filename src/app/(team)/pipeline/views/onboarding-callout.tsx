"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import type { OnboardingCard, OnboardingState, OpenSuggestion } from "@/lib/suggestions";
import { markOnboarded } from "../../clients/[slug]/actions";
import { matchIntake, writeFirstRound } from "../onboarding-actions";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import { SuggestionSheet } from "./suggested-briefs";

// New and returning clients, front and center for execs and leads: where each one is (intake, first round,
// production), with the first round one click away. Deliberately louder than everything else on Home.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function OnboardingCallout({ state, clients, bare = false }: { state: OnboardingState; clients: { id: string; name: string }[]; bare?: boolean }) {
  // The first round open is in the address (?first=id), so back closes it and a link opens it
  const openId = useParam("first");
  const sheet = (openId && state.clients.find((c) => c.firstRound?.id === openId)?.firstRound) || null;
  const router = useRouter();
  // Keeps itself current: quickly while an intake is being read, otherwise every minute (a new intake can land any time)
  const reading = state.clients.some((c) => c.intake && ["received", "read"].includes(c.intake.status) && !c.firstRound && !c.inProduction.length);
  useEffect(() => {
    if (sheet) return;
    const t = setInterval(() => router.refresh(), reading ? 8000 : 60000);
    return () => clearInterval(t);
  }, [reading, sheet, router]);
  if (!state.clients.length && !state.unmatched.length) return null;
  // Clients without a creative package have no first round to make; their card is their setup
  const creative = state.clients.filter((c) => c.creative);
  const other = state.clients.filter((c) => !c.creative);
  const ready = creative.filter((c) => c.firstRound).length;
  return (
    <section className="relative overflow-hidden rounded-[20px] border border-brand/45 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(178,30,44,0.28),rgba(178,30,44,0.06)_45%,transparent_70%)] p-5 shadow-[0_0_0_1px_rgba(178,30,44,0.15),0_20px_60px_-30px_rgba(178,30,44,0.6)] md:p-6">
      <div className={bare ? "hidden" : "mb-5 flex flex-wrap items-end justify-between gap-3"}>
        <div className="grid gap-1.5">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Onboarding</span>
          </span>
          <h2 className="font-display text-2xl tracking-tight md:text-3xl">
            {state.clients.length} {state.clients.length === 1 ? "client" : "clients"} getting started
          </h2>
          <p className="text-sm text-muted">
            {ready ? `${ready} first ${ready === 1 ? "round is" : "rounds are"} written and waiting for you. ` : ""}First rounds come from their intake form and what&apos;s winning for similar clients.
          </p>
        </div>
      </div>

      {/* Every client getting started has a card: the ones with a creative package first (they have a first round to
          make), then the rest, whose card is their account setup */}
      <div className="grid gap-3 lg:grid-cols-2">
        {[...creative, ...other].map((c) => (
          <ClientCard key={c.clientId} c={c} onOpen={(f) => pushParams({ first: f.id })} />
        ))}
      </div>

      {state.unmatched.length > 0 && (
        <div className="mt-4 grid gap-2 rounded-[14px] border border-warn/40 bg-bg/60 p-4">
          <p className="text-sm font-medium">Intake forms we couldn&apos;t match to a client</p>
          {state.unmatched.map((u) => (
            <Unmatched key={u.id} u={u} clients={clients} />
          ))}
        </div>
      )}

      {sheet && (
        <SuggestionSheet
          s={sheet}
          onClose={() => closeThen(() => router.refresh(), "first")}
        />
      )}
    </section>
  );
}

// What the strategist does while writing a first round, and roughly how long it takes
const WRITE_STEPS = ["Reading their intake form and client page", "Pulling the winners in their industry", "Choosing the angles", "Writing the concepts and hooks", "Fitting it to their allotment"];
const WRITE_SECONDS = 90;

/** Business days between two moments (weekends don't count), for how long something has waited. */
function businessDaysSince(iso: string, now: number) {
  let days = 0;
  const d = new Date(iso);
  const end = new Date(now);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (d <= end && d.getDay() !== 0 && d.getDay() !== 6) days++;
  }
  return days;
}
const waited = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`);

function ClientCard({ c, onOpen }: { c: OnboardingCard; onOpen: (s: OpenSuggestion) => void }) {
  const router = useRouter();
  const [busy, act] = useTransition();
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const intakeIn = Boolean(c.intake && c.intake.status !== "unmatched");
  const since = c.writingSince ?? started;
  const writing = Boolean(since) && !c.firstRound && !c.inProduction.length;
  const failed = !writing && !c.firstRound && Boolean(c.writeError);

  // While it writes: tick the bar every second and look for the finished brief every 4
  useEffect(() => {
    if (!writing) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => router.refresh(), 4000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [writing, router]);

  const write = async () => {
    setError(null);
    setStarted(new Date().toISOString());
    const r = await writeFirstRound(c.clientId);
    if (!r.ok) {
      setStarted(null);
      return setError(r.error);
    }
    router.refresh();
  };

  // Times depend on the clock, so they're worked out in the browser only (the server's render shows the start)
  const inBrowser = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const elapsed = since && inBrowser ? Math.max(0, (now - Date.parse(since)) / 1000) : 0;
  const pct = writing ? Math.min(96, Math.round((elapsed / WRITE_SECONDS) * 100)) : 0;
  const stepNow = WRITE_STEPS[Math.min(WRITE_STEPS.length - 1, Math.floor((elapsed / WRITE_SECONDS) * WRITE_STEPS.length))];

  // How long each stage has taken, or has been waiting
  const intakeWait = businessDaysSince(c.since, now);
  const intakeTook = intakeIn ? businessDaysSince(c.since, Date.parse(c.intake!.at)) : 0;
  const readySince = c.firstRound?.createdAt ?? null;
  const steps: { label: string; detail: string; sub?: string; state: "done" | "now" | "todo"; late?: boolean }[] = [
    { label: c.returning ? "Came back" : "Enrolled", detail: day(c.since), state: "done" },
    intakeIn
      ? { label: "Intake form", detail: `In ${day(c.intake!.at)}`, sub: Date.parse(c.intake!.at) < Date.parse(c.since) ? "Before enrolling" : `Took ${waited(intakeTook)}`, state: "done" }
      : { label: "Intake form", detail: "Waiting on the client", sub: `${waited(intakeWait)} so far`, state: "now", late: intakeWait > 2 },
    {
      label: "First round",
      detail: c.inProduction.length ? "Approved" : c.firstRound ? "Ready for you" : writing ? `AI is writing it · ${pct}%` : failed ? "Couldn't write it" : intakeIn ? "Ready to write" : "Not yet",
      sub: c.firstRound && readySince ? `Waiting on you ${waited(businessDaysSince(readySince, now))}` : undefined,
      state: c.inProduction.length ? "done" : c.firstRound || writing || failed || intakeIn ? "now" : "todo",
      late: Boolean(c.firstRound && readySince && businessDaysSince(readySince, now) > 1),
    },
    { label: "In production", detail: c.inProduction.length ? `${c.inProduction.length} ${c.inProduction.length === 1 ? "ticket" : "tickets"}` : "—", state: c.inProduction.length ? "now" : "todo" },
  ];

  return (
    <article className="grid content-start gap-4 rounded-[16px] border border-line bg-bg/70 p-4 backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/clients/${c.slug}`} className="truncate font-heading text-lg hover:underline">
              {c.name}
            </Link>
            {c.returning && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[10px] font-medium text-ok">Welcome back</span>}
            {!c.creative && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-faint">No creative package</span>}
          </span>
          <span className="truncate text-xs text-muted">{c.intake?.business ?? c.industry ?? "Industry not known yet"}</span>
        </div>
      </div>

      <ol className="grid grid-cols-2 gap-x-3 gap-y-3 md:grid-cols-4 md:gap-1.5">
        {steps.map((s, i) => (
          <li key={s.label} className="grid content-start gap-1.5">
            <span className="relative h-1 overflow-hidden rounded-full bg-surface-2">
              {i === 2 && writing ? (
                <span className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
              ) : (
                <span className={`absolute inset-0 rounded-full ${s.state === "done" ? "bg-ok" : s.state === "now" ? (s.late || (i === 2 && failed) ? "bg-bad" : "bg-brand") : ""}`} />
              )}
            </span>
            <span className={`text-[11px] font-medium ${s.state === "todo" ? "text-faint" : "text-fg"}`}>{s.label}</span>
            <span className={`text-[10.5px] leading-snug ${s.state === "now" ? (s.late || (i === 2 && failed) ? "text-bad" : "text-brand-text") : "text-faint"}`}>{s.detail}</span>
            {s.sub && <span className={`text-[10px] leading-snug ${s.late ? "text-bad" : "text-faint"}`}>{s.sub}</span>}
          </li>
        ))}
      </ol>

      {c.setup && <Setup s={c.setup} />}

      {writing && (
        <div className="grid gap-1.5 rounded-[12px] border border-brand/25 bg-brand-soft/30 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2 text-brand-text">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
              {stepNow}…
            </span>
            <span className="tabular text-faint">{pct}%</span>
          </div>
          <span className="h-1 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[10.5px] text-faint">{elapsed > WRITE_SECONDS ? "Taking longer than usual; it keeps going and opens here when it's done." : "About a minute and a half. You can leave the page; it keeps going."}</span>
        </div>
      )}

      {(error || failed) && <p className="text-xs text-bad">{error ?? `The last try didn't finish: ${c.writeError}`}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {c.firstRound ? (
          <button onClick={() => onOpen(c.firstRound!)} className="h-11 flex-1 rounded-brand bg-brand px-4 md:h-9 md:flex-none text-sm font-medium text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:brightness-110">
            Review the first round
          </button>
        ) : c.inProduction.length ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {c.inProduction.map((n) => (
              <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-3 py-2 hover:border-faint md:px-2 md:py-0.5">
                #{n}
              </Link>
            ))}
          </span>
        ) : writing ? null : c.creative ? (
          <button onClick={write} className="h-11 flex-1 rounded-brand border border-brand/50 px-4 text-sm text-fg hover:bg-brand-soft md:h-9 md:flex-none">
            {failed ? "Try again" : intakeIn ? "Write the first round" : "Write it without the intake"}
          </button>
        ) : null}
        <button
          onClick={() =>
            act(async () => {
              const r = await markOnboarded(c.clientId, c.slug);
              if (!r.ok) return setError(r.error);
              router.refresh();
            })
          }
          disabled={busy}
          className="ml-auto h-11 px-2 text-xs text-faint hover:text-fg md:h-9"
        >
          {busy ? "Saving…" : "Mark onboarded"}
        </button>
      </div>
    </article>
  );
}

// The account managers' setup checklist from the Account Overview sheet's Onboarding tab (read at 12pm and 5pm ET)
const SETUP: [string, string][] = [
  ["welcome", "Welcome email"],
  ["call", "Onboarding call"],
  ["access", "Access"],
  ["internal", "Internal meeting"],
  ["intake", "Intake form"],
  ["content", "Content"],
  ["tracking", "Tracking"],
  ["live", "Campaigns live"],
];
const done = (s: NonNullable<OnboardingCard["setup"]>) => SETUP.filter(([k]) => s.steps[k]).length;

function Setup({ s }: { s: NonNullable<OnboardingCard["setup"]> }) {
  const n = done(s);
  const next = SETUP.find(([k]) => !s.steps[k]);
  return (
    <div className="grid gap-2.5 rounded-[12px] border border-line bg-surface/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Account setup</span>
        <span className="tabular text-faint">
          {s.progress ?? `${n}/${SETUP.length}`}
          {next ? ` · next: ${next[1].toLowerCase()}` : ""}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {SETUP.map(([k, label]) => (
          <li
            key={k}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] ${s.steps[k] ? "bg-ok-soft text-ok" : k === next?.[0] ? "border border-brand/40 text-brand-text" : "border border-line text-faint"}`}
          >
            {s.steps[k] ? "✓" : "○"} {label}
          </li>
        ))}
      </ul>
      {s.notes && <p className="text-[11px] leading-snug text-muted">{s.notes}</p>}
      <p className="text-[10px] text-faint">From the Account Overview sheet · {day(s.syncedAt)}</p>
    </div>
  );
}

function Unmatched({ u, clients }: { u: { id: string; name: string | null; at: string }; clients: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">
        &ldquo;{u.name ?? "No business name"}&rdquo; <span className="text-xs text-faint">· {day(u.at)}</span>
      </span>
      <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-11 w-full rounded-brand border border-line bg-bg px-2 text-xs md:h-8 md:w-auto md:max-w-[220px]">
        <option value="">Which client is it?</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        disabled={!pick || busy}
        onClick={() =>
          act(async () => {
            const r = await matchIntake(u.id, pick);
            if (!r.ok) return setError(r.error);
            router.refresh();
          })
        }
        className="h-11 w-full rounded-brand bg-fg px-3 text-xs text-bg disabled:opacity-40 md:h-8 md:w-auto"
      >
        Match
      </button>
      {error && <span className="w-full text-xs text-bad">{error}</span>}
    </div>
  );
}
