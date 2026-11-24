// Asana writes made for a person go out as that person (their own Asana, src/lib/asana-user.ts). When they haven't
// connected it, the write is refused with this, and the screen shows a Connect button instead of quietly using
// Kaizen's shared connection. Writes nobody asked for (a cron, a form from outside) use the shared connection and say
// "Posted by Kaizen OS" in what they post. Pure: safe for the browser.

export const ASANA_CONNECT_SAY = "Connect your Asana first, so this goes in as you (not as someone else).";
export const KAIZEN_OS_STAMP = "Posted by Kaizen OS";

/** Where Connect sends them, back to `next` afterwards */
export const asanaConnectHref = (next: string) => `/api/asana/connect?next=${encodeURIComponent(next.startsWith("/") ? next : "/pipeline")}`;

/** Thrown by an Asana write inside a person's context when they haven't connected their own Asana */
export class AsanaConnectNeeded extends Error {
  readonly connectAsana = true;
  constructor() {
    super(ASANA_CONNECT_SAY);
    this.name = "AsanaConnectNeeded";
  }
}

export const isAsanaConnectNeeded = (e: unknown): e is AsanaConnectNeeded => Boolean(e && typeof e === "object" && (e as { connectAsana?: unknown }).connectAsana === true);

/** A comment posted with the shared connection says so ("Posted by Kaizen OS"), in plain text or Asana's rich text */
export function stampSystemStory(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.html_text === "string") {
    if (data.html_text.includes(KAIZEN_OS_STAMP)) return data;
    return { ...data, html_text: data.html_text.replace(/<\/body>\s*$/, `\n<em>${KAIZEN_OS_STAMP}</em></body>`) };
  }
  if (typeof data.text === "string") return data.text.includes(KAIZEN_OS_STAMP) ? data : { ...data, text: `${data.text.trimEnd()}\n\n${KAIZEN_OS_STAMP}` };
  return data;
}

/** Whether an Asana path posts a comment (a story on a task) */
export const isStoryPath = (path: string) => /^\/tasks\/[^/]+\/stories(?:\?|$)/.test(path);
