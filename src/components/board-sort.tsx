"use client";

import { Combobox } from "@/components/combobox";
import { SORT_KEYS, SORT_LABEL, type SortDir, type SortKey } from "@/lib/board-sort";

/** The board's Sort control: what to sort each column by, and which way (like Asana's Sort menu) */
export function BoardSort({ sortKey, dir, onChange }: { sortKey: SortKey | null; dir: SortDir; onChange: (key: SortKey | null, dir?: SortDir) => void }) {
  return (
    <div className="flex w-[calc(50%-4px)] items-center gap-1.5 md:w-auto">
      <Combobox
        label="Sort"
        className="min-w-0 flex-1 max-md:[&>button]:h-11 max-md:[&>div]:left-auto max-md:[&>div]:right-0 md:w-48 md:flex-none"
        placeholder="Sort"
        allLabel="Default order"
        value={sortKey}
        onChange={(v) => onChange(v as SortKey | null)}
        options={SORT_KEYS.map((k) => ({ value: k, label: SORT_LABEL[k] }))}
      />
      {sortKey && (
        <button
          type="button"
          onClick={() => onChange(sortKey, dir === "asc" ? "desc" : "asc")}
          aria-label={dir === "asc" ? "Ascending, tap for descending" : "Descending, tap for ascending"}
          title={dir === "asc" ? "Ascending" : "Descending"}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-muted hover:text-fg md:h-9 md:w-9"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={dir === "desc" ? "rotate-180" : ""}>
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
