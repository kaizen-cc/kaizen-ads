import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { addBusinessDays } from "@/lib/brand-bible";
import { gtmForContext } from "@/lib/gtm";
import { servicesOf } from "@/lib/services";
import { isBuyerRole, platformOf, primaryOf, withCoBuyers, type SeatRow } from "@/lib/buyer-seats";
import { ROLE_LABEL, baseTasks, mergeTasks, nextStatuses, relations, type OwnerRole, type TaskRow, type TaskSpec } from "@/lib/task-graph";

// The final execution plan. Once the client approves their plan, the team reviews the Meta and Google go-to-market
// strategies (keep, change, audiences, angles), typed on the client page or said on an internal strategy call, and the
// strategist folds that into one plan: what we launch on each platform, the testing, and a dated 30/60/90-day plan. A
// buyer or lead signs it off and it becomes the client's tasks, owned by role, dated, and waiting on each other, so
// everyone sees what they're holding up and what they're waiting on.

export type PlanPlatform = { platform: "meta" | "google"; launch: string[]; audiences: string[]; creative: string[]; testing: string[]; budget: string };
export type PlanPhase = { window: "d30" | "d60" | "d90"; goal: string; items: string[] };
export type ExecutionPlan = { summary: string; platforms: PlanPlatform[]; phases: PlanPhase[]; open: string[]; folded: string[] };
export type PlanRow = {
  status: "waiting" | "building" | "draft" | "final" | "failed";
  missing: string[];
  notes: string;
  notesAt: string | null;
  callIds: string[];
  plan: ExecutionPlan | null;
  error: string | null;
  startedAt: string | null;
  generatedAt: string | null;
  signedOffAt: string | null;
  signedOffBy: string | null;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "platforms", "phases", "tasks", "timing", "open", "folded"],
  properties: {
    summary: { type: "string" },
    platforms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "launch", "audiences", "creative", "testing", "budget"],
        properties: {
          platform: { type: "string", enum: ["meta", "google"] },
          launch: { type: "array", items: { type: "string" } },
          audiences: { type: "array", items: { type: "string" } },
          creative: { type: "array", items: { type: "string" } },
          testing: { type: "array", items: { type: "string" } },
          budget: { type: "string" },
        },
      },
    },
    phases: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["window", "goal", "items"], properties: { window: { type: "string", enum: ["d30", "d60", "d90"] }, goal: { type: "string" }, items: { type: "array", items: { type: "string" } } } },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "detail", "platform", "phase", "owner_role", "due_in_business_days", "depends_on"],
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          detail: { type: "string" },
          platform: { type: "string", enum: ["meta", "google", "creative", "all"] },
          phase: { type: "string", enum: ["d30", "d60", "d90"] },
          owner_role: { type: "string", enum: ["meta_buyer", "google_buyer", "graphic_designer", "video_editor", "copywriter", "coordinator", "head_of_creative", "lead", "tracking", "client"] },
          due_in_business_days: { type: "number" },
          depends_on: { type: "array", items: { type: "string" } },
        },
      },
    },
    timing: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "due_in_business_days"], properties: { key: { type: "string" }, due_in_business_days: { type: "number" } } } },
    open: { type: "array", items: { type: "string" } },
    folded: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You are Kaizen Marketing's strategist. The client has approved their plan, and the team has reviewed the Meta and Google go-to-market strategies on an internal strategy call or in written notes: what to keep, what to change, audiences, ideas, angles. Fold that review into ONE final execution plan the team will run.

