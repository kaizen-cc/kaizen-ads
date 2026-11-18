"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { WatchFlag, WatchMismatch, WatchPause } from "@/lib/account-watch/load";
import { SERVICES } from "@/lib/services";
import { endCreativePackage, setClientService } from "../clients/[slug]/actions";
import { endWatchPause, pauseWatchedService, placeWatchActor, requestWatchSprint, resolveWatchFlag, runWatchNow } from "./actions";

// The Account watch's lists: each flag as a card with its one or two moves (pause until a day, mark handled, place a
// name, ask for a sprint), the Stripe check with its one-tap fixes, and the services paused on purpose.

type Team = { id: string; name: string }[];
const SERVICE_LABEL = Object.fromEntries(SERVICES.map((s) => [s.slug, s.short])) as Record<string, string>;
/** The client page's line tab for a service */
const SERVICE_PARAM: Record<string, string> = { "facebook-ads": "meta", "google-ads": "google", "tiktok-ads": "tiktok", creative: "creative", "email-marketing": "email", "social-media": "social" };
const TONE = { critical: "bg-bad", warn: "bg-warn", info: "bg-brand" } as const;

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, msg, run };
}

const btn = "inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-fg transition-colors hover:border-faint disabled:opacity-50 md:min-h-9";
const primary = "inline-flex min-h-11 items-center justify-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50 md:min-h-9";
const field = "min-h-11 w-full rounded-[10px] border border-line bg-surface px-3 text-[14px] text-fg outline-none focus:border-faint md:min-h-9";

export function RunNow() {
  const { pending, msg, run } = useAct();
  return (
    <div className="grid justify-items-end gap-1">
      <button type="button" className={btn} disabled={pending} onClick={() => run(runWatchNow)}>
        {pending ? "Checking every account…" : "Check now"}
      </button>
      {msg && <span className={`text-xs ${msg.ok ? "text-muted" : "text-bad"}`}>{msg.text}</span>}
    </div>
  );
}

export function WatchList({ flags, canDecide, team, empty }: { flags: WatchFlag[]; canDecide: boolean; team: Team; empty: string }) {
  if (!flags.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">All clear</p>
        <p className="text-sm text-muted">{empty}</p>
      </section>
    );
  return (
    <ul className="grid gap-3">
      {flags.map((f) => (
        <FlagCard key={f.id} f={f} canDecide={canDecide} team={team} />
      ))}
    </ul>
  );
}

