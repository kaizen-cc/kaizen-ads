import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { EmailAuditResult } from "./audit-core";
import { emailTeamFor, whoHears } from "./people";
import { emailScoreOf } from "./score";
import { movement, nextCheckAt, plainMessage, snapshotOf, tally, verdictOf, type ScoreSnapshot, type SprintVerdict } from "./sprint-core";

// Email sprints: an audit's plan followed to done with the email strategist, like the ads sprints. Actions are ticked
// off (todo, doing, done, skipped); a check re-measures the email score and its seven checks, tells the strategist what
// moved, and decides when to look again. A sprint closes itself once the account is back in the green.

/** Opens the client's sprint from a finished audit: every action of its plan, or only `only` (one move added to the list). One live sprint per client: an older one is closed, never deleted. */
export async function openEmailSprint(admin: SupabaseClient, auditId: string, by: string | null, only?: number): Promise<string | null> {
  const { data: a } = await admin.from("email_audits").select("id, client_id, status, result, inputs").eq("id", auditId).maybeSingle();
  if (!a || a.status !== "ready") return null;
  const clientId = a.client_id as string;
  const plan = ((a.result as EmailAuditResult | null)?.actions ?? []).map((x, i) => ({ x, i })).filter(({ i }) => only === undefined || i === only);
  if (!plan.length) return null;

  const { data: live } = await admin.from("email_sprints").select("id, audit_id").eq("client_id", clientId).eq("status", "active").maybeSingle();
  let sprintId = live?.id as string | undefined;
  // A move added from the same audit goes onto the sprint already open; a newer audit replaces it
  if (live && live.audit_id !== auditId) {
    await admin.from("email_sprints").update({ status: "closed", closed_at: new Date().toISOString(), close_note: "Replaced by a newer audit" }).eq("id", live.id);
    sprintId = undefined;
  }
  if (!sprintId) {
    const owner = whoHears(await emailTeamFor(admin, clientId))[0] ?? by;
    const snap = ((a.inputs as { snapshot?: ScoreSnapshot } | null)?.snapshot ?? null) as ScoreSnapshot | null;
    const now = snap ?? (await emailScoreOf(admin, clientId).then((s) => (s ? snapshotOf(s) : null)).catch(() => null));
    const { data: s, error } = await admin
      .from("email_sprints")
      .insert({ client_id: clientId, audit_id: auditId, owner_id: owner ?? null, created_by: by, watcher_ids: by && by !== owner ? [by] : [], baseline: now ?? {}, latest: now ?? {}, next_check_at: nextCheckAt("started") })
      .select("id")
      .single();
    if (error || !s) throw new Error(error?.message ?? "Couldn't open the sprint");
    sprintId = s.id as string;
    await admin.from("email_sprint_checks").insert({ sprint_id: sprintId, verdict: "started", message: now ? `Sprint started with the score at ${now.score}. The moves marked for today come first.` : "Sprint started.", score: now ?? {}, next_check_at: nextCheckAt("started") });
  }
  const { data: have } = await admin.from("email_sprint_actions").select("audit_index, sort_order").eq("sprint_id", sprintId);
  const taken = new Set((have ?? []).map((h) => h.audit_index as number));
  const base = (have ?? []).reduce((n, h) => Math.max(n, (h.sort_order as number) + 1), 0);
  const rows = plan.filter(({ i }) => !taken.has(i)).map(({ x, i }, k) => ({ sprint_id: sprintId, audit_index: i, title: x.title, area: x.area, owner: x.owner, when: x.when, steps: x.steps, why: x.why, impact: x.impact, sort_order: base + k }));
  if (rows.length) await admin.from("email_sprint_actions").insert(rows);
  return sprintId;
}

type CheckOut = { message: string };

