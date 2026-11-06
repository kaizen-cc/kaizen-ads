"use client";

import { useState } from "react";
import { WriteChip, WriteOff } from "@/components/write-gate";
import type { WriteStatus } from "@/lib/write-status-core";
import { ChatPlan } from "../clients/[slug]/chat-plan";
import { planReportStep } from "./actions";

// Under the report: its "What's next" lines, each one tap from becoming a real change in the ad account. "Plan the
// change" has the buyer agent turn the step into the exact objects and amounts (the same plan card as the client chat:
// before → after, the platform's dry run, confirm). Whether it can actually be written shows before anything is
// pressed: with live changes off it plans a checklist to do by hand, each object linked to Ads Manager or Google Ads.

const NAME = { meta: "Meta", google: "Google Ads" } as const;

const without = <T,>(o: Record<number, T>, k: number) => Object.fromEntries(Object.entries(o).filter(([x]) => Number(x) !== k)) as Record<number, T>;

export function NextStepsAct({ reportId, platform, steps, write, canSwitch }: { reportId: string; platform: "meta" | "google"; steps: string[]; write: WriteStatus | null; canSwitch: boolean }) {
  const [plans, setPlans] = useState<Record<number, string | "pending">>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [gate, setGate] = useState(write);
  const list = steps.map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  const off = gate && !gate.live ? gate : null;

  const plan = async (i: number) => {
    // Instant: the row shows it's planning before the server answers
    setPlans((p) => ({ ...p, [i]: "pending" }));
    setErrors((e) => without(e, i));
    const r = await planReportStep(reportId, list[i]);
    if (r.ok) setPlans((p) => ({ ...p, [i]: r.changeId }));
    else {
      setPlans((p) => without(p, i));
      setErrors((e) => ({ ...e, [i]: r.error }));
    }
  };

  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-faint">Act on what&rsquo;s next</p>
          <p className="text-[13px] text-muted">Turn a next step into the exact change in {NAME[platform]}, checked before anything is written.</p>
        </div>
        {gate && <WriteChip status={gate} />}
      </header>
      {off && <WriteOff status={off} canSwitch={canSwitch} compact onLive={() => setGate({ ...off, live: true, off: null, reason: null })} />}
      <ol className="grid gap-2">
        {list.map((s, i) => {
          const id = plans[i];
          return (
            <li key={`${i}-${s.slice(0, 24)}`} className="grid gap-2 rounded-[14px] border border-line bg-bg/40 p-3">
              <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
                <span className="tabular mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] text-muted">{i + 1}</span>
                <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed">{s}</p>
                {!id && (
                  <button type="button" onClick={() => void plan(i)} className="min-h-11 shrink-0 rounded-full border border-line px-4 text-[12.5px] font-medium text-fg transition-colors hover:border-faint hover:bg-surface-2 max-sm:w-full md:min-h-9">
                    {off ? "Plan it as a checklist" : "Plan the change"}
                  </button>
                )}
                {id === "pending" && (
                  <span className="inline-flex min-h-11 shrink-0 items-center gap-2 px-2 text-[12.5px] text-muted md:min-h-9">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                    Planning…
                  </span>
                )}
              </div>
              {errors[i] && <p className="pl-9 text-[12px] text-bad">{errors[i]}</p>}
              {id && id !== "pending" && (
                <div className="sm:pl-9">
                  <ChatPlan id={id} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
