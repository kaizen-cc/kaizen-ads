"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

type Result = { ok: true } | { ok: false; error: string };

/**
 * A form that runs a server action and shows "Saved" or the error right under it.
 *
 * autosave: an edit form saves itself, about a second after typing stops, when a field is left, and when the page is
 * left or hidden, so nothing typed is lost to a missed Save. Fields marked data-manual (a change that should be
 * previewed first, like the conversion a KPI counts) don't trigger it; the button stays for those when `button` is set.
 * Forms that add something (a contact, a memory) don't autosave: a half-typed entry shouldn't be created.
 */
export function ActionForm({
  action,
  submitLabel,
  resetOnSuccess = false,
  className = "",
  autosave = false,
  button = !autosave,
  children,
}: {
  action: (form: FormData) => Promise<Result>;
  submitLabel: string;
  resetOnSuccess?: boolean;
  className?: string;
  autosave?: boolean;
  /** Show the button (always, without autosave; with it, only when a manual change needs it) */
  button?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One save at a time; an edit made while one is on its way is saved right after it
  const save = useCallback(async () => {
    if (!ref.current || !dirty.current) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    saving.current = true;
    do {
      again.current = false;
      dirty.current = false;
      setMsg({ ok: true, text: "Saving…" });
      const res = await action(new FormData(ref.current!)).catch(() => ({ ok: false as const, error: "Couldn't save. Check your connection; it'll try again on your next edit." }));
      if (res.ok) setMsg({ ok: true, text: "Saved" });
      else {
        dirty.current = true;
        setMsg({ ok: false, text: res.error });
        break;
      }
    } while (again.current && dirty.current);
    saving.current = false;
  }, [action]);

  const changed = (target: EventTarget | null) => {
    if (!autosave || (target instanceof Element && target.closest("[data-manual]"))) return;
    dirty.current = true;
    setMsg({ ok: true, text: "Editing…" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1000);
  };

  // Leaving or hiding the page saves what's pending; closing the tab mid-save asks first
  useEffect(() => {
    if (!autosave) return;
    const flush = () => {
      if (dirty.current) void save();
    };
    const onHide = () => document.visibilityState === "hidden" && flush();
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirty.current && !saving.current) return;
      flush();
      e.preventDefault();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", onLeave);
      // Navigating away inside the app: what's pending still goes
      flush();
    };
  }, [autosave, save]);

  return (
    <form
      ref={ref}
      className={className}
      onInput={(e) => changed(e.target)}
      onChange={(e) => changed(e.target)}
      onBlur={(e) => {
        if (autosave && dirty.current && !(e.target instanceof Element && e.target.closest("[data-manual]"))) void save();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        if (timer.current) clearTimeout(timer.current);
        dirty.current = false;
        setMsg(null);
        start(async () => {
          const res = await action(data);
          if (res.ok) {
            setMsg({ ok: true, text: "Saved" });
            if (resetOnSuccess) ref.current?.reset();
          } else setMsg({ ok: false, text: res.error });
        });
      }}
    >
      {children}
      {(button || msg) && (
        <div className="flex flex-wrap items-center gap-3">
          {button && (
            <button
              disabled={pending}
              className="h-10 rounded-[8px] bg-brand px-5 text-sm font-medium text-white shadow-[0_8px_24px_-12px_rgba(178,30,44,0.9)] transition-colors hover:bg-brand-hover disabled:opacity-60"
            >
              {pending ? "Saving…" : submitLabel}
            </button>
          )}
          {msg && <span className={`text-sm ${msg.ok ? (msg.text === "Saved" ? "text-ok" : "text-faint") : "text-brand-text"}`}>{msg.text}</span>}
        </div>
      )}
      {autosave && !button && !msg && <p className="text-[11px] text-faint">Saves as you type</p>}
    </form>
  );
}

/** A single small button that runs a server action (remove, archive…). */
export function ActionButton({
  action,
  label,
  confirmText,
  className = "",
}: {
  action: () => Promise<Result>;
  label: string;
  confirmText?: string;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    start(async () => {
      const res = await action();
      setAsking(false);
      if (!res.ok) setError(res.error);
    });

  if (asking) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-muted">{confirmText}</span>
        <button onClick={run} disabled={pending} className="text-brand-text hover:underline">
          {pending ? "…" : "Yes"}
        </button>
        <button onClick={() => setAsking(false)} className="text-muted hover:underline">
          No
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => (confirmText ? setAsking(true) : run())}
        disabled={pending}
        className={`text-xs text-muted hover:text-fg ${className}`}
      >
        {pending ? "…" : label}
      </button>
      {error && <span className="text-xs text-brand-text">{error}</span>}
    </span>
  );
}
