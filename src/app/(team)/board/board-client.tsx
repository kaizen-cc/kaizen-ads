"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Combobox } from "@/components/combobox";
import { tintFor } from "@/lib/colors";
import { BOARD_ORDER, PHASE_LABEL, health, stageInfo, type Format, type Health, type Phase, type Stage } from "@/lib/stages";
import { TicketCard } from "./ticket-card";
import { ShadowCard, ShadowSheet } from "./shadow";
import type { ShadowTicket } from "@/lib/asana";
import { TicketDrawer } from "./ticket-drawer";
import type { ClientOption, Person, Ticket } from "./types";

const HEALTH_RANK: Record<Health, number> = { bad: 0, warn: 1, ok: 2 };

// Phase bands over the columns: Brief · Make · Review · Client · Launch
const BANDS: { phase: Phase; span: number }[] = [];
for (const s of BOARD_ORDER) {
  const p = stageInfo(s).phase;
  const last = BANDS[BANDS.length - 1];
  if (last?.phase === p) last.span++;
  else BANDS.push({ phase: p, span: 1 });
}

const COL = 280; // px per column
const GAP = 12;

export function BoardClient({
  tickets: initial,
  clients,
  people,
  canRequest,
  can = { review: false, approveCopy: false },
  demo = false,
  shadows = [],
  me = null,
}: {
  tickets: Ticket[];
  clients: ClientOption[];
  people: Person[];
  canRequest: boolean;
  /** review: the Head of Creative or an exec (approve / send back creative). approveCopy: the copywriter or a lead. */
  can?: { review: boolean; approveCopy: boolean; exec?: boolean };
  demo?: boolean;
  /** Open Asana tasks not migrated yet (outline cards) */
  shadows?: ShadowTicket[];
  me?: { id: string; lead: boolean } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [tickets, setTickets] = useState(initial);

  // Fresh data from the server replaces local (optimistic) state
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setTickets(initial);
  }
  // Timers keep moving: refresh quietly every minute
  useEffect(() => {
    if (demo) return;
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [router, demo]);

  // Filters live in the URL so a filtered board can be shared
  const q = params.get("q") ?? "";
  const client = params.get("client");
  const person = params.get("person");
  const format = (params.get("format") as Format | null) ?? null;
  const only = (params.get("only") as Health | null) ?? null;
  const openNumber = params.get("t");

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^#/, "");
    return tickets.filter(
      (x) =>
        (!client || x.clientSlug === client) &&
        (!person || x.assigneeId === person) &&
        (!format || x.format === format) &&
        (!only || health(x.minutesOver, x.stage) === only) &&
        (!t || x.title.toLowerCase().includes(t) || x.clientName.toLowerCase().includes(t) || String(x.number).startsWith(t)),
    );
  }, [tickets, q, client, person, format, only]);

  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, bad: 0 };
    for (const x of tickets.filter((x) => x.stage !== "launched" && (!client || x.clientSlug === client))) c[health(x.minutesOver, x.stage)]++;
    return c;
  }, [tickets, client]);

  const byStage = useMemo(() => {
    const m = new Map<Stage, Ticket[]>(BOARD_ORDER.map((s) => [s, []]));
    for (const x of filtered) m.get(x.stage)?.push(x);
    for (const list of m.values())
      list.sort((a, b) => HEALTH_RANK[health(a.minutesOver, a.stage)] - HEALTH_RANK[health(b.minutesOver, b.stage)] || b.minutesOver - a.minutesOver || b.minutesInStage - a.minutesInStage);
    return m;
  }, [filtered]);

  const open = tickets.find((x) => String(x.number) === openNumber) ?? null;
  const shadowId = params.get("a");
  const openShadow = shadows.find((x) => x.gid === shadowId) ?? null;
  const shadowsBy = useMemo(() => {
    const t = q.trim().toLowerCase();
    const m = new Map<Stage, ShadowTicket[]>();
    for (const x of shadows) {
      if (client && x.clientSlug !== client) continue;
      if (person && x.profileId !== person) continue;
      if (format && x.format !== format) continue;
      if (only) continue; // turnaround health is ours; Asana tasks don't have it
      if (t && !x.name.toLowerCase().includes(t) && !(x.clientName ?? "").toLowerCase().includes(t)) continue;
      m.set(x.stage, [...(m.get(x.stage) ?? []), x]);
    }
    return m;
  }, [shadows, q, client, person, format, only]);
  const selectedClient = clients.find((c) => c.slug === client) ?? null;

  // Getting around a board wider than the screen: a visible scrollbar, the phase labels and arrows jump along it, and
  // dragging empty board space pans it (cards still open on click)
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const [edges, setEdges] = useState({ left: false, right: true });
  // Phones: one column per page, swiped sideways; the stage pills follow the column in view
  const switcher = useRef<HTMLDivElement>(null);
  const pills = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    const left = el.getBoundingClientRect().left + (parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0);
    const off = [...el.querySelectorAll<HTMLElement>("section[data-col]")].map((c) => Math.abs(c.getBoundingClientRect().left - left));
    if (off.length) setActive(off.indexOf(Math.min(...off)));
  };
  useEffect(() => {
    const strip = pills.current;
    const pill = strip?.children[active] as HTMLElement | undefined;
    if (strip && pill) strip.scrollTo({ left: pill.offsetLeft - (strip.clientWidth - pill.offsetWidth) / 2, behavior: "smooth" });
  }, [active]);
  /** Phones: a stage pill brings its column into view, from the top of its list. */
  const showColumn = (i: number) => {
    const el = scroller.current;
    const col = el?.querySelectorAll<HTMLElement>("section[data-col]")[i];
    if (!el || !col) return;
    const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
    el.scrollTo({ left: el.scrollLeft + col.getBoundingClientRect().left - el.getBoundingClientRect().left - pad, behavior: "smooth" });
    const below = switcher.current?.getBoundingClientRect().bottom ?? 0;
    const top = el.getBoundingClientRect().top;
    if (top < below) window.scrollBy({ top: top - below, behavior: "smooth" });
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollBoard = (by: number) => {
    const el = scroller.current;
    el?.scrollTo({ left: el.scrollLeft + by, behavior: "smooth" });
  };
  const jumpTo = (phaseIndex: number) => {
    const before = BANDS.slice(0, phaseIndex).reduce((n, b) => n + b.span, 0);
    scroller.current?.scrollTo({ left: before * (COL + GAP), behavior: "smooth" });
  };

  // Tickets move only from the buttons in the ticket (forward and back), never by dragging
  const optimisticMove = (id: string, stage: Stage) =>
    setTickets((all) => all.map((x) => (x.id === id ? { ...x, stage, minutesInStage: 0, minutesOver: 0 } : x)));

  const filtersOn = Boolean(q || client || person || format || only);

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl">Board</h1>
          <p className="mt-1 text-sm text-muted">
            {selectedClient ? (
              <>
                Everything for <span className="text-fg">{selectedClient.name}</span>, wherever it&apos;s sitting.
              </>
            ) : (
              "Every request, where it's sitting and for how long."
            )}
          </p>
        </div>
        {canRequest && (
          <Link
            href={`/requests/new${client ? `?client=${client}` : ""}`}
            className="flex h-11 items-center gap-2 rounded-brand bg-brand px-5 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] hover:bg-brand-hover"
          >
            <span className="text-lg leading-none">+</span> New request
          </Link>
        )}
      </div>

      {/* Filters + health */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full md:w-auto">
          <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            defaultValue={q}
            onChange={(e) => setParam({ q: e.target.value || null })}
            placeholder="Search title, client or #"
            aria-label="Search tickets"
            className="h-11 w-full rounded-full border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand-text md:h-9 md:w-60"
          />
        </div>
        <Combobox
          label="Client"
          className="w-[calc(50%-4px)] max-md:[&>button]:h-11 md:w-52"
          placeholder="All clients"
          allLabel="All clients"
          value={client}
          onChange={(v) => setParam({ client: v })}
          options={clients.map((c) => ({ value: c.slug, label: c.name, dot: tintFor(c.name), hint: String(tickets.filter((t) => t.clientSlug === c.slug && t.stage !== "launched").length || "") }))}
        />
        <Combobox
          label="Assigned to"
          className="w-[calc(50%-4px)] max-md:[&>button]:h-11 max-md:[&>div]:left-auto max-md:[&>div]:right-0 md:w-44"
          placeholder="Anyone"
          allLabel="Anyone"
          value={person}
          onChange={(v) => setParam({ person: v })}
          options={people.map((p) => ({ value: p.id, label: p.name, hint: p.role }))}
        />
        <div className="flex w-full rounded-full border border-line bg-surface p-0.5 text-sm md:w-auto">
          {([null, "image", "video", "carousel"] as const).map((f) => (
            <button
              key={f ?? "all"}
              onClick={() => setParam({ format: f })}
              className={`h-10 flex-1 rounded-full px-3 md:h-auto md:flex-initial md:py-1 ${format === f ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
            >
              {f ? f[0].toUpperCase() + f.slice(1) : "All"}
            </button>
          ))}
        </div>
        {filtersOn && (
          <button onClick={() => router.replace(pathname, { scroll: false })} className="h-11 px-3 text-xs text-muted hover:text-fg md:h-auto md:px-2">
            Clear
          </button>
        )}

        <div className="flex w-full items-center justify-between gap-1.5 text-xs md:ml-auto md:w-auto md:justify-start">
          {(
            [
              ["ok", "On time", "bg-ok", counts.ok],
              ["warn", "Up to 12h over", "bg-warn", counts.warn],
              ["bad", "12h+ over", "bg-bad", counts.bad],
            ] as const
          ).map(([k, label, dot, n]) => (
            <button
              key={k}
              onClick={() => setParam({ only: only === k ? null : k })}
              className={`flex h-11 items-center gap-1.5 rounded-full border px-3 transition-colors md:h-auto md:px-2.5 md:py-1 ${only === k ? "border-fg/40 bg-surface-2 text-fg" : "border-transparent text-muted hover:text-fg"}`}
              title={`Show only: ${label}`}
            >
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              <span className="tabular">{n}</span>
              <span className="md:hidden lg:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Board */}
      <div className="relative min-w-0">
      {/* Phones: a stage switcher that sticks under the top bar; tap a stage to jump to its column */}
      <div ref={switcher} className="sticky top-[calc(56px+env(safe-area-inset-top))] z-20 -mx-4 mb-3 border-b border-line/70 bg-bg/90 py-2 backdrop-blur-xl md:hidden">
        <div ref={pills} className="no-scrollbar relative flex gap-1.5 overflow-x-auto px-4">
          {BOARD_ORDER.map((s, i) => {
            const list = byStage.get(s) ?? [];
            const late = list.some((x) => health(x.minutesOver, x.stage) === "bad");
            return (
              <button
                key={s}
                type="button"
                onClick={() => showColumn(i)}
                aria-current={active === i ? "true" : undefined}
                className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm transition-colors ${active === i ? "bg-fg text-bg" : "border border-line bg-surface text-muted"}`}
              >
                {stageInfo(s).label}
                <span className="tabular text-xs opacity-70">{list.length + (shadowsBy.get(s)?.length ?? 0)}</span>
                {late && <span className="h-1.5 w-1.5 rounded-full bg-bad" aria-label="Some are 12h+ over" />}
              </button>
            );
          })}
        </div>
      </div>
      {/* Arrows at the edges when there's more board that way */}
      {edges.left && (
        <button onClick={() => scrollBoard(-(COL + GAP) * 3)} aria-label="Scroll the board left" className="absolute left-0 top-1/2 z-10 hidden h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-line bg-surface/95 text-muted shadow-lg backdrop-blur hover:text-fg md:grid">
          ‹
        </button>
      )}
      {edges.right && (
        <button onClick={() => scrollBoard((COL + GAP) * 3)} aria-label="Scroll the board right" className="absolute right-0 top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 translate-x-1/2 place-items-center rounded-full border border-line bg-surface/95 text-muted shadow-lg backdrop-blur hover:text-fg md:grid">
          ›
        </button>
      )}
      <div
        ref={scroller}
        onScroll={measure}
        onPointerDown={(e) => {
          // Pan from empty board space only; cards and buttons keep their clicks. Touch swipes the board natively.
          if (e.pointerType !== "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, select, [role=button], article")) return;
          pan.current = { x: e.clientX, left: scroller.current!.scrollLeft, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          const dx = e.clientX - p.x;
          if (Math.abs(dx) > 3) p.moved = true;
          scroller.current!.scrollLeft = p.left - dx;
        }}
        onPointerUp={() => (pan.current = null)}
        onPointerCancel={() => (pan.current = null)}
        className="board-scroll -mx-4 snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-4 md:-mx-10 md:cursor-grab md:snap-none md:scroll-px-0 md:px-10 md:active:cursor-grabbing"
      >
        <div style={{ "--board-w": `${BOARD_ORDER.length * COL + (BOARD_ORDER.length - 1) * GAP}px` } as CSSProperties} className="grid w-max gap-3 md:w-[var(--board-w)]">
          {/* Phase bands (phones use the stage switcher instead) */}
          <div className="hidden gap-3 md:flex">
            {BANDS.map((b, i) => (
              <div key={b.phase} style={{ width: b.span * COL + (b.span - 1) * GAP }} className="flex items-center gap-2">
                <button onClick={() => jumpTo(i)} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint transition-colors hover:text-fg" title={`Jump to ${PHASE_LABEL[b.phase]}`}>
                  {PHASE_LABEL[b.phase]}
                </button>
                <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
              </div>
            ))}
          </div>

          <div className="flex items-start gap-3">
            {BOARD_ORDER.map((s) => {
              const list = byStage.get(s) ?? [];
              const late = list.filter((x) => health(x.minutesOver, x.stage) === "bad").length;
              const risk = list.filter((x) => health(x.minutesOver, x.stage) === "warn").length;
              const info = stageInfo(s);
              return (
                <section
                  key={s}
                  data-col
                  aria-label={info.label}
                  style={{ "--col": `${COL}px` } as CSSProperties}
                  className="grid w-[88vw] shrink-0 snap-start content-start gap-2 rounded-[10px] bg-surface/50 p-2 md:w-[var(--col)]"
                >
                  <header className="flex items-center gap-2 px-1.5 pb-1 pt-1">
                    <h2 className="text-sm font-medium">{info.label}</h2>
                    <span className="tabular text-xs text-faint">{list.length}</span>
                    {(shadowsBy.get(s)?.length ?? 0) > 0 && (
                      <span className="tabular rounded-full border border-dashed border-line px-1.5 text-[11px] text-faint md:text-[10px]" title="Still in Asana">
                        +{shadowsBy.get(s)!.length}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {late > 0 && <span className="tabular rounded-full bg-bad-soft px-1.5 text-[11px] text-bad md:text-[10px]">{late}</span>}
                      {risk > 0 && <span className="tabular rounded-full bg-warn-soft px-1.5 text-[11px] text-warn md:text-[10px]">{risk}</span>}
                    </span>
                  </header>
                  {info.owner && <p className="-mt-1 px-1.5 text-[11px] text-faint">{info.owner}</p>}
                  {list.map((t) => (
                    <TicketCard
                      key={t.id}
                      ticket={t}
                      onOpen={() => setParam({ t: String(t.number) })}
                    />
                  ))}
                  {(shadowsBy.get(s) ?? []).map((x) => (
                    <ShadowCard key={x.gid} s={x} onOpen={() => setParam({ a: x.gid })} />
                  ))}
                  {list.length === 0 && !(shadowsBy.get(s) ?? []).length && (
                    <div className="grid h-20 place-items-center rounded-brand border border-dashed border-line/70 text-xs text-faint">
                      —
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
      </div>

      {tickets.length === 0 && (
        <div className="mx-auto grid max-w-md place-items-center gap-2 text-center">
          <p className="font-heading text-lg">No requests yet</p>
          <p className="text-sm text-muted">Create the first one and it lands in Requested, assigned to the client&apos;s designer or editor with its turnaround running.</p>
        </div>
      )}

      {openShadow && <ShadowSheet s={openShadow} canMigrate={Boolean(me && (me.lead || openShadow.profileId === me.id))} onClose={() => setParam({ a: null })} />}
      {open && <TicketDrawer key={open.id} ticket={open} people={people} can={can} onClose={() => setParam({ t: null })} onOptimisticMove={optimisticMove} demo={demo} />}

    </div>
  );
}
