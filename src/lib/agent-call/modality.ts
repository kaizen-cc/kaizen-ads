import { BACKGROUND_CHATTER_RULE, CONCISE_RULE, SPOKEN_RULE } from "./core";

// One brain, two ways to talk. A conversation with an agent runs through the same turn pipeline whether it's a voice
// call or a typed chat: the same system rules, tools, routing, gates, memory, notes and review. The only thing the
// mode changes is the output: on a call every word is spoken (short spoken sentences, fillers while tools run, a length
// guard), in a chat it's read (light markdown, clickable links, short lists). That difference lives here and only here,
// as one block in the system prompt and a few switches on how the answer streams. Pure: no keys, no network.

export type TalkMode = "voice" | "text";

export const isTalkMode = (v: unknown): v is TalkMode => v === "voice" || v === "text";
/** Anything that isn't plainly "text" is a call (the default, as before chats existed) */
export const talkModeOf = (v: unknown): TalkMode => (v === "text" ? "text" : "voice");

/** A chat stays open this long without a message (then it's closed like a call nobody hung up) */
export const CHAT_IDLE_SECONDS = 2 * 3600;
/** And at most this long in all */
export const CHAT_LIMIT_SECONDS = 12 * 3600;

/** When the conversation moved to a mode (chat to call and back): one entry per move, the first is how it started */
export type ModeStep = { mode: TalkMode; at: string };

export function parseModeLog(raw: unknown): ModeStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is ModeStep => Boolean(s) && typeof s === "object" && isTalkMode((s as ModeStep).mode) && typeof (s as ModeStep).at === "string" && Number.isFinite(Date.parse((s as ModeStep).at)));
}

/** When the current stretch of this mode began (a call's thirty minutes count from when it became a call) */
export function modeSince(input: { mode: TalkMode; startedAt: string; log: readonly ModeStep[] }): number {
  const last = [...input.log].reverse().find((s) => s.mode === input.mode);
  return Date.parse(last?.at ?? input.startedAt);
}

/**
 * Whether a conversation still takes turns: a call within its limit (plus a minute's grace for the last answer) from
 * when it became a call; a chat while it's been used in the last couple of hours, and within its overall limit.
 */
export function stillOpen(input: { mode: TalkMode; startedAt: string; lastTurnAt?: string | null; log?: readonly ModeStep[]; callLimitSeconds: number; now?: number }): boolean {
  const now = input.now ?? Date.now();
  const since = modeSince({ mode: input.mode, startedAt: input.startedAt, log: input.log ?? [] });
  if (input.mode === "voice") return now - since <= (input.callLimitSeconds + 60) * 1000;
  const alive = Math.max(Date.parse(input.lastTurnAt ?? input.startedAt) || 0, since || 0);
  return now - alive <= CHAT_IDLE_SECONDS * 1000 && now - Date.parse(input.startedAt) <= CHAT_LIMIT_SECONDS * 1000;
}

/** The modality block is wrapped in these, so a test can compare everything around it */
export const MODALITY_OPEN = "<how_you_talk_now>";
export const MODALITY_CLOSE = "</how_you_talk_now>";
const wrap = (s: string) => `${MODALITY_OPEN}\n${s}\n${MODALITY_CLOSE}`;

/** How answers are written in a chat (the written counterpart of CONCISE_RULE and SPOKEN_RULE) */
export const CHAT_RULE = `Keep it short. This is a firm rule: they're reading on a small chat window, often on a phone. Lead with the answer in one or two short sentences. Name at most five things in a list; if there are more, say how many more and offer them. Stay under about ninety words unless they ask for detail or a walkthrough, and even then keep it tight. Then, only if it helps, one short question. Never repeat their question back, no filler ("great question", "sure thing, so"), and never close with "let me know if you need anything else".`;

export const CHAT_FORMAT_RULE = `Write for the screen:
- Short paragraphs. Light markdown only: **bold** for the one number or name that matters, a short "- " list when there are several items. No headings, tables, code blocks or emojis.
- Exact figures are fine ($1,240, 2.4x ROAS, 12%), and dates as they're written (Nov 4).
- Links are clickable: write them as [label](url), or an app path like [Crust's KPIs](/clients/crust?tab=kpis). Never paste a bare long URL.
- Write names as they're spelled.`;

