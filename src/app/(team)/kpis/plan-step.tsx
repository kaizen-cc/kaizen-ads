"use client";

import { useEffect, useState } from "react";
import { WriteOff } from "@/components/write-gate";
import type { WriteStatus } from "@/lib/write-status-core";
import { ChatPlan } from "../clients/[slug]/chat-plan";
import { planTargetStep, writeForTarget } from "./change-actions";

// One next step written for a KPI (the #1 problem's plan), one tap from a real change: "Plan the change" has the buyer
// agent turn it into the exact objects and amounts on the client chat's plan card (before → after, the platform's dry
// run, confirm). Whether it can be written shows first: live changes off, it plans a checklist to do by hand.

export function PlanStep({ targetId, step, platform }: { targetId: string; step: string; platform: "meta" | "google" }) {
  const [gate, setGate] = useState<{ write: WriteStatus; canSwitch: boolean; why: string | null } | null>(null);
  const [id, setId] = useState<string | "pending" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void writeForTarget(targetId)
      .then((g) => {
        if (live) setGate(g);
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [targetId]);
  const off = gate && !gate.write.live ? gate.write : null;
  const name = platform === "google" ? "Google Ads" : "Meta";

  const plan = async () => {
    setId("pending");
    setError(null);
    const r = await planTargetStep(targetId, step);
    if (r.ok) setId(r.id);
    else {
      setId(null);
      setError(r.error);
    }
  };

  if (id && id !== "pending") return <ChatPlan id={id} />;
  // Not this person's account to change: who can, in one calm line instead of the button
  if (gate?.why) return <p className="text-[12px] text-faint">{gate.why}</p>;
  return (
    <div className="grid min-w-0 gap-2">
      {off && <WriteOff status={off} canSwitch={gate?.canSwitch ?? false} compact onLive={() => setGate(gate && { ...gate, write: { ...gate.write, live: true, off: null, reason: null } })} />}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={id === "pending"}
          onClick={() => void plan()}
          className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-[12.5px] font-medium transition-colors disabled:opacity-60 md:min-h-9 ${platform === "google" ? "border-[#4285f4]/40 text-[#8ab4f8] hover:bg-[#4285f4]/10" : "border-[#0866ff]/45 text-[#7aa7ff] hover:bg-[#0866ff]/10"}`}
        >
          {id === "pending" ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              Planning…
            </>
          ) : off ? (
            "Plan it as a checklist"
          ) : (
            `Plan the change in ${name}`
          )}
        </button>
        {error && <span className="text-[12px] text-bad">{error}</span>}
      </div>
    </div>
  );
}
