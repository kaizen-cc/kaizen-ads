"use client";

import { useState, useTransition } from "react";
import { savePlatformAliases } from "../alias-actions";

// "Names in ad platforms" on a profile: how this person shows in Meta and Google change history. Each saves on change
// (add with Enter or the button, remove with the ×).

export function PlatformAliases({ profileId, initial, canEdit }: { profileId: string; initial: string[]; canEdit: boolean }) {
  const [list, setList] = useState(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (next: string[]) => {
    const was = list;
    setList(next);
    setError(null);
    start(async () => {
      const r = await savePlatformAliases(profileId, next);
      if (!r.ok) {
        setList(was);
        setError(r.error);
      }
    });
  };
  if (!canEdit && !list.length) return null;
  return (
    <section className="grid gap-3 rounded-[20px] border border-line bg-surface p-5">
      <div>
        <h2 className="font-heading text-lg">Names in ad platforms</h2>
        <p className="mt-1 text-[13px] text-muted">How they show in Meta and Google change history. Changes under these names show as them, and count as our team&apos;s.</p>
      </div>
      {list.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {list.map((a) => (
            <li key={a} className="inline-flex min-h-9 items-center gap-1 rounded-full bg-ink/[0.06] pl-3 pr-1 text-[13px]">
              {a}
              {canEdit && (
                <button type="button" aria-label={`Remove ${a}`} disabled={pending} onClick={() => save(list.filter((x) => x !== a))} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:text-fg">
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (!v || list.includes(v)) return;
            setDraft("");
            save([...list, v]);
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A name as Meta or Google shows it" className="min-h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-3 text-[14px] outline-none focus:border-faint md:min-h-9" />
          <button type="submit" disabled={pending || !draft.trim()} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
            Add
          </button>
        </form>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </section>
  );
}
