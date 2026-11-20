"use client";

import Link from "next/link";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { KIND_LABEL } from "@/lib/suggestion-kinds";
import type { OpenSuggestion } from "@/lib/suggestions";
import { SuggestionSheet } from "@/app/(team)/pipeline/views/suggested-briefs";
import { DraftedChips, DraftedLine } from "@/components/drafted-brief-parts";
import { BriefRating } from "./brief-rating";

// The briefs the system drafted, waiting on a decision (src/lib/brief-drafting.ts): grouped by client, most urgent
// first (the nearest deadline, then the client's own asks). The request form opens on it, the Overview of anyone who
// approves shows it, and a brief opens full screen from the address (?approve=id), so back closes it.

export type ReadyGroup = { clientId: string; client: string; items: OpenSuggestion[] };

const FORMAT_ONE = { image: "image", video: "video", carousel: "carousel" } as const;
const counts = (s: OpenSuggestion) =>
  s.draft.formats
    .map((f) => [f.new ? `${f.new} new ${FORMAT_ONE[f.format]}${f.new === 1 ? "" : "s"}` : "", f.variations ? `${f.variations} variation${f.variations === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "))
    .filter(Boolean)
    .join(" · ");

export function ReadyToApprove({ groups, today, ownHref, compact = false, canRate = false }: { groups: ReadyGroup[]; today: string; /** "Add my own idea": the request form */ ownHref?: string; compact?: boolean; /** The creative leads rate each drafted brief */ canRate?: boolean }) {
  const open = useParam("approve");
  const all = groups.flatMap((g) => g.items);
  const current = all.find((s) => s.id === open) ?? null;
  const urgent = all.filter((s) => s.drafted?.deadline || s.drafted?.urgent).length;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className={compact ? "font-heading text-xl" : "font-display text-[28px] leading-tight md:text-[34px]"}>Ready to approve</h2>
          <p className="text-sm text-muted">
            {all.length ? `${all.length} brief${all.length === 1 ? "" : "s"} written from the data${urgent ? ` · ${urgent} time-sensitive` : ""}. Approve, edit, or reject with a reason it learns from.` : "Nothing waiting. A brief is drafted the moment there's a reason: a client's ask, a tired ad, a KPI dropping, or the month falling behind its even pace."}
          </p>
        </div>
        {ownHref && (
          <Link href={ownHref} className="inline-flex h-11 items-center rounded-full border border-line px-5 text-sm text-muted hover:border-faint hover:text-fg md:h-9 md:px-4">
            Add my own idea
          </Link>
        )}
      </div>

      {groups.map((g) => (
        <div key={g.clientId} className="grid gap-2">
          <p className="text-xs uppercase tracking-[0.14em] text-faint">{g.client}</p>
          <div className="grid gap-2 md:grid-cols-2">
            {g.items.map((s) => (
              <div key={s.id} className="grid content-start gap-2">
              <button type="button" onClick={() => pushParams({ approve: s.id })} className="group grid content-start gap-2 rounded-[14px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{KIND_LABEL[s.kind]}</span>
                  {s.drafted && <DraftedChips d={s.drafted} today={today} />}
                </span>
                <span className="font-heading text-[17px] leading-snug">{s.draft.title}</span>
                {s.drafted && <DraftedLine d={s.drafted} />}
                <span className="flex items-center justify-between gap-2 pt-1 text-xs text-faint">
                  <span>{counts(s)}</span>
                  <span className="text-fg transition-transform group-hover:translate-x-0.5">Review →</span>
                </span>
              </button>
              {canRate && s.drafted && <div className="px-1"><BriefRating id={s.id} /></div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {current && <SuggestionSheet key={current.id} s={current} onClose={() => closeParams("approve")} />}
    </section>
  );
}
