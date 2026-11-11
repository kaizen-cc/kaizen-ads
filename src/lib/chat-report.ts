// "Report this" and "Ask for this" right where the AI falls short, in every chat: the plain logic (client-safe, and
// tested). Which messages get the action (an error, or a reply saying it can't do something), the few turns that go
// with the report (trimmed), and the report itself, clamped on the server before it's saved.

import type { TranscriptEntry } from "./chat-transcript";

export type ChatKind =
  | "kaizen-ai"
  | "client-chat"
  | "launch"
  | "google-launch"
  | "talk-it-through"
  | "brief-revise"
  | "report-studio"
  | "agent-coach"
  | "copy-studio"
  | "ads-lab"
  | "suggested-brief"
  | "brand-bible";

export const CHAT_LABEL: Record<ChatKind, string> = {
  "kaizen-ai": "Kaizen AI",
  "client-chat": "the client chat",
  launch: "a Meta launch card",
  "google-launch": "a Google launch card",
  "talk-it-through": "Talk it through",
  "brief-revise": "the brief revise chat",
  "report-studio": "the report studio chat",
  "agent-coach": "an agent coach chat",
  "copy-studio": "the copy studio chat",
  "ads-lab": "the Ads Lab",
  "suggested-brief": "a suggested brief's chat",
  "brand-bible": "the Brand Bible chat",
};
const KINDS = Object.keys(CHAT_LABEL) as ChatKind[];

export type FallShort = "error" | "cant";

// The AI saying it can't: first person, about doing something (not "I can't stress enough" or "you can't").
const DO_VERB = "(?:access|pull|load|fetch|reach|connect|read|open|get|complete|finish|do|make|create|save|launch|upload|send|run|change|edit|update|write|post|schedule|pause|build|generate|export|download|add|delete|remove|see|view|find a way)";
const I_CANT = new RegExp(
  String.raw`\b(?:i|i'm|i am)\s+(?:(?:currently|still|just|really|unfortunately|actually)\s+)?(?:can(?:'|’)?t|cannot|can not|(?:'m|am) unable to|unable to|(?:'m|am) not able to|not able to|not (?:set up|built|allowed|permitted) to|(?:could(?:n(?:'|’)?t| not)|was(?:n(?:'|’)?t| not) able to) ${DO_VERB}|(?:'m|am) not (?:set up|built|allowed|permitted) to|(?:don(?:'|’)?t|do not) have (?:a way|the ability|the tools?|a tool|access|permission|the access|any way|the option)|have no (?:way|access|tool|ability))\b`,
  "i",
);
const NOT_BUILT =
  /\b(?:(?:that|this|it)(?:'s| is)? not (?:something i can|possible (?:here|yet|for me)|supported(?: yet)?|built(?: yet)?|available (?:to me|here|yet))|(?:isn't|is not|aren't|are not|not) (?:built|supported|wired up|connected|available to me|possible for me) (?:yet|here|in (?:this|the) (?:app|chat))|there(?:'s| is) no (?:tool|way|option|feature) (?:for me |here )?(?:to|that)|(?:outside|beyond) (?:what i can do|my (?:current )?(?:abilities|capabilities|tools|reach))|no access to|i lack (?:access|the ability|a tool))/i;
// "I can't" that isn't about being unable: emphasis, opinion, or advice
const NOT_INABILITY = /\b(?:can(?:'|’)?t|cannot) (?:stress|emphasi[sz]e|overstate|wait|recommend|help but|say enough|believe|guarantee|promise|tell|be sure|be certain)\b/i;

/** Whether an AI reply says it can't do something (can't, isn't able, has no access, isn't built, and the like). */
export function cantDo(text: string | null | undefined): boolean {
  if (!text) return false;
  // Only the AI's own words count, not a quote of the user or code
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/^>.*$/gm, " ").slice(0, 4000);
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    if (NOT_INABILITY.test(sentence) && !NOT_BUILT.test(sentence)) continue;
    if (I_CANT.test(sentence) || NOT_BUILT.test(sentence)) return true;
  }
  return false;
}

/** The sentence that says it, for the report (null when none does). */
export function cantDoSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const prose = text.replace(/```[\s\S]*?```/g, " ").slice(0, 4000);
  for (const s of prose.split(/(?<=[.!?])\s+|\n+/)) if ((I_CANT.test(s) && !NOT_INABILITY.test(s)) || NOT_BUILT.test(s)) return s.trim().slice(0, 300);
  return null;
}

/**
 * Whether a message gets an action, and which: "Report this" for an error (the route failed, or the server flagged a
 * failed tool), "Ask for this" for a reply saying it can't. One action per message at most; an error wins.
 */
export function fallShort(m: { text?: string | null; error?: string | null; failed?: boolean | null }): FallShort | null {
  if (m.error?.trim() || m.failed) return "error";
  return cantDo(m.text) ? "cant" : null;
}

