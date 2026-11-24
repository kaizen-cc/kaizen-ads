// Everyone in Kaizen OS connects their own Slack and Asana (owner, Nov 24 2026): their assistant reads and posts as
// them, and Asana changes go in as them (src/lib/asana-user.ts). Until both are connected: a critical item on their
// Overview with one-tap Connect, their assistant raises it first every day, the first run asks before anything else
// (only "Remind me tomorrow" skips it), and the executives see who's missing what in Settings › Team. A sign-in to the
// wrong account (not their Kaizen email, not Kaizen's workspace) doesn't count, with Switch. Pure: tested.

import { slackState } from "./personal-connections-core";
import { slackConnectHref } from "./slack-account-core";

export type Need = "slack" | "asana";
export type GapState = "ok" | "missing" | "reconnect" | "wrong";
export type Gaps = Record<Need, GapState>;
export const NEEDS: readonly Need[] = ["slack", "asana"];
export const LABEL: Record<Need, string> = { slack: "Slack", asana: "Asana" };

/** Why each one matters, in one line */
export const WHY: Record<Need, string> = {
  slack: "so your assistant can read your channels and DMs, catch replies you owe and post as you",
  asana: "so your tasks show up here and every change you make goes into Asana as you",
};

type SlackRow = { scopes: string | null; team_id: string | null } | null;
type AsanaRow = { confirmed: boolean | null; expires_at: string | null; refresh_token: string | null; workspaces: unknown } | null;

/** Their Slack: connected for reading in Kaizen's workspace, else what's wrong */
export function slackGap(row: SlackRow, kaizenTeam: string | null): GapState {
  if (!row) return "missing";
  if (kaizenTeam && row.team_id && row.team_id !== kaizenTeam) return "wrong";
  // The one list of what Slack must allow (src/lib/personal-connections-core.ts): a scope added there makes everyone
  // missing it "Reconnect" on its own, never announced by hand
  return slackState(row).state === "connected" ? "ok" : "reconnect";
}

/** Their Asana: their own, in Kaizen's workspace and still valid, else what's wrong */
export function asanaGap(row: AsanaRow, kaizenWorkspace: string | null, now = Date.now()): GapState {
  if (!row) return "missing";
  if (row.confirmed === false) return "wrong";
  const spaces = (Array.isArray(row.workspaces) ? row.workspaces : []) as { gid?: string }[];
  if (kaizenWorkspace && spaces.length && !spaces.some((w) => w.gid === kaizenWorkspace)) return "wrong";
  if (row.expires_at && Date.parse(row.expires_at) < now && !row.refresh_token) return "reconnect";
  return "ok";
}

export const missingOf = (g: Gaps): Need[] => NEEDS.filter((n) => g[n] !== "ok");

/** Where one tap goes: Connect, Reconnect, or Switch account (signed in as the wrong one; Asana's switch is a POST) */
export function connectHref(n: Need, state: GapState, next: string): { href: string; post: boolean } {
  if (n === "slack") return { href: slackConnectHref(next), post: false };
  return state === "wrong" ? { href: `/api/asana/disconnect?switch=1&next=${encodeURIComponent(next)}`, post: true } : { href: `/api/asana/connect?next=${encodeURIComponent(next)}`, post: false };
}

export const buttonLabel = (n: Need, state: GapState) => `${state === "wrong" ? "Switch" : state === "reconnect" ? "Reconnect" : "Connect"} ${LABEL[n]}`;

/** What's wrong with one, in a few words */
export const stateText = (state: GapState) => (state === "missing" ? "not connected" : state === "reconnect" ? "needs reconnecting" : state === "wrong" ? "signed in to the wrong account" : "connected");

/** "Connect your Slack and Asana so Kaizen OS can work for you" */
export function itemTitle(missing: readonly Need[]): string {
  return `Connect your ${missing.map((n) => LABEL[n]).join(" and ")} so Kaizen OS can work for you`;
}

/** The assistant's line, said first every day until it's done */
export function helloLine(g: Gaps): string | null {
  const m = missingOf(g);
  if (!m.length) return null;
  const parts = m.map((n) => `${LABEL[n]} (${stateText(g[n])})`);
  return `Before anything else: I still need your ${parts.join(" and ")}, ${m.length === 1 ? WHY[m[0]] : "so I can read and post as you and your Asana changes go in as you"}. Want me to bring up Connect now?`;
}

/** The cookie "Remind me tomorrow" sets (the day it was pressed) */
export const SNOOZE_COOKIE = "kz_connect_snooze";

/** The day "Remind me tomorrow" was pressed counts until the next day (New York time) */
export const snoozedToday = (snooze: string | null | undefined, today: string) => Boolean(snooze && snooze >= today);