/** One check: re-measure the score, tally the moves, say what moved, decide when to look again. Never throws. */
export async function checkEmailSprint(admin: SupabaseClient, sprintId: string) {
  const { data: s } = await admin.from("email_sprints").select("id, client_id, owner_id, watcher_ids, status, baseline, clients(name)").eq("id", sprintId).maybeSingle();
  if (!s || s.status !== "active") return;
  const clientId = s.client_id as string;
  const clientName = (s.clients as unknown as { name: string } | null)?.name ?? "the client";
  const score = await emailScoreOf(admin, clientId).catch(() => null);
  // Nothing to measure right now (Klaviyo not read): try again in a day, say nothing
  if (!score) {
    await admin.from("email_sprints").update({ next_check_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", sprintId);
    return;
  }
  const now = snapshotOf(score);
  const base = (Object.keys((s.baseline ?? {}) as object).length ? s.baseline : now) as ScoreSnapshot;
  const { data: actions } = await admin.from("email_sprint_actions").select("title, status, note, when").eq("sprint_id", sprintId).order("sort_order");
  const list = (actions ?? []) as { title: string; status: string; note: string | null; when: string | null }[];
  const t = tally(list.map((x) => x.status));
  const m = movement(base, now);
  const verdict: SprintVerdict = verdictOf(m, t, now);
  let message = plainMessage(verdict, m, t, now);
  try {
    const out = await askJson<CheckOut>({
      agent: "email_audit",
      label: "email sprint check",
      clientId,
      system:
        "You are Kaizen Marketing's Email Strategist, checking in on a sprint with the email strategist who holds the client. Write 2 to 4 plain sentences in the first person: what the email score did since the sprint began, which of the seven checks moved and why that is likely, which moves are done and which are still waiting, and what to do next. Use only the numbers given; do not invent any. Refer to people by role, never by name. No em dashes, no bullet points.",
      schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
      maxTokens: 2000,
      prompt: `<facts>\nScore now ${now.score}, at the start ${base.score} (${m.delta >= 0 ? "+" : ""}${m.delta}). Verdict: ${verdict}.\nChecks that now meet their bar: ${m.gained.join(", ") || "none"}. Slipped under their bar: ${m.lost.join(", ") || "none"}. Still under: ${m.open.join(", ") || "none"}.\n${now.checks.map((c) => `- ${c.label}: ${c.value == null ? "nothing to measure" : c.value} (bar ${c.bar}, ${c.met ? "met" : "under"}), at the start ${base.checks.find((b) => b.key === c.key)?.value ?? "n/a"}`).join("\n")}\nMoves: ${list.map((x) => `${x.title} [${x.status}]${x.note ? ` (note: ${x.note})` : ""}`).join("; ") || "none"}\n</facts>\n\nWrite the check-in for ${clientName}.`,
    });
    if (out?.message?.trim()) message = out.message.trim().slice(0, 900);
  } catch {
    // The plain message stands (AI paused or offline): the numbers are the point
  }
  const next = nextCheckAt(verdict);
  const { data: check } = await admin.from("email_sprint_checks").insert({ sprint_id: sprintId, verdict, message, score: now, next_check_at: next }).select("id").single();
  const done = verdict === "done";
  await admin
    .from("email_sprints")
    .update({ latest: now, last_check_at: new Date().toISOString(), next_check_at: next, ...(done ? { status: "done", closed_at: new Date().toISOString(), close_note: "Back in the green" } : {}) })
    .eq("id", sprintId);
  // Tell the owner (and watchers) when it matters: a slip, nothing started, or back in the green. Quiet when on track.
  if (check && (verdict === "worse" || verdict === "no_action" || verdict === "done")) {
    const to = [...new Set([s.owner_id as string | null, ...((s.watcher_ids ?? []) as string[])].filter((x): x is string => Boolean(x)))];
    if (to.length)
      await admin.from("notifications").upsert(
        to.map((id) => ({
          profile_id: id,
          kind: "email_sprint",
          title: verdict === "done" ? `${clientName} is back in the green` : verdict === "worse" ? `${clientName}'s email score slipped` : `${clientName}'s email sprint is waiting on you`,
          body: message.slice(0, 1000),
          href: `/kpis/email-sprint/${sprintId}`,
          client_id: clientId,
          key: `email-sprint:${check.id}`,
          priority: verdict === "worse" ? "critical" : "normal",
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
}

/** The scheduled step: every sprint whose next check is due */
export async function checkDueEmailSprints(admin: SupabaseClient, limit = 12) {
  const { data } = await admin.from("email_sprints").select("id").eq("status", "active").lte("next_check_at", new Date().toISOString()).order("next_check_at").limit(limit);
  let checked = 0;
  for (const s of data ?? []) {
    await checkEmailSprint(admin, s.id as string).catch((e) => console.error("[email sprint] check failed:", e instanceof Error ? e.message : e));
    checked++;
  }
  return { due: data?.length ?? 0, checked };
}
