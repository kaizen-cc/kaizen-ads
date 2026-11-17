import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_MOMENTS } from "@/lib/agent-moments";

// One agent's whole playbook as its chat reads it: Kaizen's strategy, the agent's core, then each skill with where it
// runs, its instructions and its items, and the titles of the shared items. Read by "Talk to the <agent>" and by a
// voice call with it, so both know exactly the same things.

// Keep the agent's whole playbook within a sensible prompt: long items show their start and are marked truncated
const ITEM_CAP = 6000;
const PLAYBOOK_CAP = 90000;

export type RolePlaybook = {
  role: { key: string; label: string; description: string; core: string; voice_id?: string | null };
  skills: { key: string; label: string; description: string }[];
  /** This agent's items: id → the skill it belongs to */
  owner: Map<string, string>;
  /** Items shown cut short (never rewritten whole from what was shown) */
  truncated: Set<string>;
  /** The prompt block */
  text: string;
};

export async function loadRolePlaybook(admin: SupabaseClient, roleKey: string): Promise<RolePlaybook | null> {
  const [{ data: role }, { data: skills }, { data: spine }] = await Promise.all([
    admin.from("ai_roles").select("*").eq("key", roleKey).maybeSingle(),
    admin.from("ai_agents").select("key, label, description, model, effort, instructions, live").eq("role_key", roleKey).order("sort_order"),
    admin.from("ai_spine").select("body").eq("id", 1).maybeSingle(),
  ]);
  if (!role) return null;
  const keys = (skills ?? []).map((k) => k.key as string);
  const [{ data: items }, { data: shared }] = await Promise.all([
    keys.length ? admin.from("ai_knowledge").select("id, agent_key, kind, title, body, active").in("agent_key", keys).order("created_at") : Promise.resolve({ data: [] as never[] }),
    admin.from("ai_knowledge").select("title").is("agent_key", null).eq("active", true).order("created_at"),
  ]);

  let budget = PLAYBOOK_CAP;
  const truncated = new Set<string>();
  const itemXml = (k: { id: string; kind: string; title: string; body: string; active: boolean }) => {
    const room = Math.max(400, Math.min(ITEM_CAP, budget));
    const cut = k.body.length > room;
    if (cut) truncated.add(k.id);
    budget -= Math.min(k.body.length, room);
    return `<item id="${k.id}" kind="${k.kind}" ${k.active ? "" : 'off="true" '}${cut ? 'truncated="true" ' : ""}title="${k.title.replace(/"/g, "'")}">\n${cut ? `${k.body.slice(0, room)}…` : k.body}\n</item>`;
  };
  const text = [
    `<kaizen_strategy read_only="true">\n${spine?.body ?? ""}\n</kaizen_strategy>`,
    `<me agent="${role.label}">\n<description>${role.description}</description>\n<core>\n${role.core || "(empty)"}\n</core>\n</me>`,
    ...(skills ?? []).map((sk) =>
      [
        `<skill key="${sk.key}" name="${sk.label}" model="${sk.model}" effort="${sk.effort}" ${sk.live ? "in use" : "not wired into the app yet"}>`,
        `<description>${sk.description}</description>`,
        (AGENT_MOMENTS[sk.key] ?? []).length ? `<where_it_runs>\n${AGENT_MOMENTS[sk.key].map((m) => `${m.title} (${m.where}; ${m.when})`).join("\n")}\n</where_it_runs>` : "",
        `<instructions>\n${sk.instructions || "(empty)"}\n</instructions>`,
        ...(items ?? []).filter((k) => k.agent_key === sk.key).map(itemXml),
        "</skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    shared?.length ? `<shared_knowledge read_only="true">\n${shared.map((k) => k.title).join("\n")}\n</shared_knowledge>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    role: { key: role.key as string, label: role.label as string, description: role.description as string, core: (role.core as string) ?? "", voice_id: (role as { voice_id?: string | null }).voice_id ?? null },
    skills: (skills ?? []).map((k) => ({ key: k.key as string, label: k.label as string, description: k.description as string })),
    owner: new Map((items ?? []).map((k) => [k.id as string, k.agent_key as string])),
    truncated,
    text,
  };
}
