"use client";

import Link from "next/link";
import { BriefPreviewButton } from "@/components/quick-brief-sheet";
import { createBriefHref, type BriefIdea } from "@/lib/creative-allotments";

// The two ways to act on a creative gap, wherever it shows (the Overview's Creative allotments, Next for me):
// Suggest briefs opens the strategist's quick preview for that client (their winners, angles and context; one concept
// per brief, split when it holds several), and Create brief opens the request form for that client and format.

export type { BriefIdea };

const PILL = "inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-colors sm:min-h-9 sm:w-auto";

export function SuggestBriefsButton({ idea, className = "" }: { idea: BriefIdea; className?: string }) {
  return (
    <BriefPreviewButton
      previewKey={idea.key}
      clientId={idea.clientId}
      source={{ kind: "idea", label: idea.label, text: idea.text }}
      from={{ kicker: idea.kicker, label: idea.label, format: idea.format }}
      star={false}
      wrapClassName="inline-flex w-full sm:w-auto"
      className={`${PILL} border border-ink/15 bg-ink/[0.04] text-ink/85 hover:border-ink/30 hover:bg-ink/[0.08] hover:text-fg ${className}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      </svg>
      Suggest briefs
    </BriefPreviewButton>
  );
}

export function CreateBriefLink({ idea, strong = false }: { idea: Pick<BriefIdea, "slug" | "format">; strong?: boolean }) {
  return (
    <Link href={createBriefHref(idea.slug, idea.format)} className={`${PILL} ${strong ? "bg-fg text-bg hover:bg-ink/85" : "text-ink/70 hover:bg-ink/[0.06] hover:text-fg"}`}>
      Create brief <span aria-hidden>→</span>
    </Link>
  );
}

/** Both, side by side (stacked on a phone) */
export function GapActions({ idea, strong = false }: { idea: BriefIdea; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <SuggestBriefsButton idea={idea} />
      <CreateBriefLink idea={idea} strong={strong} />
    </div>
  );
}
