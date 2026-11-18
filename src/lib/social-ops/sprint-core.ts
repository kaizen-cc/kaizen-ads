// The social sprint's plain message: email's verdicts and timing (src/lib/email-ops/sprint-core.ts) in social words,
// where the only change history is the posts that went up. Pure, so it is tested without a database.

import type { ActionTally, Movement, SprintVerdict } from "@/lib/email-ops/sprint-core";
import type { SocialSnapshot } from "./audit-core";

/** What the posts say against the ticks, in a sentence (or nothing) */
export function postsLine(t: ActionTally, recent: number | null): string {
  if (recent == null) return "";
  if (recent === 0 && t.done + t.doing > 0) return " Nothing has been posted since the last check, so I can't see the ticked moves on the accounts yet.";
  if (recent === 0) return " Nothing has been posted since the last check.";
  if (t.done + t.doing === 0) return ` I can see ${recent} ${recent === 1 ? "post" : "posts"} since the last check, but no move is ticked: tick what's done so I can follow it.`;
  return ` I can see ${recent} ${recent === 1 ? "post" : "posts"} since the last check.`;
}

/** The check's message when no AI is available: plain, first person, specific */
export function socialPlainMessage(v: SprintVerdict, m: Movement, t: ActionTally, now: Pick<SocialSnapshot, "score">, recent: number | null = null): string {
  const lead = `The social score is ${now.score} (${m.delta === 0 ? "unchanged" : `${m.delta > 0 ? "up" : "down"} ${Math.abs(m.delta)} since the sprint began`}).`;
  const gained = m.gained.length ? ` ${m.gained.join(", ")} now meets its bar.` : "";
  const lost = m.lost.length ? ` ${m.lost.join(", ")} slipped under its bar.` : "";
  const open = m.open.length ? ` Still under the bar: ${m.open.slice(0, 3).join(", ")}.` : "";
  const of = `${t.done} of ${t.done + t.doing + t.todo} moves done`;
  const core =
    v === "done"
      ? `${lead} The accounts are back in the green.${gained}`
      : v === "no_action"
        ? `${lead} Nothing on the plan is started yet. The moves marked for today come first.${open}`
        : v === "worse"
          ? `${lead}${lost}${open} ${of}: worth checking what went up since the last look.`
          : v === "improving"
            ? `${lead}${gained}${open} ${of}: keep going.`
            : `${lead}${gained}${lost}${open} Engagement takes a few posts to move, so I will look again soon.`;
  return core + postsLine(t, recent);
}
