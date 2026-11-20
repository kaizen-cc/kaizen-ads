"use server";

import { requireStaff } from "@/lib/auth";
import { shiftDay } from "@/lib/channel-kpis/calc";
import type { SocialAuditResult } from "@/lib/social-ops/audit-core";
import { createClient } from "@/lib/supabase/server";
import type { SheetAudit, SheetMove, SheetSprint } from "./email-sheet-actions";

// What a social account's sheet on the KPI board reads when it opens (the board carries the score and the month's
// numbers): every platform's days for the 7-day rate chart, the posts for the top and bottom lists, the latest social
// audit and the sprint with its moves and checks. Read through the person's own session, so only clients they can see.

export type SheetDay = { platform: string; date: string; reach: number | null; interactions: number | null; followers: number | null };
export type SheetPost = { id: string; platform: string; format: string | null; caption: string | null; permalink: string | null; thumbnail: string | null; postedAt: string | null; reach: number | null; interactions: number | null; saves: number | null; shares: number | null };

/** A post the ads team is boosting: its ads and their spend over the last 30 days */
export type SheetBoost = { postId: string; platform: string; permalink: string | null; caption: string | null; thumbnail: string | null; postedAt: string | null; format: string | null; ads: number; spend: number; impressions: number; lastSpendDay: string | null; adNames: string[] };

export type SocialSheet = { today: string; now: number; days: SheetDay[]; posts: SheetPost[]; audit: SheetAudit | null; sprint: SheetSprint | null; boosts: SheetBoost[] };

const num = (v: unknown) => Number(v ?? 0) || 0;
const orNull = (v: unknown) => (v == null ? null : Number(v));
const etDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function loadSocialSheet(clientId: string): Promise<{ ok: true; sheet: SocialSheet } | { ok: false; error: string }> {
  await requireStaff();
  const db = await createClient();
  const { data: c } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "You don't work on this client." };
  const today = etDay(new Date().toISOString());
  const [link, days, posts, audit, boosted, sprint] = await Promise.all([
    db.from("social_accounts").select("page_id, ig_id").eq("client_id", clientId).maybeSingle(),
    db.from("social_daily").select("platform, account_id, date, reach, interactions, followers").eq("client_id", clientId).gte("date", shiftDay(today, -40)).lte("date", today).order("date").limit(400),
    db.from("social_posts").select("post_id, platform, account_id, format, caption, permalink, thumbnail_url, posted_at, reach, interactions, saves, shares").eq("client_id", clientId).gte("posted_at", `${shiftDay(today, -90)}T00:00:00Z`).order("posted_at", { ascending: false }).limit(240),
    db.from("social_audits").select("id, status, step, progress, score, band, result, done, auto, error, created_at, profiles(full_name)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    // Which of their posts the ads team is boosting, and the spend behind each (src/lib/social-boosts.ts)
    import("@/lib/social-boosts").then((m) => m.boostedPosts(db, [clientId])).then((r) => r[clientId] ?? []).catch(() => []),
    db.from("social_sprints").select('id, audit_id, started_at, baseline, latest, next_check_at, last_check_at, social_sprint_actions(id, audit_index, title, owner, "when", steps, why, impact, status, note, ai_note, sort_order), social_sprint_checks(verdict, message, created_at)').eq("client_id", clientId).eq("status", "active").maybeSingle(),
  ]);
  const l = link.data;
  // Every linked account (a Page and Instagram per location), their days added up per platform and day
  const keys = (await (await import("@/lib/social/links")).linkedKeys(db, [clientId])).get(clientId) ?? new Set([`facebook:${l?.page_id ?? ""}`, `instagram:${l?.ig_id ?? ""}`]);
  const current = (r: Record<string, unknown>) => (r.platform !== "facebook" && r.platform !== "instagram") || keys.has(`${r.platform}:${r.account_id ?? ""}`);
  const { mergeAccountDays } = await import("@/lib/social/links-core");
  const a = audit.data as Record<string, unknown> | null;
  const s = sprint.data as Record<string, unknown> | null;
  return {
    ok: true,
    sheet: {
      today,
      now: Date.now(),
      boosts: boosted.map((b) => ({ postId: b.postId, platform: b.platform, permalink: b.permalink, caption: b.caption, thumbnail: b.thumbnail, postedAt: b.postedAt, format: b.format, ads: b.ads, spend: b.spend30d, impressions: b.impressions30d, lastSpendDay: b.lastSpendDay, adNames: b.adNames })),
      days: mergeAccountDays((days.data ?? []).filter(current) as { platform: string; date: string }[], ["reach", "interactions", "followers"]).map((d) => d as Record<string, unknown>).map((d) => ({ platform: d.platform as string, date: d.date as string, reach: orNull(d.reach), interactions: orNull(d.interactions), followers: orNull(d.followers) })),
      posts: (posts.data ?? []).filter(current).map((p) => ({
        id: p.post_id as string,
        platform: p.platform as string,
        format: (p.format as string | null) ?? null,
        caption: (p.caption as string | null) ?? null,
        permalink: (p.permalink as string | null) ?? null,
        thumbnail: (p.thumbnail_url as string | null) ?? null,
        postedAt: (p.posted_at as string | null) ?? null,
        reach: orNull(p.reach),
        interactions: orNull(p.interactions),
        saves: orNull(p.saves),
        shares: orNull(p.shares),
      })),
      // Before the social ops migration is applied these read nothing (an error), so the sheet says there is no audit yet
      audit: a
        ? {
            id: a.id as string,
            status: a.status as SheetAudit["status"],
            step: (a.step as string | null) ?? null,
            progress: num(a.progress),
            score: (a.score as number | null) ?? null,
            band: (a.band as SheetAudit["band"]) ?? null,
            createdAt: a.created_at as string,
            auto: Boolean(a.auto),
            by: (a.profiles as { full_name?: string } | null)?.full_name ?? null,
            error: (a.error as string | null) ?? null,
            result: (a.result as SocialAuditResult | null) ?? null,
            done: (a.done ?? {}) as SheetAudit["done"],
          }
        : null,
      sprint: s
        ? {
            id: s.id as string,
            auditId: (s.audit_id as string | null) ?? null,
            startedAt: s.started_at as string,
            baseline: (s.baseline as { score?: number } | null)?.score ?? null,
            latest: (s.latest as { score?: number } | null)?.score ?? null,
            nextCheckAt: s.next_check_at as string,
            lastCheckAt: (s.last_check_at as string | null) ?? null,
            moves: ((s.social_sprint_actions ?? []) as Record<string, unknown>[])
              .sort((x, y) => num(x.sort_order) - num(y.sort_order))
              .map((m) => ({
                id: m.id as string,
                auditIndex: (m.audit_index as number | null) ?? null,
                title: m.title as string,
                owner: (m.owner as string | null) ?? null,
                when: (m.when as string | null) ?? null,
                steps: (m.steps ?? []) as string[],
                why: (m.why as string | null) ?? null,
                impact: (m.impact as string | null) ?? null,
                status: m.status as SheetMove["status"],
                note: (m.note as string | null) ?? null,
                aiNote: (m.ai_note as string | null) ?? null,
              })),
            checks: ((s.social_sprint_checks ?? []) as Record<string, unknown>[])
              .map((k) => ({ verdict: k.verdict as string, message: k.message as string, at: k.created_at as string }))
              .sort((x, y) => y.at.localeCompare(x.at))
              .slice(0, 3),
          }
        : null,
    },
  };
}
