"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Combobox } from "@/components/combobox";
import { DuePill } from "@/components/due-pill";
import { PersonAvatar } from "@/components/person-avatar";
import { PriorityBadge } from "@/components/priority-badge";
import { toast } from "@/components/toasts";
import { tintFor } from "@/lib/colors";
import { closeParams, pushParams, replaceParams } from "@/lib/url-state";
import { businessDuration } from "@/lib/stages";
import type { EmailShadow } from "@/lib/asana-email";
import type { EmailTicket } from "@/lib/email-board";
import { EMAIL_BOARD_ORDER, EMAIL_PHASE_LABEL, emailHealth, emailStageInfo, handle, messageStatus, MESSAGE_STATUS_LABEL, type EmailKind, type EmailPhase, type EmailStage, type Health } from "@/lib/email-board-core";
import { ClientTag } from "../ticket-card";
import { migrateEmailAsana, moveEmailAsana } from "./actions";
import { EmailMoveDialog, EmailTicketSheet, KindBadge } from "./email-ticket-sheet";

type Person = { id: string; name: string; role: string };
type ClientOption = { id: string; name: string; slug: string };

const COL = 288;
const GAP = 12;
const RANK: Record<Health, number> = { bad: 0, warn: 1, ok: 2 };
const STAMP: Record<Health, string> = { ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad" };
const EDGE: Record<Health, string> = { ok: "before:bg-transparent", warn: "before:bg-warn", bad: "before:bg-bad" };
const BANDS: { phase: EmailPhase; span: number }[] = [];
for (const s of EMAIL_BOARD_ORDER) {
  const p = emailStageInfo(s).phase;
  const last = BANDS[BANDS.length - 1];
  if (last?.phase === p) last.span++;
  else BANDS.push({ phase: p, span: 1 });
}

/** The dots on a card: each message's own status, so a part-approved batch reads at a glance */
function MessageDots({ t }: { t: EmailTicket }) {
  const tone: Record<string, string> = { copy: "bg-faint", design: "bg-[#8b9cf7]", review: "bg-[#8b9cf7]", client: "bg-warn", approved: "bg-ok", changes: "bg-bad", built: "bg-ok", live: "bg-ok" };
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label="Each message's status">
      {t.messages.map((m) => {
        const s = messageStatus({ channel: m.channel, copyApproved: m.copyApproved, hasDesign: Boolean(m.designPath), aiReview: m.aiReviewStatus, clientStatus: m.clientStatus, builtAt: m.builtAt, liveAt: m.liveAt }, t.stage);
        return (
          <span key={m.id} title={`${m.name}: ${MESSAGE_STATUS_LABEL[s]}`} className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-[9.5px] font-bold text-white ${tone[s]}`}>
            {m.channel === "sms" ? "T" : "E"}
          </span>
        );
      })}
    </span>
  );
}

function EmailCard({ t, onOpen, onDragStart, onDragEnd, dragging }: { t: EmailTicket; onOpen: () => void; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void; dragging?: boolean }) {
  const h = emailHealth(t.minutesOver, t.stage);
  const waitingCopy = t.stage === "copy_review" && t.copyStatus === "writing";
  return (
    <button
      type="button"
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`group relative grid w-full gap-2.5 overflow-hidden rounded-brand border border-line bg-surface p-3 text-left transition duration-150 before:absolute before:inset-y-0 before:left-0 before:w-[3px] hover:-translate-y-px hover:border-faint hover:shadow-[0_10px_30px_-14px_rgba(0,0,0,0.45)] max-md:p-3.5 max-md:active:scale-[0.985] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-text ${EDGE[h]} ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <ClientTag name={t.clientName} />
        <span className="flex shrink-0 items-center gap-1.5">
          <PriorityBadge priority={t.priority} />
          <KindBadge kind={t.kind} />
        </span>
      </div>
      <p className="line-clamp-3 text-[15px] font-medium leading-snug">
        <span className="tabular mr-1.5 text-faint">{handle(t.number)}</span>
        {t.title}
      </p>
      <div className="-mt-0.5 flex items-center justify-between gap-2">
        <MessageDots t={t} />
        {t.clientRounds > 0 && <span className={`rounded-full px-1.5 py-px text-xs ${t.clientRounds >= 2 ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand-text"}`}>client round {t.clientRounds}</span>}
      </div>
      {t.dueOn && <DuePill due={t.dueOn} className="justify-self-start" />}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
          {waitingCopy ? (
            <span className="text-[#6f7fe6] dark:text-[#9aa7f0]">AI writing the copy</span>
          ) : t.assigneeName ? (
            <>
              <PersonAvatar name={t.assigneeName} size={20} />
              <span className="truncate">{t.assigneeName.split(" ")[0]}</span>
            </>
          ) : (
            <span className="text-faint">Unassigned</span>
          )}
        </span>
        <span title={h === "ok" ? "Within turnaround" : `${businessDuration(t.minutesOver)} over turnaround`} className={`tabular inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STAMP[h]}`}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" strokeLinecap="round" />
          </svg>
          {businessDuration(t.minutesInStage)}
        </span>
      </div>
    </button>
  );
}

function ShadowCard({ s, onOpen, onDragStart, onDragEnd, dragging }: { s: EmailShadow; onOpen: () => void; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void; dragging?: boolean }) {
  return (
    <button type="button" draggable={Boolean(onDragStart)} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onOpen} className={`grid w-full gap-2 rounded-brand border border-dashed border-line bg-transparent p-3 text-left text-muted transition hover:border-faint hover:text-fg ${dragging ? "opacity-40" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        {s.clientName ? <ClientTag name={s.clientName} small /> : <span className="text-[11px] text-warn">No client matched</span>}
        <span className="text-[11px] text-faint">Asana</span>
      </div>
      <p className="line-clamp-2 text-sm leading-snug text-fg/80">{s.title}</p>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate">{s.assignee ?? "Unassigned"}</span>
        {s.dueOn && <DuePill due={s.dueOn} />}
      </div>
    </button>
  );
}

function ShadowSheet({ s, canMove, onClose }: { s: EmailShadow; canMove: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center" onClick={onClose}>
      <div className="max-h-[88vh] w-full overflow-y-auto rounded-t-[22px] border border-line bg-bg p-5 pb-[calc(20px+env(safe-area-inset-bottom))] md:max-w-xl md:rounded-[22px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Still in Asana · {s.section ?? "no column"}</span>
            <h2 className="font-heading text-xl leading-snug">{s.title}</h2>
            <p className="text-sm text-muted">{[s.clientName ?? "No client matched", s.assignee ?? "Unassigned", s.dueOn ? `due ${s.dueOn}` : null].filter(Boolean).join(" · ")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
            ✕
          </button>
        </div>
        {s.notes && <p className="mt-4 whitespace-pre-wrap rounded-[14px] bg-surface p-3 text-sm leading-relaxed text-fg/80">{s.notes.slice(0, 3000)}</p>}
        {s.comments.length > 0 && (
          <div className="mt-4 grid gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">Comments in Asana</p>
            {s.comments.slice(-6).map((c, i) => (
              <p key={i} className="rounded-[12px] border border-line p-2.5 text-sm">
                <span className="text-muted">{c.by ?? "Someone"}: </span>
                {c.text.slice(0, 600)}
              </p>
            ))}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {canMove && (
            <button
              type="button"
              disabled={busy || !s.clientId}
              onClick={async () => {
                setBusy(true);
                const r = await migrateEmailAsana(s.gid);
                setBusy(false);
                if (!r.ok) return toast({ tone: "bad", title: "Couldn't move it over", body: r.error });
                toast({ tone: "ok", title: "Moved over to Kaizen", body: "With its history and comments." });
                if (r.number) replaceParams({ a: null, t: String(r.number) });
              }}
              className="h-11 rounded-brand bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "Moving over…" : "Move to Kaizen"}
            </button>
          )}
          {s.url && (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="grid h-11 place-items-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
              Open in Asana
            </a>
          )}
        </div>
        {!s.clientId && <p className="mt-2 text-xs text-warn">Its client couldn&apos;t be matched: add the Client ID in Asana, or the client&apos;s name to the title.</p>}
      </div>
    </div>
  );
}

export function EmailBoardClient({ tickets: initial, clients, people, shadows, me, tabs }: { tickets: EmailTicket[]; clients: ClientOption[]; people: Person[]; shadows: EmailShadow[]; me: { id: string; mine: boolean; lead: boolean }; tabs: React.ReactNode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [tickets, setTickets] = useState(initial);
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) {
    setPrev(initial);
    setTickets(initial);
  }
  // The clocks keep moving and other people's moves arrive while the board is open
  useEffect(() => {
    const tick = setInterval(() => document.visibilityState === "visible" && router.refresh(), 45_000);
    return () => clearInterval(tick);
  }, [router]);

  const q = params.get("q") ?? "";
  const client = params.get("client");
  const personParam = params.get("person");
  const person = personParam === "all" ? null : (personParam ?? (me.mine ? me.id : null));
  const pickPerson = (v: string | null) => pushParams({ person: me.mine ? (v === me.id ? null : (v ?? "all")) : v });
  const kind = (params.get("kind") as EmailKind | null) ?? null;
  const priority = ((p) => (p === "high" || p === "urgent" ? p : null))(params.get("priority"));
  const openNumber = params.get("t");
  const moveNumber = params.get("move");
  const moveTo = params.get("to") as EmailStage | null;
  const shadowId = params.get("a");
  const [dragging, setDragging] = useState<EmailTicket | null>(null);
  const [draggingShadow, setDraggingShadow] = useState<EmailShadow | null>(null);
  const [shadowMoved, setShadowMoved] = useState<Map<string, EmailStage>>(new Map());
  const [dropOn, setDropOn] = useState<EmailStage | null>(null);
  const mayMoveShadow = (x: EmailShadow) => me.lead || x.profileId === me.id;

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^e-?/, "");
    return tickets.filter((x) => (!client || x.clientSlug === client) && (!person || x.assigneeId === person) && (!kind || x.kind === kind) && (!priority || x.priority === priority) && (!t || x.title.toLowerCase().includes(t) || x.clientName.toLowerCase().includes(t) || String(x.number).startsWith(t)));
  }, [tickets, q, client, person, kind, priority]);
  const byStage = useMemo(() => {
    const m = new Map<EmailStage, EmailTicket[]>(EMAIL_BOARD_ORDER.map((s) => [s, []]));
    for (const x of filtered) m.get(x.stage)?.push(x);
    for (const list of m.values()) list.sort((a, b) => RANK[emailHealth(a.minutesOver, a.stage)] - RANK[emailHealth(b.minutesOver, b.stage)] || b.minutesOver - a.minutesOver || b.minutesInStage - a.minutesInStage);
    return m;
  }, [filtered]);
  const shadowsBy = useMemo(() => {
    const t = q.trim().toLowerCase();
    const m = new Map<EmailStage, EmailShadow[]>();
    for (const raw of shadows) {
      const x = shadowMoved.has(raw.gid) ? { ...raw, stage: shadowMoved.get(raw.gid)! } : raw;
      if ((client && x.clientSlug !== client) || (person && x.profileId !== person) || (kind && x.kind !== kind) || (priority && x.priority !== priority)) continue;
      if (t && !x.title.toLowerCase().includes(t) && !(x.clientName ?? "").toLowerCase().includes(t)) continue;
      m.set(x.stage, [...(m.get(x.stage) ?? []), x]);
    }
    return m;
  }, [shadows, shadowMoved, q, client, person, kind, priority]);
  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, bad: 0 };
    for (const x of tickets) if (!client || x.clientSlug === client) c[emailHealth(x.minutesOver, x.stage)]++;
    return c;
  }, [tickets, client]);

  const open = tickets.find((x) => String(x.number) === openNumber) ?? null;
  const moving = tickets.find((x) => String(x.number) === moveNumber) ?? null;
  const dropped = !open && moving && moveTo && EMAIL_BOARD_ORDER.concat("live").includes(moveTo) && moveTo !== moving.stage ? { ticket: moving, to: moveTo } : null;
  const openShadow = shadows.find((x) => x.gid === shadowId) ?? null;
  const selectedClient = clients.find((c) => c.slug === client) ?? null;
  const filtersOn = Boolean(q || client || personParam || kind || priority);

  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left + (parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0);
    const off = [...el.querySelectorAll<HTMLElement>("section[data-col]")].map((c) => Math.abs(c.getBoundingClientRect().left - left));
    if (off.length) setActive(off.indexOf(Math.min(...off)));
  };
  const showColumn = (i: number) => {
    const el = scroller.current;
    const col = el?.querySelectorAll<HTMLElement>("section[data-col]")[i];
    if (!el || !col) return;
    const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
    el.scrollTo({ left: el.scrollLeft + col.getBoundingClientRect().left - el.getBoundingClientRect().left - pad, behavior: "smooth" });
  };
  const dropShadow = (x: EmailShadow, to: EmailStage) => {
    const from = shadowMoved.get(x.gid) ?? x.stage;
    if (from === to) return;
    setShadowMoved((m) => new Map(m).set(x.gid, to));
    moveEmailAsana(x.gid, to).then((r) => {
      if (r.ok) return router.refresh();
      setShadowMoved((m) => new Map(m).set(x.gid, from));
      toast({ tone: "bad", title: "Couldn't move it in Asana", body: r.error });
    });
  };
  const optimisticMove = (id: string, stage: EmailStage) => setTickets((all) => (stage === "live" ? all.filter((x) => x.id !== id) : all.map((x) => (x.id === id ? { ...x, stage, minutesInStage: 0, minutesOver: 0 } : x))));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-heading text-3xl">Email Board</h1>
            {tabs}
          </div>
          <p className="mt-1 text-sm text-muted">
            {person === me.id && !selectedClient ? (
              <>
                Your campaigns and flows, wherever they&apos;re sitting.{" "}
                <button type="button" onClick={() => pickPerson(null)} className="text-fg underline-offset-4 hover:underline">
                  See everyone&apos;s
                </button>
              </>
            ) : selectedClient ? (
              <>
                Every campaign and flow for <span className="text-fg">{selectedClient.name}</span>.
              </>
            ) : (
              "Every campaign batch and flow, from copy to live."
            )}
          </p>
        </div>
        <Link href={`/board/email/new${client ? `?client=${client}` : ""}`} className="flex h-11 items-center gap-2 rounded-brand bg-brand px-5 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.6)] hover:bg-brand-hover max-md:w-full max-md:justify-center">
          <span className="text-lg leading-none">+</span> New email request
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full md:w-auto">
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input defaultValue={q} onChange={(e) => replaceParams({ q: e.target.value || null })} placeholder="Search title, client or E-number" aria-label="Search tickets" className="h-11 w-full rounded-full border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand-text md:h-9 md:w-64" />
        </div>
        <Combobox label="Client" className="w-[calc(50%-4px)] max-md:[&>button]:h-11 md:w-52" placeholder="All clients" allLabel="All clients" value={client} onChange={(v) => pushParams({ client: v })} options={clients.map((c) => ({ value: c.slug, label: c.name, dot: tintFor(c.name), hint: String(tickets.filter((t) => t.clientSlug === c.slug).length || "") }))} />
        <Combobox
          label="Assigned to"
          className="w-[calc(50%-4px)] max-md:[&>button]:h-11 max-md:[&>div]:left-auto max-md:[&>div]:right-0 md:w-44"
          placeholder="Anyone"
          allLabel="Anyone"
          value={person}
          onChange={pickPerson}
          options={[...people.filter((p) => p.id === me.id).map((p) => ({ value: p.id, label: `You (${p.name.split(" ")[0]})`, hint: p.role })), ...people.filter((p) => p.id !== me.id).map((p) => ({ value: p.id, label: p.name, hint: p.role }))]}
        />
        <div className="flex w-full rounded-full border border-line bg-surface p-0.5 text-sm md:w-auto">
          {([null, "batch", "flow"] as const).map((k) => (
            <button key={k ?? "all"} type="button" onClick={() => pushParams({ kind: k })} className={`h-10 flex-1 rounded-full px-3 md:h-auto md:flex-initial md:py-1 ${kind === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {k ? (k === "batch" ? "Campaigns" : "Flows") : "All"}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Priority" className="flex w-full rounded-full border border-line bg-surface p-0.5 text-sm md:w-auto">
          {(
            [
              [null, "Any priority"],
              ["high", "High"],
              ["urgent", "Urgent"],
            ] as const
          ).map(([p, label]) => (
            <button key={p ?? "any"} type="button" role="radio" aria-checked={priority === p} onClick={() => pushParams({ priority: p })} className={`h-10 flex-1 rounded-full px-3 md:h-auto md:flex-initial md:py-1 ${priority === p ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {label}
            </button>
          ))}
        </div>
        {filtersOn && (
          <button type="button" onClick={() => pushParams({ q: null, client: null, person: null, kind: null, priority: null })} className="h-11 px-3 text-xs text-muted hover:text-fg md:h-auto md:px-2">
            Clear
          </button>
        )}
        <div className="flex w-full items-center gap-3 text-xs text-muted md:ml-auto md:w-auto">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" />{counts.ok} on time</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warn" />{counts.warn} up to 12h over</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-bad" />{counts.bad} 12h+ over</span>
        </div>
      </div>

      <div className="relative min-w-0">
        <div className="sticky top-[calc(56px+env(safe-area-inset-top))] z-20 -mx-4 mb-3 border-b border-line/70 bg-bg/90 py-2 backdrop-blur-xl md:hidden">
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-4">
            {EMAIL_BOARD_ORDER.map((s, i) => (
              <button key={s} type="button" onClick={() => showColumn(i)} aria-current={active === i ? "true" : undefined} className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm ${active === i ? "bg-fg text-bg" : "border border-line bg-surface text-muted"}`}>
                {emailStageInfo(s).label}
                <span className="tabular text-xs opacity-70">{(byStage.get(s)?.length ?? 0) + (shadowsBy.get(s)?.length ?? 0)}</span>
              </button>
            ))}
          </div>
        </div>
        <div ref={scroller} onScroll={measure} className="board-scroll -mx-4 snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-4 md:-mx-10 md:snap-none md:scroll-px-0 md:px-10">
          <div style={{ "--board-w": `${EMAIL_BOARD_ORDER.length * COL + (EMAIL_BOARD_ORDER.length - 1) * GAP}px` } as CSSProperties} className="grid w-max gap-3 md:w-[var(--board-w)]">
            <div className="hidden gap-3 md:flex">
              {BANDS.map((b) => (
                <div key={b.phase} style={{ width: b.span * COL + (b.span - 1) * GAP }} className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{EMAIL_PHASE_LABEL[b.phase]}</span>
                  <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
                </div>
              ))}
            </div>
            <div className="flex items-start gap-3">
              {EMAIL_BOARD_ORDER.map((s) => {
                const list = byStage.get(s) ?? [];
                const outlines = shadowsBy.get(s) ?? [];
                const info = emailStageInfo(s);
                const late = list.filter((x) => emailHealth(x.minutesOver, x.stage) === "bad").length;
                return (
                  <section
                    key={s}
                    data-col
                    aria-label={info.label}
                    style={{ "--col": `${COL}px` } as CSSProperties}
                    onDragOver={(e) => {
                      if (draggingShadow ? (shadowMoved.get(draggingShadow.gid) ?? draggingShadow.stage) === s : !dragging || dragging.stage === s) return;
                      e.preventDefault();
                      setDropOn(s);
                    }}
                    onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDropOn(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropOn(null);
                      if (draggingShadow) dropShadow(draggingShadow, s);
                      else if (dragging && dragging.stage !== s) pushParams({ move: String(dragging.number), to: s });
                      setDragging(null);
                      setDraggingShadow(null);
                    }}
                    className={`grid w-[88vw] shrink-0 snap-start content-start gap-2 rounded-[12px] p-2 transition-colors md:w-[var(--col)] ${dropOn === s ? "bg-brand-soft ring-1 ring-brand-text/50" : "bg-surface/50"}`}
                  >
                    <header className="flex items-center gap-2 px-1.5 pt-1">
                      <h2 className="text-sm font-medium">{info.label}</h2>
                      <span className="tabular text-xs text-faint">{list.length}</span>
                      {outlines.length > 0 && <span className="tabular rounded-full border border-dashed border-line px-1.5 text-[11px] text-faint" title="Still in Asana">+{outlines.length}</span>}
                      {late > 0 && <span className="tabular ml-auto rounded-full bg-bad-soft px-1.5 text-[11px] text-bad">{late}</span>}
                    </header>
                    <p className="-mt-1 px-1.5 pb-1 text-[11px] text-faint">{info.owner}</p>
                    {list.map((t) => (
                      <EmailCard
                        key={t.id}
                        t={t}
                        onOpen={() => pushParams({ t: String(t.number) })}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", t.id);
                          setDragging(t);
                        }}
                        onDragEnd={() => (setDragging(null), setDropOn(null))}
                        dragging={dragging?.id === t.id}
                      />
                    ))}
                    {outlines.map((x) => (
                      <ShadowCard
                        key={x.gid}
                        s={x}
                        onOpen={() => pushParams({ a: x.gid })}
                        onDragStart={
                          mayMoveShadow(x)
                            ? (e) => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", x.gid);
                                setDraggingShadow(x);
                              }
                            : undefined
                        }
                        onDragEnd={() => (setDraggingShadow(null), setDropOn(null))}
                        dragging={draggingShadow?.gid === x.gid}
                      />
                    ))}
                    {!list.length && !outlines.length && <div className="grid h-20 place-items-center rounded-brand border border-dashed border-line/70 text-xs text-faint">Nothing here</div>}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {tickets.length === 0 && !shadows.length && (
        <div className="mx-auto grid max-w-md place-items-center gap-2 text-center">
          <p className="font-heading text-lg">No email requests yet</p>
          <p className="text-sm text-muted">Start one and the AI writes the copy right away, with the client&apos;s strategist approving it in Copy for review.</p>
        </div>
      )}

      {openShadow && <ShadowSheet s={openShadow} canMove={mayMoveShadow(openShadow)} onClose={() => closeParams("a")} />}
      {dropped && (
        <EmailMoveDialog
          key={`${dropped.ticket.id}-${dropped.to}`}
          ticket={dropped.ticket}
          to={dropped.to}
          onClose={() => closeParams("move", "to")}
          onMoved={(stage) => {
            optimisticMove(dropped.ticket.id, stage);
            closeParams("move", "to");
            router.refresh();
          }}
        />
      )}
      {openNumber && <EmailTicketSheet key={openNumber} number={Number(openNumber)} people={people} onClose={() => closeParams("t", "m", "move", "to", "tab")} onChanged={() => router.refresh()} />}
    </div>
  );
}
