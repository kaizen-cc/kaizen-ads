"use client";

import { useState, useTransition } from "react";
import type { SlotRole } from "@/lib/roles";
import { addSecondaryBuyer, removeSecondaryBuyer, setAssignment } from "./actions";

export type Option = { id: string; name: string };

/** Who fills a slot (buyer / designer / editor) on a client. Saves as soon as it changes. */
export function AssignSelect({
  clientId,
  slot,
  label,
  current,
  options,
  canEdit,
  size = "sm",
}: {
  clientId: string;
  slot: SlotRole;
  label: string;
  current: Option | null;
  options: Option[];
  canEdit: boolean;
  size?: "sm" | "md";
}) {
  const [value, setValue] = useState(current?.id ?? "");
  const [pending, start] = useTransition();
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return current ? <span className="text-sm">{current.name}</span> : <span className="text-sm text-faint">—</span>;
  }

  // Someone assigned who no longer has a matching role still shows up, so nothing silently disappears
  const all = current && !options.some((o) => o.id === current.id) ? [current, ...options] : options;

  return (
    <span className="relative inline-flex w-full items-center">
      <select
        aria-label={label}
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          const prev = value;
          setValue(next);
          start(async () => {
            const res = await setAssignment(clientId, slot, next || null);
            if (res.ok) {
              setState("saved");
              setTimeout(() => setState("idle"), 1200);
            } else {
              setValue(prev);
              setError(res.error);
              setState("error");
            }
          });
        }}
        className={`w-full truncate rounded-[8px] border bg-transparent outline-none transition-colors focus:border-brand-text ${
          size === "md" ? "h-11 px-3 text-sm md:h-10" : "h-11 px-2 text-sm md:h-8"
        } ${state === "saved" ? "border-ok" : state === "error" ? "border-brand-text" : "border-transparent hover:border-line"} ${value ? "text-fg" : "text-faint"}`}
        title={error ?? undefined}
      >
        <option value="">{value ? "Unassign" : "Assign…"}</option>
        {all.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {(pending || state === "saved") && (
        <span aria-hidden className={`pointer-events-none absolute right-8 text-xs ${state === "saved" ? "text-ok" : "text-faint"}`}>
          {pending ? "…" : "✓"}
        </span>
      )}
    </span>
  );
}

/**
 * A buyer seat's secondaries, under its primary picker: each removable with ×, and "+ Add a secondary buyer" opens a
 * picker of the other eligible buyers. Saves as soon as it changes. A secondary sees the client, its KPI cards and
 * reports, and hears its updates and alerts; the primary stays the one the KPI card and reports belong to.
 */
export function SecondaryBuyers({
  clientId,
  slot,
  label,
  primary,
  secondaries,
  options,
  canEdit,
}: {
  clientId: string;
  slot: SlotRole;
  label: string;
  primary: Option | null;
  secondaries: Option[];
  options: Option[];
  canEdit: boolean;
}) {
  const [list, setList] = useState(secondaries);
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const free = options.filter((o) => o.id !== primary?.id && !list.some((s) => s.id === o.id));

  if (!canEdit && !list.length) return null;
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, undo: () => void) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) {
        undo();
        setError(res.error);
      }
    });

  return (
    <div className="mt-1 grid gap-1">
      {list.map((s) => (
        <div key={s.id} className="flex min-h-11 items-center gap-2 rounded-[8px] px-3 md:min-h-9">
          <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
          <span className="shrink-0 text-xs text-faint">Secondary</span>
          {canEdit && (
            <button
              type="button"
              disabled={pending}
              aria-label={`Remove ${s.name} as secondary ${label.toLowerCase()}`}
              onClick={() => {
                const before = list;
                setList(list.filter((x) => x.id !== s.id));
                run(() => removeSecondaryBuyer(clientId, slot, s.id), () => setList(before));
              }}
              className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg leading-none text-faint transition-colors hover:bg-surface-2 hover:text-fg md:h-8 md:w-8"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {canEdit && primary && (adding ? (
        <select
          autoFocus
          aria-label={`Add a secondary ${label.toLowerCase()}`}
          disabled={pending}
          defaultValue=""
          onBlur={() => setAdding(false)}
          onChange={(e) => {
            const pick = free.find((o) => o.id === e.target.value);
            if (!pick) return;
            const before = list;
            setList([...list, pick]);
            setAdding(false);
            run(() => addSecondaryBuyer(clientId, slot, pick.id), () => setList(before));
          }}
          className="h-11 w-full truncate rounded-[8px] border border-line bg-transparent px-3 text-sm text-fg outline-none focus:border-brand-text md:h-10"
        >
          <option value="">{free.length ? "Pick a buyer…" : "Nobody else can hold this seat"}</option>
          {free.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <button
          type="button"
          disabled={pending || !free.length}
          onClick={() => setAdding(true)}
          className="flex min-h-11 items-center justify-self-start rounded-[8px] px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50 md:min-h-9"
        >
          + Add a secondary buyer
        </button>
      ))}
      {error && <p className="px-3 text-xs text-brand-text">{error}</p>}
    </div>
  );
}
