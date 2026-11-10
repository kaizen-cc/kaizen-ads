import type { Draft } from "@/app/(team)/requests/new/draft";

// How a brief goes out from Ready to send, in one place (pure, tested in tests/brief-send.test.ts):
// - A brief the AI wrote (talked through, a suggested brief, from the market, a winner, a promise, Kaizen AI) sends at
//   once, with no second AI review. Small automatic edits on the way (a one-click fix, an answered fact, a correction
//   in "Tell me what to change", a reference line) don't change that: they are the AI's own edits.
// - A brief written by hand gets the AI review when it's sent, but the review never stops it: its findings are
//   suggestions, "Send anyway" is one click, and while it runs "Send now" skips it.
// - A correction typed in "Tell me what to change" and not sent yet goes in first.

/** Written by the AI: it arrived with the AI's stamp, or was opened from a suggested brief */
export const aiWritten = (d: Pick<Draft, "ai" | "origin">) => Boolean(d.ai?.source) || Boolean(d.origin?.suggestionId);

export type ReviewStatus = "idle" | "running" | "done" | "error";
export type SendAction = "apply-pending" | "send" | "review";

/** What the primary button does now */
export function sendAction(i: { pendingRevise: boolean; aiOn: boolean; aiWritten: boolean; review: ReviewStatus }): SendAction {
  if (i.pendingRevise) return "apply-pending";
  if (!i.aiOn || i.aiWritten) return "send";
  // Written by hand and not read yet: the review first (it sends on by itself when it finds nothing)
  if (i.review === "idle") return "review";
  // Running ("Send now" skips it), done (sent with its notes) or failed (sent without it)
  return "send";
}

/**
 * A copy of the request saved on this device gives way to a newer writing of the brief it opens (the brief-ready link,
 * a rewrite from its preview): when the copy was saved from another writing, or (older copies) before this one.
 */
export function savedGivesWay(kept: { at: number; draft: Pick<Draft, "origin"> } | null, writtenAt: string | null | undefined) {
  if (!kept || !writtenAt) return false;
  const was = kept.draft.origin?.writtenAt;
  return was ? was !== writtenAt : kept.at < Date.parse(writtenAt);
}

/** The primary button's words */
export function sendLabel(i: { pending: boolean; review: ReviewStatus; openItems: number; tickets: number; aiOn: boolean; aiWritten: boolean }) {
  if (i.pending) return "Sending…";
  const n = `${i.tickets} ticket${i.tickets === 1 ? "" : "s"}`;
  if (i.aiWritten || !i.aiOn) return `Send to the team · ${n}`;
  if (i.review === "running") return "Send now";
  if (i.review === "done" && i.openItems > 0) return `Send anyway · ${i.openItems} note${i.openItems === 1 ? "" : "s"} open`;
  return `Send to the team · ${n}`;
}
