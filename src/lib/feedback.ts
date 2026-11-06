import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { commitUrl, github, githubConfigured, openClaudeIssue } from "@/lib/claude-fix";
import { errorFingerprint } from "@/lib/error-report";
import {
  AREA_NAMES,
  SCOPE_LABEL,
  areaFromRoute,
  autoFixDecision,
  classifyScope,
  closestGroup,
  fixOutcome,
  groupStats,
  priorityScore,
  widerScope,
  type FeedbackType,
  type GroupCandidate,
  type ReportFacts,
  type Scope,
  type Severity,
} from "@/lib/feedback-logic";

// Feedback from the team about the app. Each report is read by AI (a fast model): a one-line title, a short summary,
// its type and area, how bad it is, whether it stops someone working, how big it is (a small bug, a big issue, a
// feature request), a proposed plan, and whether it repeats something already reported. Repeats join that group, so
// each group counts its reports and the distinct people behind them and gets a priority from that.
//
// Then each group takes a path. A small bug goes to the same Claude fix pipeline as the error monitor (lib/claude-fix:
// a GitHub issue labelled claude-fix + auto-merge; the claude-fix workflow has Claude open a pull request, runs every
// check, and merges it when they pass), a few a day at most. When it ships the group is marked fixed with its commit
// and everyone who reported it hears. Big issues and feature requests wait on an exec's review card (approve to build,
// ask for more, or won't do). Every step is logged on the group. Execs get a weekly digest of what keeps coming up.

type Admin = SupabaseClient;
export const FEEDBACK_BUCKET = "feedback";
const SITE = () => process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";

const execIds = async (admin: Admin) =>
  ((await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null)).data ?? []).map((p) => p.id as string);

/** One line in a group's activity. Shared ones show to the people who reported it too. */
export async function logEvent(admin: Admin, groupId: string, kind: string, body: string | null, opts: { link?: string | null; shared?: boolean; actor?: string | null } = {}) {
  const { data } = await admin
    .from("app_feedback_events")
    .insert({ group_id: groupId, kind, body: body?.slice(0, 2000) ?? null, link: opts.link ?? null, shared: opts.shared ?? false, actor_id: opts.actor ?? null })
    .select("id")
    .single();
  return (data?.id as string | undefined) ?? null;
}

const reporters = async (admin: Admin, groupId: string) =>
  [...new Set(((await admin.from("app_feedback").select("profile_id").eq("group_id", groupId)).data ?? []).map((r) => r.profile_id as string))];

/** Tell everyone who reported it (not the person who did it). */
export async function notifyReporters(admin: Admin, groupId: string, n: { key: string; title: string; body: string; actor?: string | null }) {
  const people = (await reporters(admin, groupId)).filter((p) => p !== n.actor);
  for (const p of people)
    await admin.from("notifications").upsert(
      { profile_id: p, kind: "feedback", title: n.title.slice(0, 300), body: n.body.slice(0, 1000), href: "/feedback?tab=mine", key: n.key, priority: "normal", actor_id: n.actor ?? null },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  return people.length;
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The issue or idea in one short line (under 80 characters), plain words" },
    summary: { type: "string", description: "One or two sentences: what they hit or want, where, and why it matters" },
    type: { type: "string", enum: ["bug", "idea", "confusing"] },
    area: { type: "string", enum: AREA_NAMES },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    blocksWork: { type: "boolean", description: "True only when it stops them doing their work (no way around it)" },
    scope: {
      type: "string",
      enum: ["small_bug", "big_issue", "feature"],
      description:
        "small_bug: small, contained, clear repro (a UI glitch, a wrong link, a crash with an error, a copy mistake, a confusing label). big_issue: data could be lost or wrong, security, money or budgets, anything that writes to ad accounts, sign-in or permissions, the database, or spans several areas. feature: asks for new behaviour.",
    },
    plan: { type: "string", description: "For a feature or big issue: a proposed plan in 3 to 6 short steps. For a small bug: the likely fix in one line." },
    duplicateOf: { type: "integer", description: "The number of the existing item this is the same as, or 0 when it's new" },
  },
  required: ["title", "summary", "type", "area", "severity", "blocksWork", "scope", "plan", "duplicateOf"],
  additionalProperties: false,
};

