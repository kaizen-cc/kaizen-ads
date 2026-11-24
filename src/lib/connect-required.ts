import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asanaGap, slackGap, type Gaps } from "./connect-required-core";

// Who still has to connect their own Slack and Asana (src/lib/connect-required-core.ts), from what's stored: no call
// to Slack or Asana, so it's cheap enough for every page. Kaizen's Slack workspace is SLACK_TEAM_ID when set; Kaizen's
// Asana workspace is ASANA_WORKSPACE_GID (or the shared token's).

async function kaizenSpaces(): Promise<{ team: string | null; workspace: string | null }> {
  const { kaizenWorkspace, asanaConfigured } = await import("@/lib/asana");
  const workspace = asanaConfigured() ? await kaizenWorkspace().catch(() => null) : null;
  return { team: process.env.SLACK_TEAM_ID ?? null, workspace };
}

/** One person's gaps (both "ok" when Slack or Asana isn't set up for Kaizen OS at all) */
export async function connectionGaps(admin: SupabaseClient, profileId: string): Promise<Gaps> {
  const [{ data: s }, { data: a }, spaces] = await Promise.all([
    admin.from("slack_user_tokens").select("scopes, team_id").eq("profile_id", profileId).maybeSingle(),
    admin.from("asana_user_tokens").select("confirmed, expires_at, refresh_token, workspaces").eq("profile_id", profileId).maybeSingle(),
    kaizenSpaces(),
  ]);
  const slackOn = Boolean(process.env.SLACK_CLIENT_ID);
  const asanaOn = Boolean(process.env.ASANA_CLIENT_ID);
  return {
    slack: slackOn ? slackGap(s as never, spaces.team) : "ok",
    asana: asanaOn ? asanaGap(a as never, spaces.workspace) : "ok",
  };
}

export type TeamGap = { id: string; name: string; role: string; email: string; gaps: Gaps };

/** Every active team member's gaps, worst first (Settings › Team) */
export async function teamGaps(admin: SupabaseClient): Promise<TeamGap[]> {
  const [{ data: people }, { data: slack }, { data: asana }, spaces] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, email").eq("is_active", true).order("full_name"),
    admin.from("slack_user_tokens").select("profile_id, scopes, team_id"),
    admin.from("asana_user_tokens").select("profile_id, confirmed, expires_at, refresh_token, workspaces"),
    kaizenSpaces(),
  ]);
  const s = new Map((slack ?? []).map((r) => [r.profile_id as string, r]));
  const a = new Map((asana ?? []).map((r) => [r.profile_id as string, r]));
  return (people ?? [])
    .filter((p) => p.role !== "client" && p.email)
    .map((p) => ({ id: p.id as string, name: String(p.full_name ?? p.email), role: String(p.role ?? ""), email: String(p.email), gaps: { slack: slackGap((s.get(p.id as string) ?? null) as never, spaces.team), asana: asanaGap((a.get(p.id as string) ?? null) as never, spaces.workspace) } }))
    .sort((x, y) => Number(y.gaps.slack !== "ok") + Number(y.gaps.asana !== "ok") - (Number(x.gaps.slack !== "ok") + Number(x.gaps.asana !== "ok")) || x.name.localeCompare(y.name));
}
