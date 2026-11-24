import "server-only";
import { isPeopleMatter } from "@/lib/people-matters";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCursor, setCursor, trimBody } from "@/lib/context/shared";
import { dmOwed, isDmKey, type DmMessage } from "./owed-dms-core";

// Direct messages and group DMs waiting on a reply (owner, Nov 23 2026): read with each person's own Slack token (only
// people who let their assistant read their Slack: im:history, mpim:history, and im:read / mpim:read to list them),
// at most hourly per person. An incoming DM from a teammate or a client that they haven't answered becomes an owed
// reply like a tag in a channel (the same notices and ladder, in Kaizen OS); their own reply later closes it. Nothing
// is ever sent on Slack from here: replies are drafted for them to send (draft_message, save_draft).

type Admin = SupabaseClient;
type Who = { team: Set<string>; nameOf: Map<string, string>; profileOf: Map<string, string> };
type Conv = { id: string; is_im?: boolean; is_mpim?: boolean; user?: string; name?: string; is_user_deleted?: boolean };

const LOOKBACK_DAYS = 7;
const MAX_CONVERSATIONS = 60;

export async function scanDms(admin: Admin, who: Who): Promise<{ people: number; read: number; found: number; skipped: number; errors: string[] }> {
  const { slackRead } = await import("@/lib/slack-user");
  const { data: tokens } = await admin.from("slack_user_tokens").select("profile_id, slack_user_id, token, scopes");
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const out = { people: 0, read: 0, found: 0, skipped: 0, errors: [] as string[] };
  for (const t of (tokens ?? []) as { profile_id: string; slack_user_id: string; token: string; scopes: string | null }[]) {
    const scopes = String(t.scopes ?? "").split(/[\s,]+/);
    if (!scopes.includes("im:history") || !scopes.includes("im:read")) {
      out.skipped++;
      continue;
    }
    const key = `owed:dms:${t.profile_id}`;
    const last = await getCursor(admin, key, 1);
    if (Date.now() - last.getTime() < 55 * 60_000) continue; // hourly per person
    out.people++;
    const started = new Date();
    try {
      const types = scopes.includes("mpim:read") && scopes.includes("mpim:history") ? "im,mpim" : "im";
      const list = await slackRead<{ ok: boolean; error?: string; channels?: Conv[] }>(t.token, "conversations.list", { types, exclude_archived: "true", limit: "200" });
      if (!list.ok) throw new Error(list.error ?? "conversations.list failed");
      const convs = (list.channels ?? []).filter((c) => !c.is_user_deleted && (c.is_mpim || (c.user && c.user !== t.slack_user_id && c.user !== "USLACKBOT"))).slice(0, MAX_CONVERSATIONS);
      const rows: Record<string, unknown>[] = [];
      for (const c of convs) {
        const h = await slackRead<{ ok: boolean; error?: string; messages?: DmMessage[] }>(t.token, "conversations.history", { channel: c.id, oldest: String(since / 1000), limit: "15" });
        if (!h.ok) continue;
        const msgs = h.messages ?? [];
        out.read += msgs.length;
        const owed = dmOwed(msgs, t.slack_user_id);
        // Their own message last: anything open in this DM for them is answered
        if (!owed) {
          await admin
            .from("owed_replies")
            .update({ status: "answered", answered_at: new Date().toISOString() })
            .eq("source", "slack")
            .eq("channel_id", c.id)
            .eq("target_id", t.profile_id)
            .in("status", ["watching", "nudged", "escalated"]);
          continue;
        }
        const from = owed.user ?? "";
        const name = who.nameOf.get(from) ?? "Someone";
        rows.push({
          source: "slack",
          message_key: `dm:${c.id}:${owed.ts}`,
          target_id: t.profile_id,
          client_id: null,
          channel_id: c.id,
          channel_name: c.is_mpim ? "a group DM" : `DM with ${name}`,
          thread_ts: null,
          message_ts: owed.ts,
          from_name: name,
          from_team: who.team.has(from),
          mentioned: true,
          asked_at: new Date(Number(owed.ts) * 1000).toISOString(),
          body: trimBody(String(owed.text ?? ""), 1500),
          url: `https://slack.com/app_redirect?channel=${c.id}&message_ts=${owed.ts}`,
          channel_url: `https://slack.com/app_redirect?channel=${c.id}`,
        });
      }
      if (rows.length) {
        const { error } = await admin.from("owed_replies").upsert(rows.filter((r) => !isPeopleMatter(String(r.body ?? ""))), { onConflict: "source,message_key,target_id", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        out.found += rows.length;
      }
      await setCursor(admin, key, started, { ok: true, conversations: convs.length, owed: rows.length });
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
      await setCursor(admin, key, started, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ...out, errors: out.errors.slice(0, 5) };
}

/** What came after a DM that's owed (read as the person, with their own token), for the "was it answered?" check */
export async function dmSince(admin: Admin, o: Record<string, unknown>): Promise<{ after: DmMessage[]; asker: string | null; reactors: Set<string> } | null> {
  if (!isDmKey(o.message_key)) return null;
  const { slackRead } = await import("@/lib/slack-user");
  const { data: t } = await admin.from("slack_user_tokens").select("token").eq("profile_id", o.target_id as string).maybeSingle();
  if (!t?.token) throw new Error("their Slack isn't connected any more");
  const ts = String(o.message_ts);
  const h = await slackRead<{ ok: boolean; error?: string; messages?: DmMessage[] }>(t.token as string, "conversations.history", { channel: String(o.channel_id), oldest: String(Number(ts) - 1), limit: "50", inclusive: "true" });
  if (!h.ok) throw new Error(h.error ?? "conversations.history failed");
  const msgs = h.messages ?? [];
  const asked = msgs.find((m) => m.ts === ts);
  return { after: msgs.filter((m) => Number(m.ts) > Number(ts)), asker: asked?.user ?? null, reactors: new Set((asked?.reactions ?? []).flatMap((r) => r.users ?? [])) };
}
