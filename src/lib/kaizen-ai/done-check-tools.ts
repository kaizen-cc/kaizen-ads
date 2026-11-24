import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { PRIVATE_WHILE_VIEWING, viewingAs } from "./my-tools";

// The done-check on demand in Kaizen AI and the assistant (chat and calls): "check if my waiting replies / promises /
// tasks are done", "sweep my comms", "is X done yet". Runs the same check the scheduled sweeps do, right then
// (src/lib/done-check-now.ts), and closes what's proven done the same way, with the quote and a one-tap Reopen.

export function doneCheckTools(ctx: ToolCtx): ChatTool[] {
  return [
    {
      name: "check_if_done",
      description:
        "Checks right now whether the person's open items are done: messages waiting on their reply, things they said yes to in Slack or email, tasks and asks sent to them, Asana tasks, tracking and onboarding items. It reads Slack (threads, DMs they allowed, the client channels), Gmail and call/Gemini notes since each item opened. Proven done closes for everyone (the quote, where it was said and a reopen key come back); otherwise it reports moving (the latest sign) or nothing found. Use for 'check if my replies/promises/tasks are done', 'sweep my comms', 'is X done yet' (about: X), or for one client (client). scope team: an exec's or a lead's team's items. Say what closed (with the quote), what's moving and what has nothing yet; offer reopen_checked_item if a close looks wrong.",
      input_schema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["mine", "team"], description: "Their own (default), or their team's (execs and leads)" },
          client: { type: "string", description: "Only this client's items" },
          about: { type: "string", description: "Words from the item they asked about ('the Granite landing page')" },
        },
        additionalProperties: false,
      },
      status: (input) => `Checking ${input.about ? `"${String(input.about).slice(0, 40)}"` : input.client ? `${String(input.client).slice(0, 30)}'s items` : "your open items"} against Slack, email and call notes…`,
      run: async (input) => {
        if (viewingAs(ctx)) return { error: PRIVATE_WHILE_VIEWING };
        const { checkNow } = await import("@/lib/done-check-now");
        const me = { id: ctx.me.id, role: String(ctx.me.role ?? ""), isExec: Boolean(ctx.me.isExec), isLead: Boolean(ctx.me.isLead) };
        return checkNow(ctx.admin, me, { scope: input.scope === "team" ? "team" : "mine", client: typeof input.client === "string" ? input.client : null, about: typeof input.about === "string" ? input.about : null });
      },
    },
    {
      name: "reopen_checked_item",
      description: "Puts back an item check_if_done closed (its reopen key): it comes back on everyone's Overview, and its source goes back to how it was. Use when they say a close was wrong.",
      input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
      status: () => "Putting it back…",
      run: async (input) => {
        if (viewingAs(ctx)) return { error: "Not while viewing as someone." };
        const key = String(input.key ?? "");
        if (!/^[a-z_:]+[0-9a-z:_-]+$/i.test(key)) return { error: "Give the reopen key from check_if_done." };
        const { reopenChecked } = await import("@/lib/done-check-now");
        const r = await reopenChecked(ctx.admin, key, ctx.me.id);
        if (r.ok) await (await import("@/lib/item-state")).reviewsChanged().catch(() => null);
        return r.ok ? { reopened: true } : { error: r.error };
      },
    },
  ];
}
