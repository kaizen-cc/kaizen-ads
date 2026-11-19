import "server-only";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { ROLES, type TeamRole } from "@/lib/roles";
import { representativeFor, roleView } from "@/lib/view-as-core";
import type { AssistantCtx } from "./tools";

// The assistant's side of view as: executives can ask what a role (or a teammate) sees in Kaizen OS. Switching the
// screen itself stays a button for the owner alone (the sidebar's View as); this only describes.

const ROLE_WORDS = ROLES.map((r) => `${r.value} (${r.label})`).join(", ");

function roleFrom(words: string): TeamRole | null {
  const w = words.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const hit = ROLES.find((r) => r.value === w || r.label.toLowerCase().replace(/[\s-]+/g, "_") === w);
  if (hit) return hit.value;
  const loose = ROLES.find((r) => r.label.toLowerCase().includes(words.trim().toLowerCase()));
  return loose?.value ?? null;
}

export function viewAsTools(ctx: AssistantCtx): LoopTool[] {
  if (!ctx.me.isExec) return [];
  return [
    {
      name: "what_role_sees",
      description: `What a role, or one teammate, sees in Kaizen OS: their places in the menu, which clients they can see, whether they get reports and the paid ads screens, and, for a teammate, how many clients they hold. Give role (one of: ${ROLE_WORDS}) or person (a teammate's name). For the owner, say they can switch their own screen to exactly this with "View as" under their name in the sidebar.`,
      input_schema: { type: "object", properties: { role: { type: "string" }, person: { type: "string" } }, additionalProperties: false },
      run: async (input) => {
        const { data: people } = await ctx.db.from("profiles").select("id, full_name, role, is_active").eq("is_active", true);
        const { data: seats } = await ctx.db.from("client_assignments").select("profile_id");
        const count = new Map<string, number>();
        for (const s of seats ?? []) count.set(s.profile_id as string, (count.get(s.profile_id as string) ?? 0) + 1);
        const rows = (people ?? []).map((p) => ({ id: p.id as string, full_name: p.full_name as string, role: p.role as string, is_active: true, clients: count.get(p.id as string) ?? 0 }));
        if (typeof input.person === "string" && input.person.trim()) {
          const q = input.person.trim().toLowerCase();
          const match = rows.filter((p) => p.full_name.toLowerCase().includes(q));
          if (!match.length) return { found: false, note: `No active teammate matches "${input.person}".` };
          if (match.length > 1) return { found: false, choices: match.map((p) => p.full_name), note: "Several match: ask which." };
          const p = match[0];
          return { person: p.full_name, assigned_clients: p.clients, ...roleView(p.role as TeamRole) };
        }
        const role = typeof input.role === "string" ? roleFrom(input.role) : null;
        if (!role) return { found: false, note: `Which role? One of: ${ROLES.map((r) => r.label).join(", ")}.` };
        const rep = representativeFor(role, rows);
        return { ...roleView(role), people_in_role: rows.filter((p) => p.role === role).length, shown_through: rep ? `${rep.full_name} (${rep.clients} assigned clients)` : null };
      },
    },
  ];
}
