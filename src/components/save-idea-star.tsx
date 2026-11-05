"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/components/toasts";
import { dismissSaved, mySaves, saveClients, saveReference, unsaveReference } from "@/app/(team)/requests/new/saved-actions";
import { savedKey, saveInputOf, type SaveInput, type SavedRef } from "@/lib/saved-references";
import type { BriefSource } from "@/lib/quick-brief";

// Save for later, everywhere a brief is offered: one star, per person per client. On a client's own page (or a brief for
// one client) it saves at once; anywhere else it asks which client in one dropdown and saves on change. Instant on
// screen, confirmed (or undone) after. An idea someone else already briefed shows "already in motion by <name>"
// instead. The person's saves are read once per visit and shared by every star on the page.

// ─── The person's saves, shared by every star ───────────────────────────────────────────────────────────────

let saves: SavedRef[] | null = null;
let loading = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const put = (next: SavedRef[]) => {
  saves = next;
  emit();
};
const pending = () => (saves ?? []).filter((s) => s.id.startsWith("tmp-"));

function load(force = false) {
  if (loading || (saves && !force)) return;
  loading = true;
  mySaves()
    .then((list) => put([...pending().filter((t) => !list.some((s) => same(s, t.clientId, t))), ...list]))
    .catch(() => saves ?? put([]))
    .finally(() => {
      loading = false;
    });
}

const same = (s: SavedRef, clientId: string, i: Pick<SaveInput, "source" | "refId">) => s.clientId === clientId && savedKey(s.source, s.refId) === savedKey(i.source, i.refId);

/** Everything this person saved (open, or in motion by someone else); null while it's read */
export function useSaves(): SavedRef[] | null {
  const list = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => saves,
    () => null,
  );
  useEffect(() => load(), []);
  return list;
}

/** What the server already read for one client (the start page): shown at once, the full read follows */
export function seedSaves(clientId: string, list: SavedRef[]) {
  if (saves) return;
  put(list.filter((s) => s.clientId === clientId));
  load(true);
}

export const findSave = (list: SavedRef[] | null, clientId: string, i: Pick<SaveInput, "source" | "refId">) => (list ?? []).find((s) => same(s, clientId, i)) ?? null;

/** Star or unstar an idea for a client, instantly; undone with a note if it fails */
export async function toggleSave(clientId: string, input: SaveInput) {
  const before = saves ?? [];
  const had = findSave(before, clientId, input);
  if (had) {
    if (had.motion) return;
    put(before.filter((s) => s !== had));
    const r = await unsaveReference(clientId, input.source, input.refId).catch(() => ({ ok: false as const, error: "Couldn't remove it. Try again." }));
    if (!r.ok) {
      put([had, ...(saves ?? [])]);
      toast({ tone: "bad", title: r.error });
    }
    return;
  }
  const temp: SavedRef = { ...input, id: `tmp-${clientId}-${input.source}-${input.refId}`, clientId, createdAt: new Date().toISOString(), savedBy: null, savedById: null, motion: null };
  put([temp, ...before]);
  const r = await saveReference(clientId, input).catch(() => ({ ok: false as const, error: "Couldn't save it. Try again." }));
  const now = saves ?? [];
  if (!r.ok) {
    put(now.filter((s) => s.id !== temp.id));
    toast({ tone: "bad", title: r.error });
  } else put(now.map((s) => (s.id === temp.id ? r.ref : s)));
}

/** Close the "already in motion" notice on a saved idea */
export async function dismissSave(id: string) {
  const before = saves ?? [];
  const had = before.find((s) => s.id === id);
  put(before.filter((s) => s.id !== id));
  const r = await dismissSaved(id).catch(() => ({ ok: false as const, error: "Couldn't dismiss it. Try again." }));
  if (!r.ok && had) {
    put([had, ...(saves ?? [])]);
    toast({ tone: "bad", title: r.error });
  }
}

/** Read the person's saves again (a request was just sent: some are used now) */
export const refreshSaves = () => load(true);

/** A brief was just sent from these saves: out of the list now (the server marked them used) */
export function dropSaves(ids: string[]) {
  if (!saves || !ids.length) return;
  put(saves.filter((s) => !ids.includes(s.id)));
}

let clientsP: Promise<{ id: string; name: string }[]> | null = null;
function useSaveClients(on: boolean) {
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    clientsP ??= saveClients().catch(() => {
      clientsP = null;
      return [];
    });
    clientsP.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [on]);
  return list;
}

// ─── The star ───────────────────────────────────────────────────────────────────────────────────────────────

const VARIANT = {
  /** Over a picture */
  overlay: { off: "bg-black/45 text-white hover:bg-black/70", on: "bg-black/70" },
  /** On a card or a row */
  plain: { off: "border border-line bg-surface text-muted hover:border-faint hover:text-fg", on: "border border-warn/40 bg-warn-soft" },
  /** Over a dark story */
  dark: { off: "bg-white/10 text-white hover:bg-white/20", on: "bg-white/15" },
} as const;

export function StarIcon({ on, size = 14 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden className={on ? "text-warn" : ""}>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
    </svg>
  );
}

