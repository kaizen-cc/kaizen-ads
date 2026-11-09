import type { TeamRole } from "@/lib/roles";

// Who can train which AI agent (Settings › AI agents). Executives train every agent. Each service line's head trains
// their own line's agent and its skills: the Head of Meta the Media Buyer, the Head of Google the Google Ads Buyer, the
// Head of Creative the Creative Director. Models and effort (cost), shared knowledge and Kaizen's strategy spine stay
// with the executives.

/** Each role agent's skills (ai_agents.role_key) */
export const ROLE_SKILLS: Record<string, readonly string[]> = {
  media_buyer: ["auditor", "launcher", "fatigue", "reporter", "report_qa"],
  google_buyer: ["google_launcher", "google_reporter", "google_auditor"],
  // Offline shells until an exec brings the TikTok Ads Buyer online; the Head of Meta writes its skills
  tiktok_buyer: ["tiktok_auditor", "tiktok_launcher", "tiktok_reporter"],
  creative_director: ["creativereview", "creativecheck", "review"],
  copywriter: ["copy", "scripts"],
  strategist: ["suggest", "strategist", "gtm", "brandbible", "lab"],
  market_analyst: ["market", "winners", "industry", "verticals"],
  account_manager: ["briefing", "calls"],
};

/** The role agents each head trains */
export const HEAD_LINES: Partial<Record<TeamRole, readonly string[]>> = {
  head_of_meta: ["media_buyer", "tiktok_buyer"],
  head_of_google: ["google_buyer"],
  head_of_creative: ["creative_director"],
};

/** The role agent a skill belongs to (a role key is its own); null for a skill outside the six or shared knowledge */
export function roleOfAgent(key: string | null | undefined): string | null {
  if (!key) return null;
  const k = key.startsWith("role:") ? key.slice(5) : key;
  if (ROLE_SKILLS[k]) return k;
  for (const [role, skills] of Object.entries(ROLE_SKILLS)) if (skills.includes(k)) return role;
  return null;
}

type Me = { role: string | null | undefined; isExec?: boolean | null };

/** The role agents this person can train: every one for an exec, their line's for a head, none for anyone else */
export function trainableRoles(me: Me): readonly string[] {
  if (me.isExec) return Object.keys(ROLE_SKILLS);
  return HEAD_LINES[me.role as TeamRole] ?? [];
}

/**
 * Whether this person can train an agent: chat with it or a skill's coach, apply its proposals, edit its core, skill
 * instructions and items, run its tests and review its learnings. `target` is a role key, a skill (agent) key, or a
 * knowledge target "role:<key>". Null (shared knowledge, read by every agent) is executives only.
 */
export function canTrainAgent(me: Me, target: string | null | undefined): boolean {
  if (me.isExec) return true;
  const role = roleOfAgent(target);
  return Boolean(role && trainableRoles(me).includes(role));
}

/** Whether someone is a head who trains an agent (not an exec): their changes are logged for the execs' digest */
export const isHeadTrainer = (me: Me) => !me.isExec && trainableRoles(me).length > 0;

export type Snapshot = Record<string, unknown> | null;

/**
 * One line for the execs' digest: "Head of Google updated the Google Ads Buyer's Google account audit skill". `record`
 * is agent:<key>, item:<id> or role:<key>; labels name the person's role, the agent and the skill.
 */
export function describeChange(c: { who: string; record: string; before: Snapshot; after: Snapshot; roleLabel: string | null; skillLabel: string | null }): string {
  const agent = c.roleLabel ? `the ${c.roleLabel}` : "an agent";
  const skill = c.skillLabel ? `${agent}'s ${c.skillLabel} skill` : agent;
  if (c.record.startsWith("role:")) return `${c.who} updated ${agent}'s core`;
  if (c.record.startsWith("agent:")) {
    const b = c.before ?? {};
    const a = c.after ?? {};
    const brain = b.model !== a.model || b.effort !== a.effort;
    return `${c.who} updated ${skill}${brain ? " (model or effort)" : "'s instructions"}`;
  }
  const title = String((c.after ?? c.before ?? {}).title ?? "an item");
  if (!c.before) return `${c.who} added "${title}" to ${skill}`;
  if (c.before.active !== false && c.after?.active === false) return `${c.who} turned off "${title}" in ${skill}`;
  if (c.before.active === false && c.after?.active !== false) return `${c.who} turned "${title}" back on in ${skill}`;
  return `${c.who} edited "${title}" in ${skill}`;
}
