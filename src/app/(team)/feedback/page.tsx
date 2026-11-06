import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { daysAgoIso } from "@/lib/dates";
import { FEEDBACK_BUCKET } from "@/lib/feedback";
import { byPriority } from "@/lib/feedback-logic";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { FeedbackView, type FeedbackEvent, type Group, type MineItem, type Report } from "./feedback-view";

export const metadata: Metadata = { title: "Feedback" };

type Ctx = Record<string, unknown>;

/** Signed links to screenshots (private bucket), an hour each. */
async function signed(paths: string[]) {
  const out = new Map<string, string>();
  if (!paths.length || !adminConfigured()) return out;
  const { data } = await createAdminClient().storage.from(FEEDBACK_BUCKET).createSignedUrls(paths, 3600);
  for (const d of data ?? []) if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  return out;
}

/**
 * Feedback from the bubble. Everyone sees what they've sent and where it stands. Execs also see everyone's, grouped
 * (repeats together) and sorted by priority, to set a status, put someone on it, and mark it fixed.
 */
export default async function FeedbackPage() {
  const me = await requireStaff();
  const db = await createClient();

  const [{ data: mineRows }, { data: eventRows }] = await Promise.all([
    db
      .from("app_feedback")
      .select("id, type, message, summary, route, created_at, screenshot_path, triaged_at, app_feedback_groups(id, title, status, reports, people, fixed_at, lane, fix_state, fix_commit_url, fix_pr_url)")
      .eq("profile_id", me.id)
      .order("created_at", { ascending: false })
      .limit(100),
    // The activity on each group: all of it for execs, what's shared with the reporters for everyone else (RLS)
    db.from("app_feedback_events").select("id, group_id, kind, body, link, shared, created_at, actor:profiles!app_feedback_events_actor_id_fkey(full_name)").order("created_at").limit(4000),
  ]);
  const events = new Map<string, FeedbackEvent[]>();
  for (const e of eventRows ?? []) {
    const gid = e.group_id as string;
    events.set(gid, [
      ...(events.get(gid) ?? []),
      { id: e.id as string, kind: e.kind as string, body: (e.body as string | null) ?? null, link: (e.link as string | null) ?? null, shared: Boolean(e.shared), at: e.created_at as string, actor: (e.actor as unknown as { full_name: string } | null)?.full_name ?? null },
    ]);
  }

  let groups: Group[] = [];
  let staff: { id: string; name: string }[] = [];
  let reportPaths: string[] = [];
  let rawReports: Record<string, unknown>[] = [];
  let rawGroups: Record<string, unknown>[] = [];
  const errors = new Map<string, { message: string; count: number; fixUrl: string | null; resolved: boolean }>();
  if (me.isExec) {
    const [{ data: g }, { data: r }, { data: people }] = await Promise.all([
      db.from("app_feedback_groups").select("*, assignee:profiles!app_feedback_groups_assignee_id_fkey(full_name)").order("priority", { ascending: false }).limit(300),
      db
        .from("app_feedback")
        .select("id, group_id, type, message, summary, page_url, route, context, created_at, screenshot_path, triaged_at, author:profiles!app_feedback_profile_id_fkey(full_name, role), clients(name)")
        .order("created_at", { ascending: false })
        .limit(1500),
      db.from("profiles").select("id, full_name").eq("is_active", true).order("full_name"),
    ]);
    rawGroups = g ?? [];
    rawReports = r ?? [];
    staff = (people ?? []).map((p) => ({ id: p.id as string, name: p.full_name as string }));
    reportPaths = rawReports.map((x) => x.screenshot_path as string | null).filter((p): p is string => Boolean(p));
    const fps = [...new Set(rawGroups.map((x) => x.error_fingerprint as string | null).filter((x): x is string => Boolean(x)))];
    if (fps.length) {
      const { data: ev } = await db.from("error_events").select("fingerprint, message, count, fix_issue_url, resolved_at").in("fingerprint", fps);
      for (const e of ev ?? []) errors.set(e.fingerprint as string, { message: e.message as string, count: e.count as number, fixUrl: (e.fix_issue_url as string | null) ?? null, resolved: Boolean(e.resolved_at) });
    }
  }

  const minePaths = (mineRows ?? []).map((x) => x.screenshot_path as string | null).filter((p): p is string => Boolean(p));
  const urls = await signed([...new Set([...reportPaths, ...minePaths])]);

  if (me.isExec) {
    const reports = new Map<string, Report[]>();
    const loose: Report[] = [];
    for (const x of rawReports) {
      const ctx = (x.context ?? {}) as Ctx;
      const author = x.author as unknown as { full_name: string; role: string } | null;
      const rep: Report = {
        id: x.id as string,
        type: x.type as string,
        message: x.message as string,
        summary: (x.summary as string | null) ?? null,
        pageUrl: (x.page_url as string | null) ?? null,
        route: (x.route as string | null) ?? null,
        createdAt: x.created_at as string,
        author: author?.full_name ?? "Someone",
        role: author ? roleLabel(author.role as TeamRole) : "",
        client: (x.clients as unknown as { name: string } | null)?.name ?? null,
        screenshot: x.screenshot_path ? (urls.get(x.screenshot_path as string) ?? null) : null,
        viewport: (ctx.viewport as string | undefined) ?? null,
        userAgent: (ctx.userAgent as string | undefined) ?? null,
        version: (ctx.version as string | undefined) ?? null,
        consoleErrors: ((ctx.consoleErrors as { message: string }[] | undefined) ?? []).map((e) => e.message),
        failedRequests: ((ctx.failedRequests as { method: string; url: string; status: number | null }[] | undefined) ?? []).map((q) => `${q.method} ${q.url} ${q.status ?? "failed"}`),
      };
      const gid = x.group_id as string | null;
      if (gid) reports.set(gid, [...(reports.get(gid) ?? []), rep]);
      else loose.push(rep);
    }
    groups = rawGroups.map((x) => {
      const fp = (x.error_fingerprint as string | null) ?? null;
      return {
        id: x.id as string,
        title: x.title as string,
        summary: (x.summary as string | null) ?? null,
        type: x.type as string,
        area: x.area as string,
        status: x.status as string,
        assigneeId: (x.assignee_id as string | null) ?? null,
        assignee: (x.assignee as unknown as { full_name: string } | null)?.full_name ?? null,
        severity: x.severity as string,
        blocksWork: Boolean(x.blocks_work),
        reports: x.reports as number,
        people: x.people as number,
        priority: Number(x.priority),
        lastReportedAt: (x.last_reported_at as string | null) ?? null,
        fixedAt: (x.fixed_at as string | null) ?? null,
        error: fp && errors.has(fp) ? { fingerprint: fp, ...errors.get(fp)! } : null,
        items: reports.get(x.id as string) ?? [],
        scope: (x.scope as Group["scope"]) ?? "small_bug",
        scopeReason: (x.scope_reason as string | null) ?? null,
        lane: (x.lane as string) ?? "review",
        plan: (x.plan as string | null) ?? null,
        fixState: (x.fix_state as string | null) ?? null,
        fixIssueUrl: (x.fix_issue_url as string | null) ?? null,
        fixPrUrl: (x.fix_pr_url as string | null) ?? null,
        fixCommitUrl: (x.fix_commit_url as string | null) ?? null,
        events: events.get(x.id as string) ?? [],
      };
    });
    // Just sent, still being read: shown on their own at the top until they land in a group
    for (const r of loose)
      groups.push({
        id: `pending-${r.id}`,
        title: r.message.split("\n")[0].slice(0, 90),
        summary: null,
        type: r.type,
        area: "Reading it…",
        status: "new",
        assigneeId: null,
        assignee: null,
        severity: "low",
        blocksWork: false,
        reports: 1,
        people: 1,
        priority: 0,
        lastReportedAt: r.createdAt,
        fixedAt: null,
        error: null,
        items: [r],
        scope: "small_bug",
        scopeReason: null,
        lane: "review",
        plan: null,
        fixState: null,
        fixIssueUrl: null,
        fixPrUrl: null,
        fixCommitUrl: null,
        events: [],
        pending: true,
      });
    groups.sort(byPriority);
    groups = [...groups.filter((g) => g.pending), ...groups.filter((g) => !g.pending)];
  }

  const mine: MineItem[] = (mineRows ?? []).map((x) => {
    const g = x.app_feedback_groups as unknown as {
      id: string;
      title: string;
      status: string;
      reports: number;
      people: number;
      fixed_at: string | null;
      lane: string;
      fix_state: string | null;
      fix_commit_url: string | null;
      fix_pr_url: string | null;
    } | null;
    return {
      groupId: g?.id ?? null,
      lane: g?.lane ?? null,
      fixState: g?.fix_state ?? null,
      fixLink: g?.fix_commit_url ?? null,
      events: g ? (events.get(g.id) ?? []).filter((e) => e.shared) : [],
      id: x.id as string,
      type: x.type as string,
      message: x.message as string,
      route: (x.route as string | null) ?? null,
      createdAt: x.created_at as string,
      screenshot: x.screenshot_path ? (urls.get(x.screenshot_path as string) ?? null) : null,
      status: g?.status ?? null,
      title: g?.title ?? null,
      others: g ? Math.max(0, g.people - 1) : 0,
      fixedAt: g?.fixed_at ?? null,
    };
  });

  return <FeedbackView isExec={me.isExec} groups={groups} mine={mine} staff={staff} monthAgo={daysAgoIso(30)} />;
}
