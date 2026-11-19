"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { toast } from "@/components/toasts";
import { exitViewAs, startViewAs, viewAsOptions, type ViewAsPerson, type ViewAsRole } from "@/app/(team)/view-as-actions";
import { VIEW_AS_BLOCKED_COOKIE, VIEW_AS_COOKIE, viewAsMessage } from "@/lib/view-as-core";

// View as, on screen (how it works: lib/view-as-core.ts). The owner's control sits under their name in the sidebar
// (and in the phone menu); while it's on, a bar floats over every page with who it is and Exit.

const EYE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z";

function EyeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={EYE} />
    </svg>
  );
}

/** A fresh page, so every server and browser read starts over as the new person */
const reload = () => window.location.reload();

const hasCookie = (name: string) => typeof document !== "undefined" && document.cookie.split("; ").some((c) => c.startsWith(`${name}=`));

/** The owner's "View as" button and its picker: roles (each shown through a representative teammate) and people, searchable */
export function ViewAsControl({ size = "side", onPicked }: { size?: "side" | "menu"; onPicked?: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ roles: ViewAsRole[]; people: ViewAsPerson[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const show = () => {
    setOpen(true);
    if (data) return;
    start(async () => {
      const r = await viewAsOptions();
      if (r.ok) setData({ roles: r.roles, people: r.people });
      else setError(r.error);
    });
  };

  const term = q.trim().toLowerCase();
  const roles = useMemo(() => (data?.roles ?? []).filter((r) => !term || r.label.toLowerCase().includes(term)), [data, term]);
  const people = useMemo(() => (data?.people ?? []).filter((p) => !term || p.name.toLowerCase().includes(term) || p.roleLabel.toLowerCase().includes(term)), [data, term]);

  const pick = (key: string, what: { personId: string } | { role: ViewAsRole["role"] }) => {
    setBusy(key);
    setError(null);
    start(async () => {
      const r = await startViewAs(what);
      if (!r.ok) {
        setError(r.error);
        setBusy(null);
        return;
      }
      onPicked?.();
      reload();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={show}
        className={
          size === "menu"
            ? "flex min-h-11 w-full items-center gap-3 rounded-[12px] border border-line px-3 text-[15px] text-muted active:bg-surface-2"
            : "flex w-full items-center gap-2.5 rounded-brand px-3 py-2 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        }
      >
        <EyeIcon size={size === "menu" ? 18 : 15} />
        View as…
      </button>
      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="View as">
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[sheet-fade_.2s_ease-out]" />
          <div className="pb-safe absolute inset-x-0 bottom-0 flex max-h-[82vh] flex-col overflow-hidden rounded-t-[22px] border border-line bg-surface shadow-2xl animate-[step-in_.25s_ease] md:bottom-6 md:left-[252px] md:right-auto md:max-h-[72vh] md:w-[400px] md:rounded-[18px]">
            <div className="grid gap-3 border-b border-line px-4 pb-3 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="grid gap-0.5">
                  <p className="text-sm font-medium">View as</p>
                  <p className="text-xs text-faint">See exactly what they see. Read only; nothing is sent as them.</p>
                </div>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search a role or a teammate"
                aria-label="Search a role or a teammate"
                className="h-11 w-full rounded-[12px] border border-line bg-surface-2/60 px-3 text-[15px] outline-none placeholder:text-faint focus:border-brand/60 md:h-10 md:text-sm"
              />
              {error && <p className="text-xs text-bad">{error}</p>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
              {!data && !error && <p className="px-3 py-6 text-center text-xs text-faint">Loading the team…</p>}
              {data && roles.length > 0 && (
                <section className="grid gap-0.5 pb-2">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">Roles</p>
                  {roles.map((r) => (
                    <button
                      key={r.role}
                      type="button"
                      disabled={!r.through || pending}
                      onClick={() => pick(`role:${r.role}`, { role: r.role })}
                      className="flex min-h-12 items-center gap-3 rounded-[12px] px-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-45 disabled:hover:bg-transparent"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                        <EyeIcon size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{r.label}</span>
                        <span className="block truncate text-xs text-faint">{r.through ? `Shown through ${r.through.name}` : "Nobody active in this role"}</span>
                      </span>
                      {busy === `role:${r.role}` && <span className="text-xs text-faint">Opening…</span>}
                    </button>
                  ))}
                </section>
              )}
              {data && people.length > 0 && (
                <section className="grid gap-0.5">
                  <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-faint">People</p>
                  {people.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={pending}
                      onClick={() => pick(p.id, { personId: p.id })}
                      className="flex min-h-12 items-center gap-3 rounded-[12px] px-3 text-left transition-colors hover:bg-surface-2"
                    >
                      <PersonAvatar name={p.name} src={p.avatarUrl} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{p.name}</span>
                        <span className="block truncate text-xs text-faint">
                          {p.roleLabel}
                          {p.clients ? ` · ${p.clients} client${p.clients === 1 ? "" : "s"}` : ""}
                        </span>
                      </span>
                      {busy === p.id && <span className="text-xs text-faint">Opening…</span>}
                    </button>
                  ))}
                </section>
              )}
              {data && !roles.length && !people.length && <p className="px-3 py-6 text-center text-xs text-faint">No role or teammate matches “{q}”.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The bar over every page while viewing as someone: who, read only, and Exit. A refused change anywhere (an action,
 * an API call) comes back here as a toast saying why. With no view as on but a leftover choice, it offers to clear it.
 */
export function ViewAsBar({ label, name }: { label: string | null; name: string | null }) {
  const [stale, setStale] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (label) return;
    // Nothing on, yet the choice is still there (it ended, or the teammate left): offer to clear it
    const t = setTimeout(() => setStale(hasCookie(VIEW_AS_COOKIE)), 0);
    return () => clearTimeout(t);
  }, [label]);

  useEffect(() => {
    if (!label) return;
    const said = viewAsMessage(name ?? "this teammate");
    const original = window.fetch;
    // Every request the page makes (server actions included): when the server refused a change, say so once
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      if (hasCookie(VIEW_AS_BLOCKED_COOKIE)) {
        document.cookie = `${VIEW_AS_BLOCKED_COOKIE}=; path=/; max-age=0`;
        toast({ id: "view-as-blocked", tone: "warn", title: said, actions: [{ label: "Exit view as", primary: true, run: () => exitViewAs().then(reload) }] });
      }
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, [label, name]);

  const exit = () => start(async () => {
    await exitViewAs();
    reload();
  });

  if (!label && !stale) return null;
  return (
    <>
      {/* A thin warm line along the top: this isn't your own view */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[55] h-[3px] bg-warn" />
      <div
        role="status"
        className="fixed inset-x-3 bottom-[calc(58px+env(safe-area-inset-bottom)+10px)] z-[55] mx-auto flex max-w-[560px] items-center gap-3 rounded-full border border-warn/40 bg-surface/95 py-1.5 pl-4 pr-1.5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.6)] backdrop-blur-xl animate-[step-in_.25s_ease] md:bottom-6 md:left-[240px] md:right-0"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
          <EyeIcon size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {label ? (
            <>
              <span className="text-muted">Viewing as </span>
              <span className="font-medium">{label}</span>
              <span className="text-faint"> · read only</span>
            </>
          ) : (
            <span className="text-muted">View as has ended</span>
          )}
        </span>
        <button type="button" onClick={exit} disabled={pending} className="min-h-10 shrink-0 rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-60">
          {pending ? "…" : label ? "Exit" : "Clear"}
        </button>
      </div>
    </>
  );
}
