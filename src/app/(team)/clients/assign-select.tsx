"use client";

import { useState, useTransition } from "react";
import type { SlotRole } from "@/lib/roles";
import { setAssignment } from "./actions";

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