type Read = { title: string; summary: string; type: FeedbackType; area: string; severity: Severity; blocksWork: boolean; scope: Scope; scopeReason: string; plan: string | null; groupId: string | null };

async function readReport(f: { type: string; message: string; route: string | null; context: Record<string, unknown> }, groups: GroupCandidate[]): Promise<Read> {
  const area = areaFromRoute(f.route);
  const errors = ((f.context.consoleErrors as { message: string }[] | undefined) ?? []).slice(-5).map((e) => e.message);
  const failed = ((f.context.failedRequests as { method: string; url: string; status: number | null }[] | undefined) ?? []).slice(-5).map((r) => `${r.method} ${r.url} ${r.status ?? "failed"}`);
  try {
    const out = await askJson<Omit<Read, "groupId" | "scopeReason"> & { duplicateOf: number }>({
      agent: "briefing",
      label: "feedback triage",
      bare: true,
      maxTokens: 2000,
      system: `You triage feedback the Kaizen Marketing team leaves about Kaizen Ads, their internal app (creative requests, a board, client pages, KPIs, reports, an AI chat, a client portal, a launcher that writes to Meta ad accounts). Read one report and: write a short title and summary in plain words; confirm or correct its type (bug: broken or wrong; idea: an improvement; confusing: hard to find or understand); pick the area of the app; rate severity (high: data wrong or lost, or a core flow broken for everyone; medium: a real problem with a workaround; low: cosmetic or a nice-to-have); say whether it blocks their work; size it (small_bug, big_issue or feature: when unsure between small and big, say big); and propose a plan. Then decide whether it is the same issue or request as one of the existing items listed (the same problem in the same place, said differently). Only match when it really is the same thing; related is not the same. Answer 0 when it's new.`,
      prompt: `The report (they picked "${f.type}"), left on ${f.route ?? "an unknown page"} (area by its page: ${area}):
"""
${f.message.slice(0, 3000)}
"""
${errors.length ? `Console errors just before:\n${errors.map((e) => `- ${e}`).join("\n")}\n` : ""}${failed.length ? `Failed requests just before:\n${failed.map((e) => `- ${e}`).join("\n")}\n` : ""}
Existing items:
${groups.length ? groups.map((g, i) => `${i + 1}. [${g.type} · ${g.area}${g.status === "fixed" ? " · marked fixed" : ""}] ${g.title}${g.summary ? `: ${g.summary}` : ""}`).join("\n") : "(none yet)"}`,
      schema: SCHEMA,
    });
    const match = out.duplicateOf > 0 ? groups[out.duplicateOf - 1] : undefined;
    const finalArea = AREA_NAMES.includes(out.area) ? out.area : area;
    const scope = classifyScope({ aiScope: out.scope, type: out.type, severity: out.severity, text: `${f.message} ${out.summary}`, area: finalArea });
    return { title: out.title.slice(0, 140), summary: out.summary.slice(0, 600), type: out.type, area: finalArea, severity: out.severity, blocksWork: out.blocksWork, scope: scope.scope, scopeReason: scope.reason, plan: out.plan?.slice(0, 2000) || null, groupId: match?.id ?? null };
  } catch (e) {
    // No AI (or it failed): grouped by wording, the rest from what they picked and where they were. Without the AI's
    // read nothing is fixed automatically: it waits for review.
    console.error("[feedback] triage without AI:", e instanceof Error ? e.message : e);
    const first = f.message.split(/(?<=[.!?])\s|\n/)[0].trim();
    const scope = classifyScope({ aiScope: f.type === "idea" ? "feature" : "big_issue", type: f.type, severity: "medium", text: f.message, area });
    return {
      title: (first.length > 90 ? `${first.slice(0, 87)}...` : first) || "Feedback",
      summary: f.message.slice(0, 300),
      type: f.type as FeedbackType,
      area,
      severity: f.type === "bug" ? "medium" : "low",
      blocksWork: false,
      scope: scope.scope,
      scopeReason: "Read without AI, so a person decides",
      plan: null,
      groupId: closestGroup({ type: f.type, area, text: f.message }, groups),
    };
  }
}

