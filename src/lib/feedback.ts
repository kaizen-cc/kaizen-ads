import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { buildTranscript, transcriptMarkdown, type Transcript } from "@/lib/chat-transcript";
import { closeOn, commentOn, commitUrl, editRepoFile, github, githubConfigured, labelIssue, openClaudeIssue } from "@/lib/claude-fix";
import { sendEmail } from "@/lib/email";
import { errorFingerprint } from "@/lib/error-report";
import {
  AREA_NAMES,
  REPORTER_STATUS,
  SCOPE_LABEL,
  addToRoadmap,
  areaFromRoute,
  autoFixDecision,
  classifyScope,
  closestGroup,
  dailyFixCap,
  fixOutcome,
  groupStats,
  priorityScore,
  reporterStatus,
  widerScope,
  type AiKind,
  type FeedbackType,
  type GroupCandidate,
  type Rail,
  type ReportFacts,
  type ReporterStatus,
  type Scope,
  type Severity,
} from "@/lib/feedback-logic";

// Feedback from the team about the app: from the bubble on any page, or "Report this" / "Ask for this" right under
// an AI message that failed or said it can't. Each report is read by AI (a fast model): a one-line title, a short
// summary, its type and area, how bad it is, whether it's a bug, an Ask or just a note, which safety rail a fix would
// touch, and whether it repeats something already reported. Repeats join that group, so each group counts its
// reports and the distinct people behind them and gets a priority from that.
//
// Then each group takes a path, at once. A bug or an error, of any size, goes to the Claude fix pipeline
// (lib/claude-fix: a GitHub issue labelled claude-fix; the claude-fix workflow has Claude open a pull request and runs
// every check). One that may ship itself is labelled auto-merge and merges when the checks pass. One whose fix
// touches the safety rails (the database, sign-in and permissions, ad-account writes, billing, secrets, the pipeline,
// or a very large change) is built the same way but waits: the owner gets "Fix ready to approve" (bell and email)
// with Approve and merge or Ask for changes. A feature request never starts a fix: it reaches the owner as an Ask
// (build now, plan it on the roadmap, ask for more, or won't do). The people who reported it hear each step:
// received, building, fix ready, live, or with the owner. Every step is logged on the group.

type Admin = SupabaseClient;
export const FEEDBACK_BUCKET = "feedback";
const SITE = () => process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";
const fixCap = () => dailyFixCap(process.env.FEEDBACK_FIXES_PER_DAY);
const APPROVED_LABEL = { name: "approved-merge", color: "1F6FEB", description: "The owner approved this fix: the claude-fix workflow merges it once every check passes" };

const execs = async (admin: Admin) =>
  ((await admin.from("profiles").select("id, email").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null)).data ?? []) as { id: string; email: string | null }[];

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

/** The reporters hear where their report stands now (once per step, per fix). */
async function tellStatus(admin: Admin, groupId: string, extra = "") {
  const { data: g } = await admin.from("app_feedback_groups").select("title, status, lane, scope, fix_state, fix_issue_number").eq("id", groupId).maybeSingle();
  if (!g) return;
  const s: ReporterStatus = reporterStatus({ status: g.status as string, lane: g.lane as string, scope: g.scope as string, fixState: (g.fix_state as string | null) ?? null });
  if (s === "received" || s === "live" || s === "wont_do") return; // received shows on the report; live and won't do have their own notices
  const info = REPORTER_STATUS[s];
  await notifyReporters(admin, groupId, {
    key: `feedback-reply:status:${groupId}:${s}:${g.fix_issue_number ?? 0}`,
    title: `${info.label}: ${g.title}`,
    body: `${info.note}${extra ? ` ${extra}` : ""}`,
  });
}

/**
 * The owner hears: a bell for every exec (an alert) and an email, once per key. Used for "Fix ready to approve", a
 * new Ask, and anything the pipeline couldn't finish.
 */
