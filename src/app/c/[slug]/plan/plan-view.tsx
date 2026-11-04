"use client";

import { useState } from "react";
import { PresentationDeck } from "@/components/presentation-deck";
import type { PlanTurn } from "@/lib/plan-chat-types";
import type { Deck, Measure, Reactions } from "@/lib/presentation-types";
import { FirstAdsCard, type FirstAds } from "./first-ads";
import { PlanTalk } from "./plan-talk";
import { answerQuestion, approvePlan, chooseLaunch, chooseMeasure, reactPart } from "./actions";

export function PlanView({ slug, brand, deck, reactions: initial, approved: wasApproved, approveBy = null, canAct, intake, chat, firstAds, measure = null }: { /** The targets we'll judge their ads by */ measure?: Measure | null; /** Taken as approved on its own then, without their answer (72 business hours) */ approveBy?: string | null; slug: string; brand: string; deck: Deck; reactions: Reactions; approved: boolean; canAct: boolean; intake?: { clientId: number | null }; chat: PlanTurn[]; firstAds: FirstAds | null }) {
  const [reactions, setReactions] = useState(initial);
  const [approved, setApproved] = useState(wasApproved);
  const [error, setError] = useState<string | null>(null);
  const run = async (p: Promise<{ ok: true; reactions?: Reactions } | { ok: false; error: string }>) => {
    const r = await p;
    if (!r.ok) return setError(r.error);
    setError(null);
    if (r.reactions) setReactions(r.reactions);
  };
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="grid min-w-0 gap-5">
      {firstAds && <FirstAdsCard slug={slug} data={firstAds} canAct={canAct} />}
      {!approved && approveBy && (
        <p className="rounded-[16px] border border-line bg-surface px-4 py-3 text-[13.5px] text-muted">
          Have a look by <b className="text-fg">{new Date(approveBy).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</b>. If we haven&rsquo;t heard from you by then, we&rsquo;ll take it as approved and start building, and you can still tell us anything after.
        </p>
      )}
      <PresentationDeck
        brand={brand}
        deck={deck}
        reactions={reactions}
        approved={approved}
        readOnly={!canAct}
        intake={intake}
        measure={measure}
        onMeasure={(choice, values, note) => run(chooseMeasure(slug, choice, values, note))}
        onReact={(section, verdict, note) => run(reactPart(slug, section, verdict, note))}
        onAnswer={(q, a) => run(answerQuestion(slug, q, a))}
        onLaunch={(choice) => run(chooseLaunch(slug, choice))}
        onApprove={async () => {
          const r = await approvePlan(slug);
          if (!r.ok) return setError(r.error);
          setError(null);
          setApproved(true);
        }}
      />
      </div>
      {/* On a computer: the conversation beside the presentation. On a phone: a bar that opens it */}
      {canAct && <PlanTalk slug={slug} brand={brand} chat={chat} locked={approved} onReactions={setReactions} />}
      {error && (
        <p role="alert" className="fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 lg:bottom-6 mx-auto max-w-md rounded-[14px] bg-bad px-4 py-3 text-center text-[14px] text-white shadow-lg">
          {error}
        </p>
      )}
    </div>
  );
}
