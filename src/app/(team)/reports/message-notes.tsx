"use client";

import type { PdfField } from "./pdf-preview";

// The buyer's narrative (the headline, what we did, what we're doing, what's next, the note, what each trend means):
// never printed in the report, it travels in the message that carries it. Shown here to read and change, each line
// saved when it loses focus; the message follows.

export function MessageNotes({ fields, editable, onSave, onRemove }: { fields: PdfField[]; editable: boolean; onSave: (id: string, value: string) => void; onRemove: (id: string) => void }) {
  const shown = fields.filter((f) => f.value?.trim());
  if (!shown.length) return null;
  const groups = [...new Set(shown.map((f) => f.label))].map((label) => ({ label, items: shown.filter((f) => f.label === label) }));
  return (
    <details className="group rounded-[14px] border border-line bg-surface">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
        <span>
          <span className="font-medium text-fg">For the message</span>
          <span className="text-faint"> · what we did, are doing and do next. Not printed in the report.</span>
        </span>
        <span className="shrink-0 text-faint transition-transform group-open:rotate-180" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="grid gap-3 border-t border-line px-4 pb-4 pt-3">
        {groups.map((g) => (
          <div key={g.label} className="grid gap-1.5">
            <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{g.label}</p>
            {g.items.map((f) => (
              <div key={`${f.id}:${f.value}`} className="flex items-start gap-1.5">
                <textarea
                  defaultValue={f.value}
                  readOnly={!editable}
                  rows={1}
                  aria-label={g.label}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (editable && v && v !== f.value.trim()) onSave(f.id, v);
                  }}
                  className="min-h-11 min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3 py-2.5 text-[13.5px] leading-relaxed text-fg outline-none [field-sizing:content] focus:border-brand-text/60 md:min-h-10"
                />
                {editable && f.removable && (
                  <button type="button" onClick={() => onRemove(f.id)} aria-label="Remove this line" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg md:h-10 md:w-10">
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}
