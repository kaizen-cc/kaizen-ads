"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { setOverviewLayout } from "@/app/(team)/item-actions";

/** Cards or List: the Overview's layout, a per-person choice kept on their profile (cards unless they switch) */
export function LayoutSwitch({ layout }: { layout: "cards" | "list" }) {
  const router = useRouter();
  const [shown, setShown] = useOptimistic(layout);
  const [, start] = useTransition();
  const pick = (l: "cards" | "list") =>
    start(async () => {
      setShown(l);
      await setOverviewLayout(l);
      router.refresh();
    });
  return (
    <div role="radiogroup" aria-label="Overview layout" className="inline-flex rounded-full border border-ink/15 bg-ink/[0.04] p-0.5 text-[12px]">
      {(["cards", "list"] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={shown === l} onClick={() => pick(l)} className={`min-h-9 rounded-full px-3.5 sm:min-h-7 ${shown === l ? "bg-fg font-medium text-bg" : "text-ink/65 hover:text-fg"}`}>
          {l === "cards" ? "Cards" : "List"}
        </button>
      ))}
    </div>
  );
}
