import "server-only";
import type { ChatTool, ToolCtx } from "./tools";

// The person's own day for Kaizen AI and their assistant (the assistant gets every chat tool): what's on their
// Overview and recap, each with its key, and the quick actions every item has there (Done, Snooze to tomorrow,
// Delegate), plus their Overview layout (cards or list). The same functions the screens call, never a copy.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export const DAY_TOOLS = ["my_day", "day_item_action", "overview_layout", "item_comments", "comment_on_item", "sent_by_me", "team_nudges", "send_team_nudge", "my_team_work", "my_notifications", "mark_notification", "support_board"] as const;

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
      name: "item_comments",
      description: "The comment thread on one item of the day (by its key from my_day): what teammates added ('waiting on the client's answer') and whether it's marked waiting on the client (its reminders and escalations paused). Everyone the item reaches shares the thread. open is the address that opens it on screen (open_screen).",
      input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
      status: () => "Reading the comments…",
      run: async (input) => {
        const key = clip(input.key, 200);
        const { loadThread } = await import("@/lib/item-comments");
        const t = await loadThread(ctx.db, key);
        return { waitingOnClient: t.waiting, waitingBy: t.waitingBy, comments: t.comments.slice(-20).map((c) => ({ by: c.author, kind: c.kind, text: c.body, at: c.at })), open: `/pipeline?comments=${encodeURIComponent(t.key)}` };
      },
    },
    {
      name: "comment_on_item",
      description: "Adds a comment to an item of the person's day (by its key from my_day), as them, and/or marks it waiting on the client (waiting: true pauses its reminders and escalations until the client writes, sends a new asset, or it's due; false takes the mark off). Everyone the item reaches sees it and the people on it hear in the app (never Slack). Write the comment the way they said it.",
      input_schema: { type: "object", properties: { key: { type: "string" }, text: { type: "string", description: "The comment" }, waiting: { type: "boolean", description: "Mark (true) or unmark (false) waiting on the client" } }, required: ["key"], additionalProperties: false },
      status: () => "Adding the comment…",
      run: async (input) => {
        const key = clip(input.key, 200);
        const { todaySnapshot } = await import("@/lib/today-snapshot");
        const snap = await todaySnapshot(ctx.db, ctx.me);
        const item = snap.today.items.find((i) => i.key === key);
        const { loadThread, addComment } = await import("@/lib/item-comments");
        const t = item ? null : await loadThread(ctx.db, key);
        const clientId = item?.clientId ?? t?.clientId ?? null;
        if (!item && !t?.comments.length) return { ok: false, note: "That item isn't on their day: read my_day for its key." };
        if (clientId) {
          const { data } = await ctx.db.from("clients").select("id").eq("id", clientId).maybeSingle();
          if (!data) return { ok: false, note: "They can't see that client." };
        }
        const r = await addComment(ctx.admin, { id: ctx.me.id, fullName: ctx.me.fullName }, { key, clientId, title: item ? [item.client, item.title].filter(Boolean).join(": ") : (t?.title ?? null), body: clip(input.text, 2000), waiting: typeof input.waiting === "boolean" ? input.waiting : null, dueAt: item?.due ?? null });
        return r.ok ? { ok: true } : { ok: false, note: r.error };
      },
    },
    {
      name: "sent_by_me",
      description: "The reminders, checklists and tasks the person (or their assistant) sent to teammates: who has each, how far through its checklist they are (each item ticked or not), and whether it's done. Comments on each are item_comments with key ask:<id>. open_screen 'sent by you' shows them, each one's open address opens it.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      status: () => "Checking what you sent…",
      run: async () => {
        const { loadSentAsks, sentHref } = await import("@/lib/sent-asks");
        const sent = await loadSentAsks(ctx.db, ctx.me.id);
        return { sent: sent.map((a) => ({ id: a.id, key: `ask:${a.id}`, to: a.to, title: a.title, client: a.client?.name ?? null, status: a.status, due: a.due, checklist: a.checklist, progress: a.checklist.length ? `${a.checklist.filter((i) => i.done).length}/${a.checklist.length}` : null, open: sentHref(a.id) })) };
      },
    },
    {
      name: "team_nudges",
      description: "The escalation ladder for a lead or head: teammates with something that sat 48 hours with nothing done (a reply owed, a promise, a ticket past its turnaround, a brief to approve), each with a Slack message drafted to check in with them. Read the draft out, offer to change it, and send only with send_team_nudge after their yes.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      status: () => "Checking who on your team is behind…",
      run: async () => {
        const { loadNudges } = await import("@/lib/escalation-ladder");
        const ns = await loadNudges(ctx.db, ctx.me.id);
        return { nudges: ns.map((n) => ({ id: n.id, teammate: n.owner, client: n.client, what: n.what, since: n.since, draft: n.draft })), open: "/pipeline" };
      },
    },
    {
      name: "send_team_nudge",
      description: "Sends one nudge from team_nudges to the teammate as a Slack DM from the lead's own Slack (text: the draft as they approved or changed it), or sets it aside (dismiss: true). Only after the lead's clear yes in this turn.",
      input_schema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, dismiss: { type: "boolean" } }, required: ["id"], additionalProperties: false },
      status: (input) => (input.dismiss ? "Setting it aside…" : "Sending it from your Slack…"),
      run: async (input) => {
        const id = clip(input.id, 60);
        const { sendNudge, dismissNudge } = await import("@/lib/escalation-ladder");
        if (input.dismiss) {
          await dismissNudge(ctx.admin, ctx.me.id, id);
          return { ok: true, dismissed: true };
        }
        const { saidYes } = await import("@/lib/assistant/core");
        if (ctx.said !== undefined && !saidYes(ctx.said)) return { ok: false, note: "Read them the message and ask \"send it?\" first; send on their yes." };
        if (ctx.me.viewAs) return { ok: false, note: "Not while viewing as someone." };
        let text = clip(input.text, 3000);
        if (!text) {
          const { data } = await ctx.db.from("ladder_nudges").select("draft").eq("id", id).maybeSingle();
          text = String(data?.draft ?? "");
        }
        return sendNudge(ctx.admin, ctx.me.id, id, text);
      },
    },
    {
      name: "my_team_work",
      description: "For the lead video editor (their video editors), the lead graphic designer (their designers) and the Head of Creative (both): each teammate's plate, their Asana tasks and board tickets with stage and due date, what's overdue, and briefs they started and haven't sent. Optionally one person by name. open_screen 'my team' shows it; each person's open address opens their plate.",
      input_schema: { type: "object", properties: { person: { type: "string", description: "One teammate's name" } }, additionalProperties: false },
      status: () => "Looking at your team's work…",
      run: async (input) => {
        const { hasMyTeam, loadMyTeam } = await import("@/lib/my-team");
        if (!hasMyTeam(ctx.me.role)) return { ok: false, note: "My team is for the lead video editor, the lead graphic designer and the Head of Creative." };
        const who = clip(input.person, 80).toLowerCase();
        const team = (await loadMyTeam(ctx.admin, ctx.me.role, ctx.me.id)).filter((m) => !who || m.name.toLowerCase().includes(who));
        return { team: team.map((m) => ({ name: m.name, role: m.role, openTasks: m.tasks.length, overdue: m.overdue, onThemNow: m.onThem, tasks: m.tasks.slice(0, 15).map((t) => ({ client: t.client, title: t.title, stage: t.stageLabel, due: t.due, onThem: t.onThem })), briefsInProgress: m.briefs.map((b) => `${b.client ? `${b.client}: ` : ""}${b.title}`), open: `/pipeline?tab=team&person=${m.id}` })) };
      },
    },
    {
      name: "my_notifications",
      description: "The person's latest notifications (the bell): each with its id, title, what it says, when, and whether it's read. Use it for 'what did I miss', 'read me my notifications'. open_screen 'notifications' opens the settings; the bell is on every page.",
      input_schema: { type: "object", properties: { unread: { type: "boolean", description: "Only the unread ones" } }, additionalProperties: false },
      status: () => "Reading your notifications…",
      run: async (input) => {
        const { loadNotifications } = await import("@/lib/notifications");
        const list = await loadNotifications(ctx.db, 30);
        return { unread: list.unread, items: list.items.filter((n) => !input.unread || !n.read).map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.createdAt, read: n.read, urgent: n.priority === "critical", open: n.href })) };
      },
    },
    {
      name: "mark_notification",
      description: "Marks one of the person's notifications (by id from my_notifications) read or unread again, so it waits for later like a new one.",
      input_schema: { type: "object", properties: { id: { type: "string" }, read: { type: "boolean" } }, required: ["id", "read"], additionalProperties: false },
      status: (input) => (input.read ? "Marking it read…" : "Marking it unread…"),
      run: async (input) => {
        const { error } = await ctx.db.from("notifications").update({ read_at: input.read ? new Date().toISOString() : null }).eq("profile_id", ctx.me.id).eq("id", clip(input.id, 60));
        return error ? { ok: false, note: "Couldn't change it." } : { ok: true };
      },
    },
    {
      name: "support_board",
      description: "For the support positions: reports not sent across the company (by owner and client), every client Slack channel's unanswered messages (how long, who owes them), creatives stuck on the Asana Creative board (Ready for copy over 48 hours, sent to the client with no reply), and onboarding blockers (intake form, onboarding call, client assets). The Client Success Coordinator reads all four; the Onboarding Specialist the blockers. open is where it is on screen.",
      input_schema: { type: "object", properties: { board: { type: "string", enum: ["reports", "channels", "stuck", "blockers"] } }, required: ["board"], additionalProperties: false },
      status: () => "Reading the board…",
      run: async (input) => {
        const { isSupportRole } = await import("@/lib/roles");
        if (!isSupportRole(ctx.me.role) && !ctx.me.isExec) return { ok: false, note: "This board is for the support positions and execs." };
        if (input.board === "blockers") {
          const { onboardingBoard } = await import("@/lib/oversight/support");
          return { blockers: (await onboardingBoard(ctx.admin)).map((r) => ({ client: r.client, daysIn: r.state.daysIn, blockers: r.state.blockers })), open: "/pipeline" };
        }
        if (ctx.me.role !== "customer_success" && !ctx.me.isExec) return { ok: false, note: "Reports, channels and stuck creatives are the Client Success Coordinator's." };
        const x = await import("@/lib/oversight/support-extra");
        if (input.board === "reports") return { notSent: await x.reportsNotSent(ctx.admin), note: "The coordinator builds reports for anyone but never sends one; a nudge to each owner is drafted on the Overview.", open: "/pipeline#reports-not-sent" };
        if (input.board === "channels") return { channels: (await x.channelHealth(ctx.admin)).map((c) => ({ channel: c.channel, client: c.client, oldestHours: Math.round(c.oldestHours), waiting: c.messages.map((m) => ({ from: m.from, gist: m.gist, hours: Math.round(m.hours), owes: m.owes })) })), open: "/pipeline#channel-health" };
        const { todaySnapshot } = await import("@/lib/today-snapshot");
        const snap = await todaySnapshot(ctx.db, ctx.me);
        return { stuck: snap.today.items.filter((i) => i.key.startsWith("stuck:")).map((i) => ({ client: i.client, title: i.title, line: i.story })), open: "/pipeline" };
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
