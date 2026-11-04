// A client's plan as tasks that wait on each other: the fixed setup steps every new client goes through (access,
// tracking, the first round, approval, launch) and the steps the execution plan adds, each owned by a role. Pure:
// shared by the server (statuses, notices) and the client page (the timeline), and tested on its own.

export type TaskStatus = "blocked" | "ready" | "in_progress" | "done" | "skipped";
export type TaskPhase = "setup" | "d30" | "d60" | "d90";
export type TaskPlatform = "meta" | "google" | "creative" | "all";
/** Who owns a task: a seat on the client, a lead, the tracking team, or the client themselves */
export type OwnerRole = "meta_buyer" | "google_buyer" | "graphic_designer" | "video_editor" | "copywriter" | "coordinator" | "head_of_creative" | "lead" | "tracking" | "client";
/** Real events that complete a task on their own */
export type AutoEvent = "intake" | "plan_approved" | "plan_final" | "meta_access" | "google_access" | "tracking" | "creative_made" | "creative_approved" | "launched_meta" | "launched_google" | "onboarding_done";

export type TaskSpec = { key: string; title: string; detail: string; platform: TaskPlatform; phase: TaskPhase; owner_role: OwnerRole; depends_on: string[]; auto: AutoEvent | null; due_days: number | null };
export type TaskRow = { id?: string; key: string; title: string; status: TaskStatus; depends_on: string[]; owner_role: string; owner_id: string | null; auto: string | null; due_on: string | null };

export const OWNER_ROLES: OwnerRole[] = ["meta_buyer", "google_buyer", "graphic_designer", "video_editor", "copywriter", "coordinator", "head_of_creative", "lead", "tracking", "client"];
export const ROLE_LABEL: Record<OwnerRole, string> = {
  meta_buyer: "Meta buyer",
  google_buyer: "Google buyer",
  graphic_designer: "Designer",
  video_editor: "Video editor",
  copywriter: "Copywriter",
  coordinator: "Customer success",
  head_of_creative: "Head of Creative",
  lead: "Lead",
  tracking: "Tracking",
  client: "The client",
};
export const PHASE_LABEL: Record<TaskPhase, string> = { setup: "Getting set up", d30: "Days 1 to 30", d60: "Days 31 to 60", d90: "Days 61 to 90" };

/** The steps every new client goes through, for the services they have. Keys are fixed so plan steps can wait on them. */
export function baseTasks(has: { meta: boolean; google: boolean; creative: boolean; video: boolean }): TaskSpec[] {
  const ads = has.meta || has.google;
  const out: TaskSpec[] = [
    { key: "intake", title: "Marketing intake form in", detail: "Their goals, customers and offers, from the portal.", platform: "all", phase: "setup", owner_role: "client", depends_on: [], auto: "intake", due_days: null },
    { key: "plan_approved", title: "Client approves their plan", detail: "How we see them, approved in their portal (or on its own after 3 business days).", platform: "all", phase: "setup", owner_role: "client", depends_on: [], auto: "plan_approved", due_days: null },
    { key: "execution_plan", title: "Sign off the execution plan", detail: "The go-to-market strategies reviewed with the team's notes, folded into the final plan.", platform: "all", phase: "setup", owner_role: "lead", depends_on: ["plan_approved"], auto: "plan_final", due_days: 0 },
  ];
  if (has.meta) out.push({ key: "meta_access", title: "Meta access shared and verified", detail: "Kaizen is a partner on their Business Manager with the ad account, Page, Instagram and dataset.", platform: "meta", phase: "setup", owner_role: "client", depends_on: [], auto: "meta_access", due_days: 1 });
  if (has.google) out.push({ key: "google_access", title: "Google Ads access verified", detail: "Their account linked to our manager account.", platform: "google", phase: "setup", owner_role: "client", depends_on: [], auto: "google_access", due_days: 1 });
  if (ads)
    out.push({
      key: "tracking",
      title: "Conversion tracking confirmed",
      detail: "The pixel or tags fire, each conversion and custom event is mapped to what it means on the site, and where revenue or leads are tracked is connected. The team is told which event is which.",
      platform: "all",
      phase: "setup",
      owner_role: "tracking",
      depends_on: [has.meta ? "meta_access" : "google_access"],
      auto: "tracking",
      due_days: 3,
    });
  if (has.creative || has.meta) {
    out.push({ key: "first_round", title: "First round of creative made", detail: "Built from the plan's angles, through internal review and copy.", platform: "creative", phase: "d30", owner_role: has.video && !has.creative ? "video_editor" : "graphic_designer", depends_on: ["execution_plan"], auto: "creative_made", due_days: 5 });
    out.push({ key: "creative_approved", title: "Client approves the first round", detail: "In their portal: designs and copy.", platform: "creative", phase: "d30", owner_role: "client", depends_on: ["first_round"], auto: "creative_approved", due_days: 8 });
  }
  if (has.meta) {
    out.push({ key: "build_meta", title: "Build the Meta campaigns", detail: "Campaign structure, audiences and naming from the plan, in the ad account, paused.", platform: "meta", phase: "d30", owner_role: "meta_buyer", depends_on: ["meta_access", "execution_plan"], auto: null, due_days: 3 });
    out.push({ key: "launch_meta", title: "Launch on Meta", detail: "The approved creative live in the campaigns built for it.", platform: "meta", phase: "d30", owner_role: "meta_buyer", depends_on: ["build_meta", "creative_approved", "tracking"], auto: "launched_meta", due_days: 10 });
  }
  if (has.google) {
    out.push({ key: "build_google", title: "Build the Google campaigns", detail: "Campaigns, keyword groups, negatives, geo and assets from the plan, paused.", platform: "google", phase: "d30", owner_role: "google_buyer", depends_on: ["google_access", "execution_plan"], auto: null, due_days: 4 });
    out.push({ key: "launch_google", title: "Launch on Google", detail: "Campaigns on, with conversion tracking confirmed.", platform: "google", phase: "d30", owner_role: "google_buyer", depends_on: ["build_google", "tracking"], auto: "launched_google", due_days: 6 });
  }
  return out;
}

