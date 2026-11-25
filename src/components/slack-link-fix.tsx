"use client";

import { useEffect } from "react";
import { isBareSlackLink, slackLink } from "@/lib/slack-link";

// Every Slack link anywhere in the app (Overview items, sheets, recaps, owed replies, promises, the bell, assistant
// answers) opens the Slack app at the message: a bare slack.com/archives link (or an app.slack.com/client one) is
// given the workspace's own address the moment it's tapped, and in window.open too. One fixer for the whole app, so a
// component that renders a stored link never has to remember to. Links already saved are rewritten in the database
// as well (rewrite_slack_links); this catches whatever is left.

export function SlackLinkFix({ base }: { base: string | null }) {
  useEffect(() => {
    if (!base) return;
    const fix = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (a && isBareSlackLink(a.href)) a.href = slackLink(a.href, base);
    };
    // Before the browser follows it: taps, clicks, middle clicks, and the keyboard
    document.addEventListener("click", fix, true);
    document.addEventListener("auxclick", fix, true);
    document.addEventListener("pointerdown", fix, true);
    document.addEventListener("keydown", fix, true);
    const open = window.open.bind(window);
    window.open = (url?: string | URL, target?: string, features?: string) => open(typeof url === "string" && isBareSlackLink(url) ? slackLink(url, base) : url, target, features);
    return () => {
      document.removeEventListener("click", fix, true);
      document.removeEventListener("auxclick", fix, true);
      document.removeEventListener("pointerdown", fix, true);
      document.removeEventListener("keydown", fix, true);
      window.open = open;
    };
  }, [base]);
  return null;
}