/** "Your saved idea is already in motion by Kyle", with the ticket and a dismiss */
export function InMotionNote({ s, onDismiss, className = "" }: { s: SavedRef; onDismiss?: () => void; className?: string }) {
  if (!s.motion) return null;
  return (
    <div className={`grid gap-2 rounded-[14px] border border-ok/20 bg-ok-soft px-3 py-2.5 ${className}`}>
      <p className="flex items-start gap-2 text-[12.5px] leading-snug text-fg">
        <span aria-hidden className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-ok" />
        <span>
          Your saved idea is already in motion{s.motion.by ? ` by ${s.motion.by}` : ""}.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {s.motion.href && (
          <a href={s.motion.href} target={/^https?:/i.test(s.motion.href) ? "_blank" : undefined} rel="noreferrer" className="inline-flex min-h-9 items-center rounded-full bg-ok px-3.5 text-[12.5px] font-medium text-white hover:brightness-110">
            {/^https?:/i.test(s.motion.href) ? "Open the task ↗" : "Open the ticket →"}
          </a>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="inline-flex min-h-9 items-center rounded-full px-3 text-[12.5px] text-muted hover:text-fg">
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The star. idea: what it saves (or source and from, the brief it offers). clientId: the client in context; without one
 * it asks which client in one dropdown and saves on change.
 */
export function SaveIdeaStar({
  idea: given,
  source,
  from,
  clientId = null,
  clientName,
  variant = "plain",
  size = "md",
  className = "",
}: {
  idea?: SaveInput | null;
  source?: BriefSource;
  from?: Parameters<typeof saveInputOf>[1];
  clientId?: string | null;
  clientName?: string;
  variant?: keyof typeof VARIANT;
  size?: "sm" | "md";
  className?: string;
}) {
  const idea = given ?? (source && from ? saveInputOf(source, from) : null);
  const list = useSaves();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const clients = useSaveClients(open && !clientId);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!idea) return null;

  const mine = (list ?? []).filter((s) => savedKey(s.source, s.refId) === savedKey(idea.source, idea.refId) && (!clientId || s.clientId === clientId));
  const here = clientId ? (mine[0] ?? null) : null;
  const on = mine.length > 0;
  const motion = mine.some((s) => s.motion);
  const v = VARIANT[variant];
  const dim = size === "sm" ? "h-9 w-9 md:h-8 md:w-8" : "h-11 w-11";
  const label = here?.motion ? `Already in motion${here.motion.by ? ` by ${here.motion.by}` : ""}` : on ? (clientId ? `Saved${clientName ? ` for ${clientName}` : ""}. Tap to remove` : "Saved. Manage") : clientId ? `Save for later${clientName ? ` for ${clientName}` : ""}` : "Save for a client";

  const click = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!clientId || here?.motion) return setOpen(!open);
    void toggleSave(clientId, idea);
  };

  return (
    <span ref={box} className={`relative inline-flex shrink-0 ${className}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={click} aria-pressed={on} aria-label={label} title={label} className={`relative grid ${dim} place-items-center rounded-full backdrop-blur transition ${on ? v.on : v.off}`}>
        <StarIcon on={on} size={size === "sm" ? 15 : 18} />
        {motion && <span aria-hidden className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-ok ring-2 ring-surface" />}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label={clientId ? "Saved idea" : "Save for a client"}
          className="fixed inset-x-3 bottom-3 z-[70] grid gap-3 rounded-[18px] border border-line bg-surface p-3.5 text-left text-fg shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)] md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-2 md:w-80"
        >
          {clientId ? (
            here && <InMotionNote s={here} onDismiss={() => {
                  setOpen(false);
                  void dismissSave(here.id);
                }} />
          ) : (
            <>
              <span className="grid gap-1">
                <span className="text-[13px] font-medium">Save for later</span>
                <span className="line-clamp-2 text-[12px] text-faint">{idea.title ?? "This idea"}: it waits in your saved ideas when you make that client&rsquo;s next request.</span>
              </span>
              <select
                value=""
                disabled={!clients}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) void toggleSave(id, idea);
                }}
                aria-label="Save it for a client"
                className="h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] outline-none focus:border-faint"
              >
                <option value="">{clients ? "Save it for a client…" : "Loading clients…"}</option>
                {(clients ?? [])
                  .filter((c) => !mine.some((s) => s.clientId === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              {mine.length > 0 && (
                <span className="grid gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Saved for</span>
                  {mine.map((s) => {
                    const name = clients?.find((c) => c.id === s.clientId)?.name ?? "A client";
                    return s.motion ? (
                      <span key={s.id} className="grid gap-1">
                        <span className="text-[13px]">{name}</span>
                        <InMotionNote s={s} onDismiss={() => void dismissSave(s.id)} />
                      </span>
                    ) : (
                      <span key={s.id} className="flex min-h-11 items-center justify-between gap-2 rounded-[12px] bg-surface-2 px-3 md:min-h-9">
                        <span className="flex min-w-0 items-center gap-2 truncate text-[13px]">
                          <StarIcon on size={12} />
                          {name}
                        </span>
                        <button type="button" onClick={() => void toggleSave(s.clientId, idea)} className="shrink-0 text-[12px] text-muted hover:text-bad">
                          Remove
                        </button>
                      </span>
                    );
                  })}
                </span>
              )}
            </>
          )}
        </span>
      )}
    </span>
  );
}
