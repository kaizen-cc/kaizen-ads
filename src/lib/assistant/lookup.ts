import { findGoogleLinks } from "@/lib/google-links";

// Where the assistant looks when someone asks for context ("get me up to speed on Kore Outdoor", "what did we say about
// the reminder emails", "find my Kaizen AI thread"): every place it can read, in the order most likely to have it, so it
// goes and looks instead of asking "which one, Looms or Kaizen AI?". Pure: no keys, no network, so the tests hold it.

export type LookupSource = "client" | "kaizen_ai" | "slack" | "email" | "google_file" | "uploads";

/** Each source and the tool that searches it */
export const LOOKUP_TOOLS: Record<LookupSource, string> = {
  client: "search_client",
  kaizen_ai: "search_my_kaizen_ai",
  slack: "search_my_slack",
  email: "search_my_email",
  google_file: "read_google_file",
  uploads: "read_upload",
};

const ASKS_CONTEXT =
  /\b(context (on|for|about)|get (me )?context|up to speed|catch me up|background on|history (of|with|on)|what do (we|you) know|what did (we|they|i|he|she|the client) (say|decide|agree|send|ask)|find (the|that|my) (thread|doc|email|message|dm|loom|chat|conversation|project)|look (it|that) up|dig up|where (is|was) (the|that) (thread|doc|email|message|conversation)|said about|talked about)\b/i;

/**
 * The places to look for what they asked, most likely first. Named places come first (a Kaizen AI thread or Claude
 * project, Slack or a DM, email, a Loom, a Google link); the rest follow, so nothing is left unchecked. Empty when the
 * message isn't asking for context.
 */
export function lookupOrder(text: string): LookupSource[] {
  const t = text.toLowerCase();
  const first: LookupSource[] = [];
  if (findGoogleLinks(text).length) first.push("google_file");
  if (/kaizen ?ai|claude|imported|my (chat|thread)s?\b|\bproject\b/.test(t)) first.push("kaizen_ai");
  if (/slack|\bdms?\b|direct message|channel/.test(t)) first.push("slack");
  if (/e-?mail|inbox|gmail/.test(t) && !/email (flow|campaign|strateg|board|ticket|report)/.test(t)) first.push("email");
  if (/loom|call notes|recording|fireflies|gemini notes/.test(t)) first.push("client");
  if (/upload|attached|the pdf|the file i/.test(t)) first.push("uploads");
  const asks = ASKS_CONTEXT.test(text) || (first.length > 0 && /\b(find|search|look (for|in|through|at)|read|check|pull up|go through|what('s| is| was) in)\b/i.test(text));
  if (!asks) return first.includes("google_file") ? ["google_file"] : [];
  const all: LookupSource[] = ["client", "kaizen_ai", "slack", "email"];
  return [...new Set([...first, ...all])];
}

/** The hint for a turn that asks for context: look everywhere now, in this order, then sum up and offer to save */
export function lookupHint(text: string): string {
  const order = lookupOrder(text);
  if (!order.length) return "";
  const tools = order.map((s) => LOOKUP_TOOLS[s]);
  return `<hint>They want context. Don't ask where to look or which source they mean: look now, in this order, with every tool that fits (${tools.join(", ")}; get_client_context too when a client is named). Read the best matches (read_my_kaizen_ai_thread, read_my_slack_thread, read_my_email_thread, read_upload). Then sum up what you found, naming where each piece came from, say plainly where you looked and found nothing, and offer to save a dated summary to the client's notes (save_client_note, only on their yes).</hint>`;
}

/** A Google link in what they said: open it as them, don't ask them to paste it */
export function googleLinksHint(text: string): string {
  const links = findGoogleLinks(text);
  if (!links.length) return "";
  return `<hint>They shared ${links.length === 1 ? "a Google file link" : `${links.length} Google file links`} (${links.map((l) => l.kind).join(", ")}). Open ${links.length === 1 ? "it" : "each"} now with read_google_file (it reads as them, with their own Drive access) before answering; never ask them to paste its contents.</hint>`;
}