export async function notifyOwner(admin: Admin, n: { key: string; title: string; body: string; href: string }) {
  const people = await execs(admin);
  if (!people.length) return 0;
  const { count } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("key", n.key);
  for (const p of people)
    await admin.from("notifications").upsert(
      { profile_id: p.id, kind: "feedback", title: n.title.slice(0, 300), body: n.body.slice(0, 1000), href: n.href, key: n.key, priority: "normal" },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  if (count) return 0; // already told
  const url = `${SITE()}${n.href}`;
  const to = people.map((p) => p.email).filter((e): e is string => Boolean(e));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  if (to.length)
    await sendEmail({
      to,
      subject: n.title.slice(0, 200),
      text: `${n.title}\n\n${n.body}\n\n${url}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#17131a"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c8102e;margin:0 0 14px">Kaizen Ads · Feedback</p><p style="font-size:17px;font-weight:600;margin:0 0 8px">${esc(n.title)}</p><p style="font-size:14px;color:#4a4450;white-space:pre-wrap;margin:0 0 18px">${esc(n.body)}</p><a href="${url}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#17131a;color:#ffffff;font-size:13px;font-weight:600;text-decoration:none">Open it</a></div>`,
    }).catch(() => null);
  return people.length;
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The issue or ask in one short line (under 80 characters), plain words" },
    summary: { type: "string", description: "One or two sentences: what they hit or want, where, and why it matters" },
    type: { type: "string", enum: ["bug", "idea", "confusing"] },
    area: { type: "string", enum: AREA_NAMES },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    blocksWork: { type: "boolean", description: "True only when it stops them doing their work (no way around it)" },
    kind: {
      type: "string",
      enum: ["bug", "feature", "unclear"],
      description:
        "bug: something in the app is broken, wrong or failed (an error, wrong numbers, a crash, a confusing label), whatever its size. feature: asks for new behaviour, or for the AI to do something it can't yet. unclear: it doesn't describe anything going wrong (a note, an instruction meant for a chat or a task like 'lets launch a campaign', a test, or too vague to act on).",
    },
    rail: {
      type: "string",
      enum: ["none", "database", "auth", "ad_accounts", "billing", "secrets", "pipeline", "very_large"],
      description:
        "For a bug: what the fix would likely have to touch. database: a migration or schema change. auth: sign-in, RLS, roles or permissions. ad_accounts: anything that writes to Meta or Google ad accounts (launching, pausing, budgets). billing. secrets: keys, tokens or env. pipeline: .github or the fix pipeline. very_large: many files across several areas. none: a contained fix in app code (wrong numbers in a report or a page are none).",
    },
    plan: { type: "string", description: "For a feature: a proposed plan in 3 to 6 short steps. For a bug: the likely cause and fix in one or two lines. For unclear: the question to ask the reporter." },
    whatWentWrong: { type: "string", description: "When a chat transcript is attached: what went wrong and where in the chat, in two or three sentences (the step, the tool or route that failed, what the person was trying to do). Otherwise an empty string." },
    duplicateOf: { type: "integer", description: "The number of the existing item this is the same as, or 0 when it's new" },
  },
  required: ["title", "summary", "type", "area", "severity", "blocksWork", "kind", "rail", "plan", "whatWentWrong", "duplicateOf"],
  additionalProperties: false,
};

type Read = {
  title: string;
  summary: string;
  type: FeedbackType;
  area: string;
  severity: Severity;
  blocksWork: boolean;
  scope: Scope;
  scopeReason: string;
  rail: Rail | null;
  unclear: boolean;
  plan: string | null;
  whatWentWrong: string | null;
  groupId: string | null;
};

type ChatCtx = { key?: string; kind?: string; label?: string; mode?: "error" | "cant"; transcript?: { json?: string; md?: string; summary?: string | null } | null };

/** A report's stored transcript (the JSON in the feedback bucket), or null. */
export async function readTranscript(admin: Admin, path: string | null | undefined): Promise<Transcript | null> {
  if (!path) return null;
  const { data } = await admin.storage.from(FEEDBACK_BUCKET).download(path);
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as Transcript;
  } catch {
    return null;
  }
}

