// Slack links that open the Slack app at the message on a phone (the owner, Nov 25 2026: a bare slack.com/archives link
// opened the app, which didn't know the workspace, and bounced to "Sign in to your workspace" in the browser). The
// workspace's own address (https://<workspace>.slack.com/archives/C…/p…) is what iOS and Android open straight in the
// app, and desktop opens in the app or on the web as the person prefers. app.slack.com/client links force the browser,
// so they're turned into the same permalink. Pure and browser-safe: the server, the pages and the click fixer
// (src/components/slack-link-fix.tsx) all use it.

/** "https://kaizen.slack.com/" from whatever the workspace address was given as; null when it isn't one */
export function workspaceBase(url: string | null | undefined): string | null {
  const m = String(url ?? "").trim().match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\/?/i);
  return m && m[1].toLowerCase() !== "app" ? `https://${m[1].toLowerCase()}.slack.com/` : null;
}

/** Whether a link is a Slack one this helper rewrites (a bare slack.com/archives link or an app.slack.com/client one) */
export const isBareSlackLink = (href: string | null | undefined) => /^https:\/\/(slack\.com\/archives\/|app\.slack\.com\/client\/)/i.test(String(href ?? ""));

/** A Slack link with the workspace's own address, opening the message (and its thread) in the app; anything else as it is */
export function slackLink<T extends string | null | undefined>(href: T, base: string | null | undefined): T {
  const ws = workspaceBase(base);
  if (!href || !ws) return href;
  if (/^https:\/\/slack\.com\/archives\//i.test(href)) return href.replace(/^https:\/\/slack\.com\//i, ws) as T;
  // app.slack.com/client/T…/C… (a channel) or …/C…/thread/C…-1700000000.123456 (a thread)
  const app = href.match(/^https:\/\/app\.slack\.com\/client\/T[A-Z0-9]+\/([CDG][A-Z0-9]+)(?:\/thread\/[CDG][A-Z0-9]+-(\d+)\.(\d+))?/i);
  if (app) {
    const [, channel, sec, frac] = app;
    return (sec ? `${ws}archives/${channel}/p${sec}${frac}?thread_ts=${sec}.${frac}&cid=${channel}` : `${ws}archives/${channel}`) as T;
  }
  return href;
}

/** Every Slack link inside a piece of text (an assistant's answer, a note), rewritten */
export const slackLinksIn = (text: string, base: string | null | undefined) =>
  workspaceBase(base) ? text.replace(/https:\/\/(?:slack\.com\/archives|app\.slack\.com\/client)\/[^\s)>\]"']+/gi, (m) => slackLink(m, base)) : text;