export type ChatTurnLite = { role: "user" | "ai"; text: string };

/** The last few turns, each cut short, oldest first: enough to see what was asked and what came back. */
export function trimTurns(turns: { role: string; text: string | null | undefined }[], max = 6, chars = 600): ChatTurnLite[] {
  return turns
    .filter((t) => (t.text ?? "").trim())
    .slice(-max)
    .map((t) => {
      const text = String(t.text ?? "").replace(/\s+\n/g, "\n").trim();
      return { role: t.role === "user" ? "user" : "ai", text: text.length > chars ? `${text.slice(0, chars - 1)}…` : text };
    });
}

/** A short, stable key for a message without an id (its place and its words). */
export function messageKey(i: number, text: string | null | undefined): string {
  let h = 0;
  for (const ch of String(text ?? "").slice(0, 500)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${i}-${(h >>> 0).toString(36)}`;
}

export type ChatReport = {
  mode: FallShort;
  chat: ChatKind;
  threadId: string | null;
  messageId: string;
  /** The last few turns, trimmed, for the report's own words */
  turns: ChatTurnLite[];
  /** The browser's copy of the whole chat (used when the chat isn't stored on the server) */
  entries: TranscriptEntry[];
  /** What surrounds the chat (a brief draft, a report, a launch card's state) */
  state: Record<string, unknown> | null;
  error: { text: string | null; code: string | null } | null;
  clientSlug: string | null;
  note: string;
  path: string;
  pageUrl: string;
};

const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** A report from the browser, clamped: known chat kinds only, a few short turns, short strings. Null when it's junk. */
export function sanitizeChatReport(raw: unknown): ChatReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "error" || r.mode === "cant" ? r.mode : null;
  const chat = KINDS.includes(r.chat as ChatKind) ? (r.chat as ChatKind) : null;
  const messageId = str(r.messageId, 120);
  if (!mode || !chat || !messageId) return null;
  const all = (Array.isArray(r.turns) ? (r.turns as { role: string; text: string }[]) : []).filter((t) => t && typeof t.text === "string");
  const turns = trimTurns(all);
  const entries: TranscriptEntry[] = ((Array.isArray(r.entries) ? r.entries : all) as Record<string, unknown>[])
    .slice(-2000)
    .filter((e) => e && typeof e.text === "string")
    .map((e) => ({
      role: e.role === "user" ? "user" : e.role === "tool" ? "tool" : "ai",
      at: str(e.at, 40) || null,
      text: str(e.text, 30_000),
      name: str(e.name, 120) || null,
      ok: typeof e.ok === "boolean" ? e.ok : null,
      error: e.error && typeof e.error === "object" ? { text: str((e.error as Record<string, unknown>).text, 2000) || null, code: str((e.error as Record<string, unknown>).code, 80) || null } : null,
    }));
  let state: Record<string, unknown> | null = null;
  if (r.state && typeof r.state === "object" && !Array.isArray(r.state)) {
    const json = JSON.stringify(r.state);
    state = json.length <= 60_000 ? (JSON.parse(json) as Record<string, unknown>) : { cut: `The state was ${json.length} characters`, head: json.slice(0, 60_000) };
  }
  const e = r.error && typeof r.error === "object" ? (r.error as Record<string, unknown>) : null;
  const error = e ? { text: str(e.text, 800) || null, code: str(e.code, 80) || null } : null;
  return {
    mode,
    chat,
    threadId: str(r.threadId, 120) || null,
    messageId,
    turns,
    entries,
    state,
    error: error && (error.text || error.code) ? error : null,
    clientSlug: str(r.clientSlug, 120) || null,
    note: str(r.note, 2000).trim(),
    path: str(r.path, 500),
    pageUrl: str(r.pageUrl, 1000),
  };
}

/** The report in words, as it's saved and triaged: what happened, where, and what was asked. */
export function chatReportMessage(r: Pick<ChatReport, "mode" | "chat" | "turns" | "error" | "note">): string {
  const where = CHAT_LABEL[r.chat];
  const asked = [...r.turns].reverse().find((t) => t.role === "user")?.text ?? null;
  const said = [...r.turns].reverse().find((t) => t.role === "ai")?.text ?? null;
  const lines =
    r.mode === "error"
      ? [`Error in ${where}${r.error?.code ? ` (${r.error.code})` : ""}: ${r.error?.text ?? said ?? "it failed"}`, asked ? `They had asked: "${asked.slice(0, 400)}"` : ""]
      : [`Asked for in ${where}: "${(asked ?? "something").slice(0, 400)}"`, `The AI said it can't: "${(cantDoSentence(said) ?? said ?? "").slice(0, 300)}"`];
  return [...lines, r.note ? `Their note: ${r.note}` : ""].filter(Boolean).join("\n").slice(0, 5000);
}
