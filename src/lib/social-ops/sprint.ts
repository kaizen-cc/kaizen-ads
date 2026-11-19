import "server-only";
import { hasLine, type ServiceFields } from "@/lib/service-gate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { loadSocialScore } from "@/lib/social-score-load";
import { autoMoves, movement, nextCheckAt, tally, verdictOf, type ScoreSnapshot, type SprintVerdict } from "@/lib/email-ops/sprint-core";
import { socialSnapshotOf, type SocialAuditResult, type SocialSnapshot } from "./audit-core";
import { socialPlainMessage } from "./sprint-core";
import { socialTeamFor, whoHearsSocial } from "./people";

// Social sprints: a social audit's plan followed to done with the social media manager, exactly like the email sprints
// (same statuses, owners, verdicts and timing; src/lib/email-ops/sprint-core.ts is shared). A check re-measures the
// social score, reads the posts that went up since the last check (the platforms keep no other change history), says
// what moved, and decides when to look again. A red account's audit opens its sprint by itself; a sprint closes itself
// once the account is back in the green.

const asEmailSnap = (s: SocialSnapshot) => s as unknown as ScoreSnapshot;

/** Opens the client's sprint from a finished audit: every action, one (`only`), or a list. One live sprint per client. */
export async function openSocialSprint(admin: SupabaseClient, auditId: string, by: string | null, only?: number | number[]): Promise<string | null> {
  const { data: a } = await admin.from("social_audits").select("id, client_id, status, result, inputs").eq("id", auditId).maybeSingle();
  if (!a || a.status !== "ready") return null;
  const clientId = a.client_id as string;
  const picked = only === undefined ? null : new Set(Array.isArray(only) ? only : [only]);
  const plan = ((a.result as SocialAuditResult | null)?.actions ?? []).map((x, i) => ({ x, i })).filter(({ i }) => !picked || picked.has(i));
  if (!plan.length) return null;
  const { data: live } = await admin.from("social_sprints").select("id, audit_id").eq("client_id", clientId).eq("status", "active").maybeSingle();
  let sprintId = live?.id as string | undefined;
  if (live && live.audit_id !== auditId) {
    await admin.from("social_sprints").update({ status: "closed", closed_at: new Date().toISOString(), close_note: "Replaced by a newer audit" }).eq("id", live.id);
    sprintId = undefined;
  }
  if (!sprintId) {
    const owner = whoHearsSocial(await socialTeamFor(admin, clientId))[0] ?? by;
    const snap = ((a.inputs as { snapshot?: SocialSnapshot } | null)?.snapshot ?? null) as SocialSnapshot | null;
    const now = snap ?? (await loadSocialScore(admin, clientId).then((s) => (s ? socialSnapshotOf(s) : null)).catch(() => null));
    const { data: s, error } = await admin
      .from("social_sprints")
      .insert({ client_id: clientId, audit_id: auditId, owner_id: owner ?? null, created_by: by, watcher_ids: by && by !== owner ? [by] : [], baseline: now ?? {}, latest: now ?? {}, next_check_at: nextCheckAt("started") })
      .select("id")
      .single();
    if (error || !s) throw new Error(error?.message ?? "Couldn't open the sprint");
    sprintId = s.id as string;
    await admin.from("social_sprint_checks").insert({ sprint_id: sprintId, client_id: clientId, verdict: "started", message: now ? `Sprint started with the score at ${now.score}. The moves marked for today come first.` : "Sprint started.", score: now ?? {}, next_check_at: nextCheckAt("started") });
  }
  const { data: have } = await admin.from("social_sprint_actions").select("audit_index, sort_order").eq("sprint_id", sprintId);
  const taken = new Set((have ?? []).map((h) => h.audit_index as number));
  const base = (have ?? []).reduce((n, h) => Math.max(n, (h.sort_order as number) + 1), 0);
  const rows = plan.filter(({ i }) => !taken.has(i)).map(({ x, i }, k) => ({ sprint_id: sprintId, client_id: clientId, audit_index: i, title: x.title, area: x.area, owner: x.owner, platform: x.platform, when: x.when, steps: x.steps, why: x.why, impact: x.impact, sort_order: base + k }));
  if (rows.length) await admin.from("social_sprint_actions").insert(rows);
  return sprintId;
}

