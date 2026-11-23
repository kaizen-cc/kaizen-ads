import { blocksText, messageBlocks } from "./delivery-core";

// A report has one text and one set of sections, and every output is drawn from them: the Slack post IS the message,
// the email's body IS the same message (turned from Slack's formatting into the email's, see messageBlocks), and the PDF,
// the report page and the client's /r page are drawn from the sections. Nothing is copied, so nothing can go stale.
// After the AI changes a report the app reads both back and says, from the saved text itself, which outputs changed:
// the AI never claims a change is somewhere it didn't check.

type Version = { message?: string | null; sections?: unknown };

/** What the writer is told about where its text goes, so it never says "regenerate" or "it's already in both" unchecked */
export const OUTPUTS_RULE = `Where your text goes: the message you return is the Slack post AND the body of the email, word for word (the app turns its Slack formatting into the email's: headings, paragraphs and bullets, every one of them, with nothing cut). The sections are the PDF, the report page and the client's report link. So a change to the message is a change to the email too, and one to the sections is in the PDF. Every output is drawn from what you return the moment it's saved: never tell them to regenerate, reload, refresh or reopen anything, and never say a change is "already in" a version. The app checks what changed in each output after you save and tells them under your reply, so say only what you changed.`;

const emailBody = (m: string | null | undefined) => blocksText(messageBlocks(m)).join("\n").trim();
const sectionsKey = (s: unknown) => JSON.stringify(s ?? null);

export type OutputsCheck = { slack: boolean; email: boolean; pdf: boolean; line: string };

/** Read back after a change: which outputs now differ from before, as one plain line for the chat */
export function outputsCheck(before: Version, after: Version): OutputsCheck {
  const slack = String(before.message ?? "").trim() !== String(after.message ?? "").trim();
  const email = emailBody(before.message) !== emailBody(after.message);
  const pdf = sectionsKey(before.sections) !== sectionsKey(after.sections);
  const changed = [slack || email ? (email ? "the Slack message and the email (one text)" : "the Slack message") : null, pdf ? "the PDF" : null].filter(Boolean) as string[];
  const same = [!slack && !email ? "the Slack message and the email" : null, !pdf ? "the PDF" : null].filter(Boolean) as string[];
  const line = !changed.length
    ? "Checked after saving: nothing changed in the Slack message, the email or the PDF."
    : `Checked after saving: ${changed.join(" and ")} ${changed.length > 1 || changed[0].includes(" and ") ? "are" : "is"} updated${same.length ? `; ${same.join(" and ")} ${same[0].includes(" and ") ? "are" : "is"} as before` : ""}.`;
  return { slack, email, pdf, line };
}
