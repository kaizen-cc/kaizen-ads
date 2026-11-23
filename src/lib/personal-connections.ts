import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallEvent } from "@/lib/agent-call/core";
import { connectCard, needsConnection, slackState, SLACK_READ_NEEDS, type ConnState, type NeedsConnection, type Service } from "./personal-connections-core";

// A person's own work accounts, checked as them: their Slack token (auth.test with their own token, on their own
// request), and Gmail, Drive and Calendar through Kaizen's Google Workspace access (a token for their own mailbox per
// scope; a refusal is the admin's setting, never theirs), and Asana through Kaizen's account. Shared by Settings ›
// Connections › Yours, the assistant's tools (a needs_connection answer plus a Connect card in the conversation) and
// the hello (a broken connection mentioned once).

export type ConnRow = { service: Service; state: ConnState; detail: string; missing?: string[]; scopes?: { scope: string; ok: boolean }[] };

const GOOGLE: Record<"gmail" | "drive" | "calendar", { scope: string; label: string }[]> = {
  gmail: [
    { scope: "https://www.googleapis.com/auth/gmail.readonly", label: "read" },
    { scope: "https://www.googleapis.com/auth/gmail.compose", label: "drafts" },
    { scope: "https://www.googleapis.com/auth/gmail.send", label: "send" },
  ],
  drive: [{ scope: "https://www.googleapis.com/auth/drive.readonly", label: "read" }],
  calendar: [
    { scope: "https://www.googleapis.com/auth/calendar.readonly", label: "read" },
    { scope: "https://www.googleapis.com/auth/calendar.freebusy", label: "free/busy" },
    { scope: "https://www.googleapis.com/auth/calendar.events", label: "booking" },
  ],
};

/** Whether Google gives a token for this mailbox and scope (kept ten minutes per server: the answer is company-wide) */
const minted = new Map<string, { at: number; ok: Promise<boolean> }>();
async function googleAllows(email: string, scope: string): Promise<boolean> {
  const key = `${email}|${scope}`;
  const hit = minted.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.ok;
  const ok = (async () => {
    const { googleConfigured, googleTokenFor } = await import("@/lib/context/google");
    if (!googleConfigured()) return false;
    return googleTokenFor(email, scope).then(
      () => true,
      () => false,
    );
  })();
  minted.set(key, { at: Date.now(), ok });
  return ok;
}

/** Their Slack, from what's stored, and (live) what Slack's auth.test says about their own token */
export async function slackConnection(profileId: string, live = false): Promise<ConnRow> {
  const { slackUserToken, slackRead } = await import("@/lib/slack-user");
  const t = await slackUserToken(profileId);
  let authError: string | null = null;
  if (t && live) {
    const r = await slackRead<{ ok: boolean; error?: string }>(t.token, "auth.test", {}).catch(() => ({ ok: true }) as { ok: boolean; error?: string });
    authError = r.ok ? null : (r.error ?? "unknown");
  }
  const s = slackState(t ? { scopes: t.scopes.join(",") } : null, authError);
  const detail =
    s.state === "connected"
      ? "Connected as you: posting, searching and reading your channels and DMs"
      : s.state === "missing_scope"
        ? "Connected for posting only: your assistant can't search or read your Slack until you reconnect"
        : s.state === "reconnect"
          ? "The connection stopped working (Slack says the sign-in expired or was revoked)"
          : "Not connected: your assistant can't post, search or read your Slack";
  return { service: "slack", state: s.state, detail, missing: s.missing };
}

/** Every one of their work accounts, for Settings */
export async function myWorkConnections(me: { id: string; email: string }): Promise<ConnRow[]> {
  const { googleConfigured } = await import("@/lib/context/google");
  const { asanaConfigured } = await import("@/lib/asana");
  const google = async (service: "gmail" | "drive" | "calendar"): Promise<ConnRow> => {
    if (!googleConfigured()) return { service, state: "off", detail: "Kaizen's Google Workspace isn't connected to Kaizen OS yet" };
    const scopes = await Promise.all(GOOGLE[service].map(async (g) => ({ scope: g.label, ok: await googleAllows(me.email, g.scope) })));
    const off = scopes.filter((s) => !s.ok);
    return {
      service,
      state: off.length === scopes.length ? "admin" : "connected",
      detail: off.length ? `Through Kaizen's Google Workspace, nothing to connect. ${off.map((s) => s.scope).join(", ")} not switched on yet (an admin setting)` : "Through Kaizen's Google Workspace, nothing to connect",
      scopes,
    };
  };
  const [slack, gmail, drive, calendar] = await Promise.all([slackConnection(me.id, true), google("gmail"), google("drive"), google("calendar")]);
  const asana = await asanaRow(me.id, asanaConfigured());
  return [slack, gmail, drive, calendar, asana];
}

