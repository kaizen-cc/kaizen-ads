import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, type AgentKey } from "@/lib/ai";
import { pickWinner, rankLearnings, scopeLabel, widenScope, type ClientPlace, type Learning, type LearningKind, type LearningScope } from "@/lib/learning-rank";

// What the agents learn from the team pushing back (a disagreement with a creative review note, a rebuttal of an audit
// finding, a copy flag rebutted or approved past), kept from piling up and making them worse: each becomes one
// conditional learning (what holds, under which condition, for whom), consolidated nightly (duplicates merged,
// contradictions settled or put to an exec, stale ones retired), and every call reads only the few that fit it.

export type LearningSource = "creative_review_disagreements" | "audit_rebuttals" | "copy_rule_overrides" | "audit_item_messages";

/**
 * The agent that learns from each kind of pushback, unless the caller names it (a Google audit's rebuttal teaches the
 * Google auditor; a lesson taught in the Why chat on a Google idea plan teaches the Google launcher)
 */
export const SOURCE_AGENT: Record<LearningSource, AgentKey> = { creative_review_disagreements: "creativereview", audit_rebuttals: "auditor", copy_rule_overrides: "copy", audit_item_messages: "google_launcher" };

type Row = {
  id: string;
  agent_key: string;
  source_table: string;
  source_id: string | null;
  client_id: string | null;
  model: string | null;
  vertical_id: string | null;
  scope: LearningScope;
  proposed_scope: LearningScope | null;
  kind: LearningKind;
  condition: string | null;
  lesson: string;
  confidence: number;
  evidence: number;
  evidence_clients: string[];
  sources: { table: string; id: string }[];
  status: "active" | "merged" | "retired" | "conflict";
  last_seen: string;
  updated_at: string;
};

const COLS = "id, agent_key, source_table, source_id, client_id, model, vertical_id, scope, proposed_scope, kind, condition, lesson, confidence, evidence, evidence_clients, sources, status, last_seen, updated_at";

export const toLearning = (r: Row): Learning => ({
  id: r.id,
  agentKey: r.agent_key,
  scope: r.scope,
  clientId: r.client_id,
  model: r.model,
  verticalId: r.vertical_id,
  kind: r.kind,
  condition: r.condition,
  lesson: r.lesson,
  confidence: Number(r.confidence) || 0.5,
  evidence: r.evidence || 1,
  evidenceClients: r.evidence_clients ?? [],
  lastSeen: r.last_seen,
});

/** A client's kind of business and sub-vertical, kept for a run */
async function placeOf(admin: SupabaseClient, clientId: string, cache?: Map<string, ClientPlace>): Promise<ClientPlace> {
  const hit = cache?.get(clientId);
  if (hit) return hit;
  const [{ businessModelOf }, { data: c }] = await Promise.all([import("@/lib/business-model"), admin.from("clients").select("vertical_id").eq("id", clientId).maybeSingle()]);
  const m = await businessModelOf(admin, clientId).catch(() => null);
  const place = { clientId, model: m?.model ?? null, also: m?.also ?? null, verticalId: (c?.vertical_id as string | null) ?? null };
  cache?.set(clientId, place);
  return place;
}

// ─── Recording one ───────────────────────────────────────────────────────────

/**
 * A rebuttal, disagreement or override was saved: keep it as a learning for its client, then classify it (what it
 * really says, under which condition, a one-off or a lesson). Never throws: the team's action has already gone through.
 */
export async function recordLearning(admin: SupabaseClient, s: { table: LearningSource; id: string; clientId: string; text: string; agent?: AgentKey }) {
  try {
    const place = await placeOf(admin, s.clientId);
    // Once per source row (a unique index on it; a second save is a no-op)
    const { data, error } = await admin
      .from("agent_learnings")
      .insert({ agent_key: s.agent ?? SOURCE_AGENT[s.table], source_table: s.table, source_id: s.id, client_id: s.clientId, model: place.model, vertical_id: place.verticalId, lesson: s.text.slice(0, 800), evidence_clients: [s.clientId], sources: [{ table: s.table, id: s.id }] })
      .select("id")
      .maybeSingle();
    if (error && error.code !== "23505") throw new Error(error.message);
    if (data?.id) await classifyLearning(admin, data.id as string);
  } catch (e) {
    console.error("[learnings] record", e instanceof Error ? e.message : e);
  }
}