- The go-to-market strategies are the starting point; the team's notes and the strategy call override them wherever they disagree. In "folded", list each change the review made (one short line each). Never drop something the team said to keep.
- summary: 2 to 4 sentences: what we're launching first, for what goal, and how we'll know it's working (profitably: if it isn't profitable, it isn't working).
- platforms: one entry per platform Kaizen runs for them (only those). launch: the campaigns we launch first, with objective and structure. audiences: the audiences to start with and what to test next. creative: the angles and formats the first rounds are built on. testing: the tests in order, each with what it decides. budget: how the budget is split to start, in one line, from the strategies (or "Not set: confirm with the client").
- phases: d30, d60 and d90, each with a goal and the 3 to 6 things that happen in that window (dated where the strategies or the team gave a date).
- tasks: the plan's own steps beyond the fixed setup steps listed in <fixed_steps> (don't repeat those). Concrete, one owner each (by role), a due date in business days from today, and depends_on: the keys of fixed steps or of your own tasks this one can't start before (e.g. a retargeting test waits on "launch_meta"; a day-30 review waits on "launch_meta"). Give your own tasks short snake_case keys. 4 to 12 tasks across the 90 days. Only roles listed in <team> or "lead", "tracking", "client".
- timing: optional due dates for the fixed steps, in business days from today, when the strategies or the team set one.
- open: anything still to confirm (with who), short.
Plain words, no fluff, no em dashes. Refer to people by role, never by name.`;

const fromRow = (r: Record<string, unknown> | null, signer: string | null = null): PlanRow | null =>
  r
    ? {
        status: r.status as PlanRow["status"],
        missing: (r.missing as string[] | null) ?? [],
        notes: (r.notes as string) ?? "",
        notesAt: (r.notes_at as string | null) ?? null,
        callIds: (r.call_ids as string[] | null) ?? [],
        plan: (r.plan as ExecutionPlan | null) ?? null,
        error: (r.error as string | null) ?? null,
        startedAt: (r.started_at as string | null) ?? null,
        generatedAt: (r.generated_at as string | null) ?? null,
        signedOffAt: (r.signed_off_at as string | null) ?? null,
        signedOffBy: signer,
      }
    : null;

/** What the plan needs before it can be written: the client's approval and a go-to-market strategy per platform */
export async function planGate(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: deck }, { data: meta }, { data: google }] = await Promise.all([
    admin.from("clients").select("services, services_extra, services_removed").eq("id", clientId).maybeSingle(),
    admin.from("client_presentations").select("status, approved_at").eq("client_id", clientId).maybeSingle(),
    admin.from("client_gtm_strategies").select("status").eq("client_id", clientId).maybeSingle(),
    admin.from("client_google_gtm").select("status").eq("client_id", clientId).maybeSingle(),
  ]);
  const services = servicesOf(c ?? {});
  const has = { meta: services.includes("facebook-ads"), google: services.includes("google-ads"), creative: services.includes("creative"), video: false };
  const ready = (s?: string | null) => s === "draft" || s === "reviewed";
  const missing: string[] = [];
  if (deck?.status !== "approved") missing.push("the client approving their plan");
  if (has.meta && !ready(meta?.status as string | null)) missing.push("the Meta go-to-market strategy");
  if (has.google && !ready(google?.status as string | null)) missing.push("the Google Ads go-to-market strategy");
  if (!has.meta && !has.google && !has.creative) missing.push("a paid ads or creative service");
  return { missing, has, approvedAt: (deck?.approved_at as string | null) ?? null };
}

/** Internal team calls that talked about this client since they approved their plan: the strategy call */
export async function strategyCalls(admin: SupabaseClient, clientId: string, since: string | null) {
  const { data } = await admin
    .from("call_mentions")
    .select("call_id, summary, client_calls!inner(title, occurred_at, status)")
    .eq("client_id", clientId)
    .eq("client_calls.status", "internal")
    .gte("client_calls.occurred_at", since ?? "1970-01-01")
    .limit(10);
  return (data ?? [])
    .map((m) => {
      const call = m.client_calls as unknown as { title: string; occurred_at: string };
      const s = (m.summary ?? {}) as { summary?: string; decisions?: string[]; clientSaid?: string[] };
      return { id: m.call_id as string, title: call.title, at: call.occurred_at, text: [s.summary, s.decisions?.length ? `Decided: ${s.decisions.join("; ")}` : "", s.clientSaid?.length ? `About the client: ${s.clientSaid.join("; ")}` : ""].filter(Boolean).join("\n") };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Write (or rewrite) the plan as a draft from the strategies, the team's notes and the strategy calls */
export async function buildExecutionPlan(admin: SupabaseClient, clientId: string) {
  const gate = await planGate(admin, clientId);
  if (gate.missing.length) {
    await admin.from("client_execution_plans").upsert({ client_id: clientId, status: "waiting", missing: gate.missing, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
    return { status: "waiting" as const, missing: gate.missing };
  }
  const now = new Date().toISOString();
  await admin.from("client_execution_plans").upsert({ client_id: clientId, status: "building", started_at: now, error: null, missing: [], updated_at: now }, { onConflict: "client_id" });
  try {
    const [{ data: c }, { data: row }, { data: deck }, { data: seats }, calls, meta, google] = await Promise.all([
      admin.from("clients").select("name").eq("id", clientId).single(),
      admin.from("client_execution_plans").select("notes").eq("client_id", clientId).maybeSingle(),
      admin.from("client_presentations").select("reactions").eq("client_id", clientId).maybeSingle(),
      admin.from("client_assignments").select("role").eq("client_id", clientId),
      strategyCalls(admin, clientId, gate.approvedAt),
      gate.has.meta ? gtmForContext(admin, clientId, "meta") : Promise.resolve(null),
      gate.has.google ? gtmForContext(admin, clientId, "google") : Promise.resolve(null),
    ]);
    const { businessModelOf, modelBlock } = await import("@/lib/business-model");
    const model = await businessModelOf(admin, clientId).catch(() => null);
    const base = baseTasks(gate.has);
    const reactions = (deck?.reactions ?? {}) as { sections?: Record<string, { verdict: string; note: string }>; launch?: { choice: string } };
    const off = Object.entries(reactions.sections ?? {}).filter(([, v]) => v?.verdict === "off");
    const roles = [...new Set((seats ?? []).map((s) => s.role as string))];
    const out = await askJson<ExecutionPlan & { tasks: { key: string; title: string; detail: string; platform: string; phase: string; owner_role: string; due_in_business_days: number; depends_on: string[] }[]; timing: { key: string; due_in_business_days: number }[] }>({
      agent: "strategist",
      label: `execution plan ${c?.name ?? clientId}`,
      system: SYSTEM,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 12000,
      schema: SCHEMA,
      prompt: [
        `<client>${c?.name ?? ""}</client>`,
        `<today>${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" })}</today>`,
        model ? modelBlock(model) : "",
        `<team>Seats filled: ${roles.join(", ") || "none yet"}</team>`,
        `<fixed_steps>\n${base.map((t) => `${t.key}: ${t.title} (${ROLE_LABEL[t.owner_role]})${t.depends_on.length ? `, waits on ${t.depends_on.join(", ")}` : ""}`).join("\n")}\n</fixed_steps>`,
        meta ? `<meta_strategy>\n${meta}\n</meta_strategy>` : "",
        google ? `<google_strategy>\n${google}\n</google_strategy>` : "",
        reactions.launch ? `<client_launch_choice>${reactions.launch.choice === "engagement_first" ? "Go live fast with an engagement campaign from their best posts, then conversion campaigns" : "Wait for the conversion creative before launching"}</client_launch_choice>` : "",
        off.length ? `<client_said_not_quite>\n${off.map(([k, v]) => `${k}: ${v.note}`).join("\n")}\n</client_said_not_quite>` : "",
        row?.notes?.trim() ? `<team_notes>\n${row.notes.trim()}\n</team_notes>` : "",
        calls.length ? `<strategy_calls>\n${calls.map((x) => `${x.title} (${x.at.slice(0, 10)}):\n${x.text}`).join("\n\n")}\n</strategy_calls>` : "",
        !row?.notes?.trim() && !calls.length ? "No team notes or strategy call yet: write the plan from the strategies, and say in open that the team still needs to review it." : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const plan: ExecutionPlan = { summary: out.summary, platforms: out.platforms.filter((p) => (p.platform === "meta" ? gate.has.meta : gate.has.google)), phases: out.phases, open: out.open, folded: out.folded };
    const tasks = mergeTasks(base, out.tasks ?? [], out.timing ?? []);
    await admin
      .from("client_execution_plans")
      .update({ status: "draft", plan: { ...plan, tasks }, markdown: planMarkdown(plan), call_ids: calls.map((x) => x.id), generated_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() })
      .eq("client_id", clientId);
    return { status: "draft" as const };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("client_execution_plans").update({ status: "failed", error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq("client_id", clientId);
    return { status: "failed" as const, error };
  }
}

export function planMarkdown(p: ExecutionPlan) {
  const name = { meta: "Meta", google: "Google Ads" } as const;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return [
    p.summary,
    ...p.platforms.map((x) => `## ${name[x.platform]}\n**Launch**\n${list(x.launch)}\n\n**Audiences**\n${list(x.audiences)}\n\n**Creative**\n${list(x.creative)}\n\n**Testing**\n${list(x.testing)}\n\n**Budget:** ${x.budget}`),
    `## 30/60/90\n${p.phases.map((ph) => `**${ph.window === "d30" ? "Days 1 to 30" : ph.window === "d60" ? "Days 31 to 60" : "Days 61 to 90"}: ${ph.goal}**\n${list(ph.items)}`).join("\n\n")}`,
    p.open.length ? `## Still to confirm\n${list(p.open)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who holds each role on this client (the seats, then the leads), for task owners */
export async function owners(admin: SupabaseClient, clientId: string): Promise<Partial<Record<OwnerRole, string>>> {
  const [{ data: seats }, { data: leads }] = await Promise.all([
    admin.from("client_assignments").select("role, profile_id, is_primary, created_at").eq("client_id", clientId),
    admin.from("profiles").select("id, role").eq("is_active", true).in("role", ["head_of_creative", "head_of_meta", "head_of_google"]),
  ]);
  // A task has one owner: the seat's primary
  const seat = (r: string) => primaryOf((seats ?? []) as SeatRow[], r)?.profile_id;
  const lead = (r: string) => (leads ?? []).find((p) => p.role === r)?.id as string | undefined;
  return {
    meta_buyer: seat("meta_buyer") ?? lead("head_of_meta"),
    google_buyer: seat("google_buyer") ?? lead("head_of_google"),
    graphic_designer: seat("graphic_designer") ?? lead("head_of_creative"),
    video_editor: seat("video_editor") ?? lead("head_of_creative"),
    copywriter: seat("copywriter") ?? lead("head_of_creative"),
    coordinator: seat("coordinator"),
    head_of_creative: lead("head_of_creative"),
    lead: seat("meta_buyer") ? lead("head_of_meta") : seat("google_buyer") ? lead("head_of_google") : (lead("head_of_meta") ?? lead("head_of_google")),
  };
}

/** Signed off: the plan becomes the client's tasks, dated from today, and the first ones are ready */
export async function signOffPlan(admin: SupabaseClient, clientId: string, by: string) {
  const { data: row } = await admin.from("client_execution_plans").select("status, plan").eq("client_id", clientId).maybeSingle();
  if (!row || row.status !== "draft") return { ok: false as const, error: "There's no draft plan to sign off." };
  const tasks = ((row.plan as { tasks?: TaskSpec[] } | null)?.tasks ?? []) as TaskSpec[];
  const now = new Date();
  await admin.from("client_execution_plans").update({ status: "final", signed_off_at: now.toISOString(), signed_off_by: by, updated_at: now.toISOString() }).eq("client_id", clientId);
  const who = await owners(admin, clientId);
  const due = (d: number | null) => (d == null ? null : (d === 0 ? now : addBusinessDays(now, d)).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  const { data: existing } = await admin.from("client_tasks").select("key, status, owner_id").eq("client_id", clientId);
  const kept = new Map((existing ?? []).map((t) => [t.key as string, t]));
  await admin.from("client_tasks").upsert(
    tasks.map((t, i) => ({
      client_id: clientId,
      key: t.key,
      title: t.title,
      detail: t.detail,
      platform: t.platform,
      phase: t.phase,
      owner_role: t.owner_role,
      // An owner someone set by hand stays
      owner_id: (kept.get(t.key)?.owner_id as string | null) ?? who[t.owner_role] ?? null,
      due_on: due(t.due_days),
      depends_on: t.depends_on,
      auto: t.auto,
      status: (kept.get(t.key)?.status as string | undefined) ?? "blocked",
      position: i,
      updated_at: now.toISOString(),
    })),
    { onConflict: "client_id,key" },
  );
  // Steps a rebuilt plan dropped are set aside, never deleted
  const keys = new Set(tasks.map((t) => t.key));
  // (a business audit's tasks, ba:…, and actions saved from a launch chat, lc:…, aren't part of the plan: they stay)
  const dropped = (existing ?? []).filter((t) => !keys.has(t.key as string) && !/^(ba|lc):/.test(String(t.key)) &&!["done", "skipped"].includes(t.status as string)).map((t) => t.key as string);
  if (dropped.length) await admin.from("client_tasks").update({ status: "skipped", updated_at: now.toISOString() }).eq("client_id", clientId).in("key", dropped);
  await refreshTasks(admin, clientId);
  return { ok: true as const };
}

/** The real events that complete tasks on their own */
async function events(admin: SupabaseClient, clientId: string) {
  const [{ count: intakes }, { data: deck }, { data: plan }, { data: c }, { data: launch }] = await Promise.all([
    admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", clientId),
    admin.from("client_presentations").select("status, approved_at").eq("client_id", clientId).maybeSingle(),
    admin.from("client_execution_plans").select("status").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("status").eq("id", clientId).maybeSingle(),
    admin.from("engagement_launches").select("status").eq("client_id", clientId).maybeSingle(),
  ]);
  const since = (deck?.approved_at as string | null) ?? "1970-01-01";
  const { data: reqs } = await admin.from("requests").select("stage").eq("client_id", clientId).gte("created_at", since).limit(200);
  const { loadGuide, guideHas } = await import("@/lib/onboarding-guide");
  const { accessLeft } = await import("@/lib/onboarding-guide-types");
  const [guide, has] = await Promise.all([loadGuide(admin, clientId), guideHas(admin, clientId)]);
  const stages = new Set((reqs ?? []).map((r) => r.stage as string));
  const ev = new Set<string>();
  if (intakes) ev.add("intake");
  if (deck?.status === "approved") ev.add("plan_approved");
  if (plan?.status === "final") ev.add("plan_final");
  if (guide.meta.status === "verified") ev.add("meta_access");
  if (guide.google.status === "verified") ev.add("google_access");
  const picks = guide.tracking.picks ?? [];
  if (["done", "na"].includes(guide.tracking.status ?? "") || (picks.length > 0 && picks.every((p) => p.status === "done"))) ev.add("tracking");
  if (["ready_for_client", "client_review", "client_revision", "ready_for_launch", "launched"].some((s) => stages.has(s))) ev.add("creative_made");
  if (stages.has("ready_for_launch") || stages.has("launched")) ev.add("creative_approved");
  if (stages.has("launched") || launch?.status === "live") ev.add("launched_meta");
  if (accessLeft(guide, has).left === 0 || (c?.status && c.status !== "onboarding")) ev.add("onboarding_done");
  return ev;
}

/** Bring a client's tasks up to date: done when their event happened, blocked or ready from what they wait on */
export async function refreshTasks(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("client_tasks").select("id, key, title, status, depends_on, owner_role, owner_id, auto, due_on").eq("client_id", clientId);
  const tasks = (data ?? []) as (TaskRow & { id: string })[];
  if (!tasks.length) return 0;
  const changes = nextStatuses(tasks, await events(admin, clientId));
  if (!changes.length) return 0;
  const now = new Date().toISOString();
  const { data: client } = await admin.from("clients").select("name, slug").eq("id", clientId).single();
  for (const ch of changes) {
    const t = tasks.find((x) => x.key === ch.key)!;
    await admin
      .from("client_tasks")
      .update({ status: ch.status, updated_at: now, ...(ch.status === "done" ? { done_at: now, done_how: ch.how ?? "manual" } : {}), ...(ch.status === "ready" ? { ready_at: now } : {}) })
      .eq("id", t.id);
    t.status = ch.status;
  }
  // Whoever's turn it now is hears it, with what it holds up
  for (const ch of changes.filter((x) => x.status === "ready")) {
    const t = tasks.find((x) => x.key === ch.key)!;
    if (!t.owner_id) continue;
    const { holdingUp } = relations(tasks, t.key);
    // A buyer's task: the client's secondary buyers on that platform hear it too
    const to = isBuyerRole(t.owner_role) ? await withCoBuyers(admin, clientId, platformOf(t.owner_role), [t.owner_id]) : [t.owner_id];
    await admin.from("notifications").upsert(
      to.map((id) => ({
        profile_id: id,
        kind: "task",
        title: `Your turn: ${t.title}`.slice(0, 200),
        body: `${client?.name ?? "A client"}: everything it waited on is done.${holdingUp.length ? ` It's holding up ${holdingUp.map((h) => h.title).join(", ")}.` : ""}`.slice(0, 1000),
        href: `/clients/${client?.slug ?? ""}?tab=plan`,
        client_id: clientId,
        key: `task-ready:${t.id}`,
        priority: holdingUp.length ? "high" : "normal",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  return changes.length;
}

/**
 * Every few minutes: write the plan once a client has approved and the strategies are in; rewrite a draft when an
 * internal strategy call about them comes in; and keep every client's tasks up to date. One plan written per run.
 */
export async function keepExecution(admin: SupabaseClient) {
  const out: Record<string, string> = {};
  const { data: approved } = await admin.from("client_presentations").select("client_id, approved_at, clients!inner(name, status, archived_at)").eq("status", "approved").is("clients.archived_at", null).limit(200);
  const ids = (approved ?? []).map((a) => a.client_id as string);
  if (ids.length) {
    const { data: plans } = await admin.from("client_execution_plans").select("client_id, status, call_ids, started_at").in("client_id", ids);
    let wrote = false;
    for (const a of approved ?? []) {
      if (wrote) break;
      const id = a.client_id as string;
      const p = (plans ?? []).find((x) => x.client_id === id);
      const name = (a.clients as unknown as { name: string }).name;
      const stuck = p?.status === "building" && Date.now() - Date.parse((p.started_at as string) ?? "1970-01-01") > 30 * 60_000;
      if (!p || p.status === "waiting" || p.status === "failed" || stuck) {
        if (p?.status === "failed" && Date.now() - Date.parse((p.started_at as string) ?? "1970-01-01") < 6 * 3_600_000) continue;
        const gate = await planGate(admin, id);
        if (gate.missing.length) {
          if (p?.status !== "waiting") await admin.from("client_execution_plans").upsert({ client_id: id, status: "waiting", missing: gate.missing, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
          continue;
        }
        out[name] = (await buildExecutionPlan(admin, id)).status;
        wrote = true;
      } else if (p.status === "draft") {
        // A strategy call since the last draft: fold it in
        const calls = await strategyCalls(admin, id, a.approved_at as string | null);
        if (calls.some((x) => !((p.call_ids as string[] | null) ?? []).includes(x.id))) {
          out[name] = `${(await buildExecutionPlan(admin, id)).status} (strategy call)`;
          wrote = true;
        }
      }
    }
  }
  const { data: open } = await admin.from("client_tasks").select("client_id").not("status", "in", "(done,skipped)").limit(2000);
  for (const id of [...new Set((open ?? []).map((t) => t.client_id as string))].slice(0, 40)) await refreshTasks(admin, id).catch(() => 0);
  return out;
}

export async function loadPlan(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("client_execution_plans").select("*, profiles:signed_off_by(full_name)").eq("client_id", clientId).maybeSingle();
  return fromRow(data, (data?.profiles as unknown as { full_name: string } | null)?.full_name ?? null);
}

export type ClientTask = {
  id: string;
  key: string;
  title: string;
  detail: string;
  platform: string;
  phase: string;
  ownerRole: OwnerRole;
  ownerId: string | null;
  owner: string | null;
  dueOn: string | null;
  status: TaskRow["status"];
  doneAt: string | null;
  doneHow: "auto" | "manual" | null;
  waitingOn: { title: string; who: string }[];
  holdingUp: { title: string; who: string }[];
};

const whoOf = (t: { owner_role: string; owner_id: string | null }, names: Map<string, string>) => (t.owner_role === "client" ? "the client" : t.owner_id ? (names.get(t.owner_id) ?? ROLE_LABEL[t.owner_role as OwnerRole]) : ROLE_LABEL[t.owner_role as OwnerRole] ?? t.owner_role);

/** A client's tasks with names, and what each waits on and holds up */
export async function loadTasks(db: SupabaseClient, clientId: string): Promise<ClientTask[]> {
  const { data } = await db.from("client_tasks").select("id, key, title, detail, platform, phase, owner_role, owner_id, due_on, depends_on, auto, status, done_at, done_how, position").eq("client_id", clientId).neq("status", "skipped").order("position");
  return shape(db, (data ?? []) as Record<string, unknown>[]);
}

async function shape(db: SupabaseClient, rows: Record<string, unknown>[], all?: Record<string, unknown>[]): Promise<ClientTask[]> {
  const pool = (all ?? rows) as unknown as (TaskRow & { client_id?: string })[];
  const ids = [...new Set(pool.map((t) => t.owner_id).filter(Boolean))] as string[];
  const { data: people } = ids.length ? await db.from("profiles").select("id, full_name").in("id", ids) : { data: [] };
  const names = new Map((people ?? []).map((p) => [p.id as string, p.full_name as string]));
  return rows.map((r) => {
    const sameClient = pool.filter((x) => !x.client_id || x.client_id === r.client_id);
    const rel = relations(sameClient, r.key as string);
    return {
      id: r.id as string,
      key: r.key as string,
      title: r.title as string,
      detail: (r.detail as string) ?? "",
      platform: r.platform as string,
      phase: r.phase as string,
      ownerRole: r.owner_role as OwnerRole,
      ownerId: (r.owner_id as string | null) ?? null,
      owner: whoOf(r as never, names),
      dueOn: (r.due_on as string | null) ?? null,
      status: r.status as TaskRow["status"],
      doneAt: (r.done_at as string | null) ?? null,
      doneHow: (r.done_how as "auto" | "manual" | null) ?? null,
      waitingOn: rel.waitingOn.map((x) => ({ title: x.title, who: whoOf(x, names) })),
      holdingUp: rel.holdingUp.map((x) => ({ title: x.title, who: whoOf(x, names) })),
    };
  });
}

/** One person's open plan tasks across their clients, with what they hold up and wait on */
export async function myTasks(db: SupabaseClient, me: string) {
  const { data: mine } = await db.from("client_tasks").select("id, key, title, detail, platform, phase, owner_role, owner_id, due_on, depends_on, auto, status, done_at, done_how, position, client_id, clients(name, slug)").eq("owner_id", me).in("status", ["ready", "in_progress", "blocked"]).limit(60);
  if (!mine?.length) return [];
  const clientIds = [...new Set(mine.map((t) => t.client_id as string))];
  const { data: all } = await db.from("client_tasks").select("key, title, status, depends_on, owner_role, owner_id, client_id").in("client_id", clientIds).neq("status", "skipped");
  const shaped = await shape(db, mine as Record<string, unknown>[], (all ?? []) as Record<string, unknown>[]);
  return shaped.map((t, i) => {
    const c = mine[i].clients as unknown as { name: string; slug: string } | null;
    return { ...t, clientId: mine[i].client_id as string, client: c?.name ?? "", clientSlug: c?.slug ?? "" };
  });
}

/** For the kickoff message: whether the plan is signed off, and its 30/60/90 in short */
export async function planSignedOff(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("client_execution_plans").select("status, plan, signed_off_at").eq("client_id", clientId).maybeSingle();
  const plan = (data?.plan ?? null) as ExecutionPlan | null;
  if (data?.status !== "final" || !plan) return { signedOff: false as const, at: null, summary: null, phases: [] as PlanPhase[] };
  return { signedOff: true as const, at: data.signed_off_at as string, summary: plan.summary, phases: plan.phases };
}
