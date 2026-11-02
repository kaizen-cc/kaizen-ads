"use client";

import { useState } from "react";
import { PresentationDeck } from "@/components/presentation-deck";
import type { PlanTurn } from "@/lib/plan-chat-types";
import type { Deck, Reactions } from "@/lib/presentation-types";
import { FirstAdsCard, type FirstAds } from "./first-ads";
import { PlanTalk } from "./plan-talk";
import { answerQuestion, approvePlan, chooseLaunch, reactPart } from "./actions";

export function PlanView({ slug, brand, deck, reactions: initial, approved: wasApproved, canAct, intake, chat, firstAds }: { slug: string; brand: string; deck: Deck; reactions: Reactions; approved: boolean; canAct: boolean; intake?: { clientId: number | null }; chat: PlanTurn[]; firstAds: FirstAds | null }) {
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
    <>
      {firstAds && (
        <div className="mb-5">
          <FirstAdsCard slug={slug} data={firstAds} canAct={canAct} />
        </div>
      )}
      <PresentationDeck
        brand={brand}
        deck={deck}
        reactions={reactions}
        approved={approved}
        readOnly={!canAct}
        intake={intake}
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
      {canAct && <PlanTalk slug={slug} brand={brand} chat={chat} locked={approved} onReactions={setReactions} />}
      {error && (
        <p role="alert" className="fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-md rounded-[14px] bg-bad px-4 py-3 text-center text-[14px] text-white shadow-lg">
          {error}
        </p>
      )}
    </>
  );
}
