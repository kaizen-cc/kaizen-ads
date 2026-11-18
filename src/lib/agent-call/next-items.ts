import type { NextItem } from "@/lib/next-for-me";
import { cleanItems, type CheckItem } from "./ask-rules";
import { firstNameOf } from "./core";

// The Overview's Next for me rows that come from the agents: a call whose learnings still wait for keep or toss, and
// a reminder or a task someone asked an agent for. Plain builders, tested on their own.

const TZ = "America/New_York";
const dayOf = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: TZ });

/** "today", "yesterday", "Tuesday", or "Nov 3" a week or more back: the day a call was on, as the Overview says it */
export function dayWord(iso: string, now = new Date()): string {
  const day = dayOf(new Date(iso));
  if (day === dayOf(now)) return "today";
  if (day === dayOf(new Date(now.getTime() - 86_400_000))) return "yesterday";
  const days = (Date.parse(`${dayOf(now)}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000;
  return days < 7 ? new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" }) : new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" });
}

/** The day as said after a verb: "today", "yesterday", "on Tuesday", "on Nov 3" */
export function onDay(iso: string, now = new Date()): string {
  const w = dayWord(iso, now);
  return w === "today" || w === "yesterday" ? w : `on ${w}`;
}

/** Where a call's review opens: the agent's page with the sheet up (?review=<call>) */
export const reviewHref = (roleKey: string, callId: string) => `/settings?tab=agents&role=${encodeURIComponent(roleKey)}&review=${encodeURIComponent(callId)}`;

/** A call with learnings still to keep or toss */
export function callReviewItem(r: { callId: string; roleKey: string; roleLabel: string; startedAt: string; items: unknown[] }, now = new Date()): NextItem {
  const n = r.items.length;
  const day = dayWord(r.startedAt, now);
  return {
    id: `cl-${r.callId}`,
    kind: "call-learnings",
    tone: "brand",
    client: `The ${r.roleLabel}`,
    title: `Review what you taught the ${r.roleLabel} ${onDay(r.startedAt, now)}`,
    why: `${n === 1 ? "One thing" : `${n} things`} heard on the call ${n === 1 ? "waits" : "wait"} for you to keep or toss. Nothing is applied until you do.`,
    when: day === "today" ? "From today" : `From ${day}`,
    href: reviewHref(r.roleKey, r.callId),
    action: "Review",
  };
}

/** A feature request (an Ask) from the team, waiting on the owner to approve or comment on */
export type OwnerAsk = { id: string; title: string; summary: string | null; people: number; createdAt: string; by: string | null };

/** The owner's row for an Ask: approve or comment right on the Overview, or open it on the Feedback page */
export function ownerAskItem(g: OwnerAsk, now = new Date()): NextItem {
  const who = g.by ? `From ${firstNameOf(g.by)}` : "From the team";
  const more = g.people > 1 ? ` and ${g.people - 1} more` : "";
  return {
    id: `fb-${g.id}`,
    kind: "feedback",
    tone: "brand",
    client: "Kaizen OS",
    title: g.title,
    why: `${who}${more}${g.summary ? `: ${g.summary}` : ""}`,
    when: `Asked ${dayWord(g.createdAt, now)}`,
    href: `/feedback?section=asks&g=${encodeURIComponent(g.id)}`,
    action: "Open it",
    feedback: { groupId: g.id },
  };
}

export type AskRow = { id: string; kind: "reminder" | "task"; title: string; detail: string; due_on: string | null; created_at: string; asked_by: string; askerName: string | null; roleLabel: string | null; client: { name: string; slug: string } | null; checklist?: unknown; call_id?: string | null; with_transcript?: boolean | null };

/**
 * A reminder or a task from a conversation with an agent: on the person it's for, credited to who asked and which
 * agent. Due today or earlier (or no date) is for now; a later date is coming up.
 */
export function askItem(a: AskRow, me: string, now = new Date()): { item: NextItem; bucket: "now" | "coming" } {
  const today = dayOf(now);
  const mine = a.asked_by === me;
  const via = a.roleLabel ? ` via the ${a.roleLabel}` : "";
  const credit = mine ? `Your reminder${via}` : `From ${firstNameOf(a.askerName)}${via}`;
  const due = a.due_on ? new Date(`${a.due_on}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ }) : null;
  const late = Boolean(a.due_on && a.due_on < today);
  // A checklist reminder: its items ticked off one by one on the row
  const items: CheckItem[] = cleanItems(a.checklist);
  const item: NextItem = {
    id: `ask-${a.id}`,
    kind: "ask",
    tone: late ? "bad" : a.kind === "task" ? "warn" : "brand",
    client: a.client?.name ?? (mine ? "Reminder" : "From the team"),
    title: a.title,
    why: a.detail ? `${credit}: ${a.detail}` : credit,
    when: due ? (late ? `Was due ${due}` : `Due ${due}`) : `Asked ${dayWord(a.created_at, now)}`,
    href: a.client ? `/clients/${a.client.slug}` : "/pipeline#next",
    action: a.client ? "Open client" : "Open",
    ask: { id: a.id, checklist: items.length ? items : undefined, transcriptCallId: a.with_transcript && a.call_id ? a.call_id : undefined },
  };
  return { item, bucket: !a.due_on || a.due_on <= today ? "now" : "coming" };
}