/** A red account's audit opens its sprint by itself (today's and this week's moves); a live sprint someone started on is left */
export async function autoSocialSprint(admin: SupabaseClient, auditId: string): Promise<string | null> {
  const { data: a } = await admin.from("social_audits").select("client_id, band, status, result, created_by").eq("id", auditId).maybeSingle();
  if (!a || a.status !== "ready" || a.band !== "bad") return null;
  const { data: live } = await admin.from("social_sprints").select("id, audit_id").eq("client_id", a.client_id).eq("status", "active").maybeSingle();
  if (live?.audit_id === auditId) return live.id as string;
  if (live) {
    const { count } = await admin.from("social_sprint_actions").select("id", { count: "exact", head: true }).eq("sprint_id", live.id).neq("status", "todo");
    if (count) return null;
  }
  const moves = autoMoves((a.result as SocialAuditResult | null)?.actions ?? []);
  if (!moves.length) return null;
  return openSocialSprint(admin, auditId, (a.created_by as string | null) ?? null, moves);
}

type CheckOut = { message: string; actions: { n: number; status: "looks_done" | "partly" | "not_done"; note: string }[] };

/** One check: re-measure the score, tally the moves, read the posts since, say what moved. Never throws. */
export async function checkSocialSprint(admin: SupabaseClient, sprintId: string) {
  const { data: s } = await admin.from("social_sprints").select("id, client_id, owner_id, watcher_ids, status, baseline, started_at, last_check_at, clients(name)").eq("id", sprintId).maybeSingle();
  if (!s || s.status !== "active") return;
  const clientId = s.client_id as string;
  const clientName = (s.clients as unknown as { name: string } | null)?.name ?? "the client";
  const score = await loadSocialScore(admin, clientId).catch(() => null);
  if (!score) {
    await admin.from("social_sprints").update({ next_check_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", sprintId);
    return;
  }
  const now = socialSnapshotOf(score);
  const base = (Object.keys((s.baseline ?? {}) as object).length ? s.baseline : now) as SocialSnapshot;
  const { data: actions } = await admin.from("social_sprint_actions").select("id, title, status, note, steps, done_at, platform").eq("sprint_id", sprintId).order("sort_order");
  const list = (actions ?? []) as { id: string; title: string; status: string; note: string | null; steps: string[] | null; done_at: string | null; platform: string | null }[];
  const startedAt = (s.started_at as string | null) ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const lastAt = (s.last_check_at as string | null) ?? startedAt;
  // The posts that went up since the sprint began: the only "change history" the platforms give
  const { data: posts } = await admin.from("social_posts").select("platform, format, caption, posted_at").eq("client_id", clientId).gte("posted_at", startedAt).order("posted_at", { ascending: false }).limit(60);
  const since = (posts ?? []).map((p) => ({ at: p.posted_at as string, line: `${String(p.posted_at).slice(0, 10)} ${p.platform} ${p.format ?? "post"}${p.caption ? ` "${String(p.caption).replace(/\s+/g, " ").slice(0, 80)}"` : ""}` }));
  const recent = since.filter((p) => p.at >= lastAt).length;
  const t = tally(list.map((x) => x.status));
  const m = movement(asEmailSnap(base), asEmailSnap(now));
  const verdict: SprintVerdict = verdictOf(m, t, asEmailSnap(now), since.length);
  let message = socialPlainMessage(verdict, m, t, now, recent);
  let judged: CheckOut["actions"] = [];
  try {
    const out = await askJson<CheckOut>({
      agent: "social_audit",
      label: "social sprint check",
      clientId,
      system:
        "You are Kaizen Marketing's Social Strategist, checking in on a sprint with the social media manager who holds the client. You see the social score now and at the start (overall and per platform), the moves on the plan with what was ticked, and the posts that went up since the sprint began (the platforms keep no other change history). Write 2 to 5 plain sentences in the first person: what the score did and which checks moved, whether the planned moves show in the posts (name a move ticked done that no post shows, and posts that match no move), and what to do next. If nothing was posted and nothing is ticked, say plainly that nobody has worked on the account since the sprint began and name the first move. Use only the numbers given. Refer to people by role, never by name. No em dashes, no bullet points.\nactions: for each move by its number, whether the posts show it (looks_done, partly, not_done) with a short note. Moves that need no post (a question for the client, a profile change) go by what was ticked and noted.",
      schema: {
        type: "object",
        properties: { message: { type: "string" }, actions: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, status: { type: "string", enum: ["looks_done", "partly", "not_done"] }, note: { type: "string" } }, required: ["n", "status", "note"], additionalProperties: false } } },
        required: ["message", "actions"],
        additionalProperties: false,
      },
      maxTokens: 3000,
      prompt: `<facts>\nScore now ${now.score}, at the start ${base.score} (${m.delta >= 0 ? "+" : ""}${m.delta}). Verdict: ${verdict}.\nPer platform now: ${now.platforms.map((p) => `${p.platform} ${p.score}`).join(", ")}; at the start: ${(base.platforms ?? []).map((p) => `${p.platform} ${p.score}`).join(", ") || "n/a"}.\nChecks that now meet their bar: ${m.gained.join(", ") || "none"}. Slipped: ${m.lost.join(", ") || "none"}. Still under: ${m.open.join(", ") || "none"}.\nSprint began ${startedAt.slice(0, 10)}; last check ${lastAt.slice(0, 10)}.\n</facts>\n\n<moves>\n${list.map((x, i) => `${i + 1}. [${x.status}${x.done_at ? `, ticked ${x.done_at.slice(0, 10)}` : ""}] ${x.platform && x.platform !== "all" ? `${x.platform}: ` : ""}${x.title}${x.note ? ` (note: ${x.note})` : ""}`).join("\n") || "(none)"}\n</moves>\n\n<posts_since_the_sprint_began>\n${since.map((p) => p.line).join("\n") || "(none)"}\n</posts_since_the_sprint_began>\n\nWrite the check-in for ${clientName}.`,
    });
    if (out?.message?.trim()) message = out.message.trim().replace(/\s*—\s*/g, ", ").slice(0, 900);
    judged = out?.actions ?? [];
  } catch {
    // The plain message stands
  }
  const next = nextCheckAt(verdict);
  const { data: check } = await admin.from("social_sprint_checks").insert({ sprint_id: sprintId, client_id: clientId, verdict, message, score: now, next_check_at: next }).select("id").single();
  for (const j of judged) {
    const x = list[j.n - 1];
    if (!x || !j.note?.trim()) continue;
    const lead = j.status === "looks_done" ? "Seen in the posts" : j.status === "partly" ? "Partly seen in the posts" : "Not seen in the posts yet";
    await admin.from("social_sprint_actions").update({ ai_note: `${lead}: ${j.note.trim()}`.replace(/\s*—\s*/g, ", ").slice(0, 400) }).eq("id", x.id);
  }
  const done = verdict === "done";
  await admin
    .from("social_sprints")
    .update({ latest: now, last_check_at: new Date().toISOString(), next_check_at: next, ...(done ? { status: "done", closed_at: new Date().toISOString(), close_note: "Back in the green" } : {}) })
    .eq("id", sprintId);
  if (check && (verdict === "worse" || verdict === "no_action" || verdict === "done")) {
    const to = [...new Set([s.owner_id as string | null, ...((s.watcher_ids ?? []) as string[])].filter((x): x is string => Boolean(x)))];
    if (to.length)
      await admin.from("notifications").upsert(
        to.map((id) => ({
          profile_id: id,
          kind: "social_sprint",
          title: verdict === "done" ? `${clientName}'s social is back in the green` : verdict === "worse" ? `${clientName}'s social score slipped` : `${clientName}'s social sprint is waiting on you`,
          body: message.slice(0, 1000),
          href: `/kpis/social-sprint/${sprintId}`,
          client_id: clientId,
          key: `social-sprint:${check.id}`,
          priority: verdict === "worse" ? "critical" : "normal",
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
}

/** The scheduled step: every social sprint whose next check is due */
export async function checkDueSocialSprints(admin: SupabaseClient, limit = 12) {
  const { data, error } = await admin.from("social_sprints").select("id, clients(services, services_extra, services_removed, strategy_only)").eq("status", "active").lte("next_check_at", new Date().toISOString()).order("next_check_at").limit(limit);
  if (error) return { skipped: "Social ops migration not applied" };
  let checked = 0;
  for (const s of data ?? []) {
    // A client that no longer buys social media (src/lib/service-gate.ts): the sprint is kept and waits a day, unchecked
    if (!hasLine((Array.isArray(s.clients) ? s.clients[0] : s.clients) as ServiceFields | null, "social")) {
      await admin.from("social_sprints").update({ next_check_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("id", s.id);
      continue;
    }
    await checkSocialSprint(admin, s.id as string).catch((e) => console.error("[social sprint] check failed:", e instanceof Error ? e.message : e));
    checked++;
  }
  return { due: data?.length ?? 0, checked };
}
