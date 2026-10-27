"use client";

import { useState, useTransition } from "react";
import { setClientIndustry } from "./actions";
import { Layer } from "./layer";

/** The client's industry, in the header. Execs and leads can change it, or hand it back to the AI. */
export function IndustryChip({
  clientId,
  slug,
  industry,
  detail,
  source,
  options,
  canEdit,
}: {
  clientId: string;
  slug: string;
  industry: string | null;
  detail: string | null;
  source: "ai" | "team" | null;
  options: readonly (readonly [string, string])[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(industry ?? "");
  const [text, setText] = useState(detail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const label = options.find(([k]) => k === industry)?.[1];

  const save = (auto: boolean) =>
    start(async () => {
      setError(null);
      const r = await setClientIndustry(clientId, slug, auto ? "auto" : value, text);
      if (!r.ok) return setError(r.error);
      setOpen(false);
    });

  const editor = (
    <>
      <span className="text-xs text-muted">Industry. Ads that work for other clients in it are suggested when requests are written.</span>
      <select value={value} onChange={(e) => setValue(e.target.value)} className="h-11 rounded-brand border border-line bg-bg px-2 text-sm md:h-9">
        <option value="">Pick one</option>
        {options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="More specific, e.g. Pizza restaurant" className="h-11 rounded-brand border border-line bg-bg px-2.5 text-sm outline-none placeholder:text-faint md:h-9" />
      <span className="flex flex-wrap items-center gap-2">
        <button disabled={busy || !value} onClick={() => save(false)} className="h-11 flex-1 rounded-brand bg-brand px-3 text-sm font-medium text-white disabled:opacity-40 md:h-8 md:flex-none md:text-xs">
          {busy ? "Saving…" : "Save"}
        </button>
        <button disabled={busy} onClick={() => save(true)} className="h-11 rounded-brand px-2 text-sm text-muted hover:text-fg disabled:opacity-40 md:h-8 md:text-xs">
          Let the AI decide
        </button>
      </span>
      {error && <span className="text-xs text-bad">{error}</span>}
    </>
  );

  return (
    <span className="relative">
      <button
        disabled={!canEdit}
        onClick={() => setOpen(!open)}
        className={`inline-flex h-10 max-w-full items-center gap-1.5 rounded-full px-3 text-xs md:h-7 ${label ? "bg-surface-2 text-fg" : "border border-dashed border-line text-faint"} ${canEdit ? "hover:bg-surface-3" : ""}`}
        title={source === "ai" ? "Detected by the AI from what we know about the client" : source === "team" ? "Set by the team" : undefined}
      >
        {label ? (
          <>
            {detail ?? label}
            {detail && <span className="text-faint">· {label}</span>}
            {source === "ai" && <span className="text-[10px] text-[#9aa7f0]">AI</span>}
          </>
        ) : (
          "Industry not set yet"
        )}
      </button>
      {open && (
        <span className="absolute left-0 top-9 z-30 hidden w-72 gap-2.5 rounded-[12px] border border-line bg-surface p-3 shadow-2xl md:grid">
          {editor}
        </span>
      )}
      {/* Phones: the same editor as a sheet from the bottom */}
      {open && (
        <Layer>
          <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] md:hidden" />
          <div role="dialog" aria-label="Industry" className="fixed inset-x-0 bottom-0 z-50 grid gap-3 rounded-t-[22px] border-t border-line bg-surface px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl md:hidden">
            <span aria-hidden className="mx-auto mb-1 h-1 w-10 rounded-full bg-ink/15" />
            {editor}
          </div>
        </Layer>
      )}
    </span>
  );
}
