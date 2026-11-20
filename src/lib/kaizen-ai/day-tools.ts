import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// The person's own day for Kaizen AI and their assistant (the assistant gets every chat tool): what's on their
// Overview and recap, each with its key, and the quick actions every item has there (Done, Snooze to tomorrow,
// Delegate), plus their Overview layout (cards or list). The same functions the screens call, never a copy.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export const DAY_TOOLS = ["my_day", "day_item_action", "overview_layout"] as const;

export function dayTools(ctx: ToolCtx): ChatTool[] {
  return [
    {
      name: "my_day",
      description: "What's on the person's own day (their Overview and recap): every open item with its key, topic, client, title, due date, tier and whether it's new since they last looked. Use it for 'what's on my plate', 'what's new', before acting on an item, or to find an item's key. Optionally only one topic or client. open_screen 'overview' shows it.",
      input_schema: { type: "object", properties: { topic: { type: "string", description: "Only this topic (mine, promises, onboarding, accounts, email, social, work, briefs, ads, allotments)" }, client: { type: "string", description: "Only this client (name)" } }, additionalProperties: false },
      status: () => "Reading your day…",
      run: async (input) => {
        const { todaySnapshot } = await import("@/lib/today-snapshot");
        const snap = await todaySnapshot(ctx.db, ctx.me);
        const topic = clip(input.topic, 30);
        const client = clip(input.client, 80).toLowerCase();
        const items = snap.today.items.filter((i) => (!topic || i.topic === topic) && (!client || i.client.toLowerCase().includes(client)));
        return {
          new: snap.today.items.filter((i) => i.state === "new").length,
          total: snap.today.items.length,
          items: items.slice(0, 40).map((i) => ({ key: i.key, topic: i.topic, client: i.client, clientId: i.clientId, title: i.title, due: i.due ?? null, tier: i.tier, status: i.state, why: i.why })),
          open: "/pipeline",
        };
      },
    },
    {
      name: "day_item_action",
      description: "Acts on one item of the person's own day, by its key from my_day: done (closes it for them; their own message or promise closes for everyone), snooze (hides it until tomorrow, then it comes back on its own), or delegate (hands it to a teammate as a task, with an optional note and due date; it leaves their day and stays with the new owner only). Do it when they ask; say what happened in a few words.",
      input_schema: {
        type: "object",
        properties: {
          key: { type: "string", description: "The item's key (from my_day)" },
          action: { type: "string", enum: ["done", "snooze", "delegate"] },
          to: { type: "string", description: "delegate: the teammate's name" },
          note: { type: "string", description: "delegate: a short note for them" },
          due: { type: "string", description: "delegate: due date, YYYY-MM-DD" },
        },
        required: ["key", "action"],
        additionalProperties: false,
      },
      status: (input) => (input.action === "snooze" ? "Snoozing it to tomorrow…" : input.action === "delegate" ? `Handing it to ${clip(input.to, 40) || "a teammate"}…` : "Marking it done…"),
      run: async (input) => {
        const key = clip(input.key, 200);
        const { todaySnapshot } = await import("@/lib/today-snapshot");
        const snap = await todaySnapshot(ctx.db, ctx.me);
        const item = snap.today.items.find((i) => i.key === key);
        if (!item) return { ok: false, note: "That item isn't on their day any more (or the key is wrong): read my_day again." };
        const s = { topic: item.topic, client: item.client, title: item.title, clientId: item.clientId };
        if (input.action === "done") {
          const { markItem } = await import("@/lib/item-state");
          await markItem(ctx.db, ctx.me.id, key, "done", s);
          return { ok: true, done: item.title };
        }
        if (input.action === "snooze") {
          const { snoozeItem } = await import("@/lib/item-state");
          return { ok: true, snoozedUntil: await snoozeItem(ctx.db, ctx.me.id, key, s) };
        }
        const name = clip(input.to, 80);
        if (!name) return { ok: false, note: "Who should it go to?" };
        const [{ personNamed }, { delegateItem }, { markItem }, { stableKeyOf }] = await Promise.all([import("@/lib/seat-transfer"), import("@/lib/delegate"), import("@/lib/item-state"), import("@/lib/today-counts")]);
        const found = await personNamed(ctx.admin, name);
        if (!("one" in found)) return { ok: false, note: "many" in found ? `Several people match: ${found.many.map((p) => p.full_name).join(", ")}. Ask which.` : `Nobody on the team matches "${name}".` };
        const title = [item.client, item.title].filter(Boolean).join(": ");
        const r = await delegateItem(ctx.admin, { id: ctx.me.id, fullName: ctx.me.fullName, role: ctx.me.role, isExec: ctx.me.isExec }, { ref: `item:${stableKeyOf(key)}`.slice(0, 200), clientId: item.clientId, title, to: found.one.id, note: clip(input.note, 300) || null, due: clip(input.due, 10) || null, why: null });
        if (!r.ok) return { ok: false, note: r.error };
        await markItem(ctx.db, ctx.me.id, key, "dismissed", s, { label: `Delegated to ${r.to}: ${title}`.slice(0, 300) });
        return { ok: true, delegatedTo: r.to };
      },
    },
    {
      name: "overview_layout",
      description: "Switches the person's Overview between cards (the default) and the list view (one row per item: client, what it is, due date, status). Kept on their profile, on every device. Then open_screen 'overview'.",
      input_schema: { type: "object", properties: { layout: { type: "string", enum: ["cards", "list"] } }, required: ["layout"], additionalProperties: false },
      status: (input) => `Switching your Overview to ${input.layout === "list" ? "the list" : "cards"}…`,
      run: async (input) => {
        const layout = input.layout === "list" ? "list" : "cards";
        await ctx.admin.from("profiles").update({ overview_layout: layout }).eq("id", ctx.me.id);
        const { revalidateDay } = await import("@/lib/item-state");
        revalidateDay();
        return { ok: true, layout, open: "/pipeline" };
      },
    },
  ];
}
