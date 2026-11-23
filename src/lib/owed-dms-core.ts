// Which DM is waiting on the person: the newest human message in the conversation is someone else's (not a bot, not a
// join/leave notice, not just an emoji), so they haven't answered it yet. Pure, tested on its own.

export type DmMessage = { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string; reactions?: { name: string; users?: string[] }[] };

/** Nothing to answer: a thanks, an ok, an emoji on its own */
const NOTHING_TO_ANSWER = /^\s*(?:(?:thanks?|thank you|thx|ty|ok(?:ay)?|k|cool|great|perfect|awesome|got it|sounds good|np|no worries|👍|🙏|🙌|✅|:[a-z0-9_+-]+:)[\s!.]*)+$/i;

/** The message they owe a reply to in this DM (newest first or oldest first, as Slack sends it), else null */
export function dmOwed(messages: readonly DmMessage[], me: string): DmMessage | null {
  const human = [...messages].filter((m) => m.user && !m.bot_id && (!m.subtype || m.subtype === "thread_broadcast") && m.text?.trim()).sort((a, b) => Number(b.ts) - Number(a.ts));
  const last = human[0];
  if (!last || last.user === me) return null;
  if (NOTHING_TO_ANSWER.test(last.text ?? "")) return null;
  // They reacted to it (a thumbs-up on "can you check X?" is an answer of sorts): left to the "was it answered?" read
  return last;
}

/** An owed reply that came from a DM ("dm:<channel>:<ts>"): read with the person's own token, never the bot's */
export const isDmKey = (key: unknown) => typeof key === "string" && key.startsWith("dm:");
