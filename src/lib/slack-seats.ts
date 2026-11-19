import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slack, slackConfigured } from "@/lib/context/slack";
import { LIVE } from "@/lib/live";
import { byChannel, leavesExternal, planSlackSeats, type ClientSeats, type Members, type Problem } from "@/lib/slack-seats-core";

// Slack access follows the seat (src/lib/slack-seats-core.ts): everyone assigned to a live client is in its internal and
// external channels. The audit checks every client (daily, and by hand), invites who's missing through the Kaizen OS
// bot (it must be in the channel, with channels:write.invites and groups:write.invites), and saves its report. Every
// seat change does the same for the person who took the seat, and takes the person who left out of the client's
// external channel when they hold no other seat there. Invites happen only while app_settings.slack_seat_sync.invite is
// on; until then the audit only reports.

type Setting = { invite: boolean; removeFromExternal: boolean };

async function setting(admin: SupabaseClient): Promise<Setting> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "slack_seat_sync").maybeSingle();
  const v = (data?.value ?? {}) as Partial<Setting>;
  return { invite: v.invite === true, removeFromExternal: v.removeFromExternal !== false };
}

/** A person's Slack user: saved on their profile, else found by work email (and saved) */
async function slackIdOf(admin: SupabaseClient, p: { id: string; email: string | null; slack_user_id: string | null }): Promise<string | null> {
  if (p.slack_user_id) return p.slack_user_id;
  if (!p.email) return null;
  const { findSlackUser } = await import("@/lib/profile-slack");
  const found = await findSlackUser(p.email).catch(() => null);
  if (found?.id) await admin.from("profiles").update({ slack_user_id: found.id }).eq("id", p.id);
  return found?.id ?? null;
}

async function membersOf(channel: string): Promise<Members> {
  const ids = new Set<string>();
  let cursor = "";
  try {
    do {
      const page = await slack<{ members: string[]; response_metadata?: { next_cursor?: string } }>("conversations.members", { channel, limit: "1000", ...(cursor ? { cursor } : {}) });
      for (const m of page.members) ids.add(m);
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return { ok: true, ids };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, why: /not_in_channel|channel_not_found/.test(m) ? "The Kaizen OS bot isn't in this channel (private: someone in it adds the app), so it can't see or invite members" : m.replace(/^Slack /, "") };
  }
}

const why = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/missing_scope/.test(m)) return "The Slack app needs the channels:write.invites and groups:write.invites scopes (add them, reinstall the app)";
  if (/not_in_channel/.test(m)) return "The Kaizen OS bot isn't in this channel";
  if (/cant_invite|user_is_restricted|ura_max_channels/.test(m)) return "Slack won't invite this person here (a guest or a restricted account)";
  if (/is_archived/.test(m)) return "The channel is archived";
  return m.replace(/^Slack /, "");
};

export type AuditReport = {
  at: string;
  invited: boolean;
  clients: number;
  channels: number;
  alreadyIn: number;
  /** Added, or (a report-only run) who would be */
  added: { client: string; channel: "internal" | "external"; people: string[] }[];
  failed: { client: string; channel: "internal" | "external"; people: string[]; why: string }[];
  problems: Problem[];
};