async function readReport(f: { type: string; message: string; route: string | null; context: Record<string, unknown> }, groups: GroupCandidate[], transcript: Transcript | null): Promise<Read> {
  const area = areaFromRoute(f.route);
  const errors = ((f.context.consoleErrors as { message: string }[] | undefined) ?? []).slice(-5).map((e) => e.message);
  const failed = ((f.context.failedRequests as { method: string; url: string; status: number | null }[] | undefined) ?? []).slice(-5).map((r) => `${r.method} ${r.url} ${r.status ?? "failed"}`);
  const chat = (f.context.chat ?? null) as ChatCtx | null;
  const md = transcript ? transcriptMarkdown(buildTranscript(transcript, 40_000)) : null;
  try {
    const out = await askJson<Omit<Read, "groupId" | "scopeReason" | "scope" | "rail" | "unclear"> & { kind: AiKind; rail: Rail | "none"; duplicateOf: number }>({
      agent: "briefing",
      label: "feedback triage",
      bare: true,
      maxTokens: 2500,
      system: `You triage feedback the Kaizen Marketing team leaves about Kaizen Ads, their internal app (creative requests, a board, client pages, KPIs, reports, an AI chat, a client portal, a launcher that writes to Meta and Google ad accounts). Some reports come from a chat, with its whole transcript: read it to see what the person was trying to do and where it went wrong. Read one report and: write a short title and summary in plain words; confirm or correct its type (bug: broken or wrong; idea: an improvement; confusing: hard to find or understand); pick the area of the app; rate severity (high: data wrong or lost, or a core flow broken for everyone; medium: a real problem with a workaround; low: cosmetic or a nice-to-have); say whether it blocks their work; say whether it's a bug, a feature, or unclear (a note or an instruction that doesn't describe anything going wrong is unclear, never a bug); for a bug, name the safety rail its fix would touch, if any; and propose a plan. Then decide whether it is the same issue or request as one of the existing items listed (the same problem in the same place, said differently). Only match when it really is the same thing; related is not the same. Answer 0 when it's new.`,
      prompt: `The report (they picked "${f.type}"${chat?.mode ? `, sent with "${chat.mode === "error" ? "Report this" : "Ask for this"}" from ${chat.label ?? "a chat"}` : ""}), left on ${f.route ?? "an unknown page"} (area by its page: ${area}):
"""
${f.message.slice(0, 3000)}
"""
${errors.length ? `Console errors just before:\n${errors.map((e) => `- ${e}`).join("\n")}\n` : ""}${failed.length ? `Failed requests just before:\n${failed.map((e) => `- ${e}`).join("\n")}\n` : ""}${md ? `\nThe chat's transcript:\n<transcript>\n${md}\n</transcript>\n` : ""}
Existing items:
${groups.length ? groups.map((g, i) => `${i + 1}. [${g.type} · ${g.area}${g.status === "fixed" ? " · marked fixed" : ""}] ${g.title}${g.summary ? `: ${g.summary}` : ""}`).join("\n") : "(none yet)"}`,
      schema: SCHEMA,
    });
    const match = out.duplicateOf > 0 ? groups[out.duplicateOf - 1] : undefined;
    const finalArea = AREA_NAMES.includes(out.area) ? out.area : area;
    // A chat's error is a bug whatever the wording; an "Ask for this" is an Ask
    const aiKind: AiKind = chat?.mode === "error" ? "bug" : chat?.mode === "cant" ? "feature" : out.kind;
    const scope = classifyScope({ aiKind, aiRail: out.rail, type: chat?.mode === "error" ? "bug" : out.type, text: `${f.message} ${out.summary}`, note: chat?.mode ? undefined : f.message, area: finalArea });
    return {
      title: out.title.slice(0, 140),
      summary: out.summary.slice(0, 600),
      type: out.type,
      area: finalArea,
      severity: out.severity,
      blocksWork: out.blocksWork,
      scope: scope.scope,
      scopeReason: scope.reason,
      rail: scope.rail,
      unclear: scope.unclear,
      plan: out.plan?.slice(0, 2000) || null,
      whatWentWrong: out.whatWentWrong?.trim().slice(0, 1200) || null,
      groupId: match?.id ?? null,
    };
  } catch (e) {
    // No AI (or it failed): grouped by wording, the rest from what they picked and where they were. A bug still goes
    // to the pipeline, behind approval since nothing read how big it is.
    console.error("[feedback] triage without AI:", e instanceof Error ? e.message : e);
    const first = f.message.split(/(?<=[.!?])\s|\n/)[0].trim();
    const scope = classifyScope({ aiKind: f.type === "idea" || chat?.mode === "cant" ? "feature" : "bug", aiRail: "very_large", type: f.type, text: f.message, note: chat?.mode ? undefined : f.message, area });
    return {
      title: (first.length > 90 ? `${first.slice(0, 87)}...` : first) || "Feedback",
      summary: f.message.slice(0, 300),
      type: f.type as FeedbackType,
      area,
      severity: f.type === "bug" ? "medium" : "low",
      blocksWork: false,
      scope: scope.scope,
      scopeReason: scope.scope === "big_issue" ? "Read without AI, so the fix waits for approval" : scope.reason,
      rail: scope.rail,
      unclear: scope.unclear,
      plan: null,
      whatWentWrong: null,
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

const laneFor = (scope: Scope): "auto_fix" | "review" | "build" => (scope === "small_bug" ? "auto_fix" : scope === "big_issue" ? "build" : "review");

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
    const chat = (context.chat ?? null) as ChatCtx | null;
    const transcript = await readTranscript(admin, chat?.transcript?.json);
    const read = await readReport({ type: f.type as string, message: f.message as string, route: (f.route as string | null) ?? null, context }, (groups ?? []) as GroupCandidate[], transcript);

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
    if (groupId) {
      const { data: g } = await admin.from("app_feedback_groups").select("status, scope, lane, fix_state, error_fingerprint").eq("id", groupId).maybeSingle();
      const scope = widerScope((g?.scope as Scope | undefined) ?? "feature", read.scope);
      const reopened = g?.status === "fixed";
      const inFlight = ["working", "pr_open", "queued"].includes((g?.fix_state as string | null) ?? "");
      // A report that needs approval takes a fix out of the ships-itself path, unless one is already on its way; a bug
      // report on an Ask makes it a fix (the dedupe keeps it one fix, not two)
      const lane = reopened || !inFlight ? laneFor(scope) : (g?.lane as string);
      await admin
        .from("app_feedback_groups")
        .update({
          scope,
          ...(scope !== g?.scope ? { scope_reason: read.scopeReason } : {}),
          ...(g?.lane !== "build" || reopened ? { lane } : {}),
          // Reported again after it was marked fixed: it's back on the list, and gets a fresh try
          ...(reopened ? { status: "new", fixed_at: null, fixed_by: null, fix_state: null, fix_attempts: 0 } : {}),
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
          lane: laneFor(read.scope),
        })
        .select("id")
        .single();
      groupId = (g?.id as string | undefined) ?? null;
      if (groupId) await logEvent(admin, groupId, "triaged", `${SCOPE_LABEL[read.scope]}: ${read.scopeReason}`);
    }
    await admin
      .from("app_feedback")
      .update({
        summary: read.summary,
        area: read.area,
        severity: read.severity,
        blocks_work: read.blocksWork,
        scope: read.scope,
        group_id: groupId,
        triaged_at: new Date().toISOString(),
        // What went wrong in the chat, in short: on the review card and the GitHub issue
        ...(chat?.transcript && read.whatWentWrong ? { context: { ...context, chat: { ...chat, transcript: { ...chat.transcript, summary: read.whatWentWrong } } } } : {}),
      })
      .eq("id", id);
    if (!groupId) return;
    await recomputeGroup(admin, groupId);
    // A note, not a bug: the reporter is asked what they meant, once
    if (read.unclear) {
      const eventId = await logEvent(admin, groupId, "comment", "This reads like a note or an instruction rather than something going wrong. What were you trying to do, and what happened? If it was meant for a chat, send it there.", { shared: true });
      await notifyReporters(admin, groupId, { key: `feedback-reply:${eventId}`, title: `About your feedback: ${read.title}`, body: "It reads like a note rather than something going wrong. Tell us what you were trying to do and what happened." });
    }
    await routeGroup(admin, groupId);
  } catch (e) {
    console.error("[feedback] triage failed:", e instanceof Error ? e.message : e);
  }
}

/** The owner looks at something the pipeline couldn't finish (once per reason). */
async function needsALook(admin: Admin, groupId: string, title: string, reason: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("lane").eq("id", groupId).maybeSingle();
  if (g?.lane !== "review") await admin.from("app_feedback_groups").update({ lane: "review", updated_at: new Date().toISOString() }).eq("id", groupId);
  const { count } = await admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("kind", "needs_review").eq("body", reason);
  if (count) return;
  await logEvent(admin, groupId, "needs_review", reason);
  await notifyOwner(admin, { key: `feedback-review:look:${groupId}:${reason.slice(0, 40)}`, title: `A fix needs a look: ${title}`, body: reason, href: `/feedback?section=approval&g=${groupId}` });
  await tellStatus(admin, groupId);
}

/** A new Ask reaches the owner (once). */
async function askOwner(admin: Admin, groupId: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, summary, scope_reason").eq("id", groupId).maybeSingle();
  if (!g) return;
  const { data: who } = await admin.from("app_feedback").select("author:profiles!app_feedback_profile_id_fkey(full_name)").eq("group_id", groupId).order("created_at").limit(1).maybeSingle();
  const by = (who?.author as unknown as { full_name: string } | null)?.full_name ?? "Someone on the team";
  const { count } = await admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("group_id", groupId).eq("kind", "needs_review");
  if (!count) await logEvent(admin, groupId, "needs_review", (g.scope_reason as string | null) ?? "An Ask");
  await notifyOwner(admin, { key: `feedback-review:ask:${groupId}`, title: `New ask from ${by}: ${g.title}`, body: (g.summary as string | null) ?? "", href: `/feedback?section=asks&g=${groupId}` });
  await tellStatus(admin, groupId);
}

/** Send a group down its path: a fix now (or next, within today's cap), an Ask for the owner, or a look when it's stuck. */
export async function routeGroup(admin: Admin, groupId: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("id, title, status, scope, scope_reason, lane, fix_state, fix_attempts").eq("id", groupId).maybeSingle();
  if (!g) return;
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: started }, { count: failed }] = await Promise.all([
    admin.from("app_feedback_events").select("id", { count: "exact", head: true }).in("kind", ["auto_fix_started", "build_started"]).gte("created_at", day),
    admin.from("app_feedback_events").select("id", { count: "exact", head: true }).eq("kind", "checks_failed").gte("created_at", day),
  ]);
  const d = autoFixDecision({
    scope: g.scope as Scope,
    status: g.status as string,
    lane: g.lane as string,
    fixState: (g.fix_state as string | null) ?? null,
    attempts: g.fix_attempts as number,
    startedToday: started ?? 0,
    failedToday: failed ?? 0,
    github: githubConfigured(),
    cap: fixCap(),
  });
  if (d.action === "start") await startFix(admin, groupId, d.autoMerge, { reason: d.autoMerge ? null : ((g.scope_reason as string | null) ?? d.reason) });
  else if (d.action === "wait") {
    if (g.fix_state !== "queued") {
      await admin.from("app_feedback_groups").update({ lane: g.lane === "review" ? laneFor(g.scope as Scope) : g.lane, fix_state: "queued" }).eq("id", groupId);
      await logEvent(admin, groupId, "queued", d.reason);
      await tellStatus(admin, groupId);
    }
  } else if (d.action === "ask") await askOwner(admin, groupId);
  else if (d.action === "stuck") await needsALook(admin, groupId, g.title as string, d.reason);
}

/** Everything known about a group, for Claude: the reports, where, what the browser saw, chat transcripts, and the screenshots. */
async function issueBody(admin: Admin, groupId: string, mode: "fix" | "approval" | "build", note: string | null, reason: string | null) {
  const [{ data: g }, { data: rows }, { data: prev }] = await Promise.all([
    admin.from("app_feedback_groups").select("title, summary, type, area, scope, plan, reports, people, error_fingerprint, fix_pr_url").eq("id", groupId).single(),
    admin.from("app_feedback").select("message, route, page_url, context, screenshot_path, created_at, author:profiles!app_feedback_profile_id_fkey(role)").eq("group_id", groupId).order("created_at", { ascending: false }).limit(6),
    admin.from("app_feedback_events").select("body, link").eq("group_id", groupId).in("kind", ["checks_failed", "changes_asked"]).order("created_at", { ascending: false }).limit(3),
  ]);
  const shots = (rows ?? []).map((r) => r.screenshot_path as string | null).filter((p): p is string => Boolean(p));
  const signed = shots.length ? ((await admin.storage.from(FEEDBACK_BUCKET).createSignedUrls(shots, 7 * 86_400)).data ?? []) : [];
  let stack: string | null = null;
  if (g?.error_fingerprint) {
    const { data: ev } = await admin.from("error_events").select("message, sample").eq("fingerprint", g.error_fingerprint).maybeSingle();
    stack = ev ? `${ev.message}\n${((ev.sample ?? {}) as { stack?: string }).stack ?? ""}`.trim() : null;
  }
  // GitHub takes a body up to 65,536 characters: transcripts go inline while they fit, linked otherwise
  let room = 52_000;
  const reports: string[] = [];
  for (const [i, r] of (rows ?? []).entries()) {
    const c = (r.context ?? {}) as Record<string, unknown>;
    const chat = (c.chat ?? null) as ChatCtx | null;
    const errs = ((c.consoleErrors as { message: string }[] | undefined) ?? []).slice(-6).map((e) => `  - ${e.message}`);
    const reqs = ((c.failedRequests as { method: string; url: string; status: number | null }[] | undefined) ?? []).slice(-6).map((q) => `  - ${q.method} ${q.url} ${q.status ?? "failed"}`);
    const shot = signed.find((s) => s.path === r.screenshot_path)?.signedUrl;
    let transcript = "";
    if (chat?.transcript?.json) {
      const t = await readTranscript(admin, chat.transcript.json);
      const link = chat.transcript.md ? (await admin.storage.from(FEEDBACK_BUCKET).createSignedUrl(chat.transcript.md, 30 * 86_400)).data?.signedUrl : null;
      const md = t ? transcriptMarkdown(buildTranscript(t, Math.max(4000, Math.min(room, 45_000))), "Transcript") : null;
      const fits = md && md.length + 200 < room;
      if (fits) room -= md.length + 200;
      transcript = [
        chat.transcript.summary ? `- **What went wrong in the chat:** ${chat.transcript.summary}` : "",
        fits ? `<details><summary>The whole chat (${t?.entries.length ?? 0} messages${t?.cut ? `, ${t.cut} characters of long tool output cut` : ""})</summary>\n\n${md}\n\n</details>` : "",
        link ? `- Full transcript (link valid 30 days): ${link}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    reports.push(
      [
        `### Report ${i + 1} (${(r.author as unknown as { role: string } | null)?.role ?? "team member"}, ${new Date(r.created_at as string).toISOString().slice(0, 10)})`,
        `> ${String(r.message).replace(/\n/g, "\n> ")}`,
        `- Page: \`${r.route ?? "unknown"}\` (${r.page_url ?? ""})`,
        chat?.kind ? `- From: ${chat.label ?? chat.kind} (${chat.mode === "error" ? "Report this" : "Ask for this"})` : `- Screen: ${c.viewport ?? "?"} · ${c.userAgent ?? "unknown browser"} · app version ${c.version ?? "?"}`,
        errs.length ? `- Console errors just before:\n${errs.join("\n")}` : "",
        reqs.length ? `- Failed requests just before:\n${reqs.join("\n")}` : "",
        shot ? `- Screenshot (link valid 7 days): ${shot}` : "",
        transcript,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [
    mode === "fix"
      ? `Reported by the team and sent to Claude automatically as a bug. It merges itself once every check passes.`
      : mode === "approval"
        ? `Reported by the team as a bug and sent to Claude at once. ${reason ?? "Its fix may touch a safety rail"}: build the fix on a pull request as usual; it is not merged automatically, the owner approves it.`
        : `An Ask from the team that the owner approved to build. Open a pull request; the owner approves it before it merges.`,
    ``,
    `**${g?.title}**`,
    g?.summary ?? "",
    `Area: ${g?.area} · reported ${g?.reports}× by ${g?.people} ${g?.people === 1 ? "person" : "people"}`,
    g?.plan ? `\n**${mode === "build" ? "Proposed plan" : "Likely fix"}:**\n${g.plan}` : "",
    note ? `\n**The owner's note:** ${note}` : "",
    (prev ?? []).length ? `\n**Earlier attempts:** ${(prev ?? []).map((p) => [p.body, p.link].filter(Boolean).join(" ")).join(" · ")}. Read why before trying again.` : "",
    stack ? `\n**The error monitor recorded:**\n\`\`\`\n${stack.slice(0, 2500)}\n\`\`\`` : "",
    ``,
    ...reports,
    ``,
    `**Rules for this ${mode === "build" ? "change" : "fix"}:**`,
    `- Make the smallest change that ${mode === "build" ? "does what the plan asks" : "fixes it"}. Add or update a test in tests/ where practical.`,
    mode === "fix"
      ? `- This fix should stay out of supabase/migrations, sign-in, RLS or permissions (src/lib/auth.ts, src/proxy.ts, src/lib/supabase/), src/lib/meta-write.ts, src/lib/google-write* or anything else that writes to ad accounts, billing, secrets or env, and .github/. If the real fix needs any of that, make it anyway on the pull request: it then waits for the owner's approval instead of merging itself. Say clearly in the PR what it touches.`
      : `- If it needs a database change, add an idempotent migration in supabase/migrations/ and say clearly in the PR that it must be applied; code must still work before it's applied.`,
    `- If it isn't caused by our code, or there is nothing to change, change nothing: comment on this issue why, and stop.`,
    ``,
    `Kaizen feedback group: \`${groupId}\` · ${SITE()}/feedback?g=${groupId}`,
  ]
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .slice(0, 64_000);
}

/**
 * Hand a group to Claude. autoMerge: it ships itself when every check passes. Otherwise the pull request waits for
 * the owner's approval (a bug at the safety rails, or an Ask the owner said to build).
 */
export async function startFix(admin: Admin, groupId: string, autoMerge: boolean, opts: { note?: string | null; actor?: string | null; reason?: string | null } = {}) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, scope, fix_attempts").eq("id", groupId).single();
  const mode = autoMerge ? "fix" : g?.scope === "feature" ? "build" : "approval";
  const issue = await openClaudeIssue(`${mode === "build" ? "Build" : "Fix"}: ${g?.title}`, await issueBody(admin, groupId, mode, opts.note ?? null, opts.reason ?? null), autoMerge);
  if (!issue.url || !issue.number) {
    await logEvent(admin, groupId, "fix_error", issue.error ?? "GitHub didn't take it");
    await needsALook(admin, groupId, (g?.title as string) ?? "Feedback", `Couldn't start the fix: ${issue.error ?? "GitHub didn't take it"}`);
    return { error: issue.error ?? "GitHub didn't take it" };
  }
  await admin
    .from("app_feedback_groups")
    .update({
      lane: autoMerge ? "auto_fix" : "build",
      status: "in_progress",
      fix_state: "working",
      fix_issue_number: issue.number,
      fix_issue_url: issue.url,
      fix_pr_url: null,
      fix_started_at: new Date().toISOString(),
      fix_attempts: ((g?.fix_attempts as number) ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", groupId);
  await logEvent(
    admin,
    groupId,
    autoMerge ? "auto_fix_started" : "build_started",
    autoMerge ? "Sent to Claude to fix; it ships itself if every check passes" : mode === "build" ? "Sent to Claude to build; the pull request waits for approval" : `Sent to Claude to fix; ${opts.reason ?? "it waits for approval before it merges"}`,
    { link: issue.url, actor: opts.actor ?? null, shared: true },
  );
  await tellStatus(admin, groupId);
  return { url: issue.url };
}

/** Marked fixed (by hand or by a merged fix): everyone who reported it hears, once per fix. */
export async function notifyFixed(admin: Admin, groupId: string, actorId: string | null) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, fixed_at").eq("id", groupId).maybeSingle();
  if (!g?.fixed_at) return { notified: 0 };
  const notified = await notifyReporters(admin, groupId, {
    key: `feedback-fixed:${groupId}:${new Date(g.fixed_at as string).getTime()}`,
    title: `Live: ${g.title}`,
    body: REPORTER_STATUS.live.note,
    actor: actorId,
  });
  return { notified };
}

// ─── The owner's decisions ──────────────────────────────────────────────────

const issueOf = async (admin: Admin, groupId: string) =>
  (await admin.from("app_feedback_groups").select("title, fix_issue_number, fix_pr_url, lane, fix_state").eq("id", groupId).maybeSingle()).data as {
    title: string;
    fix_issue_number: number | null;
    fix_pr_url: string | null;
    lane: string;
    fix_state: string | null;
  } | null;

/** Approve and merge: the workflow runs every check again and merges it as kaizen-cc; the sync picks up the merge. */
export async function approveMerge(admin: Admin, groupId: string, actor: string) {
  const g = await issueOf(admin, groupId);
  if (!g?.fix_issue_number || !g.fix_pr_url) return { error: "There's no pull request to merge yet." };
  const r = await labelIssue(g.fix_issue_number, [APPROVED_LABEL.name], APPROVED_LABEL);
  if ("error" in r) return { error: `GitHub didn't take the approval: ${r.error}` };
  await logEvent(admin, groupId, "merge_approved", "Approved: merging once every check passes", { actor, link: g.fix_pr_url, shared: true });
  return { ok: true as const };
}

/** Ask for changes: this pull request is closed and Claude builds it again with the owner's note (still needing approval). */
export async function askForChanges(admin: Admin, groupId: string, note: string, actor: string) {
  const g = await issueOf(admin, groupId);
  if (!g?.fix_issue_number) return { error: "There's no fix to change yet." };
  const prNumber = Number(g.fix_pr_url?.match(/\/pull\/(\d+)/)?.[1] ?? 0);
  if (prNumber) {
    await commentOn(prNumber, `The owner asked for changes: ${note}\n\nClosed; Claude is building it again with this note.`);
    await closeOn(prNumber, "pull");
  }
  await closeOn(g.fix_issue_number, "issue");
  await logEvent(admin, groupId, "changes_asked", note, { actor, link: g.fix_pr_url });
  await admin.from("app_feedback_groups").update({ fix_state: null, fix_attempts: 0, lane: "build" }).eq("id", groupId);
  return startFix(admin, groupId, false, { note, actor, reason: "The owner asked for changes; the new fix waits for approval too" });
}

/** Plan it: a line under "Requested by the team" on the roadmap, and the group is planned. */
export async function planOnRoadmap(admin: Admin, groupId: string, actor: string) {
  const { data: g } = await admin.from("app_feedback_groups").select("title, summary, people").eq("id", groupId).maybeSingle();
  if (!g) return { error: "That one is gone." };
  const date = new Date().toISOString().slice(0, 10);
  const line = `**${g.title}** (${date}, asked by ${g.people} ${g.people === 1 ? "person" : "people"}): ${(g.summary as string | null) ?? ""}`.replace(/—/g, ",");
  const r = await editRepoFile("docs/ROADMAP.md", `Roadmap: plan "${String(g.title).slice(0, 60)}" (requested by the team)`, (md) => addToRoadmap(md, line));
  if ("error" in r) return { error: `Couldn't add it to the roadmap: ${r.error}` };
  await admin.from("app_feedback_groups").update({ status: "planned", updated_at: new Date().toISOString() }).eq("id", groupId);
  await logEvent(admin, groupId, "planned", "Planned: on the roadmap under Requested by the team", { actor, link: r.url, shared: true });
  await notifyReporters(admin, groupId, { key: `feedback-reply:planned:${groupId}`, title: `Planned: ${g.title}`, body: "It's on the roadmap. You'll hear when it's built.", actor });
  return { ok: true as const };
}

type GhIssue = { state: string; created_at: string };
type GhComment = { body: string };
type GhPull = { html_url: string; state: string; merged_at: string | null; number: number };

async function ghJson<T>(path: string): Promise<T | null> {
  const res = await github(path).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

/** Where each fix in flight stands on GitHub: live, ready to approve, failed its checks, or nothing to change. */
export async function syncFixes(admin: Admin) {
  if (!githubConfigured()) return { checked: 0 };
  const { data } = await admin
    .from("app_feedback_groups")
    .select("id, title, lane, status, scope, fix_state, fix_issue_number, fix_issue_url, fix_started_at, fix_pr_url")
    .in("fix_state", ["working", "pr_open"])
    .not("fix_issue_number", "is", null)
    .limit(30);
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
      await logEvent(admin, id, "fixed", g.lane === "build" ? "Approved and merged: live with this deploy" : "Fixed by Claude; every check passed and it shipped", { link: commit ?? prUrl, shared: true });
      await recomputeGroup(admin, id);
      await notifyFixed(admin, id, null);
      shipped++;
    } else if (out.state === "checks_failed") {
      await admin.from("app_feedback_groups").update({ fix_state: "checks_failed", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, "checks_failed", out.note, { link: prUrl });
      // One more try, then the owner (routeGroup applies the limits)
      await routeGroup(admin, id);
    } else if (out.state === "ready") {
      // Built, every check passed, and it waits for approval (planned that way, or the workflow found it touches a rail)
      const moved = g.lane !== "build" || g.fix_state !== "pr_open" || g.fix_pr_url !== prUrl;
      if (moved) {
        await admin.from("app_feedback_groups").update({ lane: "build", fix_state: "pr_open", fix_pr_url: prUrl }).eq("id", id);
        await logEvent(admin, id, "fix_ready", out.note, { link: prUrl, shared: true });
      }
      await notifyOwner(admin, { key: `feedback-review:approve:${id}:${pr?.number ?? n}`, title: `Fix ready to approve: ${g.title}`, body: `Every check passed. ${out.note ?? ""}`.trim(), href: `/feedback?section=approval&g=${id}` });
      if (moved) await tellStatus(admin, id);
    } else if (out.state === "no_change") {
      await admin.from("app_feedback_groups").update({ fix_state: "no_change", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, "no_change", out.note, { link: (g.fix_issue_url as string | null) ?? null });
      await needsALook(admin, id, g.title as string, out.note ?? "Claude found nothing to change");
    } else if (out.state === "pr_open" && g.fix_pr_url !== prUrl) {
      await admin.from("app_feedback_groups").update({ fix_state: "pr_open", fix_pr_url: prUrl }).eq("id", id);
      await logEvent(admin, id, "pr_opened", "Pull request open; checks running", { link: prUrl });
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

/** Every 15 minutes: missed reports read, fixes in flight checked, queued fixes started as today's cap allows. */
export async function runFeedback(admin: Admin) {
  const triaged = await triagePending(admin);
  const fixes = await syncFixes(admin);
  const { data: queued } = await admin.from("app_feedback_groups").select("id").eq("fix_state", "queued").in("status", ["new", "planned", "in_progress"]).order("priority", { ascending: false }).limit(fixCap());
  for (const q of queued ?? []) await routeGroup(admin, q.id as string);
  // Bugs left waiting on a review by the old routing: they go to the pipeline now
  const { data: waiting } = await admin.from("app_feedback_groups").select("id").eq("lane", "review").neq("scope", "feature").is("fix_state", null).eq("status", "new").order("priority", { ascending: false }).limit(3);
  for (const w of waiting ?? []) await routeGroup(admin, w.id as string);
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
  const people = await execs(admin);
  for (const exec of people)
    await admin.from("notifications").upsert(
      {
        profile_id: exec.id,
        kind: "feedback",
        title: top.length === 1 ? `Feedback this week: ${top[0].title}` : `Feedback this week: ${top[0].title} and ${top.length - 1} more`,
        body: top.map(line).join(" · "),
        href: "/feedback",
        key: `feedback-digest:${date}`,
        priority: "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  return { sent: people.length, items: top.length };
}
