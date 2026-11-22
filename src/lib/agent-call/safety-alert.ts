// A flagged call's alert, shared by the executives: one dismissal clears it for all of them, and their comments sit
// on the same page. The pure parts (checked in tests).

export const SAFETY_COMMENT_MAX = 4000;
export const SAFETY_RESOLUTION_MAX = 1000;

/** A comment or a resolution note, trimmed and capped; empty when there's nothing to say */
export function cleanSafetyText(text: unknown, max = SAFETY_COMMENT_MAX): string {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n").trim().slice(0, max).trim() : "";
}

/** The notification key every exec's alert for this call was sent under (one dismissal clears them all) */
export const safetyAlertKey = (callId: string) => `call-safety:${callId}`;

export const isCallId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
