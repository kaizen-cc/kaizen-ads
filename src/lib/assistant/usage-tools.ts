import "server-only";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { dollars, lengthLabel, PROJECTION_METHOD, teamLabel } from "@/lib/calls-usage-core";
import type { AssistantCtx } from "./tools";

// The owner's Settings › Calls & usage, through the assistant: who uses the agents most and what it costs this month,
// and the call log (flagged first). The owner only (can_view_as, never while viewing as someone); nobody else gets
// the tool at all. open_screen goes to the page ("calls and usage", "ai usage").

export function usageTools(ctx: AssistantCtx): LoopTool[] {
  const me = ctx.me as typeof ctx.me & { canViewAs?: boolean; viewAs?: unknown };
  if (!me.canViewAs || me.viewAs) return [];
  return [
    {
      name: "calls_and_usage",
      description:
        "The owner's view of the agents: what: usage (this month to date per person and team: calls, chats, minutes, messages, tokens and cost, with the projection to month end) or calls (every call and Kaizen AI chat in a date range, the safety review's flagged ones first with the reason, then by team; optional person and search). Say the headline in a line or two; offer to open the page (open_screen place 'calls and usage' or 'ai usage').",
      input_schema: {
        type: "object",
        properties: {
          what: { type: "string", enum: ["usage", "calls"] },
          person: { type: "string", description: "A teammate's name, to narrow it to them" },
          days: { type: "integer", description: "Calls: how many days back (default 7)" },
          search: { type: "string", description: "Calls: words said in the call or chat" },
          flagged_only: { type: "boolean" },
        },
        required: ["what"],
        additionalProperties: false,
      },
      run: async (input) => {
        const { loadCallLog, loadUsage } = await import("@/lib/calls-usage");
        const name = typeof input.person === "string" ? input.person.trim().toLowerCase() : "";
        if (input.what === "usage") {
          const u = await loadUsage();
          const people = u.people.filter((p) => !name || p.name.toLowerCase().includes(name)).sort((a, b) => b.cost - a.cost).slice(0, 25);
          return {
            month_to_date: dollars(u.total.cost),
            projected_month_end: dollars(u.total.projected),
            projection_method: PROJECTION_METHOD,
            teams: u.teams.map((t) => ({ team: teamLabel(t.team), cost: dollars(t.cost), projected: dollars(t.projected), calls: t.calls, chats: t.chats, minutes: t.minutes })),
            people: people.map((p) => ({ name: p.name, team: teamLabel(p.team), cost: dollars(p.cost), projected: dollars(p.projected), calls: p.calls, chats: p.chats, minutes: p.minutes, messages: p.messages, tokens_in: p.input, tokens_out: p.output, cache_write: p.cacheW, cache_read: p.cacheR, active_days: p.activeDays })),
            not_tied_to_a_person: dollars(u.unattributed.cost),
          };
        }
        const days = Math.min(90, Math.max(1, Number(input.days) || 7));
        const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
        let personId: string | null = null;
        if (name) {
          const { data } = await ctx.db.from("profiles").select("id, full_name").ilike("full_name", `%${name.replace(/[%_,()]/g, " ")}%`).limit(5);
          if (!data?.length) return { found: false, note: `No teammate matches "${input.person}".` };
          if (data.length > 1) return { found: false, choices: data.map((p) => p.full_name), note: "Several match: ask which." };
          personId = data[0].id as string;
        }
        const { entries } = await loadCallLog({ team: null, person: personId, from: day(new Date(Date.now() - days * 86_400_000)), to: day(new Date()), flag: input.flagged_only === true ? "flagged" : null, q: typeof input.search === "string" ? input.search.slice(0, 80) : "" });
        const sorted = [...entries].sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.at.localeCompare(a.at)).slice(0, 40);
        return {
          count: entries.length,
          flagged: entries.filter((e) => e.flagged).length,
          calls: sorted.map((e) => ({ flagged: e.flagged, reason: e.reason, person: e.person, team: teamLabel(e.team), when: e.at, length: lengthLabel(e.seconds), mode: e.mode, agents: e.agents, clients: e.clients, topic: e.topic, link: e.href })),
        };
      },
    },
  ];
}