/** Checks every live client's channels against its seats; invites who's missing when invites are on (or forced) */
export async function syncSlackSeats(admin: SupabaseClient, opts: { invite?: boolean } = {}): Promise<AuditReport> {
  if (!slackConfigured()) throw new Error("SLACK_BOT_TOKEN is missing");
  const s = await setting(admin);
  const invite = opts.invite ?? s.invite;
  const [{ data: clients }, { data: seats }, { data: people }] = await Promise.all([
    admin.from("clients").select("id, name, status, archived_at, slack_channel_id, internal_slack_channel_id").is("archived_at", null).in("status", LIVE),
    admin.from("client_assignments").select("client_id, profile_id"),
    admin.from("profiles").select("id, full_name, email, slack_user_id, is_active").eq("is_active", true),
  ]);
  const active = new Map((people ?? []).map((p) => [p.id as string, p]));
  const slackIds = new Map<string, string | null>();
  for (const id of new Set((seats ?? []).map((x) => x.profile_id as string))) {
    const p = active.get(id);
    if (p) slackIds.set(id, await slackIdOf(admin, { id, email: (p.email as string | null) ?? null, slack_user_id: (p.slack_user_id as string | null) ?? null }));
  }
  const list: ClientSeats[] = (clients ?? []).map((c) => ({
    clientId: c.id as string,
    client: c.name as string,
    internal: (c.internal_slack_channel_id as string | null) ?? null,
    external: (c.slack_channel_id as string | null) ?? null,
    people: [...new Set((seats ?? []).filter((x) => x.client_id === c.id).map((x) => x.profile_id as string))]
      .filter((id) => active.has(id))
      .map((id) => ({ profileId: id, name: active.get(id)!.full_name as string, slackId: slackIds.get(id) ?? null })),
  }));
  const channels = [...new Set(list.filter((c) => c.people.length).flatMap((c) => [c.internal, c.external]).filter((x): x is string => Boolean(x)))];
  const members = new Map<string, Members>();
  for (const ch of channels) members.set(ch, await membersOf(ch));
  const plan = planSlackSeats(list, members);
  const added: AuditReport["added"] = [];
  const failed: AuditReport["failed"] = [];
  for (const g of byChannel(plan.invites)) {
    const first = g.invites[0];
    const row = { client: first.client, channel: first.kind, people: g.invites.map((i) => i.name) };
    if (!invite) {
      added.push(row);
      continue;
    }
    try {
      await slack("conversations.invite", { channel: g.channel, users: g.invites.map((i) => i.slackId).join(",") });
      added.push(row);
    } catch (e) {
      // One refused person fails the whole call: try each on their own so the rest still get in
      for (const i of g.invites) {
        try {
          await slack("conversations.invite", { channel: g.channel, users: i.slackId });
          added.push({ ...row, people: [i.name] });
        } catch (e2) {
          if (/already_in_channel/.test(String(e2))) continue;
          failed.push({ ...row, people: [i.name], why: why(e2 ?? e) });
        }
      }
    }
  }
  const report: AuditReport = { at: new Date().toISOString(), invited: invite, clients: list.filter((c) => c.people.length).length, channels: channels.length, alreadyIn: plan.inPlace, added: merge(added), failed, problems: plan.problems };
  await admin.from("slack_seat_audits").insert({ invited: invite, report });
  return report;
}

/** One line per client and channel */
function merge(rows: AuditReport["added"]) {
  const m = new Map<string, AuditReport["added"][number]>();
  for (const r of rows) {
    const k = `${r.client}|${r.channel}`;
    const cur = m.get(k);
    m.set(k, cur ? { ...cur, people: [...cur.people, ...r.people] } : r);
  }
  return [...m.values()];
}

export type SeatSlack = { internal?: string; external?: string; leftExternal?: string } | null;

/**
 * A seat changed hands on a client: the new person joins its internal and external channels; the person who left
 * leaves the external one when they hold no other seat there (and aren't an exec or a line head). Off (nothing done,
 * null) while invites are off or Slack isn't connected.
 */
export async function seatSlackChange(admin: SupabaseClient, clientId: string, toId: string | null, fromId: string | null): Promise<SeatSlack> {
  if (!slackConfigured()) return null;
  const s = await setting(admin);
  if (!s.invite) return null;
  const { data: c } = await admin.from("clients").select("slack_channel_id, internal_slack_channel_id").eq("id", clientId).maybeSingle();
  if (!c) return null;
  const out: NonNullable<SeatSlack> = {};
  if (toId) {
    const { data: p } = await admin.from("profiles").select("id, email, slack_user_id").eq("id", toId).maybeSingle();
    const sid = p ? await slackIdOf(admin, { id: p.id as string, email: (p.email as string | null) ?? null, slack_user_id: (p.slack_user_id as string | null) ?? null }) : null;
    for (const [kind, ch] of [["internal", c.internal_slack_channel_id], ["external", c.slack_channel_id]] as const) {
      if (!ch) out[kind] = "no channel linked";
      else if (!sid) out[kind] = "no Slack user found";
      else
        try {
          await slack("conversations.invite", { channel: ch as string, users: sid });
          out[kind] = "added";
        } catch (e) {
          out[kind] = /already_in_channel/.test(String(e)) ? "already in" : why(e);
        }
    }
  }
  if (fromId && fromId !== toId && s.removeFromExternal && c.slack_channel_id) {
    const [{ data: still }, { data: p }] = await Promise.all([
      admin.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", fromId),
      admin.from("profiles").select("id, email, slack_user_id, is_exec, is_lead, role").eq("id", fromId).maybeSingle(),
    ]);
    const leader = Boolean(p?.is_exec || p?.is_lead || String(p?.role ?? "").startsWith("head_of_"));
    if (p && leavesExternal((still ?? []).length, leader)) {
      const sid = await slackIdOf(admin, { id: p.id as string, email: (p.email as string | null) ?? null, slack_user_id: (p.slack_user_id as string | null) ?? null });
      if (sid)
        try {
          await slack("conversations.kick", { channel: c.slack_channel_id as string, user: sid });
          out.leftExternal = "removed from the client's channel";
        } catch (e) {
          out.leftExternal = /not_in_channel/.test(String(e)) ? "wasn't in it" : why(e);
        }
    }
  }
  return out;
}
