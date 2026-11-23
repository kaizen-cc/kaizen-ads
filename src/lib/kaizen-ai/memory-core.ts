// Kaizen AI remembers across all of a person's chats (an email strategist, Nov 2026: "the AI doesn't carry history
// between my client chats"). Three kinds, each with its own reach:
//   - the person's own memory (how they like to work, what they told it to remember, their general lessons such as
//     "always put the offer first in subject lines"): every chat, every client;
//   - what they discussed and decided about a client in their other chats and calls: only that client's chats;
//   - nothing of anyone else's, ever, and nothing about another client (a call that covered two clients gives this
//     client's chat only the sentences about this client).
// Pure: the server reads the rows (src/lib/kaizen-ai/memory.ts).

export const MEMORY_PAGE = "/assistant?tab=memory";

export type PastThread = { title: string; at: string; gist: string };
export type PastCall = { at: string; summary: string };

/** The sentences of a text that are about this client (by name), so another client's details stay out */
export function sentencesAbout(text: string, client: string): string {
  const key = client.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (!key) return "";
  const words = key.split(/\s+/).filter((w) => w.length > 2);
  const about = (s: string) => {
    const t = s.toLowerCase();
    return t.includes(key) || (words.length > 1 && words.every((w) => t.includes(w)));
  };
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(about)
    .join(" ")
    .trim();
}

const day = (iso: string) => iso.slice(0, 10);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

/**
 * The block every Kaizen AI turn reads: their own memory, then (with a client pinned) that client's history from their
 * other chats and calls, newest first and short. Empty when there's nothing.
 */
export function memoryPrompt(o: { personal: string; client: string | null; threads: readonly PastThread[]; calls: readonly PastCall[] }): string {
  const parts: string[] = [];
  if (o.personal.trim()) parts.push(`<about_them note="their own memory, from all their chats and calls: apply it everywhere">\n${o.personal.trim()}\n</about_them>`);
  if (o.client) {
    const lines = [
      ...o.threads.slice(0, 8).map((t) => `- ${day(t.at)} chat "${cut(t.title, 80)}": ${cut(t.gist, 280)}`),
      ...o.calls
        .map((c) => ({ ...c, about: sentencesAbout(c.summary, o.client!) }))
        .filter((c) => c.about)
        .slice(0, 5)
        .map((c) => `- ${day(c.at)} call: ${cut(c.about, 280)}`),
    ];
    if (lines.length) parts.push(`<their_history_with_${o.client.replace(/[^A-Za-z0-9]+/g, "_")} note="what they discussed and decided about this client in their other chats and calls, newest first; read one whole with read_my_kaizen_ai when it matters">\n${lines.join("\n")}\n</their_history_with_${o.client.replace(/[^A-Za-z0-9]+/g, "_")}>`);
  }
  if (!parts.length) return "";
  return [
    "Memory is on across all their chats: use what follows without being asked, and never say you can't remember other chats. When something from another chat might help (a decision, a number, a draft), search_my_kaizen_ai first. When they tell you how they like to work, or a lesson for every client (\"always lead subject lines with the offer\"), save it with remember. Never bring a detail about one client into another client's chat.",
    ...parts,
  ].join("\n\n");
}