const CLASSIFY = {
  type: "object",
  additionalProperties: false,
  required: ["lesson", "condition", "kind", "scope", "confidence"],
  properties: {
    lesson: { type: "string" },
    condition: { type: "string" },
    kind: { type: "string", enum: ["exception", "lesson"] },
    scope: { type: "string", enum: ["client", "vertical", "model", "everyone"] },
    confidence: { type: "number" },
  },
};

/** What one piece of pushback really teaches, and how far it could ever reach */
export async function classifyLearning(admin: SupabaseClient, id: string) {
  const { data: r } = await admin.from("agent_learnings").select(COLS).eq("id", id).maybeSingle();
  if (!r) return;
  const row = r as unknown as Row;
  const [{ data: c }, { data: v }] = await Promise.all([
    row.client_id ? admin.from("clients").select("name, industry_detail").eq("id", row.client_id).maybeSingle() : Promise.resolve({ data: null }),
    row.vertical_id ? admin.from("verticals").select("name").eq("id", row.vertical_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const out = await askJson<{ lesson: string; condition: string; kind: LearningKind; scope: LearningScope; confidence: number }>({
    agent: row.agent_key as AgentKey,
    label: `learning scope ${row.agent_key}`,
    bare: true,
    schema: CLASSIFY,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 1500,
    system: `You turn a moment where Kaizen's team pushed back on an AI agent's work into a precise, conditional learning, so the agent gets better without getting more rigid. Kaizen is a paid social agency; the agents review creative, write copy and audit ad accounts.
Return:
- lesson: one or two sentences, in the agent's voice as an instruction ("Don't flag…", "Treat … as allowed when …"), concrete, no people's names, no client name unless it's a fact about that client's brand.
- condition: when it holds, as specifically as the pushback supports ("when the client confirmed the claim in writing", "for top-of-funnel video", "only for this ad set", "for subscription offers"). "" only if it truly holds always.
- kind: "exception" when it's a one-off (this ad, this campaign, a special arrangement, a client's own approval of one thing); "lesson" when it's a reusable way of judging.
- scope: the widest it could ever reasonably apply to if other clients showed the same: "client" (only this client's brand or deal), "vertical" (their sub-vertical), "model" (their kind of business), "everyone" (any client). Be conservative: most pushback is about the client.
- confidence: 0 to 1, how clearly the pushback supports the lesson.`,
    prompt: `<agent>${row.agent_key}</agent>
<client>${c?.name ?? "unknown"}${c?.industry_detail ? ` · ${c.industry_detail}` : ""}${v?.name ? ` · sub-vertical: ${v.name}` : ""}${row.model ? ` · kind of business: ${row.model}` : ""}</client>
<pushback source="${row.source_table}">
${row.lesson}
</pushback>`,
  });
  await admin
    .from("agent_learnings")
    .update({
      lesson: out.lesson.trim().slice(0, 600) || row.lesson,
      condition: out.condition.trim().slice(0, 300) || null,
      kind: out.kind,
      proposed_scope: out.kind === "exception" ? "client" : out.scope,
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0.5)),
      classified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

// ─── What a call reads ───────────────────────────────────────────────────────

/**
 * The few learnings this call should see (at most 8): only those about this client, its sub-vertical, its kind of
 * business or everyone, best first, each with the condition it holds under. Replaces the separate disagreement,
 * rebuttal and override blocks. The tag carries the client and agents, so a test can rebuild it with newer learnings.
 */
export async function learningsBlock(admin: SupabaseClient, agents: AgentKey[], clientId: string | null, task?: string | null) {
  try {
    let q = admin.from("agent_learnings").select(COLS).in("agent_key", agents).eq("status", "active").order("last_seen", { ascending: false }).limit(400);
    q = clientId ? q.or(`client_id.eq.${clientId},scope.neq.client`) : q.neq("scope", "client");
    const { data } = await q;
    const list = ((data ?? []) as unknown as Row[]).map(toLearning);
    if (!list.length) return "";
    const place = clientId ? await placeOf(admin, clientId) : { model: null, also: null, verticalId: null };
    const top = rankLearnings(list, { clientId, model: place.model, also: place.also, verticalId: place.verticalId, task: task?.slice(0, 6000) ?? null });
    if (!top.length) return "";
    return `<learned_from_the_team client="${clientId ?? ""}" agents="${agents.join(",")}">
What Kaizen's team taught you by pushing back on earlier work. Each holds only under its condition: apply it when the condition fits this task, otherwise ignore it. They never override the client's own rules or Kaizen's strategy.
${top.map((l) => `- [${scopeLabel(l)}${l.evidence > 1 ? `, seen ${l.evidence}×` : ""}] ${l.condition ? `When ${l.condition.replace(/^when\s+/i, "")}: ` : ""}${l.lesson}`).join("\n")}
</learned_from_the_team>
`;
  } catch (e) {
    console.error("[learnings] block", e instanceof Error ? e.message : e);
    return "";
  }
}

// ─── Consolidation (nightly and on demand) ───────────────────────────────────

const CONSOLIDATE = {
  type: "object",
  additionalProperties: false,
  required: ["duplicates", "contradictions"],
  properties: {
    duplicates: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["ids", "lesson", "condition"], properties: { ids: { type: "array", items: { type: "string" } }, lesson: { type: "string" }, condition: { type: "string" } } },
    },
    contradictions: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["a", "b", "why"], properties: { a: { type: "string" }, b: { type: "string" }, why: { type: "string" } } },
    },
  },
};

