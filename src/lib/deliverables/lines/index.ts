import type { LineConfig } from "../engine";
import { EMAIL_LINE } from "./email";

// Every line the deliverable flow runs for. Creative and social add their config here (lead, writer, kinds, context,
// doc, Asana project, section and fields) without touching the engine.

export const LINES: readonly LineConfig[] = [EMAIL_LINE];
export const lineOf = (key: string | null | undefined) => LINES.find((l) => l.line === key) ?? null;

/** The line a person's ask starts the flow for ("I need to create campaigns for Candy Cloud"), or null */
export function lineForAsk(text: string): LineConfig | null {
  return LINES.find((l) => l.trigger.test(String(text ?? ""))) ?? null;
}
