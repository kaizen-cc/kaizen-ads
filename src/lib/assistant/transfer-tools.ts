import "server-only";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { showCard as showCallCard } from "@/lib/agent-call/call-cards";
import { linesFor, mayTransferAny, seatLabel, type SeatLine } from "@/lib/seat-transfer-core";
import type { AssistantCtx } from "./tools";

// Moving someone's accounts through the assistant ("We're letting Matheus go: move all his accounts to Lucas"): find
// every seat a person holds, plan the moves in one go, and open the Handoffs page where each move, with the handoff
// written for the new person, is approved, changed or dropped. Executives move any seat; a line head their own line's.
// The tools never move anything themselves.

const LINES: SeatLine[] = ["meta", "google", "creative", "email", "social"];

export function transferTools(ctx: AssistantCtx): LoopTool[] {
  if (!mayTransferAny(ctx.me)) return [];
  const asker = { id: ctx.me.id, fullName: ctx.me.fullName, role: ctx.me.role, isExec: ctx.me.isExec };
  const scope = ctx.me.isExec ? "every line" : `the ${linesFor(ctx.me).join(" and ")} line`;
  return [
    {
      name: "find_person_accounts",
      description: `Every client seat a teammate holds (buyer, designer, editor, email and social seats, primary or secondary), on live clients: use it whenever they ask what someone has, or before moving someone's accounts. Search by the person's name, never the clients'. Lists the seats this person may move (${scope}) and how many others the teammate holds on other lines.`,
      input_schema: { type: "object", properties: { person: { type: "string", description: "The teammate's name" } }, required: ["person"], additionalProperties: false },
      status: (input) => `Looking up ${String(input.person ?? "their")} accounts…`,
      run: async (input) => {
        const { findAccounts } = await import("@/lib/seat-transfer");
        return findAccounts(ctx.admin, asker, String(input.person ?? ""));
      },
    },
    {
      name: "plan_account_transfer",
      description: `Plans moving a teammate's client seats to someone else in one plan (someone leaving, changing team, covering): all of them, or only some clients or seats. Each seat goes to someone who can hold it: give 'to' for everything they can take, and by_line for a line 'to' can't cover (the Google seats to someone else). Seats nobody named can hold are planned without a person, picked on the page. Nothing moves: it opens the Handoffs page, where each move and the handoff written for the new person is approved, changed or dropped. Plan it straight away when they ask; say how many seats and which ones still need a person, then that it's on screen to approve.`,
      input_schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Whose accounts move (name)" },
          to: { type: "string", description: "Who takes them (name)" },
          clients: { type: "array", items: { type: "string" }, description: "Only these clients (names); leave out for all" },
          seats: { type: "array", items: { type: "string", enum: ["meta_buyer", "google_buyer", "tiktok_buyer", "graphic_designer", "video_editor", "social_manager", "social_creative", "email_strategist", "email_designer", "email_builder"] }, description: "Only these seats; leave out for all" },
          by_line: { type: "object", properties: Object.fromEntries(LINES.map((l) => [l, { type: "string", description: `Who takes the ${l} seats instead (name)` }])), additionalProperties: false },
          note: { type: "string", description: "Why, in a few words (shown on the plan)" },
        },
        required: ["from"],
        additionalProperties: false,
      },
      status: (input) => `Planning the handover of ${String(input.from ?? "their")} accounts…`,
      run: async (input) => {
        const { personNamed, planTransfer, writeMoveDocs } = await import("@/lib/seat-transfer");
        const who = async (name: unknown) => {
          const n = String(name ?? "").trim();
          if (!n) return null;
          const r = await personNamed(ctx.admin, n);
          if ("one" in r) return r.one;
          throw new Error("many" in r ? `Several people match "${n}": ${r.many.map((p) => p.full_name).join(", ")}. Ask which.` : `Nobody on the team matches "${n}".`);
        };
        let from, to;
        const byLine: Partial<Record<SeatLine, string>> = {};
        try {
          from = await who(input.from);
          to = await who(input.to);
          const bl = (input.by_line ?? {}) as Record<string, unknown>;
          for (const l of LINES) {
            const p = await who(bl[l]);
            if (p) byLine[l] = p.id;
          }
        } catch (e) {
          return { planned: false, note: e instanceof Error ? e.message : String(e) };
        }
        if (!from) return { planned: false, note: "Whose accounts move?" };
        if (to && to.id === from.id) return { planned: false, note: "That's the same person." };
        // Clients by name, among the ones they hold
        let clientIds: string[] | null = null;
        const names = Array.isArray(input.clients) ? input.clients.map(String).filter(Boolean) : [];
        if (names.length) {
          const { seatsHeldBy } = await import("@/lib/seat-transfer");
          const held = await seatsHeldBy(ctx.admin, from.id);
          const pick = (n: string) => held.find((s) => s.client.toLowerCase() === n.toLowerCase()) ?? held.find((s) => s.client.toLowerCase().includes(n.toLowerCase()));
          const missing = names.filter((n) => !pick(n));
          if (missing.length) return { planned: false, note: `${from.full_name} isn't on ${missing.join(", ")}. Their clients: ${[...new Set(held.map((s) => s.client))].join(", ") || "none"}.` };
          clientIds = [...new Set(names.map((n) => pick(n)!.clientId))];
        }
        const r = await planTransfer(ctx.admin, asker, { fromId: from.id, toId: to?.id ?? null, clientIds, roles: Array.isArray(input.seats) ? input.seats.map(String) : null, byLine, note: typeof input.note === "string" ? input.note : null });
        if ("error" in r) return { planned: false, note: r.error };
        const { after } = await import("next/server");
        after(() => writeMoveDocs(ctx.admin, r.id));
        const href = `/team/handoffs?t=${r.id}`;
        showCallCard(ctx, { title: `Handoffs: ${from.full_name}${to ? ` to ${to.full_name}` : ""}`, detail: `${r.moves.length} seat${r.moves.length === 1 ? "" : "s"} to approve, with their handoffs`, href, external: false, cta: "Review and approve" });
        ctx.emit({ t: "navigate", href });
        const open = r.moves.filter((m) => !m.toId);
        return {
          planned: true,
          seats: r.moves.map((m) => `${m.client}: ${seatLabel(m.role)}${m.primary ? "" : " (secondary)"} → ${m.to ?? "needs a person"}`),
          needPerson: open.map((m) => `${m.client} (${seatLabel(m.role)})`),
          note: "The Handoffs page is open with every move; a handoff for each new person (everything outstanding, what to tell the client, a checklist for whoever hands over) is being written now; on approval the open work moves and Slack access follows the seat. Nothing moves until they approve there (one by one or Approve all). Say so in a sentence or two; don't read every seat out.",
        };
      },
    },
  ];
}