/** Their own Asana (OAuth, asana_user_tokens): connected as whom; else connect it (Kaizen's shared account meanwhile) */
async function asanaRow(profileId: string, shared: boolean): Promise<ConnRow> {
  const [{ asanaConnection }, { createAdminClient }] = await Promise.all([import("@/lib/asana-user"), import("@/lib/supabase/admin")]);
  const a = await asanaConnection(createAdminClient(), profileId).catch(() => null);
  if (a?.connected) return { service: "asana", state: "connected", detail: `Connected as you${a.name ? ` (${a.name})` : ""}: your My tasks, private ones too` };
  if (a?.configured) return { service: "asana", state: "missing", detail: shared ? "Not connected: your assistant sees only what Kaizen's shared Asana account can (not your private My tasks)" : "Not connected: your assistant can't see your Asana tasks" };
  return shared ? { service: "asana", state: "connected", detail: "Through Kaizen's shared Asana account" } : { service: "asana", state: "off", detail: "Kaizen's Asana isn't connected to Kaizen OS yet (an admin setting)" };
}

/** Their Slack token when it can do this (read: search and history; post: chat:write); else the needs_connection answer */
export async function slackTokenFor(profileId: string, need: "read" | "post"): Promise<{ token: string } | NeedsConnection> {
  const { slackUserToken } = await import("@/lib/slack-user");
  const t = await slackUserToken(profileId);
  if (!t) return needsConnection("slack", "missing");
  const lacking = (need === "read" ? [...SLACK_READ_NEEDS] : ["chat:write"]).filter((s) => !t.scopes.includes(s));
  if (lacking.length) return needsConnection("slack", "missing_scope", { missing: lacking, what: need === "read" ? "search or read your Slack" : "post on Slack as you" });
  return { token: t.token };
}

/** A Slack error from a call with their token, as needs_connection when it's the connection (else null) */
export function slackErrorNeeds(error: string | undefined): NeedsConnection | null {
  if (!error) return null;
  if (error === "missing_scope") return needsConnection("slack", "missing_scope");
  if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"].includes(error)) return needsConnection("slack", "reconnect");
  return null;
}

/** A Google refusal of a scope as needs_connection for the admin (the executives hear once) */
export function googleNeeds(service: "gmail" | "drive" | "calendar", scope: string, what?: string): NeedsConnection {
  return needsConnection(service, "admin", { what, forAdmin: `Add ${scope} to the service account's domain-wide delegation (Google Admin console > Security > API controls > Domain-wide delegation).` });
}

/** The fix on screen: the Connect / Reconnect card in the call or the chat (the voice says it once, from `say`) */
export function showConnect(emit: ((e: CallEvent) => void) | undefined, n: NeedsConnection) {
  const card = connectCard(n);
  if (card && emit) emit({ t: "card", card });
}

/** Slack refused the reading scopes at sign-in (the Slack app doesn't list them yet): the executives hear once */
export async function tellExecsSlackReadScopes(admin: SupabaseClient) {
  const { data } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({
      profile_id: id,
      kind: "setup",
      title: "Slack reading needs one setting in the Slack app",
      body: `People can't let their assistant read their Slack yet: Slack refused the reading permissions. In api.slack.com/apps > Kaizen OS > OAuth & Permissions > User Token Scopes, add ${SLACK_READ_NEEDS.join(", ")}, then everyone reconnects from Settings > Connections > Yours.`,
      href: "/settings?tab=connections&section=yours",
      key: "slack:read-scopes-refused",
      priority: "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}
