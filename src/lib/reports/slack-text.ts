// How a report's Slack message opens and how its mentions read. Plain functions (no server code), shared by the writer,
// the senders, the studio's Slack preview and the tests.
//
// A report goes to the client's channel and is addressed to everyone there: it opens with @here (Slack's <!here>), never
// with a person's mention. A person's mention is a raw "<@U085HHFG535>" that shows as that code in a preview, and may not
// resolve for a client in a shared channel; and the buyers' own recaps the writer learns the voice from open with one.

/** Slack's @here, as the message text carries it */
export const HERE = "<!here>";

// A person's mention (<@U123ABC> or <@U123ABC|name>) and the broadcast words Slack writes as <!here>, <!channel>, <!everyone>
const PERSON = /<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g;
const BROADCAST = /<!(?:here|channel|everyone)(?:\|[^>]*)?>/g;

/**
 * The message as it is posted: it opens with @here, whoever it opened with before. A person's mention (or @channel,
 * @everyone) at the start becomes @here; one further in is taken out (no person is tagged in a client's channel), the
 * sentence tidied; a message that opened with neither gets @here in front. Safe to run again.
 */
export function openWithHere(text: string | null | undefined): string {
  let t = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return t;
  // The opening: any run of mentions (and the comma, colon or dash after it) is one @here
  const lead = new RegExp(`^(?:(?:${PERSON.source}|${BROADCAST.source})[\\s,:;\\-–]*)+`);
  t = lead.test(t) ? t.replace(lead, "") : t;
  // The rest: no person is tagged, and a second @here is noise
  const rest = t.replace(PERSON, "").replace(BROADCAST, "");
  if (rest !== t)
    t = rest
      .replace(/[ \t]+([,.;:!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return t ? `${HERE} ${t}` : HERE;
}

/** Examples of how a buyer writes (their own past recaps) with the mentions taken out, so the writer never copies one */
export const withoutMentions = (text: string | null | undefined) =>
  String(text ?? "")
    .split("\n")
    .map((line) => {
      const clean = line.replace(PERSON, "").replace(BROADCAST, "");
      // Only a line that had a mention is tidied (bullets and indents elsewhere stay as they were)
      return clean === line ? line : clean.replace(/^[ \t]*[,:;][ \t]*/, "").replace(/[ \t]{2,}/g, " ").trim();
    })
    .join("\n");

/** What the studio's Slack preview shows for a mention: "@here", "@channel", or "@someone" for a person */
export function mentionLabel(token: string): string {
  const here = /^<!(here|channel|everyone)/.exec(token);
  if (here) return `@${here[1]}`;
  const named = /^<@[UW][A-Z0-9]+\|([^>]+)>$/.exec(token);
  return named ? `@${named[1]}` : "@someone";
}

/** The mention tokens in a line of Slack text, for the preview to draw as chips (global; use with matchAll) */
export const MENTION = /<!(?:here|channel|everyone)(?:\|[^>]*)?>|<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g;