/** A group's counts and priority, from its reports as they stand. */
export async function recomputeGroup(admin: Admin, groupId: string) {
  const [{ data: g }, { data: rows }] = await Promise.all([
    admin.from("app_feedback_groups").select("type, status").eq("id", groupId).maybeSingle(),
    admin.from("app_feedback").select("profile_id, severity, blocks_work, created_at").eq("group_id", groupId),
  ]);
  if (!g) return;
  const stats = groupStats((rows ?? []).map((r): ReportFacts => ({ profileId: r.profile_id as string, severity: (r.severity as Severity | null) ?? null, blocksWork: Boolean(r.blocks_work), createdAt: r.created_at as string })));
  await admin
    .from("app_feedback_groups")
    .update({
      reports: stats.reports,
      people: stats.people,
      severity: stats.severity,
      blocks_work: stats.blocksWork,
      ...(stats.firstReportedAt ? { first_reported_at: stats.firstReportedAt, last_reported_at: stats.lastReportedAt } : {}),
      priority: priorityScore({ ...stats, type: g.type as string, status: g.status as string }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", groupId);
}

/** Read one report, put it in its group (an existing one it repeats, or a new one), and send the group on its way. Never throws. */
export async function triageFeedback(admin: Admin, id: string) {
  try {
    const { data: f } = await admin.from("app_feedback").select("id, type, message, route, context, triaged_at, triage_tries").eq("id", id).maybeSingle();
    if (!f || f.triaged_at) return;
    await admin.from("app_feedback").update({ triage_tries: (f.triage_tries as number) + 1 }).eq("id", id);
    const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const { data: groups } = await admin
      .from("app_feedback_groups")
      .select("id, type, area, title, summary, status")
      .gte("last_reported_at", since)
      .neq("status", "wont_fix")
      .order("priority", { ascending: false })
      .limit(80);
    const context = (f.context ?? {}) as Record<string, unknown>;
    const read = await readReport({ type: f.type as string, message: f.message as string, route: (f.route as string | null) ?? null, context }, (groups ?? []) as GroupCandidate[]);

    // The error monitor may already have this one: the latest console error on the page it was left on
    const lastError = ((context.consoleErrors as { message: string }[] | undefined) ?? []).at(-1)?.message ?? null;
    const path = typeof context.path === "string" ? context.path : null;
    let fingerprint: string | null = null;
    if (lastError) {
      const fp = errorFingerprint("page", lastError, path);
      const { data: known } = await admin.from("error_events").select("fingerprint").eq("fingerprint", fp).maybeSingle();
      fingerprint = known ? fp : null;
    }

    let groupId = read.groupId;
    let isNew = false;
    if (groupId) {
      const { data: g } = await admin.from("app_feedback_groups").select("status, scope, lane, fix_state, error_fingerprint").eq("id", groupId).maybeSingle();
      const scope = widerScope((g?.scope as Scope | undefined) ?? "small_bug", read.scope);
      const reopened = g?.status === "fixed";
      // A report that makes it bigger takes it out of the automatic path, unless a fix is already on its way
      const toReview = scope !== "small_bug" && g?.lane === "auto_fix" && !["working", "pr_open"].includes((g?.fix_state as string | null) ?? "");
      await admin
        .from("app_feedback_groups")
        .update({
          scope,
          ...(scope !== g?.scope ? { scope_reason: read.scopeReason } : {}),
          ...(toReview ? { lane: "review" } : {}),
          // Reported again after it was marked fixed: it's back on the list, and gets a fresh try
          ...(reopened ? { status: "new", fixed_at: null, fixed_by: null, fix_state: null, fix_attempts: 0, lane: scope === "small_bug" ? "auto_fix" : "review" } : {}),
          ...(fingerprint && !g?.error_fingerprint ? { error_fingerprint: fingerprint } : {}),
        })
        .eq("id", groupId);
      await logEvent(admin, groupId, reopened ? "reopened" : "repeat", reopened ? "Reported again after it was marked fixed" : `Reported again: ${read.summary}`);
    } else {
      const { data: g } = await admin
        .from("app_feedback_groups")
        .insert({
          title: read.title,
          summary: read.summary,
          type: read.type,
          area: read.area,
          severity: read.severity,
          blocks_work: read.blocksWork,
          error_fingerprint: fingerprint,
          scope: read.scope,
          scope_reason: read.scopeReason,
          plan: read.plan,
          lane: read.scope === "small_bug" ? "auto_fix" : "review",
        })
        .select("id")
        .single();
      groupId = (g?.id as string | undefined) ?? null;
      isNew = true;
      if (groupId) await logEvent(admin, groupId, "triaged", `${SCOPE_LABEL[read.scope]}: ${read.scopeReason}`);
    }
    await admin
      .from("app_feedback")
      .update({ summary: read.summary, area: read.area, severity: read.severity, blocks_work: read.blocksWork, scope: read.scope, group_id: groupId, triaged_at: new Date().toISOString() })
      .eq("id", id);
    if (!groupId) return;
    await recomputeGroup(admin, groupId);

    // Something stopping someone's work, badly: execs hear now rather than in the weekly digest
    if (isNew && read.severity === "high" && read.blocksWork) {
      for (const exec of await execIds(admin))
        await admin.from("notifications").upsert(
          { profile_id: exec, kind: "feedback", title: `Blocking bug reported: ${read.title}`, body: read.summary, href: `/feedback?g=${groupId}`, key: `feedback-urgent:${groupId}`, priority: "critical" },
          { onConflict: "profile_id,key", ignoreDuplicates: true },
        );
    }
    await routeGroup(admin, groupId);
  } catch (e) {
    console.error("[feedback] triage failed:", e instanceof Error ? e.message : e);
  }
}

/** Execs hear once that a group waits on their review. */
async function askForReview(admin: Admin, groupId: string, title: string, reason: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("lane").eq("id", groupId).maybeSingle();
  if (g?.lane !== "review") await admin.from("app_feedback_groups").update({ lane: "review", updated_at: new Date().toISOString() }).eq("id", groupId);
  const { count } = await admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("kind", "needs_review").eq("body", reason);
  if (!count) await logEvent(admin, groupId, "needs_review", reason);
  for (const exec of await execIds(admin))
    await admin.from("notifications").upsert(
      { profile_id: exec, kind: "feedback", title: `Feedback to review: ${title}`, body: reason, href: `/feedback?g=${groupId}`, key: `feedback-review:${groupId}`, priority: "normal" },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
}

/** Send a group down its path: an automatic fix now (or next, within today's limit), or an exec's review. */
export async function routeGroup(admin: Admin, groupId: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("id, title, status, scope, scope_reason, lane, fix_state, fix_attempts").eq("id", groupId).maybeSingle();
  if (!g || g.lane === "build") return;
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: started }, { count: failed }] = await Promise.all([
    admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("kind", "auto_fix_started").gte("created_at", day),
    admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("kind", "checks_failed").gte("created_at", day),
  ]);
  const d = autoFixDecision({
    scope: g.scope as Scope,
    status: g.status as string,
    fixState: (g.fix_state as string | null) ?? null,
    attempts: g.fix_attempts as number,
    startedToday: started ?? 0,
    failedToday: failed ?? 0,
    github: githubConfigured(),
  });
  if (d.action === "start") await startFix(admin, groupId, true);
  else if (d.action === "wait") {
    if (g.fix_state !== "queued") {
      await admin.from("app_feedback_groups").update({ lane: "auto_fix", fix_state: "queued" }).eq("id", groupId);
      await logEvent(admin, groupId, "queued", d.reason);
    }
  } else if (d.action === "review") await askForReview(admin, groupId, g.title as string, g.scope === "small_bug" ? d.reason : `${SCOPE_LABEL[g.scope as Scope]}: ${(g.scope_reason as string | null) ?? d.reason}`);
}

/** Everything known about a group, for Claude: the reports, where, what the browser saw, and the screenshots. */
async function issueBody(admin: Admin, groupId: string, mode: "fix" | "build", note: string | null) {
  const [{ data: g }, { data: rows }, { data: prev }] = await Promise.all([
    admin.from("app_feedback_groups").select("title, summary, type, area, scope, plan, reports, people, error_fingerprint, fix_pr_url").eq("id", groupId).single(),
    admin.from("app_feedback").select("message, route, page_url, context, screenshot_path, created_at, author:profiles!app_feedback_profile_id_fkey(role)").eq("group_id", groupId).order("created_at", { ascending: false }).limit(6),
    admin.from("app_feedback_events").select("body, link").eq("group_id", groupId).eq("kind", "checks_failed").order("created_at", { ascending: false }).limit(2),
  ]);
  const shots = (rows ?? []).map((r) => r.screenshot_path as string | null).filter((p): p is string => Boolean(p));
  const signed = shots.length ? ((await admin.storage.from(FEEDBACK_BUCKET).createSignedUrls(shots, 7 * 86_400)).data ?? []) : [];
  let stack: string | null = null;
  if (g?.error_fingerprint) {
    const { data: ev } = await admin.from("error_events").select("message, sample").eq("fingerprint", g.error_fingerprint).maybeSingle();
    stack = ev ? `${ev.message}\n${((ev.sample ?? {}) as { stack?: string }).stack ?? ""}`.trim() : null;
  }
  const reports = (rows ?? []).map((r, i) => {
    const c = (r.context ?? {}) as Record<string, unknown>;
    const errs = ((c.consoleErrors as { message: string }[] | undefined) ?? []).slice(-6).map((e) => `  - ${e.message}`);
    const reqs = ((c.failedRequests as { method: string; url: string; status: number | null }[] | undefined) ?? []).slice(-6).map((q) => `  - ${q.method} ${q.url} ${q.status ?? "failed"}`);
    const shot = signed.find((s) => s.path === r.screenshot_path)?.signedUrl;
    return [
      `### Report ${i + 1} (${(r.author as unknown as { role: string } | null)?.role ?? "team member"}, ${new Date(r.created_at as string).toISOString().slice(0, 10)})`,
      `> ${String(r.message).replace(/\n/g, "\n> ")}`,
      `- Page: \`${r.route ?? "unknown"}\` (${r.page_url ?? ""})`,
      `- Screen: ${c.viewport ?? "?"} · ${c.userAgent ?? "unknown browser"} · app version ${c.version ?? "?"}`,
      errs.length ? `- Console errors just before:\n${errs.join("\n")}` : "",
      reqs.length ? `- Failed requests just before:\n${reqs.join("\n")}` : "",
      shot ? `- Screenshot (link valid 7 days): ${shot}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    mode === "fix"
      ? `Reported by the team through Kaizen Ads's feedback bubble and sent to Claude automatically as a small bug.`
      : `Feedback from the team, approved by an exec to build. Open a pull request for review; it is not merged automatically.`,
    ``,
    `**${g?.title}**`,
    g?.summary ?? "",
    `Area: ${g?.area} · reported ${g?.reports}× by ${g?.people} ${g?.people === 1 ? "person" : "people"}`,
    g?.plan ? `\n**${mode === "fix" ? "Likely fix" : "Proposed plan"}:**\n${g.plan}` : "",
    note ? `\n**Exec's note:** ${note}` : "",
    (prev ?? []).length ? `\n**Earlier attempts failed their checks:** ${(prev ?? []).map((p) => p.link ?? "").filter(Boolean).join(", ")}. Read why before trying again.` : "",
    stack ? `\n**The error monitor recorded:**\n\`\`\`\n${stack.slice(0, 2500)}\n\`\`\`` : "",
    ``,
    ...reports,
    ``,
    `**Rules for this ${mode === "fix" ? "fix" : "change"}:**`,
    `- Make the smallest change that ${mode === "fix" ? "fixes it" : "does what the plan asks"}. Add or update a test in tests/ where practical.`,
    mode === "fix"
      ? `- An automatic fix never touches supabase/migrations, sign-in, RLS or permissions (src/lib/auth.ts, src/proxy.ts, src/lib/supabase/), src/lib/meta-write.ts or anything that writes to ad accounts, billing, secrets or env, .github/, or more than 5 files. If fixing it needs any of that, change nothing: comment on this issue with what it needs, and stop.`
      : `- If it needs a database change, add a migration and say clearly in the PR that it must be applied.`,
    `- If it isn't caused by our code, change nothing: comment on this issue why, and stop.`,
    ``,
    `Kaizen feedback group: \`${groupId}\` · ${SITE()}/feedback?g=${groupId}`,
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n");
}

/** Hand a group to Claude: a small bug merges itself when its checks pass; an approved build opens a PR to review. */
export async function startFix(admin: Admin, groupId: string, autoMerge: boolean, opts: { note?: string | null; actor?: string | null } = {}) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, fix_attempts").eq("id", groupId).single();
  const issue = await openClaudeIssue(`${autoMerge ? "Fix" : "Build"}: ${g?.title}`, await issueBody(admin, groupId, autoMerge ? "fix" : "build", opts.note ?? null), autoMerge);
  if (!issue.url || !issue.number) {
    await logEvent(admin, groupId, "fix_error", issue.error ?? "GitHub didn't take it");
    if (autoMerge) await askForReview(admin, groupId, (g?.title as string) ?? "Feedback", `Couldn't start the automatic fix: ${issue.error ?? "GitHub didn't take it"}`);
    return { error: issue.error ?? "GitHub didn't take it" };
  }
  await admin
    .from("app_feedback_groups")
    .update({
      lane: autoMerge ? "auto_fix" : "build",
      fix_state: "working",
      fix_issue_number: issue.number,
      fix_issue_url: issue.url,
      fix_pr_url: null,
      fix_started_at: new Date().toISOString(),
      fix_attempts: autoMerge ? ((g?.fix_attempts as number) ?? 0) + 1 : (g?.fix_attempts ?? 0),
      updated_at: new Date().toISOString(),
    })
    .eq("id", groupId);
  await logEvent(admin, groupId, autoMerge ? "auto_fix_started" : "build_started", autoMerge ? "Sent to Claude to fix; it ships itself if every check passes" : "Sent to Claude to build; the pull request waits for review", { link: issue.url, actor: opts.actor ?? null });
  return { url: issue.url };
}

/** Marked fixed (by hand or by a merged fix): everyone who reported it hears, once per fix. */
export async function notifyFixed(admin: Admin, groupId: string, actorId: string | null) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, fixed_at").eq("id", groupId).maybeSingle();
  if (!g?.fixed_at) return { notified: 0 };
  const notified = await notifyReporters(admin, groupId, {
    key: `feedback-fixed:${groupId}:${new Date(g.fixed_at as string).getTime()}`,
    title: `Fixed: ${g.title}`,
    body: "Thanks for flagging it. It's fixed in the latest version (refresh if you still see the old behaviour).",
    actor: actorId,
  });
  return { notified };
}

type GhIssue = { state: string; created_at: string };
type GhComment = { body: string };
type GhPull = { html_url: string; state: string; merged_at: string | null; number: number };

async function ghJson<T>(path: string): Promise<T | null> {
  const res = await github(path).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

/** Where each fix in flight stands on GitHub: shipped, waiting on review, failed its checks, or nothing to change. */
export async function syncFixes(admin: Admin) {
  if (!githubConfigured()) return { checked: 0 };
  const { data } = await admin
    .from("app_feedback_groups")
    .select("id, title, lane, status, fix_state, fix_issue_number, fix_issue_url, fix_started_at, fix_pr_url")
    .in("fix_state", ["working", "pr_open"])
    .not("fix_issue_number", "is", null)
    .limit(20);
  const owner = (process.env.GITHUB_REPO || "kaizen-cc/kaizen-ads").split("/")[0];
  let shipped = 0;
  for (const g of data ?? []) {
    const n = g.fix_issue_number as number;
    const [issue, comments, pulls] = await Promise.all([
      ghJson<GhIssue>(`/issues/${n}`),
      ghJson<GhComment[]>(`/issues/${n}/comments?per_page=50`),
      ghJson<GhPull[]>(`/pulls?state=all&head=${owner}:claude/fix-${n}&per_page=5`),
    ]);
    if (!issue) continue;
    const pr = pulls?.[0] ?? null;
    const prComments = pr ? ((await ghJson<GhComment[]>(`/issues/${pr.number}/comments?per_page=50`)) ?? []) : [];
    const out = fixOutcome({
      issueClosed: issue.state === "closed",
      pr: pr ? { url: pr.html_url, open: pr.state === "open", merged: Boolean(pr.merged_at) } : null,
      comments: [...(comments ?? []), ...prComments].map((c) => c.body ?? ""),
      minutesSinceStart: (Date.now() - new Date((g.fix_started_at as string | null) ?? issue.created_at).getTime()) / 60_000,
    });
    const id = g.id as string;
    const prUrl = pr?.html_url ?? null;
    if (out.state === "merged") {
      const commit = out.commit ? commitUrl(out.commit) : null;
      const now = new Date().toISOString();
      await admin.from("app_feedback_groups").update({ status: "fixed", fixed_at: now, fix_state: "merged", fix_pr_url: prUrl, fix_commit_url: commit, updated_at: now }).eq("id", id);
      await logEvent(admin, id, "fixed", g.lane === "build" ? "Built and merged" : "Fixed by Claude; every check passed and it shipped", { link: commit ?? prUrl, shared: true });
      await recomputeGroup(admin, id);
      await notifyFixed(admin, id, null);
      shipped++;
    } else if (out.state === "checks_failed") {
      await admin.from("app_feedback_groups").update({ fix_state: "checks_failed", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, "checks_failed", out.note, { link: prUrl });
      // One more try, then a person (routeGroup applies the limits)
      if (g.lane === "auto_fix") await routeGroup(admin, id);
    } else if (out.state === "protected" || out.state === "no_change") {
      await admin.from("app_feedback_groups").update({ fix_state: out.state === "no_change" ? "no_change" : "pr_open", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, out.state, out.note, { link: prUrl ?? (g.fix_issue_url as string | null) ?? null });
      await askForReview(admin, id, g.title as string, out.note ?? "Needs a look");
    } else if (out.state === "pr_open" && g.fix_pr_url !== prUrl) {
      await admin.from("app_feedback_groups").update({ fix_state: "pr_open", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, "pr_opened", g.lane === "build" ? "Pull request ready for review" : "Pull request open; checks running", { link: prUrl, shared: g.lane === "build" });
    }
  }
  return { checked: data?.length ?? 0, shipped };
}

/** Reports the moment after sending missed (a timeout, a deploy): read now, three tries each. */
export async function triagePending(admin: Admin) {
  const { data } = await admin
    .from("app_feedback")
    .select("id")
    .is("triaged_at", null)
    .lt("triage_tries", 3)
    .lt("created_at", new Date(Date.now() - 2 * 60_000).toISOString())
    .order("created_at")
    .limit(15);
  for (const f of data ?? []) await triageFeedback(admin, f.id as string);
  return { triaged: data?.length ?? 0 };
}

/** Every 15 minutes: missed reports read, fixes in flight checked, queued fixes started as today's limit allows. */
export async function runFeedback(admin: Admin) {
  const triaged = await triagePending(admin);
  const fixes = await syncFixes(admin);
  const { data: queued } = await admin.from("app_feedback_groups").select("id").eq("fix_state", "queued").in("status", ["new", "planned", "in_progress"]).order("priority", { ascending: false }).limit(3);
  for (const q of queued ?? []) await routeGroup(admin, q.id as string);
  return { ...triaged, ...fixes, queued: queued?.length ?? 0 };
}

/** Monday morning: the open items that keep coming up, most important first, to every exec. */
export async function feedbackDigest(admin: Admin) {
  const { data } = await admin
    .from("app_feedback_groups")
    .select("id, title, reports, people")
    .in("status", ["new", "planned", "in_progress"])
    .order("priority", { ascending: false })
    .limit(20);
  const repeating = (data ?? []).filter((g) => (g.reports as number) >= 2);
  const top = (repeating.length ? repeating : (data ?? [])).slice(0, 5);
  if (!top.length) return { sent: 0 };
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const line = (g: (typeof top)[number]) => `${g.title} (${g.reports}× from ${g.people} ${g.people === 1 ? "person" : "people"})`;
  const execs = await execIds(admin);
  for (const exec of execs)
    await admin.from("notifications").upsert(
      {
        profile_id: exec,
        kind: "feedback",
        title: top.length === 1 ? `Feedback this week: ${top[0].title}` : `Feedback this week: ${top[0].title} and ${top.length - 1} more`,
        body: top.map(line).join(" · "),
        href: "/feedback",
        key: `feedback-digest:${date}`,
        priority: "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  return { sent: execs.length, items: top.length };
}
