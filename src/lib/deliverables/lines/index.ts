import type { LineConfig } from "../engine";
import { CREATIVE_LINE } from "./creative";
import { EMAIL_LINE } from "./email";
import { SOCIAL_LINE } from "./social";

// Every line the deliverable flow runs for: email, paid creative and organic social. A new line adds its config here
// (lead, writer, kinds, context, doc, Asana project, section and fields) without touching the engine.

export const LINES: readonly LineConfig[] = [EMAIL_LINE, CREATIVE_LINE, SOCIAL_LINE];
export const lineOf = (key: string | null | undefined) => LINES.find((l) => l.line === key) ?? null;

/** The line a person's ask starts the flow for ("I need to create campaigns for Candy Cloud"), or null */
export function lineForAsk(text: string): LineConfig | null {
  return LINES.find((l) => l.trigger.test(String(text ?? ""))) ?? null;
}
