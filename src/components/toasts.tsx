"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// Notifications in the bottom-right corner: anything can raise one with toast(); each goes away by itself after a few
// seconds (paused while hovered) or when dismissed. Actions are buttons or links inside it.

export type ToastAction = { label: string; href?: string; run?: () => void | Promise<void>; primary?: boolean };
export type Toast = { id?: string; tone?: "info" | "ok" | "warn" | "bad"; title: string; body?: string; actions?: ToastAction[]; ms?: number };

export function toast(t: Toast) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<Toast>("kz-toast", { detail: t }));
}

const DOT: Record<NonNullable<Toast["tone"]>, string> = { info: "bg-faint", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

function ToastCard({ t, onClose }: { t: Required<Pick<Toast, "id">> & Toast; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const left = useRef(t.ms ?? 5000);
  useEffect(() => {
    if (hover) return;
    const started = Date.now();
    const timer = setTimeout(onClose, left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(800, left.current - (Date.now() - started));
    };
  }, [hover, onClose]);
  return (
    <div
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pointer-events-auto grid w-full max-w-[calc(100vw-32px)] md:w-[340px] animate-[step-in_.25s_ease] gap-2 rounded-[14px] border border-line bg-surface p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]"
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.tone ?? "info"]}`} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-sm font-medium leading-snug">{t.title}</p>
          {t.body && <p className="text-xs leading-relaxed text-muted">{t.body}</p>}
        </div>
        <button type="button" onClick={onClose} className="-mr-3 -mt-3 grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:text-fg md:-mr-1 md:-mt-1 md:block md:h-auto md:w-auto md:px-1.5" aria-label="Dismiss">
          ×
        </button>
      </div>
      {t.actions && t.actions.length > 0 && (
        <div className="grid gap-1.5 pl-[18px]">
          {t.actions.map((a) =>
            a.href ? (
              <Link key={a.label} href={a.href} onClick={onClose} className={`rounded-full px-3 py-3 text-center text-sm md:py-1.5 md:text-xs ${a.primary ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                {a.label}
              </Link>
            ) : (
              <button
                key={a.label}
                type="button"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(a.label);
                  await a.run?.();
                  onClose();
                }}
                className={`rounded-full px-3 py-3 text-sm disabled:opacity-60 md:py-1.5 md:text-xs ${a.primary ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}
              >
                {busy === a.label ? "Starting…" : a.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Toaster() {
  const [list, setList] = useState<(Toast & { id: string })[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      const id = t.id ?? `${Date.now()}-${Math.random()}`;
      setList((l) => [...l.filter((x) => x.id !== id), { ...t, id }].slice(-4));
    };
    window.addEventListener("kz-toast", on);
    return () => window.removeEventListener("kz-toast", on);
  }, []);
  const close = useCallback((id: string) => setList((l) => l.filter((x) => x.id !== id)), []);
  return (
    // Phones: above the bottom tab bar, full width; desktop: bottom-right
    <div
      className="pointer-events-none fixed bottom-[calc(76px+env(safe-area-inset-bottom,0px))] left-4 right-[max(16px,env(safe-area-inset-right,0px))] z-[60] grid justify-items-stretch gap-2 md:bottom-[calc(16px+env(safe-area-inset-bottom,0px))] md:left-auto md:justify-items-end"
      aria-live="polite"
    >
      {list.map((t) => (
        <ToastCard key={t.id} t={t} onClose={() => close(t.id)} />
      ))}
    </div>
  );
}
