"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { completeCard, refreshInPlace } from "@/lib/complete-card";
import { hideForMe } from "../hide-actions";

// Done and Dismiss on anything on the Overview: it leaves this person's board only. Whoever it's on still has it, and
// nothing is closed or sent. The card goes at once; the page catches up behind it.

export function HideForMe({ hideKey, label, href, compact = false }: { hideKey: string; label: string; href?: string | null; compact?: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const hide = (e: React.MouseEvent<HTMLButtonElement>, how: "done" | "dismissed") => {
    e.preventDefault();
    e.stopPropagation();
    const card = e.currentTarget.closest("[data-hideable]") as HTMLElement | null;
    // Done: a check plays over the card, then it goes. Dismiss: it just goes. The page refreshes once it's gone, so
    // nothing moves under the pointer while it plays.
    const save = hideForMe(hideKey, how, label, href);
    const after = () => start(async () => {
      await save;
      refreshInPlace(router);
    });
    if (how === "done") completeCard(card, after);
    else {
      card?.style.setProperty("display", "none");
      after();
    }
  };
  const btn = compact ? "h-11 rounded-full px-2.5 text-xs md:h-7" : "h-11 rounded-brand px-3 text-sm md:h-9";
  return (
    <span className="inline-flex items-center gap-1" title="Clears it from your board only. It stays for whoever it's on.">
      <button type="button" onClick={(e) => hide(e, "done")} className={`${btn} text-muted hover:bg-ok-soft hover:text-ok`}>
        ✓ Done
      </button>
      <button type="button" onClick={(e) => hide(e, "dismissed")} className={`${btn} text-faint hover:text-fg`}>
        Dismiss
      </button>
    </span>
  );
}
