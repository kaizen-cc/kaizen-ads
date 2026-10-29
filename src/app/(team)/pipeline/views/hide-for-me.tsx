"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { hideForMe } from "../hide-actions";

// Done and Dismiss on anything on the Overview: it leaves this person's board only. Whoever it's on still has it, and
// nothing is closed or sent. The card goes at once; the page catches up behind it.

export function HideForMe({ hideKey, compact = false }: { hideKey: string; compact?: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const hide = (e: React.MouseEvent<HTMLButtonElement>, how: "done" | "dismissed") => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget.closest("[data-hideable]") as HTMLElement | null)?.style.setProperty("display", "none");
    start(async () => {
      await hideForMe(hideKey, how);
      router.refresh();
    });
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
