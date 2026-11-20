import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { shiftDay, etToday } from "@/lib/channel-kpis/calc";
import { loadSocialScore } from "@/lib/social-score-load";
import type { SocialAccountScore, SocialPostRow } from "@/lib/social-score";
import { socialDigest, SOCIAL_AREA_LABEL, type SocialAuditResult } from "./audit-core";

// What the client chat knows about a social client when the person is on the social team (or opens the Social sheet):
// every platform's numbers and the social score (the same digest the audit reads), the latest audit and sprint. It
// answers as the Social Strategist (the social_desk skill). Read only: nothing is posted or scheduled from here.

export type SocialRead = { name: string; score: SocialAccountScore; posts: SocialPostRow[]; digest: string; today: string };

/** The account as the audit, the sprint checks and the chat read it; null when nothing is synced yet */
export async function readSocialAccount(admin: SupabaseClient, clientId: string): Promise<SocialRead | null> {
  const today = etToday();
  const [score, { data: client }, { data: link }, { data: rows }, social] = await Promise.all([
    loadSocialScore(admin, clientId),
    admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
    admin.from("social_accounts").select("page_id, ig_id").eq("client_id", clientId).maybeSingle(),
    admin.from("social_posts").select("platform, account_id, format, caption, permalink, posted_at, reach, interactions, saves, shares").eq("client_id", clientId).gte("posted_at", `${shiftDay(today, -45)}T00:00:00Z`).order("posted_at", { ascending: false }).limit(200),
    import("@/lib/social/store").then((m) => m.clientSocial(admin, clientId)).catch(() => null),
  ]);
  if (!score) return null;
  const name = (client?.name as string | null) ?? "the client";
  // Every linked account's posts (a Page and Instagram per location)
  const keys = (await (await import("@/lib/social/links")).linkedKeys(admin, [clientId])).get(clientId) ?? new Set([`facebook:${link?.page_id ?? ""}`, `instagram:${link?.ig_id ?? ""}`]);
  const current = (r: Record<string, unknown>) => (r.platform !== "facebook" && r.platform !== "instagram") || keys.has(`${r.platform}:${r.account_id ?? ""}`);
  const posts: SocialPostRow[] = (rows ?? []).filter(current).map((p) => ({
    platform: p.platform as string,
    postedAt: (p.posted_at as string | null) ?? null,
    format: (p.format as string | null) ?? null,
    reach: p.reach == null ? null : Number(p.reach),
    interactions: p.interactions == null ? null : Number(p.interactions),
    saves: p.saves == null ? null : Number(p.saves),
    shares: p.shares == null ? null : Number(p.shares),
    caption: (p.caption as string | null) ?? null,
    permalink: (p.permalink as string | null) ?? null,
  }));
  return { name, score, posts, today, digest: socialDigest(name, score, posts, social?.health ?? [], today) };
}

/** The text block the social desk reads, or a plain note when there are no social numbers yet */
export async function socialDeskBlock(admin: SupabaseClient, clientId: string): Promise<string> {
  const read = await readSocialAccount(admin, clientId).catch(() => null);
  if (!read) return "<social_account>\nNo social numbers for this client yet: the Page or Instagram account is not linked, or the first read has not finished. Say so, and say the link is picked on the client's Social tab.\n</social_account>";
  const parts = [read.digest];
  const [{ data: audit }, { data: sprint }] = await Promise.all([
    admin.from("social_audits").select("created_at, score, result, done").eq("client_id", clientId).eq("status", "ready").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("social_sprints").select("baseline, latest, social_sprint_actions(title, status)").eq("client_id", clientId).eq("status", "active").maybeSingle(),
  ]);
  if (audit) {
    const r = audit.result as SocialAuditResult | null;
    parts.push(`<latest_social_audit ran="${String(audit.created_at).slice(0, 10)}" score="${audit.score ?? "?"}" actions_ticked="${Object.keys((audit.done ?? {}) as object).length}">\n${r?.verdict ? `Verdict: ${r.verdict.headline}. ${r.verdict.summary}\nDiagnosis: ${r.diagnosis}` : ""}\n${(r?.actions ?? []).slice(0, 8).map((a, i) => `- Action (${a.when}, ${a.owner}, ${a.platform}, ${SOCIAL_AREA_LABEL[a.area] ?? a.area}${(audit.done as Record<string, unknown>)?.[String(i)] ? ", done" : ""}): ${a.title}. ${a.why}`).join("\n")}\n</latest_social_audit>`);
  }
  if (sprint) {
    const acts = (sprint.social_sprint_actions ?? []) as { title: string; status: string }[];
    parts.push(`<social_sprint score_at_start="${(sprint.baseline as { score?: number } | null)?.score ?? "?"}" score_now="${(sprint.latest as { score?: number } | null)?.score ?? "?"}">\n${acts.map((a) => `- [${a.status}] ${a.title}`).join("\n")}\n</social_sprint>`);
  }
  parts.push("<change_history>Meta's APIs give no edit history for a Page or Instagram account (only the posts and when they went up), so there is no change history: judge whether anyone is working in the account by the posts.</change_history>");
  return parts.join("\n\n");
}

/** The client desk's prompt with its ad account sections cut, and the social desk's rules in their place */
export function socialDeskSystem(adsSystem: string): string {
  const head = adsSystem.split("\nChanges in the ad account")[0].replace(/If they ask you to run an audit[^\n]*/, 'If they ask you to run an audit, say they can start one from the client\'s sheet on the Social KPI board, under Actions.');
  return `${head}

You are talking with the social team about this client's organic social accounts. You answer as Kaizen's Social Strategist: read <social_score> (the overall score and every platform's eight checks: engagement rate against the client's target, 30 points; follower growth, bar 1% in 30 days, 15; reach against the 30 days before, bar holding level, 15; posts against the package, 15; saves and shares per reach, bar 0.6%, 10; video and Reels share, bar 40%, 3.75; video against static engagement, bar level, 3.75; profile visits per reach, bar 4%, 7.5; green from 80, yellow from 60, red under), the best and weakest posts with their hooks, the posting times, the latest audit and the sprint, and argue from those numbers, platform by platform. When the data is thin, say so; never invent a competitor or a benchmark. Say what you would do next and who does it (the social media manager, the graphic designer, the video editor, the client). Nothing can be posted, scheduled or edited on Instagram, Facebook or TikTok from here: when they ask, say the social team makes the move, and offer to put it on the audit's plan or say what to do.
Set change.wanted false and launch.wanted false with "" fields: nothing in an ad account is changed or launched from the social desk.`;
}
