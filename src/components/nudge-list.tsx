"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissLadderNudge, sendLadderNudge } from "@/app/(team)/nudge-actions";
import type { Nudge } from "@/lib/escalation-ladder";
import { useParam } from "@/lib/url-state";

// The lead's nudge cards (the escalation ladder): who's behind on what, and a message drafted to check in with them.
// Edit it, send it as yourself from Slack, or set it aside. A notification opens one (?nudge=<id>).

const days = (since: string) => Math.max(2, Math.round((Date.now() - Date.parse(since)) / 864e5));

export function NudgeList({ nudges }: { nudges: Nudge[] }) {
  return (
    <section aria-labelledby="nudges-title" className="grid gap-3 rounded-[22px] border border-line bg-deep p-4 md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="nudges-title" className="font-heading text-[18px] tracking-tight text-fg">
          Check in with your team
        </h3>
        <span className="text-[12px] text-ink/50">48 hours with nothing done · a message is drafted for each</span>
      </div>
      <ul className="grid gap-2">
        {nudges.map((n) => (
          <Card key={n.id} n={n} />
        ))}
      </ul>
    </section>
  );
}

function Card({ n }: { n: Nudge }) {
  const router = useRouter();
  const focus = useParam("nudge") === n.id;
  const ref = useRef<HTMLLIElement>(null);
  const [text, setText] = useState(n.draft);
  const [state, setState] = useState<"idle" | "sent" | "gone">("idle");
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [busy, start] = useTransition();
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus]);
  if (state === "gone") return null;
  const send = () =>
    start(async () => {
      setError(null);
      const r = await sendLadderNudge(n.id, text);
      if (!r.ok) {
        setError(r.error);
        setConnect(Boolean("needsConnect" in r && r.needsConnect));
        return;
      }
      setState("sent");
      router.refresh();
    });
  return (
    <li ref={ref} className={`grid gap-2.5 rounded-[18px] border bg-bg/40 p-3.5 ${focus ? "border-ink/30" : "border-line"}`}>
      <p className="text-[13.5px] leading-snug text-fg">
        <span className="font-medium">{n.owner}</span> · {n.client ? `${n.client}: ` : ""}
        {n.what}
        <span className="text-ink/50"> · {days(n.since)} days</span>
      </p>
      {state === "sent" ? (
        <p className="text-[12.5px] text-[#5be3a5]">Sent to {n.owner.split(" ")[0]} from your Slack.</p>
      ) : (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={3000} aria-label={`Message to ${n.owner}`} className="w-full resize-none rounded-[14px] border border-line bg-transparent px-3 py-2 text-[15px] leading-relaxed text-fg outline-none focus:border-ink/35 md:text-[13.5px]" />
          {error && (
            <p className="text-[12px] text-[var(--bad)]">
              {error}
              {connect && (
                <a href={`/api/slack/connect?next=${encodeURIComponent("/pipeline")}`} className="ml-1 underline">
                  Connect Slack
                </a>
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !text.trim()} onClick={send} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 sm:min-h-9">
              {busy ? "Sending…" : `Send to ${n.owner.split(" ")[0]} on Slack`}
            </button>
            {n.href && (
              <a href={n.href} target={n.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="min-h-11 content-center rounded-full px-3 text-[12.5px] text-ink/60 hover:text-fg sm:min-h-9">
                See the item
              </a>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setState("gone");
                  await dismissLadderNudge(n.id);
                })
              }
              className="ml-auto min-h-11 rounded-full px-3 text-[12.5px] text-ink/50 hover:text-fg sm:min-h-9"
            >
              Not needed
            </button>
          </div>
        </>
      )}
    </li>
  );
}
