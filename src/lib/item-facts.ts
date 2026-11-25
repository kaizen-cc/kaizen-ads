// What an item's sheet shows beyond its words (owner, Nov 25 2026: the sheets of routine-made items were empty), kept
// on agent_asks.facts: where it came from (links to the Slack message, the Asana task, the Gmail thread, the call, the
// Drive file), the hand-off it stands for, the evidence that it's probably done, and the choices for the agent's
// question. A drafted message and the agent's question stay on agent_asks.draft (src/lib/routine-agent.ts ItemDraft);
// an answer goes in as a comment on the item (item_comments key ask:<id>), which the nightly agent reads. Pure.

export type ItemLink = { label: string; url: string };
export type ItemFacts = {
  links?: ItemLink[];
  handoff?: { toId: string | null; toName: string; scope: string; done: string; detail: string } | null;
  evidence?: { state: "done" | "moving"; quote: string | null; source: string | null; url: string | null; at: string | null } | null;
  options?: string[] | null;
};

/** A label for a link by where it goes */
export function linkLabel(url: string): string {
  if (/slack\.com\/archives\//i.test(url)) return /thread_ts=/.test(url) ? "Slack thread" : "Slack message";
  if (/app\.asana\.com/i.test(url)) return "Asana task";
  if (/mail\.google\.com/i.test(url)) return "Gmail thread";
  if (/docs\.google\.com\/(document|presentation|spreadsheets)/i.test(url)) return "Google Doc";
  if (/drive\.google\.com/i.test(url)) return "Drive file";
  if (/fireflies\.ai|meet\.google\.com|gemini/i.test(url)) return "Call notes";
  if (/portal\.kaizenmarketing\.agency\/r\//i.test(url)) return "Report";
  return "Link";
}

/** Every link in some text, labeled, once each (trailing punctuation and Slack's <url|text> markup off) */
export function linksIn(text: string | null | undefined, max = 6): ItemLink[] {
  const seen = new Set<string>();
  const out: ItemLink[] = [];
  for (const m of String(text ?? "").matchAll(/https?:\/\/[^\s<>"|)]+/g)) {
    const url = m[0].replace(/[.,;:!?'\]]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ label: linkLabel(url), url });
    if (out.length >= max) break;
  }
  return out;
}

/** Facts with new links added (others kept), never more than eight */
export function withLinks(f: ItemFacts | null | undefined, more: readonly ItemLink[]): ItemFacts {
  const have = f?.links ?? [];
  const add = more.filter((l) => !have.some((h) => h.url === l.url));
  return { ...(f ?? {}), links: [...have, ...add].slice(0, 8) };
}
