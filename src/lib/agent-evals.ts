import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, forgetAgent, getAgent, withAgent, type AgentConfig, type AgentKey, type Effort, type ModelKey } from "@/lib/ai";
import { momentOf } from "@/lib/agent-moments";
import { createAdminClient } from "@/lib/supabase/admin";

// Testing a change to an agent before it's saved: real calls are sampled as they happen (the last 30 per place in the
// app), and a proposed change (instructions, a skill, the core, the brain) is replayed on a handful of them next to
// what the agent does now. A judge reads each pair against the task and Kaizen's standards (better, same or worse, and
// why). Saving is never blocked; the result is kept with the change in the agent's history. The same replay runs weekly
// on what the team's learnings changed, as a drift check for execs.

export type ItemEdit = { id?: string | null; kind: "skill" | "knowledge" | "example"; title: string; body: string; active: boolean };
export type Proposal = { instructions?: string; model?: ModelKey; effort?: Effort; core?: string; items?: ItemEdit[]; learnings?: boolean };
export type EvalResult = { sampleId: string; agent: string; label: string; moment: string; current: string; proposed: string; verdict: "better" | "same" | "worse" | "error"; why: string; reused: boolean };
export type EvalRow = { id: string; agentKey: string | null; roleKey: string | null; kind: "change" | "drift"; target: string; status: "running" | "done" | "failed"; results: EvalResult[]; better: number; same: number; worse: number; summary: string | null; error: string | null; createdAt: string; finishedAt: string | null; appliedAt: string | null; by: string | null };

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut)` : s);

/** Keep one real call as a sample (the database keeps the last 30 per agent and place) */
export async function captureSample(s: { agent: AgentKey; label: string; system: string; prompt: string; schema: Record<string, unknown>; output: string; model: string; effort: string; hadMedia: boolean }) {
  const moment = momentOf(s.agent, s.label)?.title ?? s.label.slice(0, 60);
  await createAdminClient()
    .from("agent_samples")
    .insert({ agent_key: s.agent, moment, label: s.label.slice(0, 200), system: cut(s.system, 30_000), prompt: cut(s.prompt, 60_000), schema: s.schema, output: cut(s.output, 20_000), model: s.model, effort: s.effort, had_media: s.hadMedia });
}

/** Start a test (it runs in the background; the page polls it) */
export async function startEval(admin: SupabaseClient, e: { agentKey?: string | null; roleKey?: string | null; target: string; proposal: Proposal; by: string | null; kind?: "change" | "drift" }) {
  const { data, error } = await admin
    .from("agent_evals")
    .insert({ agent_key: e.agentKey ?? null, role_key: e.roleKey ?? null, kind: e.kind ?? "change", target: e.target, proposal: e.proposal, created_by: e.by })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

type Sample = { id: string; agent_key: string; moment: string; label: string; system: string; prompt: string; schema: Record<string, unknown>; output: string; model: string; effort: string; had_media: boolean; created_at: string };

/** A spread of recent samples: round the places in the app, text-only first (a replay can't resend pictures) */
function pickSamples(all: Sample[], max: number) {
  const byMoment = new Map<string, Sample[]>();
  for (const s of [...all].sort((a, b) => Number(a.had_media) - Number(b.had_media) || Date.parse(b.created_at) - Date.parse(a.created_at))) {
    const k = `${s.agent_key}:${s.moment}`;
    byMoment.set(k, [...(byMoment.get(k) ?? []), s]);
  }
  const out: Sample[] = [];
  const queues = [...byMoment.values()];
  while (out.length < max && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < max) out.push(q.shift()!);
  return out;
}

/** The agent with the proposed change applied */
function applyProposal(cfg: AgentConfig, items: { id: string; kind: string; title: string; body: string }[], p: Proposal): AgentConfig {
  let list = items;
  for (const e of p.items ?? []) {
    if (e.id) list = e.active ? list.map((k) => (k.id === e.id ? { ...k, kind: e.kind, title: e.title, body: e.body } : k)) : list.filter((k) => k.id !== e.id);
    else if (e.active) list = [...list, { id: `new-${list.length}`, kind: e.kind, title: e.title, body: e.body }];
  }
  return {
    ...cfg,
    instructions: p.instructions ?? cfg.instructions,
    model: p.model ?? cfg.model,
    effort: p.effort ?? cfg.effort,
    role: p.core != null && cfg.role ? { ...cfg.role, core: p.core } : cfg.role,
    knowledge: list.map((k) => ({ kind: k.kind, title: k.title, body: k.body })),
  };
}

/** For the drift check: the sample's learnings block rebuilt with what the team's learnings are now */
async function freshLearnings(admin: SupabaseClient, prompt: string) {
  const m = prompt.match(/<learned_from_the_team client="([^"]*)" agents="([^"]*)">[\s\S]*?<\/learned_from_the_team>\n?/);
  if (!m) return null;
  const { learningsBlock } = await import("@/lib/learnings");
  const block = await learningsBlock(admin, m[2].split(",").filter(Boolean) as AgentKey[], m[1] || null, prompt);
  return prompt.replace(m[0], block);
}

const JUDGE = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "why"],
  properties: { winner: { type: "string", enum: ["A", "B", "same"] }, why: { type: "string" } },
};

/** Replay the samples with the current and the proposed agent, judge each pair, and keep the verdicts */
export async function runEval(admin: SupabaseClient, evalId: string, maxSamples = 8) {
  const { data: e } = await admin.from("agent_evals").select("id, agent_key, role_key, kind, proposal").eq("id", evalId).single();
  if (!e) return;
  try {
    const proposal = (e.proposal ?? {}) as Proposal;
    const drift = e.kind === "drift";
    const keys: string[] = e.agent_key ? [e.agent_key as string] : ((await admin.from("ai_agents").select("key").eq("role_key", e.role_key)).data ?? []).map((a) => a.key as string);
    const { data: raw } = await admin.from("agent_samples").select("*").in("agent_key", keys).order("created_at", { ascending: false }).limit(150);
    const samples = pickSamples(((raw ?? []) as Sample[]).filter((s) => !drift || s.prompt.includes("<learned_from_the_team")), Math.min(8, maxSamples));
    if (!samples.length) {
      await admin.from("agent_evals").update({ status: "done", summary: drift ? "No recent calls that read the team's learnings to replay yet." : "No recent real calls to replay yet: it samples them as the agent works.", finished_at: new Date().toISOString() }).eq("id", evalId);
      return;
    }
    // When anything this agent reads last changed: a sample made after that is still what it does now
    const [{ data: agents }, { data: know }, { data: spine }] = await Promise.all([
      admin.from("ai_agents").select("key, updated_at, ai_roles(updated_at)").in("key", keys),
      admin.from("ai_knowledge").select("agent_key, updated_at").or(`agent_key.in.(${keys.join(",")}),agent_key.is.null`).order("updated_at", { ascending: false }).limit(200),
      admin.from("ai_spine").select("updated_at").eq("id", 1).maybeSingle(),
    ]);
    const changedAt = (key: string) => {
      const a = (agents ?? []).find((x) => x.key === key);
      const times = [a?.updated_at as string | undefined, (a?.ai_roles as unknown as { updated_at: string } | null)?.updated_at, spine?.updated_at as string | undefined, ...(know ?? []).filter((k) => k.agent_key === key || k.agent_key === null).map((k) => k.updated_at as string)];
      return Math.max(0, ...times.filter(Boolean).map((t) => Date.parse(t!)));
    };
    const spineText = (await getAgent(keys[0] as AgentKey)).spine;
    const results = await Promise.all(
      samples.map(async (s): Promise<EvalResult> => {
        const base = { sampleId: s.id, agent: s.agent_key, label: s.label, moment: s.moment };
        try {
          forgetAgent(s.agent_key as AgentKey);
          const now = await getAgent(s.agent_key as AgentKey);
          const { data: items } = await admin.from("ai_knowledge").select("id, kind, title, body").eq("active", true).or(`agent_key.eq.${s.agent_key},agent_key.is.null`).order("created_at");
          const next = drift ? now : applyProposal(now, (items ?? []) as { id: string; kind: string; title: string; body: string }[], proposal);
          const replay = async (cfg: AgentConfig, prompt: string) =>
            JSON.stringify(
              await askJson<unknown>({ agent: s.agent_key as AgentKey, label: `${s.label} (test)`, system: "", systemOverride: withAgent(s.system, cfg), prompt, schema: s.schema, override: { model: cfg.model, effort: cfg.effort }, noSample: true }),
              null,
              1,
            );
          const reused = drift || Date.parse(s.created_at) > changedAt(s.agent_key);
          const proposedPrompt = drift ? ((await freshLearnings(admin, s.prompt)) ?? s.prompt) : s.prompt;
          const [current, proposed] = await Promise.all([reused ? Promise.resolve(s.output) : replay(now, s.prompt), replay(next, proposedPrompt)]);
          // The judge doesn't know which is which (the order is shuffled)
          const flip = Math.random() < 0.5;
          const [A, B] = flip ? [proposed, current] : [current, proposed];
          const j = await askJson<{ winner: "A" | "B" | "same"; why: string }>({
            agent: "coach",
            label: "agent eval",
            bare: true,
            noSample: true,
            schema: JUDGE,
            override: { model: "sonnet", effort: "low" },
            maxTokens: 1500,
            system: `You judge two answers an AI agent gave to the same real task at Kaizen Marketing, a paid social agency. Judge by the task's own instructions and Kaizen's standards below: accurate to the facts given, follows the client's rules, specific and useful to the team, nothing invented, no rigid rules applied where they don't fit, no needless nitpicks. Pick the better one, or "same" when the difference doesn't matter. why: one sentence naming the concrete difference.
