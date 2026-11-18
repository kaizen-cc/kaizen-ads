"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LINE_LABEL, LINE_OF_SERVICE, type KpiLine, type LineKpi, type Tone } from "@/lib/clients-kpi/core";
import { SERVICES, type ServiceSlug } from "@/lib/services";

// The KPI row under a card's service pills: one chip per line that has a KPI, coloured by the boards' own status. A
// chip opens a small card with the top reasons behind the number (hover on a mouse, a tap on a phone, where it rises
// from the bottom as a sheet), and a way into the KPI card. The reasons are stored with the KPI, nothing is fetched.

const CHIP: Record<Tone, string> = {
  good: "bg-ok-soft text-ok",
  watch: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  none: "bg-surface-2 text-muted",
};
const DOT: Record<Tone, string> = { good: "bg-ok", watch: "bg-warn", bad: "bg-bad", none: "border border-faint/60" };
const WORD: Record<Tone, string> = { good: "On target", watch: "Close to target", bad: "Off target", none: "Not judged" };
const REASON_DOT = { down: "bg-bad", up: "bg-ok", info: "bg-faint" } as const;

/** What a chip says after the line's name: the score, the cost against its target, or why there's nothing to judge */
function chipText(k: LineKpi): string {
  if (k.label === LINE_LABEL[k.line]) return k.shown.replace(/^.*? · /, "");
  return k.shown.startsWith(k.label) ? k.shown : `${k.label} ${k.shown}`;
}

function Chip({ k, name }: { k: LineKpi; name: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; sheet: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // How it opened: hover goes away when the pointer does, a tap or click stays until closed
  const via = useRef<"hover" | "tap">("tap");
  const timer = useRef<number | undefined>(undefined);

  const show = (how: "hover" | "tap") => {
    window.clearTimeout(timer.current);
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    via.current = how;
    const sheet = window.innerWidth < 640;
    setPos({ top: r.bottom + 8, left: Math.max(12, Math.min(r.left, window.innerWidth - 340)), sheet });
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 140);
  };

  // A click while it's open from hover keeps it open; a second one (or a tap on an open one) closes it
  const press = () => {
    if (!open) return show("tap");
    if (via.current === "hover") via.current = "tap";
    else setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!card.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // The popover is placed from where the chip was: scrolling the page moves it, so it closes (the sheet stays put)
    const scroll = () => !pos?.sheet && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, pos?.sheet]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const body = (
    <div ref={card} role="dialog" aria-label={`${LINE_LABEL[k.line]} KPI for ${name}`} data-no-open onPointerEnter={(e) => e.pointerType === "mouse" && window.clearTimeout(timer.current)} onPointerLeave={(e) => e.pointerType === "mouse" && via.current === "hover" && hideSoon()} className="grid gap-2.5 rounded-[14px] border border-line bg-surface p-4 text-left shadow-[0_18px_48px_-12px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{LINE_LABEL[k.line]}</p>
          <p className="mt-0.5 flex items-center gap-2 text-[15px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[k.tone]}`} />
            <span className="tabular font-medium">{k.label === LINE_LABEL[k.line] && k.health != null ? `Score ${k.shown}` : chipText(k)}</span>
          </p>
          <p className="mt-0.5 text-xs text-faint">{WORD[k.tone]}</p>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg md:hidden">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {k.reasons.length ? (
        <ul className="grid gap-1.5 border-t border-line pt-2.5">
          {k.reasons.slice(0, 3).map((r) => (
            <li key={r.text} className="flex items-start gap-2 text-[13px] leading-snug text-muted">
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${REASON_DOT[r.tone]}`} />
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-line pt-2.5 text-[13px] text-faint">{k.tone === "none" ? "Nothing to judge yet." : "No single cause stands out yet."}</p>
      )}
      <Link href={k.href} className="inline-flex min-h-11 items-center text-[13px] text-brand-text hover:underline md:min-h-0">
        Open the KPI card →
      </Link>
    </div>
  );

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={(e) => e.pointerType === "mouse" && show("hover")}
        onPointerLeave={(e) => e.pointerType === "mouse" && via.current === "hover" && hideSoon()}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show("tap")}
        onClick={press}
        className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[11.5px] transition-[filter] hover:brightness-110 md:h-7 md:px-2.5 ${CHIP[k.tone]}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[k.tone]}`} />
        <span className="font-medium">{LINE_LABEL[k.line]}</span>
        <span className="tabular">{chipText(k)}</span>
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          pos.sheet ? (
            <div className="fixed inset-0 z-50 flex items-end bg-fg/25 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-no-open>
              <div className="w-full">{body}</div>
            </div>
          ) : (
            <div className="fixed z-50 w-[328px]" style={{ top: pos.top, left: pos.left }}>
              {body}
            </div>
          ),
          document.body,
        )}
    </>
  );
}

/** The services a line stands for, for the neutral note when a client is on it with no KPI yet */
const SERVICE_OF_LINE: Partial<Record<KpiLine, ServiceSlug>> = { meta: "facebook-ads", google: "google-ads", tiktok: "tiktok-ads", email: "email-marketing", social: "social-media", creative: "creative" };

/** The KPI row of a card: a chip per line with a KPI, and a quiet note for a line they're on that has none yet */
export function KpiRow({ kpis, services, name, channel }: { kpis: LineKpi[]; services: ServiceSlug[]; name: string; channel: "email" | "social" | null }) {
  const have = new Set(kpis.map((k) => k.line));
  // Lines they're on with no KPI (a neutral note, not a number): only the ones this person sees
  const bare = services
    .map((s) => LINE_OF_SERVICE[s])
    .filter((l): l is KpiLine => Boolean(l) && !have.has(l as KpiLine) && (!channel || l === channel) && !(l === "tiktok"));
  if (!kpis.length && !bare.length) return null;
  const order: KpiLine[] = ["meta", "google", "tiktok", "email", "social", "creative"];
  const sorted = [...kpis].sort((a, b) => order.indexOf(a.line) - order.indexOf(b.line));
  return (
    <div className="relative flex flex-wrap gap-1.5" aria-label="KPIs">
      {sorted.map((k) => (
        <Chip key={k.line} k={k} name={name} />
      ))}
      {bare.map((l) => (
        <span key={l} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line px-2.5 text-[11.5px] text-faint" title={`${SERVICES.find((s) => s.slug === SERVICE_OF_LINE[l])?.label ?? LINE_LABEL[l]} has no KPI yet`}>
          {LINE_LABEL[l]} · no KPI
        </span>
      ))}
    </div>
  );
}
