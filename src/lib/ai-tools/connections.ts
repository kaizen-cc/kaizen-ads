import type { AiTool } from "./types";

// Everyone connects their own Slack and Asana (src/lib/connect-required-core.ts): the executives ask who hasn't
// ("who still needs to connect Asana?"), the same list as Settings › Team.

const teamConnections: AiTool = {
  name: "team_connections",
  description:
    "Who on the team hasn't connected their own Slack or Asana yet, is signed in to the wrong account, or needs to reconnect for a missing scope (executives). Each missing one already has a critical item on that person's Overview and a daily reminder from their assistant. To show it, open_screen to settings team.",
  input_schema: { type: "object", properties: { service: { type: "string", enum: ["slack", "asana"], description: "Only this one" } }, additionalProperties: false },
  only: (u) => u.isExec,
  run: async (user, input) => {
    if (!user.isExec) return { error: "That list is for the executives." };
    const [{ teamGaps }, { createAdminClient }, core] = await Promise.all([import("@/lib/connect-required"), import("@/lib/supabase/admin"), import("@/lib/connect-required-core")]);
    const people = await teamGaps(createAdminClient());
    const which: readonly ("slack" | "asana")[] = input.service === "slack" || input.service === "asana" ? [input.service] : core.NEEDS;
    const behind = people.filter((p) => which.some((n) => p.gaps[n] !== "ok"));
    return {
      team: people.length,
      connected: Object.fromEntries(core.NEEDS.map((n) => [n, people.filter((p) => p.gaps[n] === "ok").length])),
      still_to_connect: behind.map((p) => ({ name: p.name, role: p.role, ...Object.fromEntries(which.map((n) => [n, core.stateText(p.gaps[n])])) })),
      note: behind.length ? "Name them in a sentence or two; each is already reminded every day." : "Everyone is connected.",
    };
  },
};

export const tools: AiTool[] = [teamConnections];
