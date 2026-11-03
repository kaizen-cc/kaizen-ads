"use client";

import { useState } from "react";

/** A value to copy in one tap (a Shopify collaborator code, a store address) */
export function CopyChip({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => void navigator.clipboard?.writeText(value).then(() => setDone(true))} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] hover:border-faint">
      {label && <span className="text-faint">{label}</span>}
      <span className="tabular font-medium">{value}</span>
      <span className="text-[11.5px] text-brand-text">{done ? "Copied ✓" : "Copy"}</span>
    </button>
  );
}
