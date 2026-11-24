import type { Card } from "@/lib/kaizen-ai/types";
import type { LineConfig } from "./engine";

// The deliverable flow in Kaizen AI chat (pure, so it's tested): a tool's card as a card of the thread, and the note
// that lets one thread hold the lead's and the copywriter's voices, each labeled.

type Emitted = { title: string; detail: string; href: string; external: boolean; cta: string; copy?: import("@/lib/agent-call/core").CallCopyDoc };

/** The assistant's card shape as a Kaizen AI card: copy documents render as a document card, the rest as link cards */
export function chatCardOf(c: Emitted): Card {
  if (c.copy) return { type: "copy_doc", detail: c.detail, copy: c.copy };
  return { type: "link", title: c.title, detail: c.detail, href: c.href, cta: c.cta, external: c.external };
}

const label = (key: string) => key.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());

/** Whether a message is about making a deliverable (so the flow's note is worth sending) */
export const WANTS_DELIVERABLE = /\b(?:campaigns?|flows?|sms|texts? blast|newsletters?|carousels?|reels?|ad concepts?|creative briefs?|brief (?:me|for)|static (?:ads?|posts?)|social posts?|organic posts?|posts? for|copy doc|content calendar|batch of)\b/i;

/** The note for one thread: who leads and writes each line, the staged flow, the labeled voices */
export function deliverableNote(lines: readonly Pick<LineConfig, "line" | "label" | "lead" | "writer">[], activeLabel: string): string {
  return [
    "Deliverables (email campaigns, flows and SMS; paid ad concepts; organic social posts) run through the deliverable tool, the same staged flow as the assistant: start it with the client and line, always read next and follow it. Ask the type and how many only when missing, pull fresh context, brainstorm topics (or suggest ideas) and record them agreed on their own yes, the writer drafts ONE preview document with create_copy_doc (a document card in this thread to read and open), review it line by line, record the approvals (when they want the copy in a Google Doc they already keep, add_copy_to_google_doc types it in at the end in its layout on their yes; never say you can't write into a Google Doc), then the lead asks for the requests. The Google Doc and the Asana task are made only after they type a clear yes (confirmed: true); never before.",
    `One thread, labeled speakers: you're answering as ${activeLabel}. Bring in the line's specialist and the copywriter when the flow calls for them (${lines.map((l) => `${l.label}: ${label(l.lead)} leads, ${label(l.writer)} writes`).join("; ")}). Start each of their turns with a bold label line, like **${label(lines[0]?.lead ?? "email_strategist")}:** or **Copywriter:**, in that role's voice and judgement, then go back to ${activeLabel} when the deliverable is done. When you speak as the lead or the writer, pass as: <their role key> to the deliverable tool. Short and natural, one question at a time.`,
  ].join("\n\n");
}