<kaizen_strategy>
${cut(spineText, 4000)}
</kaizen_strategy>`,
            prompt: `<task_instructions>\n${cut(s.system, 3000)}\n</task_instructions>\n<task>\n${cut(s.prompt, 9000)}\n</task>\n<answer_A>\n${cut(A, 7000)}\n</answer_A>\n<answer_B>\n${cut(B, 7000)}\n</answer_B>`,
          });
          const proposedWon = (j.winner === "A" && flip) || (j.winner === "B" && !flip);
          const currentWon = (j.winner === "A" && !flip) || (j.winner === "B" && flip);
          return { ...base, current: cut(current, 6000), proposed: cut(proposed, 6000), verdict: proposedWon ? "better" : currentWon ? "worse" : "same", why: j.why.slice(0, 400), reused };
        } catch (err) {
          return { ...base, current: cut(s.output, 3000), proposed: "", verdict: "error", why: err instanceof Error ? err.message.slice(0, 300) : "It couldn't be replayed.", reused: false };
        }
      }),
    );
    const n = (v: EvalResult["verdict"]) => results.filter((r) => r.verdict === v).length;
    const [better, same, worse] = [n("better"), n("same"), n("worse")];
    const lead = results.find((r) => r.verdict === "worse") ?? results.find((r) => r.verdict === "better");
    const summary = `${better} better, ${same} same, ${worse} worse${n("error") ? `, ${n("error")} couldn't run` : ""}${lead ? `: ${lead.why}` : ""}`;
    await admin.from("agent_evals").update({ status: "done", results, better, same, worse, summary, finished_at: new Date().toISOString() }).eq("id", evalId);
  } catch (err) {
    await admin.from("agent_evals").update({ status: "failed", error: err instanceof Error ? err.message.slice(0, 400) : "The test failed.", finished_at: new Date().toISOString() }).eq("id", evalId);
  }
}

/**
 * A change was saved: kept in the agent's history with who and when, and the test it had just before (by the same
 * person, of the same thing, in the last three hours), if any.
 */
export async function recordChange(admin: SupabaseClient, c: { agentKey?: string | null; roleKey?: string | null; target: string; by: string }) {
  try {
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    let q = admin.from("agent_evals").select("id, summary").eq("target", c.target).eq("kind", "change").eq("created_by", c.by).is("applied_at", null).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
    q = c.agentKey ? q.eq("agent_key", c.agentKey) : q.eq("role_key", c.roleKey ?? "");
    const { data: ev } = await q.maybeSingle();
    if (ev) await admin.from("agent_evals").update({ applied_at: new Date().toISOString() }).eq("id", ev.id);
    await admin.from("agent_changes").insert({ agent_key: c.agentKey ?? null, role_key: c.roleKey ?? null, target: c.target, eval_id: ev?.id ?? null, eval_summary: (ev?.summary as string | null) ?? null, changed_by: c.by });
  } catch (e) {
    console.error("[agent evals] record change", e instanceof Error ? e.message : e);
  }
}

export const toEval = (r: Record<string, unknown>): EvalRow => ({
  id: r.id as string,
  agentKey: (r.agent_key as string | null) ?? null,
  roleKey: (r.role_key as string | null) ?? null,
  kind: r.kind as EvalRow["kind"],
  target: r.target as string,
  status: r.status as EvalRow["status"],
  results: (r.results ?? []) as EvalResult[],
  better: (r.better as number) ?? 0,
  same: (r.same as number) ?? 0,
  worse: (r.worse as number) ?? 0,
  summary: (r.summary as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
  appliedAt: (r.applied_at as string | null) ?? null,
  by: (r.profiles as { full_name: string } | null)?.full_name ?? null,
});

/**
 * Weekly drift check: for each agent whose learnings changed this week (merged, widened, retired, settled), replay a
 * few recent calls with the learnings as they are now against what it did then, and tell execs the verdicts.
 */
export async function driftCheck(admin: SupabaseClient) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: changed } = await admin.from("agent_learnings").select("agent_key").gte("updated_at", since);
  const keys = [...new Set((changed ?? []).map((c) => c.agent_key as string))].slice(0, 4);
  const lines: string[] = [];
  for (const k of keys) {
    const id = await startEval(admin, { agentKey: k, target: "learnings", proposal: { learnings: true }, by: null, kind: "drift" });
    await runEval(admin, id, 4);
    const { data: ev } = await admin.from("agent_evals").select("summary, worse").eq("id", id).single();
    lines.push(`${k}: ${ev?.summary ?? "no result"}`);
  }
  if (lines.length) {
    const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_exec", true);
    const week = new Date().toISOString().slice(0, 10);
    if (execs?.length)
      await admin.from("notifications").upsert(
        execs.map((x) => ({ profile_id: x.id, kind: "agent", title: "Weekly drift check: what the team's learnings changed", body: lines.join(" · ").slice(0, 1000), href: "/settings?tab=agents", key: `drift:${week}`, priority: "normal" })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  }
  return { agents: keys, lines };
}
