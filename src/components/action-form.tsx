"use client";

import { useRef, useState, useTransition } from "react";

type Result = { ok: true } | { ok: false; error: string };

/** A form that runs a server action and shows "Saved" or the error right under it. */
export function ActionForm({
  action,
  submitLabel,
  resetOnSuccess = false,
  className = "",
  children,
}: {
  action: (form: FormData) => Promise<Result>;
  submitLabel: string;
  resetOnSuccess?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <form
      ref={ref}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
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
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending}
          className="h-9 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ok" : "text-brand-text"}`}>{msg.text}</span>}
      </div>
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
