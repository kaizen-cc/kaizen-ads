"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { OnboardingCard, OnboardingState, OpenSuggestion } from "@/lib/suggestions";
import { markOnboarded } from "../../clients/[slug]/actions";
import { matchIntake, writeFirstRound } from "../onboarding-actions";
import { SuggestionSheet } from "./suggested-briefs";

// New and returning clients, front and center for execs and leads: where each one is (intake, first round,
// production), with the first round one click away. Deliberately louder than everything else on Home.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function OnboardingCallout({ state, clients }: { state: OnboardingState; clients: { id: string; name: string }[] }) {
  const [sheet, setSheet] = useState<OpenSuggestion | null>(null);
  const router = useRouter();
  // Keeps itself current: quickly while an intake is being read, otherwise every minute (a new intake can land any time)
  const reading = state.clients.some((c) => c.intake && ["received", "read"].includes(c.intake.status) && !c.firstRound && !c.inProduction.length);
  useEffect(() => {
    if (sheet) return;
    const t = setInterval(() => router.refresh(), reading ? 8000 : 60000);
    return () => clearInterval(t);
  }, [reading, sheet, router]);
  if (!state.clients.length && !state.unmatched.length) return null;
  // Clients without a creative package have no first round to make: one quiet line, not a card each
  const creative = state.clients.filter((c) => c.creative);
  const other = state.clients.filter((c) => !c.creative);
  const ready = creative.filter((c) => c.firstRound).length;
  return (
    <section className="relative overflow-hidden rounded-[20px] border border-brand/45 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(178,30,44,0.28),rgba(178,30,44,0.06)_45%,transparent_70%)] p-5 shadow-[0_0_0_1px_rgba(178,30,44,0.15),0_20px_60px_-30px_rgba(178,30,44,0.6)] md:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Onboarding</span>
          </span>
          <h2 className="font-display text-2xl tracking-tight md:text-3xl">
            {creative.length} {creative.length === 1 ? "client" : "clients"} getting started
          </h2>
          <p className="text-sm text-muted">
            {ready ? `${ready} first ${ready === 1 ? "round is" : "rounds are"} written and waiting for you. ` : ""}First rounds come from their intake form and what&apos;s winning for similar clients.
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {creative.map((c) => (
          <ClientCard key={c.clientId} c={c} onOpen={setSheet} />
        ))}
      </div>

      {other.length > 0 && (
        <p className="mt-4 text-xs text-faint">
          Also onboarding, without a creative package:{" "}
          {other.map((c, i) => (
            <span key={c.clientId}>
              {i > 0 && ", "}
              <Link href={`/clients/${c.slug}`} className="text-muted hover:text-fg">
                {c.name}
              </Link>
            </span>
          ))}
        </p>
      )}

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
          onClose={() => {
            setSheet(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function ClientCard({ c, onOpen }: { c: OnboardingCard; onOpen: (s: OpenSuggestion) => void }) {
  const router = useRouter();
  const [busy, act] = useTransition();
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intakeIn = Boolean(c.intake && c.intake.status !== "unmatched");
  const reading = c.intake && ["received", "read"].includes(c.intake.status) && !c.firstRound && !c.inProduction.length;
  const failed = c.intake?.status === "failed";

  const write = async () => {
    setError(null);
    setWriting(true);
    const r = await writeFirstRound(c.clientId);
    setWriting(false);
    if (!r.ok) return setError(r.error);
    onOpen(r.suggestion);
  };

  const steps: { label: string; detail: string; state: "done" | "now" | "todo" }[] = [
    { label: c.returning ? "Came back" : "Enrolled", detail: day(c.since), state: "done" },
    { label: "Intake form", detail: intakeIn ? `In ${day(c.intake!.at)}` : "Waiting for it", state: intakeIn ? "done" : "now" },
    {
      label: "First round",
      detail: c.inProduction.length ? "Approved" : c.firstRound ? "Ready for you" : reading ? "AI is writing it" : failed ? "Couldn't write it" : "Not yet",
      state: c.inProduction.length ? "done" : c.firstRound || reading ? "now" : "todo",
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

      <ol className="grid grid-cols-4 gap-1.5">
        {steps.map((s, i) => (
          <li key={s.label} className="grid content-start gap-1.5">
            <span className={`h-1 rounded-full ${s.state === "done" ? "bg-ok" : s.state === "now" ? "bg-brand" : "bg-surface-2"} ${s.state === "now" && i === 2 && !c.firstRound ? "animate-pulse" : ""}`} />
            <span className={`text-[11px] font-medium ${s.state === "todo" ? "text-faint" : "text-fg"}`}>{s.label}</span>
            <span className={`text-[10.5px] leading-snug ${s.state === "now" ? "text-brand-text" : "text-faint"}`}>{s.detail}</span>
          </li>
        ))}
      </ol>

      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {c.firstRound ? (
          <button onClick={() => onOpen(c.firstRound!)} className="h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white shadow-[0_8px_24px_-10px_rgba(178,30,44,0.9)] hover:brightness-110">
            Review the first round
          </button>
        ) : c.inProduction.length ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {c.inProduction.map((n) => (
              <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 py-0.5 hover:border-faint">
                #{n}
              </Link>
            ))}
          </span>
        ) : reading ? (
          <span className="flex items-center gap-2 text-xs text-brand-text">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
            Reading their intake and the winners in their industry…
          </span>
        ) : c.creative ? (
          <button onClick={write} disabled={writing} className="h-9 rounded-brand border border-brand/50 px-4 text-sm text-fg hover:bg-brand-soft disabled:opacity-60">
            {writing ? "Writing the first round…" : intakeIn ? "Write the first round" : "Write it without the intake"}
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
          className="ml-auto h-9 px-2 text-xs text-faint hover:text-fg"
        >
          {busy ? "Saving…" : "Mark onboarded"}
        </button>
      </div>
    </article>
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
      <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 max-w-[220px] rounded-brand border border-line bg-bg px-2 text-xs">
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
        className="h-8 rounded-brand bg-fg px-3 text-xs text-bg disabled:opacity-40"
      >
        Match
      </button>
      {error && <span className="w-full text-xs text-bad">{error}</span>}
    </div>
  );
}