/** The assistant's way of talking, by mode (everything else in its instructions is the same for both) */
export function assistantModality(mode: TalkMode): string {
  if (mode === "text")
    return wrap(`You're in a live typed chat with them (a chat window over the app): they read what you write as it streams in. They may have just moved here from a voice call, or move to one from here: it's the same conversation either way.

${CHAT_RULE}

${CHAT_FORMAT_RULE}

Don't end an answer with a generic open question ("what's on your mind?", "anything else?"): end on the point, or offer the obvious next step by name.`);
  return wrap(`You're on a live voice call: everything you write is spoken aloud as you write it.

${CONCISE_RULE}

${SPOKEN_RULE}

How you speak:
- Short spoken sentences. No markdown, lists, bullets, links, emojis or code. Several points go in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them ("about twelve hundred dollars", "a two point four ROAS"). Never read a table out.
- Write names as they're spelled (Klaviyo, Cloudbeds): the voice already says them right. Never spell a name out phonetically.

${BACKGROUND_CHATTER_RULE}`);
}

/** A specialist's (or a directly called agent's) way of talking, by mode */
export function agentModality(mode: TalkMode): string {
  if (mode === "text")
    return wrap(`You're in a live typed chat (a chat window over the app): they read what you write as it streams in. Speak like a sharp colleague in a chat, in the first person ("I check…", "In my briefs I…").

${CHAT_RULE}

${CHAT_FORMAT_RULE}
- Never say anything that sounds like reading a document ("as stated in my core"). Just say what you do.
- If you didn't catch something or it's vague, ask one short question.`);
  return wrap(`You're on a live voice call: everything you write is spoken aloud by a text to speech voice as you write it.

${CONCISE_RULE}

${SPOKEN_RULE}

Speak like a sharp colleague on the phone, in the first person ("I check…", "In my briefs I…"):
- Short spoken sentences, one to three by default.
- No markdown, no lists, no bullets, no headings, no asterisks, no emojis, no links, no code. If there are several points, say them in a sentence: "Three things. First… Then… And last…".
- Numbers as people say them: "about twelve hundred dollars", "a two point four ROAS", "three to five days", "March fourth". Round when exact digits don't matter. Say "percent", not the symbol. Never read a table out: give the one or two numbers that answer the question and offer more.
- Never say anything that sounds like reading a document ("as stated in my core"). Just say what you do.
- Write names as they're spelled (Klaviyo, Cloudbeds): the voice already says them right. Never spell a name out phonetically or explain how it's said.
- If you didn't catch something or it's vague, ask one short question.`);
}

/** A system prompt with its modality block taken out (what must match between a call and a chat) */
export function withoutModality(system: string): string {
  return system.replace(new RegExp(`${MODALITY_OPEN}[\\s\\S]*?${MODALITY_CLOSE}`, "g"), MODALITY_OPEN);
}

/**
 * How an answer streams in each mode: on a call, a spoken filler covers slow tools and a length guard stops a long
 * answer at a sentence and offers the rest; in a chat neither (it's read, and a list can't be cut mid-way), and the
 * answer is kept with its line breaks (its lists and paragraphs).
 */
export function streamShaping(mode: TalkMode): { filler: boolean; lengthGuard: boolean; keepLineBreaks: boolean } {
  return mode === "text" ? { filler: false, lengthGuard: false, keepLineBreaks: true } : { filler: true, lengthGuard: true, keepLineBreaks: false };
}

/** The answer as it's kept in the conversation (what was cut short by talking over it ends with an ellipsis) */
export function keptLine(reply: string, aborted: boolean, mode: TalkMode): string {
  const text = streamShaping(mode).keepLineBreaks ? reply.replace(/\n{3,}/g, "\n\n").trim() : reply.replace(/\n+/g, " ").trim();
  return text ? `${text}${aborted ? "…" : ""}` : "";
}
