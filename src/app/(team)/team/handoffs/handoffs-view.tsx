"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChatPlan } from "@/app/(team)/clients/[slug]/chat-plan";
import type { MoveView, TransferView } from "@/lib/seat-transfer";
import type { SeatLine } from "@/lib/seat-transfer-core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { approveAll, approveMove, changeMovePerson, dropPlannedMove, rewriteMoveDoc } from "./actions";

// The Handoffs page: each plan (someone's seats to someone else) as one card, every move a row: the client, the seat,
// who has it → who takes it (changeable), the handoff written for them (read it before approving), and Approve or
// Drop; Approve all for the whole plan. A handoff opened lives in the address (?doc=), so back closes it.

const LINE: Record<SeatLine, string> = { meta: "Meta", google: "Google", creative: "Creative", email: "Email", social: "Social" };

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function HandoffsView({ transfers, singles, focus, lines, exec }: { transfers: TransferView[]; singles: string[]; focus: string | null; lines: SeatLine[]; exec: boolean }) {
  const router = useRouter();
  const docId = useParam("doc");
  const open = transfers.filter((t) => t.moves.some((m) => ["planned", "applying", "failed"].includes(m.status)));
  const past = transfers.filter((t) => !open.includes(t));
  const doc = transfers.flatMap((t) => t.moves).find((m) => m.id === docId) ?? null;
  // Handoffs still being written: look again in a few seconds
  const writing = transfers.some((t) => t.moves.some((m) => m.docStatus === "writing" || m.status === "applying"));
  useEffect(() => {
    if (!writing) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [writing, router]);

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[980px] gap-8 pb-10">
      <header className="grid gap-1.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Team</p>
        <h1 className="font-heading text-[28px] leading-tight md:text-[34px]">Handoffs</h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-muted">
          Accounts moving from one person to another. Read each handoff, change who takes a seat, then approve. Nothing moves until you do.{" "}
          {exec ? "You can move any seat." : `You move the ${lines.map((l) => LINE[l]).join(" and ")} seats.`} Ask your assistant to plan one: &ldquo;Move all of Matheus&apos;s accounts to Lucas.&rdquo;
        </p>
      </header>

      {open.length === 0 && singles.length === 0 && (
        <div className="grid place-items-center gap-2 rounded-[22px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading text-[18px]">Nothing waiting</p>
          <p className="max-w-sm text-[13.5px] leading-relaxed text-muted">When your assistant plans moving someone&apos;s accounts, the plan shows up here to approve.</p>
        </div>
      )}

      {open.map((t) => (
        <TransferCard key={t.id} t={t} focused={focus === t.id} />
      ))}

      {singles.length > 0 && (
        <section className="grid min-w-0 gap-3">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Single seat changes</h2>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {singles.map((id) => (
              <ChatPlan key={id} id={id} />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <details className="group grid gap-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-muted transition-colors hover:text-fg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition-transform group-open:rotate-90">
              <path d="m9 6 6 6-6 6" />
            </svg>
            Finished ({past.length})
          </summary>
          <div className="mt-3 grid gap-4">
            {past.map((t) => (
              <TransferCard key={t.id} t={t} focused={false} />
            ))}
          </div>
        </details>
      )}

      {doc && <DocSheet m={doc} onClose={() => closeParams("doc")} />}
    </div>
  );
}

function TransferCard({ t, focused }: { t: TransferView; focused: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const waiting = t.moves.filter((m) => ["planned", "failed"].includes(m.status));
  const ready = waiting.filter((m) => m.toId);
  const done = t.moves.filter((m) => m.status === "applied").length;
  const all = () =>
    start(async () => {
      setError(null);
      const r = await approveAll(t.id);
      if (!r.ok) setError(r.error);
      else if (r.failed.length) setError(`${r.done} moved; ${r.failed.length} didn't: ${r.failed[0].error}`);
      router.refresh();
    });
  return (
    <section className={`grid min-w-0 gap-4 rounded-[22px] border bg-surface p-4 shadow-sm md:p-5 ${focused ? "border-brand/50 ring-2 ring-brand/15" : "border-line"}`} aria-label={`Moving ${t.from ?? "someone"}'s accounts`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="font-heading text-[19px] leading-snug [overflow-wrap:anywhere] md:text-[21px]">
            {t.from ?? "Someone"}
            <span className="px-2 text-faint">→</span>
            {t.to ?? "several people"}
          </p>
          <p className="text-[12.5px] text-muted">
            {t.moves.length} seat{t.moves.length === 1 ? "" : "s"} · {done} moved{t.by ? ` · planned by ${t.by}` : ""} · {when(t.createdAt)}
          </p>
          {t.note && <p className="text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">{t.note}</p>}
        </div>
        {ready.length > 0 && (
          <button type="button" onClick={all} disabled={pending} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 md:min-h-10">
            {pending ? "Moving…" : `Approve all (${ready.length})`}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] divide-y divide-line overflow-hidden rounded-[16px] border border-line">
        {t.moves.map((m) => (
          <MoveRow key={m.id} m={m} busyAll={pending} />
        ))}
      </ul>
    </section>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: "Waiting", cls: "bg-surface-2 text-muted" },
  applying: { label: "Moving…", cls: "bg-brand-soft text-brand-text" },
  applied: { label: "Moved", cls: "bg-ok-soft text-ok" },
  dropped: { label: "Dropped", cls: "bg-surface-2 text-faint" },
  failed: { label: "Didn't go", cls: "bg-bad/10 text-bad" },
};

function MoveRow({ m, busyAll }: { m: MoveView; busyAll: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(m.error);
  const waiting = m.status === "planned" || m.status === "failed";
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  const s = STATUS[m.status] ?? STATUS.planned;
  return (
    <li className={`grid min-w-0 gap-3 p-3.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_auto] md:items-center md:gap-4 md:p-4 ${m.status === "dropped" ? "opacity-55" : ""}`}>
      <div className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {m.slug ? (
            <Link href={`/clients/${m.slug}?tab=team`} className="min-w-0 font-medium text-fg [overflow-wrap:anywhere] hover:underline">
              {m.client}
            </Link>
          ) : (
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{m.client}</span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${s.cls}`}>{s.label}</span>
        </span>
        <span className="text-[12.5px] text-muted">
          {m.seat}
          {m.primary ? "" : " (secondary)"}
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13.5px]">
        <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{m.from ?? "Nobody"}</span>
        <span aria-hidden className="text-faint">→</span>
        {waiting ? (
          <label className="min-w-0 flex-1">
            <span className="sr-only">Who takes the {m.seat} seat on {m.client}</span>
            <select
              value={m.toId ?? ""}
              disabled={pending || busyAll}
              onChange={(e) => e.target.value && run(() => changeMovePerson(m.id, e.target.value))}
              className={`h-11 w-full min-w-0 max-w-[260px] rounded-full border bg-surface px-3.5 text-[16px] text-fg outline-none transition-colors focus:border-faint md:h-9 md:text-[13.5px] ${m.toId ? "border-line" : "border-warn/60"}`}
            >
              {!m.toId && <option value="">Pick who takes it…</option>}
              {m.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{m.to ?? "Nobody"}</span>
        )}
        <DocChip m={m} onRetry={() => run(() => rewriteMoveDoc(m.id))} />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
        {waiting && (
          <>
            <button type="button" onClick={() => run(() => dropPlannedMove(m.id))} disabled={pending || busyAll} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50 md:min-h-9">
              Drop
            </button>
            <button type="button" onClick={() => run(() => approveMove(m.id))} disabled={pending || busyAll || !m.toId} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition hover:opacity-90 active:scale-[0.98] disabled:opacity-40 md:min-h-9">
              {pending ? "Moving…" : "Approve"}
            </button>
          </>
        )}
        {m.status === "applied" && m.handoffId && (
          <Link href={`/handoff/${m.handoffId}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg md:min-h-9">
            Their handoff
          </Link>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-bad md:col-span-3">
          {error}
        </p>
      )}
    </li>
  );
}

function DocChip({ m, onRetry }: { m: MoveView; onRetry: () => void }) {
  if (m.docStatus === "none") return null;
  if (m.docStatus === "writing")
    return (
      <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[12px] text-muted">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
        Writing the handoff…
      </span>
    );
  if (m.docStatus === "failed")
    return (
      <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center rounded-full px-3 text-[12px] text-bad transition-colors hover:bg-bad/10 md:min-h-9">
        Handoff didn&apos;t write · Try again
      </button>
    );
  return (
    <button type="button" onClick={() => pushParams({ doc: m.id })} className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-brand-soft px-3 text-[12px] font-medium text-brand-text transition hover:opacity-85 md:min-h-9">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6" />
      </svg>
      Read the handoff
    </button>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{title}</h3>
      <ul className="grid gap-1.5">
        {items.map((x, i) => (
          <li key={i} className="flex gap-2 text-[14px] leading-relaxed text-fg/90">
            <span aria-hidden className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-faint" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{x}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The handoff written for the new person, read before approving the move */
function DocSheet({ m, onClose }: { m: MoveView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = was;
    };
  }, [onClose]);
  const d = m.doc;
  return (
    <div className="fixed inset-0 z-[85] flex items-stretch justify-end" role="dialog" aria-modal aria-label={`Handoff for ${m.client}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-[sheet-fade_.2s_ease-out]" />
      <div className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-bg pt-safe pb-safe animate-[sheet-up_.26s_cubic-bezier(.2,.8,.2,1)] md:w-[min(640px,92vw)] md:border-l md:border-line md:bg-surface">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-brand-text">Handoff · {m.seat}</p>
            <p className="font-heading text-[20px] leading-tight [overflow-wrap:anywhere]">{m.client}</p>
            <p className="text-[12.5px] text-muted">
              {m.from ?? "Nobody"} → {m.to ?? "nobody yet"}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close the handoff" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {!d ? (
            <p className="text-[14px] text-muted">{m.docStatus === "writing" ? "The strategist is writing it now." : "There's no handoff for this move."}</p>
          ) : (
            <div className="grid gap-6">
              <div className="grid gap-2">
                <p className="font-heading text-[18px] leading-snug">{d.headline}</p>
                <p className="text-[14.5px] leading-relaxed text-fg/90">{d.summary}</p>
              </div>
              <List title="Do" items={d.dos} />
              <List title="Don't" items={d.donts} />
              <List title="In motion" items={(d.inMotion ?? []).map((x) => `${x.what}: ${x.status}`)} />
              <List title="Keep in mind" items={d.keepInMind} />
              <List title="First week" items={d.firstWeek} />
              <List title="What the client said" items={(d.clientSaid ?? []).map((x) => `${x.when} · ${x.what}`)} />
              <p className="text-[12.5px] leading-relaxed text-faint">They get this handoff when the move is approved, with everything else about the account, and can ask questions about it.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
