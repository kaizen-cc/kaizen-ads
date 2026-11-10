import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { BusinessAuditResult, BusinessChannel } from "@/lib/business-audit";
import { firstPass, mergePlan, similarity, SAME, type CandidateMove, type ExistingMove, type MergeVerdict } from "@/lib/business-audit-merge";
import type { OwnerRole } from "@/lib/task-graph";
import { withCoBuyers } from "@/lib/buyer-seats";

// After a business audit: its moves go to the people who do them. Meta and Google moves go on that account's
// optimization sprint, to its buyer (the head of the platform follows). If a sprint is already being worked, the plan
// grows instead of resetting: only new moves are added at the end, and ones that pull against a move in progress are
// set aside for the buyer to decide. Creative, copy, client communication and whole-business moves become the client's
// tasks for the designer or editor, the copywriter, customer success or the lead. Everyone gets a notice that opens
// their sprint or tasks, and the audit keeps where each move went.

export type RoutedAction = {
  to: "sprint" | "task" | "later" | "duplicate" | "conflict";
  sprintId?: string | null;
  moveId?: string | null;
  taskKey?: string | null;
  owner?: string | null;
  note?: string | null;
};
export type RoutedChannel = {
  kind: "created" | "added" | "unchanged" | "tasks";
  platform?: "meta" | "google";
  sprintId?: string | null;
  owner?: string | null;
  added: number;
  duplicates: number;
  conflicts: { title: string; of: string; note: string }[];
};
export type BusinessRouting = { at: string; channels: Partial<Record<BusinessChannel, RoutedChannel>>; actions: Record<number, RoutedAction> };

type Action = BusinessAuditResult["actions"][number];

const COPY = /\b(copy|copywrit|headline|primary text|ad text|captions?|hooks? line|description line)/i;

/** Who does a non-paid move, as a task owner */
export function taskOwner(a: Pick<Action, "channel" | "owner" | "title" | "steps">): OwnerRole {
  if (a.owner === "client" || a.owner === "account_manager" || a.channel === "communication") return "coordinator";
  if (a.channel === "creative" || a.owner === "creative") return COPY.test(`${a.title} ${a.steps.join(" ")}`) ? "copywriter" : "head_of_creative";
  if (a.channel === "meta") return "meta_buyer";
  if (a.channel === "google") return "google_buyer";
  return "lead";
}

const MERGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, verdict: { type: "string", enum: ["new", "duplicate", "contradicts"] }, of: { type: "string" }, note: { type: "string" } },
        required: ["index", "verdict", "of", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

/** The AI's read of the moves the words couldn't settle: new, already on the sprint, or pulling against one in progress */
async function settleUnsure(platform: string, client: string, unsure: CandidateMove[], existing: ExistingMove[]): Promise<MergeVerdict[]> {
  if (!unsure.length) return [];
  const out = await askJson<{ verdicts: MergeVerdict[] }>({
    agent: "auditor",
    label: `sprint merge ${client}`,
    bare: true,
    override: { model: "haiku", effort: "low" },
    maxTokens: 3000,
    schema: MERGE_SCHEMA,
    system: `A ${platform} account already has an optimization sprint the media buyer is working. A new whole-business audit suggests more moves. For each suggested move, say:
- duplicate: the sprint already has this move (open or done), even in other words. of = that move's id.
- contradicts: it pulls against a move still to do or in progress (e.g. pause what the sprint is scaling, cut a budget the sprint raises, test against what it's testing). of = that move's id; note = one short line on the conflict, for the buyer to decide.
- new: anything else, including moves that build on the sprint. of = "", note = "".
Be strict about duplicates and contradictions: when unsure, it's new. Roles, never names. No em dashes.`,
    prompt: `<sprint_moves>\n${existing.map((e) => `${e.id} [${e.status}] ${e.title}${e.why ? `: ${e.why.slice(0, 160)}` : ""}`).join("\n")}\n</sprint_moves>\n\n<suggested_moves>\n${unsure.map((c) => `${c.index}: ${c.title}${c.why ? `: ${c.why.slice(0, 160)}` : ""}`).join("\n")}\n</suggested_moves>`,
  });
  return out.verdicts.map((v) => ({ ...v, of: v.of || null, note: v.note || null }));
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** Send a finished business audit's moves to the teams (safe to run again: it only adds what isn't there yet) */
export async function routeBusinessAudit(admin: SupabaseClient, auditId: string): Promise<BusinessRouting | null> {
  const { data: b } = await admin.from("business_audits").select("id, client_id, created_by, result, created_at, routing").eq("id", auditId).single();
  if (!b?.result) return null;
  if (b.routing) return b.routing as BusinessRouting;
  const r = b.result as BusinessAuditResult;
  const clientId = b.client_id as string;
  const dated = new Date(b.created_at as string).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const [{ data: client }, { owners }, { data: heads }, { addBusinessDays }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    import("@/lib/execution-plan"),
    admin.from("profiles").select("id, role").eq("is_active", true).in("role", ["head_of_meta", "head_of_google", "head_of_creative"]),
    import("@/lib/brand-bible"),
  ]);
  if (!client) return null;
  const who = await owners(admin, clientId);
  const head = (role: string) => (heads ?? []).find((h) => h.role === role)?.id as string | undefined;
  const routing: BusinessRouting = { at: new Date().toISOString(), channels: {}, actions: {} };
  const notices: { profileId: string; title: string; body: string; href: string; key: string; priority: "normal" | "critical" }[] = [];

  const act = r.actions.map((a, index) => ({ a, index }));
  for (const { a, index } of act) if (a.when === "next") routing.actions[index] = { to: "later" };
  const doable = act.filter(({ a }) => a.when !== "next");

  // ── Meta and Google: the account's sprint ──
  for (const platform of ["meta", "google"] as const) {
    const moves = doable.filter(({ a }) => a.channel === platform && (a.owner === "media_buyer" || a.owner === "strategist"));
    if (!moves.length) continue;
    const { data: targets } = await admin.from("kpi_targets").select("id, owner_id").eq("client_id", clientId).eq("platform", platform).eq("active", true).not("target", "is", null);
    if (!targets?.length) continue; // no account with a KPI set to run a sprint on: they become tasks below
    const ids = targets.map((t) => t.id as string);
    const { data: open } = await admin.from("optimization_sprints").select("id, target_id, buyer_id").in("target_id", ids).eq("status", "active").order("started_at", { ascending: false }).limit(1).maybeSingle();
    const candidates: CandidateMove[] = moves.map(({ a, index }) => ({ index, title: a.title, why: a.why }));
    const toMove = (index: number) => {
      const a = r.actions[index];
      return { index, title: a.title, area: platform, owner: "media_buyer", when: a.when, steps: a.steps, why: a.why, impact: a.impact, objects: a.objects ?? [] };
    };
    const headId = head(platform === "meta" ? "head_of_meta" : "head_of_google");
    const { openBusinessSprint, appendBusinessMoves } = await import("@/lib/sprints");

    if (open) {
      const { data: have } = await admin.from("sprint_actions").select("id, title, status, why").eq("sprint_id", open.id);
      const existing = (have ?? []) as ExistingMove[];
      const first = firstPass(candidates, existing);
      const ai = await settleUnsure(platform === "meta" ? "Meta" : "Google Ads", client.name as string, first.unsure, existing).catch((e) => {
        console.error("[business audit] merge", e instanceof Error ? e.message : e);
        return [] as MergeVerdict[];
      });
      const plan = mergePlan(first.kept, existing, [...first.settled, ...ai]);
      const conflicts = plan.conflicts.map((c) => ({ title: c.move.title, of: c.of.title, note: c.note }));
      const added = await appendBusinessMoves(admin, open.id as string, auditId, plan.add.map((m) => toMove(m.index)), conflicts, dated);
      plan.add.forEach((m, i) => (routing.actions[m.index] = { to: "sprint", sprintId: open.id as string, moveId: added[i] ?? null }));
      plan.duplicates.forEach((d) => (routing.actions[d.move.index] = { to: "duplicate", sprintId: open.id as string, moveId: d.of.id, note: `Already on the sprint: ${d.of.title}` }));
      plan.conflicts.forEach((c) => (routing.actions[c.move.index] = { to: "conflict", sprintId: open.id as string, moveId: c.of.id, note: c.note }));
      // A suggestion that repeats another one on this list isn't added twice
      for (const c of candidates) if (!routing.actions[c.index]) routing.actions[c.index] = { to: "duplicate", sprintId: open.id as string, note: "Said twice in the audit" };
      routing.channels[platform] = { kind: plan.add.length ? "added" : "unchanged", platform, sprintId: open.id as string, owner: (open.buyer_id as string | null) ?? null, added: plan.add.length, duplicates: plan.duplicates.length, conflicts };
      if (plan.add.length || conflicts.length) {
        const body = [
          plan.add.length ? `New: ${plan.add.map((m) => m.title).join("; ")}.` : "",
          conflicts.length ? `Left for you to decide (pulls against a move in progress): ${conflicts.map((c) => `${c.title} vs ${c.of}`).join("; ")}.` : "",
          "Your moves and progress stay as they were.",
        ].filter(Boolean).join(" ");
        const title = `${client.name}: ${plan.add.length ? `${plan.add.length} ${plan.add.length === 1 ? "move" : "moves"} added to your ${platform === "meta" ? "Meta" : "Google"} sprint` : `the business audit has a call for you on your ${platform === "meta" ? "Meta" : "Google"} sprint`}`;
        // The sprint's buyer (and the client's secondary buyers on the platform), and the head of the platform
        for (const pid of new Set([...(await withCoBuyers(admin, clientId, platform, [open.buyer_id as string | null])), headId].filter(Boolean) as string[]))
          notices.push({ profileId: pid, title, body, href: `/kpis/sprint/${open.id}`, key: `ba:${auditId}:${platform}`, priority: conflicts.length ? "critical" : "normal" });
      }
    } else {
      // No sprint on the account yet: open one from the audit, on the account with the most spend
      const { data: snaps } = await admin.from("kpi_snapshots").select("target_id, windows").in("target_id", ids);
      const spendOf = new Map((snaps ?? []).map((x) => [x.target_id as string, Number((x.windows as Record<string, { spend?: number }> | null)?.d30?.spend ?? 0)]));
      const target = [...targets].sort((x, y) => (spendOf.get(y.id as string) ?? 0) - (spendOf.get(x.id as string) ?? 0))[0];
      const first = firstPass(candidates, []);
      const buyer = (target.owner_id as string | null) ?? who[platform === "meta" ? "meta_buyer" : "google_buyer"] ?? null;
      const watchers = [...new Set([b.created_by as string | null, headId].filter((x): x is string => Boolean(x) && x !== buyer))];
      const { sprintId, ids: moveIds } = await openBusinessSprint(admin, { targetId: target.id as string, clientId, businessAuditId: auditId, buyer, watchers, createdBy: (b.created_by as string | null) ?? null, moves: first.kept.map((m) => toMove(m.index)), headline: r.verdict.headline });
      first.kept.forEach((m, i) => (routing.actions[m.index] = { to: "sprint", sprintId, moveId: moveIds[i] ?? null }));
      for (const c of candidates) if (!routing.actions[c.index]) routing.actions[c.index] = { to: "duplicate", sprintId, note: "Said twice in the audit" };
      routing.channels[platform] = { kind: "created", platform, sprintId, owner: buyer, added: first.kept.length, duplicates: 0, conflicts: [] };
      const title = `${client.name}: a ${platform === "meta" ? "Meta" : "Google"} sprint from the business audit`;
      const body = `${first.kept.length} ${first.kept.length === 1 ? "move" : "moves"} to work: ${first.kept.map((m) => m.title).join("; ")}.`;
      for (const pid of new Set([...(await withCoBuyers(admin, clientId, platform, [buyer])), headId].filter(Boolean) as string[])) notices.push({ profileId: pid, title, body, href: `/kpis/sprint/${sprintId}`, key: `ba:${auditId}:${platform}`, priority: "normal" });
    }
  }

  // ── Everything else (and paid moves with no account to sprint on): the client's tasks, to whoever does them ──
  const rest = doable.filter(({ index }) => !routing.actions[index]);
  if (rest.length) {
    const { data: openTasks } = await admin.from("client_tasks").select("key, title, owner_role").eq("client_id", clientId).like("key", "ba:%").in("status", ["ready", "in_progress", "blocked"]);
    const { data: last } = await admin.from("client_tasks").select("position").eq("client_id", clientId).order("position", { ascending: false }).limit(1).maybeSingle();
    let position = ((last?.position as number | undefined) ?? 0) + 1;
    const now = new Date();
    const rows: Record<string, unknown>[] = [];
    const perOwner = new Map<string, { titles: string[]; creative: boolean }>();
    for (const { a, index } of rest) {
      const role = taskOwner(a);
      const twin = (openTasks ?? []).find((t) => t.owner_role === role && similarity(t.title as string, a.title) >= SAME);
      if (twin) {
        routing.actions[index] = { to: "duplicate", taskKey: twin.key as string, note: `Already a task: ${twin.title}` };
        continue;
      }
      const key = `ba:${auditId.slice(0, 8)}:${index}`;
      const owner = who[role] ?? null;
      const brief = a.channel === "creative" && role === "head_of_creative" ? `\nBrief it (its quick preview, on the business audit): /clients/${client.slug}` : "";
      rows.push({
        client_id: clientId,
        key,
        title: a.owner === "client" ? `Ask the client: ${a.title}` : a.title,
        detail: [`From the full business audit (${dated}). ${a.why}`, ...a.steps.map((s, i) => `${i + 1}. ${s}`), a.impact ? `Expected: ${a.impact}` : ""].filter(Boolean).join("\n") + brief,
        platform: a.channel === "meta" || a.channel === "google" || a.channel === "creative" ? a.channel : "all",
        phase: "d30",
        owner_role: role,
        owner_id: owner,
        due_on: fmtDay(addBusinessDays(now, a.when === "now" ? 1 : 5)),
        depends_on: [],
        auto: null,
        status: "ready",
        ready_at: now.toISOString(),
        position: position++,
        updated_at: now.toISOString(),
      });
      routing.actions[index] = { to: "task", taskKey: key, owner };
      const ch = (routing.channels[a.channel] ??= { kind: "tasks", added: 0, duplicates: 0, conflicts: [] });
      ch.added++;
      if (owner) {
        const o = perOwner.get(owner) ?? { titles: [], creative: false };
        o.titles.push(a.title);
        o.creative ||= a.channel === "creative";
        perOwner.set(owner, o);
      }
    }
    if (rows.length) {
      const { error } = await admin.from("client_tasks").upsert(rows, { onConflict: "client_id,key", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    for (const [pid, o] of perOwner)
      notices.push({
        profileId: pid,
        title: `${client.name}: ${o.titles.length} ${o.titles.length === 1 ? "task" : "tasks"} from the business audit`,
        body: `${o.titles.join("; ")}.${o.creative ? " Brief the creative from the new request flow." : ""}`,
        href: `/clients/${client.slug}?tab=plan`,
        key: `ba:${auditId}:tasks:${pid}`,
        priority: "normal",
      });
  }

  if (notices.length)
    await admin.from("notifications").upsert(
      notices.map((n) => ({ profile_id: n.profileId, kind: "sprint", title: n.title.slice(0, 200), body: n.body.slice(0, 1000), href: n.href, client_id: clientId, key: n.key, priority: n.priority })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  await admin.from("business_audits").update({ routing }).eq("id", auditId);
  return routing;
}