/** Tell execs something needs their call in Settings › AI agents › What it has learned */
async function tellExecs(admin: SupabaseClient, agentKey: string, title: string, body: string, key: string) {
  const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_exec", true);
  if (!execs?.length) return;
  await admin.from("notifications").upsert(
    execs.map((e) => ({ profile_id: e.id, kind: "agent", title: title.slice(0, 200), body: body.slice(0, 1000), href: `/settings?tab=agents&agent=${agentKey}&view=learned`, key, priority: "normal" })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

/**
 * Classify a few backfilled learnings, then per agent: merge duplicates (evidence adds up, and a lesson backed by three
 * clients reaches their shared sub-vertical or kind of business), settle contradictions (newer, more proven, narrower
 * wins; otherwise both wait for an exec), and retire what's had no new evidence in 120 days.
 */
export async function consolidateLearnings(admin: SupabaseClient, opts: { classify?: number; agents?: string[] } = {}) {
  const out = { classified: 0, merged: 0, widened: 0, retired: 0, conflicts: 0, settled: 0, errors: [] as string[] };
  // 1. A few unclassified ones (backfilled, or a classify that failed)
  const { data: raw } = await admin.from("agent_learnings").select("id").is("classified_at", null).neq("status", "merged").order("created_at").limit(opts.classify ?? 12);
  for (const r of raw ?? []) {
    try {
      await classifyLearning(admin, r.id as string);
      out.classified++;
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  // 2. Stale: nothing new in 120 days
  const stale = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const { data: old } = await admin.from("agent_learnings").update({ status: "retired", note: "No new evidence in 120 days", updated_at: new Date().toISOString() }).eq("status", "active").lt("last_seen", stale).select("id");
  out.retired += old?.length ?? 0;
  // 3. Per agent
  const { data: keys } = await admin.from("agent_learnings").select("agent_key").eq("status", "active").not("classified_at", "is", null);
  const agents = [...new Set((keys ?? []).map((k) => k.agent_key as string))].filter((k) => !opts.agents || opts.agents.includes(k));
  const places = new Map<string, ClientPlace>();
  for (const agentKey of agents) {
    try {
      const { data } = await admin.from("agent_learnings").select(COLS).eq("agent_key", agentKey).eq("status", "active").not("classified_at", "is", null).order("last_seen", { ascending: false }).limit(120);
      const rows = (data ?? []) as unknown as Row[];
      if (rows.length < 2) continue;
      const code = new Map(rows.map((r, i) => [`L${i + 1}`, r]));
      const clientCode = new Map<string, string>();
      for (const r of rows) if (r.client_id && !clientCode.has(r.client_id)) clientCode.set(r.client_id, `C${clientCode.size + 1}`);
      const res = await askJson<{ duplicates: { ids: string[]; lesson: string; condition: string }[]; contradictions: { a: string; b: string; why: string }[] }>({
        agent: agentKey as AgentKey,
        label: `learning consolidate ${agentKey}`,
        bare: true,
        schema: CONSOLIDATE,
        override: { model: "sonnet", effort: "low" },
        maxTokens: 6000,
        system: `You keep an AI agent's learned lessons tidy so they don't pile up and over-constrain it. You get its active lessons, each with an id, the client it came from (a code), its scope and condition.
- duplicates: groups of ids (2 or more) that teach the same thing under compatible conditions, with one merged lesson and the narrowest condition that covers them ("" if none). Only true duplicates.
- contradictions: pairs of ids that would tell the agent opposite things in the same situation, with why. Lessons for different clients or different conditions don't contradict.
Never invent ids. Leave both lists empty if there's nothing.`,
        prompt: [...code.entries()].map(([k, r]) => `${k} · client ${r.client_id ? clientCode.get(r.client_id) : "-"} · ${r.scope}${r.kind === "exception" ? " (one-off)" : ""} · seen ${r.evidence}× · last ${r.last_seen.slice(0, 10)}${r.condition ? ` · when ${r.condition}` : ""}\n${r.lesson}`).join("\n\n"),
      });
      const used = new Set<string>();
      for (const d of res.duplicates) {
        const group = d.ids.map((i) => code.get(i)).filter((x): x is Row => Boolean(x) && !used.has(x!.id));
        if (group.length < 2) continue;
        group.forEach((g) => used.add(g.id));
        // The oldest stays, the rest fold into it
        const [keep, ...rest] = [...group].sort((a, b) => Date.parse(a.last_seen) - Date.parse(b.last_seen));
        const clients = [...new Set(group.flatMap((g) => g.evidence_clients ?? []))];
        const evidence = group.reduce((n, g) => n + (g.evidence || 1), 0);
        const kind: LearningKind = group.every((g) => g.kind === "exception") ? "exception" : "lesson";
        const proposed = (group.map((g) => g.proposed_scope ?? "client") as LearningScope[]).sort((a, b) => ["client", "vertical", "model", "everyone"].indexOf(a) - ["client", "vertical", "model", "everyone"].indexOf(b))[0];
        const reach = widenScope(await Promise.all(clients.map((c) => placeOf(admin, c, places))), proposed, kind);
        if (reach.scope !== "client") out.widened++;
        await admin
          .from("agent_learnings")
          .update({
            lesson: d.lesson.trim().slice(0, 600) || keep.lesson,
            condition: d.condition.trim().slice(0, 300) || null,
            kind,
            evidence,
            evidence_clients: clients,
            sources: group.flatMap((g) => g.sources ?? []),
            last_seen: group.map((g) => g.last_seen).sort().at(-1),
            ...(reach.scope !== "client" ? { scope: reach.scope, model: reach.model, vertical_id: reach.verticalId, client_id: null } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", keep.id);
        await admin.from("agent_learnings").update({ status: "merged", merged_into: keep.id, updated_at: new Date().toISOString() }).in("id", rest.map((r) => r.id));
        out.merged += rest.length;
      }
      for (const c of res.contradictions) {
        const a = code.get(c.a);
        const b = code.get(c.b);
        if (!a || !b || used.has(a.id) || used.has(b.id)) continue;
        used.add(a.id);
        used.add(b.id);
        const w = pickWinner(toLearning(a), toLearning(b));
        if (w) {
          const [win, lose] = w === "a" ? [a, b] : [b, a];
          await admin.from("agent_learnings").update({ status: "retired", note: `Contradicted by a newer, better-backed lesson: ${win.lesson.slice(0, 200)}`, conflict_with: win.id, updated_at: new Date().toISOString() }).eq("id", lose.id);
          out.settled++;
        } else {
          await admin.from("agent_learnings").update({ status: "conflict", conflict_with: b.id, note: c.why.slice(0, 400), updated_at: new Date().toISOString() }).eq("id", a.id);
          await admin.from("agent_learnings").update({ status: "conflict", conflict_with: a.id, note: c.why.slice(0, 400), updated_at: new Date().toISOString() }).eq("id", b.id);
          await tellExecs(admin, agentKey, `Two lessons the ${agentKey} agent learned contradict`, `${c.why} Decide which holds in Settings › AI agents › What it has learned.`, `learning-conflict:${a.id}:${b.id}`);
          out.conflicts++;
        }
      }
    } catch (e) {
      out.errors.push(`${agentKey}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

// ─── An exec's hand on a learning ────────────────────────────────────────────

export type LearningView = {
  id: string;
  scope: LearningScope;
  kind: LearningKind;
  condition: string | null;
  lesson: string;
  confidence: number;
  evidence: number;
  clients: number;
  status: Row["status"];
  note: string | null;
  lastSeen: string;
  conflictWith: string | null;
  sources: { label: string; href: string | null }[];
  clientName: string | null;
};

/** One agent's learnings for Settings: by status, each with where it came from (a link back to the pushback) */
export async function loadLearnings(admin: SupabaseClient, agentKey: string): Promise<LearningView[]> {
  const { data } = await admin
    .from("agent_learnings")
    .select(`${COLS}, note, conflict_with, clients(name, slug)`)
    .eq("agent_key", agentKey)
    .neq("status", "merged")
    .order("status")
    .order("last_seen", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as unknown as (Row & { note: string | null; conflict_with: string | null; clients: { name: string; slug: string } | null })[];
  // Where each source lives: a ticket (creative and copy) or the client's audits
  const ids = (t: string) => [...new Set(rows.flatMap((r) => (r.sources ?? []).filter((s) => s.table === t).map((s) => s.id)))];
  const [{ data: dis }, { data: ovr }, { data: reb }] = await Promise.all([
    ids("creative_review_disagreements").length ? admin.from("creative_review_disagreements").select("id, requests(number)").in("id", ids("creative_review_disagreements")) : Promise.resolve({ data: [] }),
    ids("copy_rule_overrides").length ? admin.from("copy_rule_overrides").select("id, requests(number)").in("id", ids("copy_rule_overrides")) : Promise.resolve({ data: [] }),
    ids("audit_rebuttals").length ? admin.from("audit_rebuttals").select("id, clients(slug)").in("id", ids("audit_rebuttals")) : Promise.resolve({ data: [] }),
  ]);
  const ticket = new Map([...(dis ?? []), ...(ovr ?? [])].map((x) => [x.id as string, (x.requests as unknown as { number: number } | null)?.number ?? null]));
  const slug = new Map((reb ?? []).map((x) => [x.id as string, (x.clients as unknown as { slug: string } | null)?.slug ?? null]));
  const NAMES: Record<string, string> = { creative_review_disagreements: "Disagreed with a review note", copy_rule_overrides: "Copy flag rebutted or approved past", audit_rebuttals: "Audit finding pushed back on" };
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    kind: r.kind,
    condition: r.condition,
    lesson: r.lesson,
    confidence: Number(r.confidence) || 0.5,
    evidence: r.evidence,
    clients: (r.evidence_clients ?? []).length,
    status: r.status,
    note: r.note,
    lastSeen: r.last_seen,
    conflictWith: r.conflict_with,
    clientName: r.scope === "client" ? (r.clients?.name ?? null) : null,
    sources: (r.sources ?? []).slice(0, 6).map((s) => {
      const n = ticket.get(s.id);
      const sl = slug.get(s.id);
      return { label: `${NAMES[s.table] ?? s.table}${n ? ` · #${n}` : ""}`, href: n ? `/board?t=${n}` : sl ? `/clients/${sl}?tab=kpis` : null };
    }),
  }));
}
