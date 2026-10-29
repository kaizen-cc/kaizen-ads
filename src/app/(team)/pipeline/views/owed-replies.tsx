"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { OwedReply } from "@/lib/owed-replies";
import { dismissOwed, doneOwed } from "@/app/today/actions";
import { HideForMe } from "./hide-for-me";
import { completeCard } from "@/lib/complete-card";

// Messages nobody answered (Slack tags, a client's message in their channel, emails written to someone), once the
// person has had a notice: theirs to answer or set aside, and for leads and execs, the ones that were escalated.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

export function OwedReplies({ items, me }: { items: OwedReply[]; me: string }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [, start] = useTransition();
  const shown = items.filter((o) => !gone.has(o.id));
  if (!shown.length) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {shown.map((o) => {
        const mine = o.targetId === me;
        const second = o.status === "escalated";
        return (
          <article key={o.id} data-hideable className={`grid content-start gap-3 rounded-[16px] border bg-bg/70 p-4 ${second ? "border-bad/40" : "border-line"}`}>
            <div className="grid gap-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${second ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>{second ? "Second notice" : "Notice sent"}</span>
                {o.clientSlug ? (
                  <Link href={`/clients/${o.clientSlug}`} className="font-medium text-fg hover:underline">
                    {o.client}
                  </Link>
                ) : (
                  <span className="font-medium text-fg">{o.fromTeam ? "Team" : o.from}</span>
                )}
                · {o.source === "gmail" ? "Email" : "Slack"} · {day(o.askedAt)}
              </span>
              <p className="text-[15px] leading-snug">
                <span className="text-muted">{mine ? "You" : o.target} → </span>
                {o.from}: {o.gist}
              </p>
              <p className="line-clamp-2 text-xs text-faint">&ldquo;{o.body.replace(/\s+/g, " ")}&rdquo;</p>
              {second && !mine && <p className="text-xs text-bad">They had a notice and still haven&apos;t answered.</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {o.url && (
                <a href={o.url} target="_blank" rel="noreferrer" className="inline-flex h-11 w-full items-center justify-center rounded-brand bg-fg px-4 text-sm font-medium text-bg md:h-9 md:w-auto">
                  {o.source === "gmail" ? "Open the email" : "Open in Slack"} ↗
                </a>
              )}
              {o.channelUrl && (
                <a href={o.channelUrl} target="_blank" rel="noreferrer" className="inline-flex h-11 flex-1 items-center justify-center rounded-brand border border-line px-4 text-sm text-muted hover:text-fg md:h-9 md:flex-none">
                  The channel ↗
                </a>
              )}
              {mine && (
                <>
                  <button
                    type="button"
                    title="You took care of it another way (a call, in person). It closes, and anyone it went up to hears it's done."
                    onClick={(e) => {
                      const saved = doneOwed(o.id);
                      completeCard(e.currentTarget.closest("article"), () => {
                        setGone((g) => new Set(g).add(o.id));
                        start(async () => {
                          await saved;
                          router.refresh();
                        });
                      });
                    }}
                    className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-brand border border-ok/40 px-4 text-sm text-ok hover:bg-ok-soft md:h-9 md:flex-none"
                  >
                    <span aria-hidden>✓</span> Done, handled another way
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGone((g) => new Set(g).add(o.id));
                      start(async () => {
                        await dismissOwed(o.id);
                        router.refresh();
                      });
                    }}
                    className="h-11 rounded-brand px-3 text-sm text-faint hover:text-fg md:h-9"
                  >
                    Doesn&apos;t need a reply
                  </button>
                </>
              )}
              {/* Someone else's: clear it off your board (it stays theirs) */}
              {!mine && <HideForMe hideKey={`owed:${o.id}`} label={`${o.target} → ${o.from}: ${o.gist}`} href={o.url} />}
            </div>
          </article>
        );
      })}
    </div>
  );
}