function FlagCard({ f, canDecide, team }: { f: WatchFlag; canDecide: boolean; team: Team }) {
  const { pending, msg, run } = useAct();
  const [open, setOpen] = useState<"pause" | "handled" | "place" | null>(null);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [who, setWho] = useState("");
  const changes = f.kind === "unrecognized" ? ((f.detail.changes ?? []) as { at: string; what: string; object: string | null }[]) : [];
  const closes = f.kind === "idle" || f.kind === "unrecognized" ? canDecide : true;
  return (
    <li className="relative grid gap-3 overflow-hidden rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${TONE[f.severity]}`} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/clients/${f.slug}`} className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted hover:text-fg">
            {f.client}
            {f.line && SERVICE_LABEL[f.line] ? ` · ${SERVICE_LABEL[f.line]}` : ""}
          </Link>
          <p className="mt-1 font-heading text-[17px] leading-snug">{f.title}</p>
        </div>
        {f.severity === "critical" && <span className="shrink-0 rounded-full bg-bad-soft px-2.5 py-0.5 text-[11px] font-medium text-bad">Critical</span>}
      </div>
      {f.body && <p className="text-[13.5px] leading-relaxed text-muted">{f.body}</p>}
      {changes.length > 0 && (
        <ul className="grid gap-1 rounded-[12px] bg-ink/[0.03] p-3 text-[12.5px] text-muted">
          {changes.slice(0, 8).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="tabular shrink-0 text-faint">{c.at.slice(0, 10)}</span>
              <span className="min-w-0 truncate">
                {c.what}
                {c.object ? ` · ${c.object}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {f.kind === "idle" && canDecide && f.line && (
          <button type="button" className={btn} onClick={() => setOpen(open === "pause" ? null : "pause")}>
            Paused on purpose…
          </button>
        )}
        {f.kind === "creative_sprint" && (
          <button type="button" className={primary} disabled={pending} onClick={() => run(() => requestWatchSprint(f.id))}>
            Ask for 2 extra creatives
          </button>
        )}
        {f.kind === "unrecognized" && canDecide && (
          <>
            <button type="button" className={btn} onClick={() => setOpen(open === "place" ? null : "place")}>
              It&apos;s on our team…
            </button>
            <button type="button" className={btn} disabled={pending} onClick={() => run(() => placeWatchActor(f.id, "client"))}>
              The client&apos;s person
            </button>
            <button type="button" className={btn} disabled={pending} onClick={() => run(() => placeWatchActor(f.id, "partner"))}>
              Partner or tool
            </button>
          </>
        )}
        {closes && (
          <button type="button" className={btn} onClick={() => setOpen(open === "handled" ? null : "handled")}>
            Handled…
          </button>
        )}
        <Link href={`/clients/${f.slug}${f.line && SERVICE_PARAM[f.line] ? `?service=${SERVICE_PARAM[f.line]}` : ""}`} className={btn}>
          Open
        </Link>
      </div>
      {open === "pause" && f.line && (
        <form
          className="grid gap-2 rounded-[14px] border border-line p-3 md:grid-cols-[180px_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => pauseWatchedService(f.clientId, f.line!, until, reason));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted">
            Paused until
            <input type="date" required value={until} onChange={(e) => setUntil(e.target.value)} className={field} />
          </label>
          <label className="grid gap-1 text-[12px] text-muted">
            Why
            <input required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Off season until spring, the client asked" className={field} />
          </label>
          <button type="submit" className={primary} disabled={pending}>
            Save pause
          </button>
        </form>
      )}
      {open === "handled" && (
        <form
          className="grid gap-2 rounded-[14px] border border-line p-3 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => resolveWatchFlag(f.id, note));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted">
            What was done (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Relaunched the search campaign" className={field} />
          </label>
          <button type="submit" className={primary} disabled={pending}>
            Mark handled
          </button>
        </form>
      )}
      {open === "place" && (
        <form
          className="grid gap-2 rounded-[14px] border border-line p-3 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => placeWatchActor(f.id, "team", who));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted">
            Who is it
            <select required value={who} onChange={(e) => setWho(e.target.value)} className={field}>
              <option value="">Pick a team member</option>
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primary} disabled={pending}>
            Add as their name
          </button>
        </form>
      )}
      {msg && <p className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </li>
  );
}

export function MismatchList({ rows, syncedAt }: { rows: WatchMismatch[]; syncedAt: string | null }) {
  if (!syncedAt)
    return (
      <section className="grid gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Not read from Stripe yet</p>
        <p className="text-sm text-muted">The hourly Kaizen Track mirror reads what Stripe bills. It shows here after its next run.</p>
      </section>
    );
  if (!rows.length)
    return (
      <section className="grid gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Every client matches Stripe</p>
        <p className="text-sm text-muted">The services and creative packages here are what Stripe billed in the last 45 days.</p>
      </section>
    );
  const by = new Map<string, WatchMismatch[]>();
  for (const r of rows) by.set(r.clientId, [...(by.get(r.clientId) ?? []), r]);
  return (
    <section className="grid gap-3">
      <p className="text-[13px] text-muted">Kaizen OS against what Stripe billed in the last 45 days (via Kaizen Track). A fix changes Kaizen OS only, never Stripe.</p>
      <ul className="grid gap-px overflow-hidden rounded-[18px] border border-line bg-line">
        {[...by.values()].map((list) => (
          <li key={list[0].clientId} className="grid gap-2 bg-surface p-4">
            <Link href={`/clients/${list[0].slug}`} className="font-heading text-[16px] hover:text-brand-text">
              {list[0].client}
            </Link>
            <ul className="grid gap-2">
              {list.map((m, i) => (
                <MismatchRow key={i} m={m} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MismatchRow({ m }: { m: WatchMismatch }) {
  const { pending, msg, run } = useAct();
  const fix = m.fix === "add" ? "Add the service" : m.fix === "remove" ? "Take it off" : m.fix === "clear_package" ? "Clear the package" : null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-[13.5px] text-muted">{m.text}</span>
      {fix && !msg?.ok && (
        <button
          type="button"
          className={btn}
          disabled={pending}
          onClick={() => run(async () => ((m.fix === "clear_package" ? await endCreativePackage(m.clientId, m.slug) : await setClientService(m.clientId, m.slug, m.service!, m.fix === "add")) as { ok: true } | { ok: false; error: string }))}
        >
          {fix}
        </button>
      )}
      {msg && <span className={`text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.ok ? "Fixed" : msg.text}</span>}
    </li>
  );
}

export function PauseList({ pauses, canDecide }: { pauses: WatchPause[]; canDecide: boolean }) {
  if (!pauses.length)
    return (
      <section className="grid gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Nothing paused</p>
        <p className="text-sm text-muted">A seasonal client (a paintball park in winter) is paused from its billed-but-idle card, with the day it comes back.</p>
      </section>
    );
  return (
    <ul className="grid gap-px overflow-hidden rounded-[18px] border border-line bg-line">
      {pauses.map((p) => (
        <PauseRow key={p.id} p={p} canDecide={canDecide} />
      ))}
    </ul>
  );
}

function PauseRow({ p, canDecide }: { p: WatchPause; canDecide: boolean }) {
  const { pending, run } = useAct();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 bg-surface p-4">
      <span className="grid min-w-0">
        <Link href={`/clients/${p.slug}`} className="font-heading text-[15px] hover:text-brand-text">
          {p.client} · {SERVICE_LABEL[p.service] ?? p.service}
        </Link>
        <span className="text-[12.5px] text-muted">
          Until {p.until} · {p.reason}
        </span>
      </span>
      {canDecide && (
        <button type="button" className={btn} disabled={pending} onClick={() => run(() => endWatchPause(p.id))}>
          End pause
        </button>
      )}
    </li>
  );
}