/** Plan steps from the AI, made safe: known roles and phases, unique keys, dependencies only on tasks that exist */
export function mergeTasks(base: TaskSpec[], extra: { key: string; title: string; detail: string; platform: string; phase: string; owner_role: string; due_in_business_days: number; depends_on: string[] }[], timing: { key: string; due_in_business_days: number }[] = []) {
  const out = base.map((t) => ({ ...t }));
  for (const t of timing) {
    const b = out.find((x) => x.key === t.key);
    if (b && Number.isFinite(t.due_in_business_days) && t.due_in_business_days >= 0) b.due_days = Math.min(120, Math.round(t.due_in_business_days));
  }
  const keys = new Set(out.map((t) => t.key));
  for (const t of extra) {
    let key = `p_${(t.key || t.title).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}`;
    while (keys.has(key)) key = `${key}_2`;
    keys.add(key);
    out.push({
      key,
      title: t.title.slice(0, 160),
      detail: (t.detail ?? "").slice(0, 1200),
      platform: (["meta", "google", "creative", "all"].includes(t.platform) ? t.platform : "all") as TaskPlatform,
      phase: (["setup", "d30", "d60", "d90"].includes(t.phase) ? t.phase : "d30") as TaskPhase,
      owner_role: (OWNER_ROLES.includes(t.owner_role as OwnerRole) ? t.owner_role : "lead") as OwnerRole,
      depends_on: t.depends_on ?? [],
      auto: null,
      due_days: Number.isFinite(t.due_in_business_days) ? Math.max(0, Math.min(120, Math.round(t.due_in_business_days))) : null,
    });
  }
  // Dependencies point at real tasks (an AI key like "launch_meta" or one of its own, "p_…"), never at themselves
  const resolve = (d: string) => (keys.has(d) ? d : keys.has(`p_${d}`) ? `p_${d}` : null);
  for (const t of out) t.depends_on = [...new Set(t.depends_on.map(resolve).filter((d): d is string => Boolean(d) && d !== t.key))];
  return dropCycles(out);
}

/** A dependency that would make a loop is dropped (the later one), so nothing waits on itself forever */
export function dropCycles<T extends { key: string; depends_on: string[] }>(tasks: T[]): T[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byKey.get(from)?.depends_on ?? []).some((d) => reaches(d, to, seen));
  };
  for (const t of tasks) {
    const kept: string[] = [];
    for (const d of t.depends_on) if (!reaches(d, t.key)) kept.push(d);
    t.depends_on = kept;
  }
  return tasks;
}

const settled = (s: TaskStatus) => s === "done" || s === "skipped";

/**
 * Each open task's status from what's happened: a task whose real event happened is done; one still waiting on an
 * unfinished task is blocked; otherwise it's ready (or stays in progress). Returns the changes only.
 */
export function nextStatuses(tasks: TaskRow[], events: Set<string>) {
  const status = new Map(tasks.map((t) => [t.key, t.status]));
  const changes: { key: string; status: TaskStatus; how?: "auto" }[] = [];
  for (const t of tasks) {
    if (!settled(t.status) && t.auto && events.has(t.auto)) {
      status.set(t.key, "done");
      changes.push({ key: t.key, status: "done", how: "auto" });
    }
  }
  for (const t of tasks) {
    const s = status.get(t.key)!;
    if (settled(s)) continue;
    const waiting = t.depends_on.some((d) => status.has(d) && !settled(status.get(d)!));
    const next: TaskStatus = waiting ? "blocked" : s === "in_progress" ? "in_progress" : "ready";
    if (next !== s) changes.push({ key: t.key, status: next });
  }
  return changes;
}

/** What a task waits on, and what's waiting on it */
export function relations(tasks: TaskRow[], key: string) {
  const t = tasks.find((x) => x.key === key);
  const waitingOn = t ? tasks.filter((x) => t.depends_on.includes(x.key) && !settled(x.status)) : [];
  const holdingUp = tasks.filter((x) => x.depends_on.includes(key) && !settled(x.status));
  return { waitingOn, holdingUp };
}
