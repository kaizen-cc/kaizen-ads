// Who may change a client's Team & setup (the owner, Nov 19 2026: "only execs and team leads can adjust the team and
// setup for the internal client page"): seats and the team, services and tiers, packages and allotments, the portal
// and the client's notifications, connections (email provider keys, ad accounts, social pages, stores, the Drive
// folder), contacts, the client's details and status, archiving. Everyone else sees it read only. Pure, so the server
// actions, the assistant's and Kaizen AI's tools and the tests share it. (Some of these stay narrower: billing and
// creative packages are the executives' alone.)

export type SetupWho = { role: string | null | undefined; isExec?: boolean | null; isLead?: boolean | null };

export const SETUP_REFUSAL = "Only executives and team leads change a client's team and setup. You can still see it.";

/** Executives, the leaders (Meta, Google, Creative) and the heads of the email and organic social teams */
export const mayEditSetup = (me: SetupWho) => Boolean(me.isExec || me.isLead) || String(me.role ?? "").startsWith("head_of_");

/** The same, as a verdict with the sentence to show */
export const setupVerdict = (me: SetupWho): { ok: true } | { ok: false; error: string } => (mayEditSetup(me) ? { ok: true } : { ok: false, error: SETUP_REFUSAL });
