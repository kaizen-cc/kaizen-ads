"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveWidget, type Widget, type WidgetId } from "@/lib/widgets-core";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { saveWidgets } from "../widget-actions";
import { refreshInPlace } from "@/lib/complete-card";

// "Add widget" (owner, Nov 24 2026): the gallery of what this person can add to their Overview, grouped; add, remove
// and move up or down, saved at once. Open in the address (?widgets=1), so Back closes it. Full screen on a phone.

export function WidgetGallery({ groups, chosen }: { groups: { group: string; widgets: Widget[] }[]; chosen: WidgetId[] }) {
  const router = useRouter();
  const open = useParam("widgets") === "1";
  const [ids, setIds] = useState<WidgetId[]>(chosen);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const save = (next: WidgetId[]) => {
    const was = ids;
    setIds(next);
    setError(null);
    start(async () => {
      const r = await saveWidgets(next);
      if (!r.ok) {
        setIds(was);
        return setError(r.error);
      }
      refreshInPlace(router);
    });
  };
  const all = groups.flatMap((g) => g.widgets);
  const title = (id: WidgetId) => all.find((w) => w.id === id)?.title ?? id;
  const pill = "inline-flex min-h-11 items-center rounded-full px-3.5 text-[13px] transition-colors disabled:opacity-40 sm:min-h-8 sm:px-3 sm:text-[12px]";
  return (
    <>
      <button type="button" onClick={() => pushParams({ widgets: "1" })} className={`${pill} justify-self-start border border-ink/15 text-ink/75 hover:border-ink/35 hover:text-fg`}>
        + Add widget
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="Add widget" onClick={() => closeParams("widgets")}>
          <div onClick={(e) => e.stopPropagation()} className="flex h-[100dvh] w-full flex-col overflow-hidden bg-bg md:h-auto md:max-h-[85vh] md:max-w-2xl md:rounded-[24px] md:border md:border-line">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] md:px-5 md:pt-4">
              <span className="font-heading text-[17px] text-fg">Your widgets</span>
              <button type="button" onClick={() => closeParams("widgets")} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-[18px] text-muted hover:bg-surface-2 hover:text-fg">
                ✕
              </button>
            </div>
            <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto overscroll-contain p-4 pb-[max(16px,env(safe-area-inset-bottom))] md:p-5">
              <p className="text-[13px] text-muted">They show under your blocks, in this order. Your blocks stay as they are.</p>
              {ids.length > 0 && (
                <section className="grid gap-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">On your Overview</h3>
                  <ul className="grid gap-1.5">
                    {ids.map((id, i) => (
                      <li key={id} className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface px-3 py-2">
                        <span className="min-w-0 flex-1 text-[14px] text-fg">{title(id)}</span>
                        <button type="button" aria-label={`Move ${title(id)} up`} disabled={i === 0} onClick={() => save(moveWidget(ids, id, -1))} className={`${pill} border border-ink/15 text-ink/75`}>
                          ↑
                        </button>
                        <button type="button" aria-label={`Move ${title(id)} down`} disabled={i === ids.length - 1} onClick={() => save(moveWidget(ids, id, 1))} className={`${pill} border border-ink/15 text-ink/75`}>
                          ↓
                        </button>
                        <button type="button" onClick={() => save(ids.filter((x) => x !== id))} className={`${pill} text-muted hover:text-fg`}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {groups.map((g) => {
                const left = g.widgets.filter((w) => !ids.includes(w.id));
                if (!left.length) return null;
                return (
                  <section key={g.group} className="grid gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{g.group}</h3>
                    <ul className="grid gap-1.5 sm:grid-cols-2">
                      {left.map((w) => (
                        <li key={w.id} className="grid gap-2 rounded-[14px] border border-line bg-surface p-3">
                          <span className="grid gap-0.5">
                            <span className="text-[14px] font-medium text-fg">{w.title}</span>
                            <span className="text-[12.5px] leading-snug text-muted">{w.blurb}</span>
                          </span>
                          <button type="button" onClick={() => save([...ids, w.id])} className={`${pill} justify-self-start bg-fg font-medium text-bg hover:opacity-90`}>
                            Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {error && <p className="text-[13px] text-bad">{error}</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
