import { describe, expect, it } from "vitest";
import { askRowsFor, askRundown, followUpReminders, gatherAsks, groupProgress, type AskRowIn } from "@/lib/agent-call/ask-groups";

const now = new Date("2026-11-18T20:00:00Z");
const hedgehog = { id: "c1", name: "Hedgehog Co", slug: "hedgehog" };
const crust = { id: "c2", name: "Crust", slug: "crust" };
let n = 0;
const ask = (o: Partial<AskRowIn> = {}): AskRowIn => ({
  id: `a${++n}`,
  kind: "reminder",
  title: `Do thing ${n}`,
  detail: "A follow-up from your call with your assistant",
  due_on: null,
  created_at: "2026-11-18T20:49:00Z",
  asked_by: "me",
  askerName: "Me Person",
  roleLabel: "Assistant",
  roleKey: "assistant",
  client: hedgehog,
  checklist: [],
  call_id: "call-1",
  with_transcript: true,
  ...o,
});

describe("follow-ups from one call", () => {
  it("become one reminder per client and one general", () => {
    const r = followUpReminders([
      { what: "Confirm the acquisition event", due: null, clientId: "c1", client: "Hedgehog Co" },
      { what: "Confirm daily budget per ad set", due: "2026-11-20", clientId: "c1", client: "Hedgehog Co" },
      { what: "Verify the purchase event", due: "2026-11-19", clientId: "c1", client: "Hedgehog Co" },
      { what: "Send the Crust report", due: null, clientId: "c2", client: "Crust" },
      { what: "Block time for reviews", due: null, clientId: null, client: null },
      { what: "Read the benchmark doc", due: null, clientId: null, client: null },
    ]);
    expect(r).toHaveLength(3);
    expect(r[0].title).toBe("Hedgehog Co: 3 follow-ups from your call");
    expect(r[0].checklist.map((i) => i.text)).toHaveLength(3);
    expect(r[0].due).toBe("2026-11-19");
    expect(r[1].title).toBe("Send the Crust report");
    expect(r[1].checklist).toEqual([]);
    expect(r[2].clientId).toBeNull();
    expect(r[2].title).toBe("2 follow-ups from your call");
  });
});

describe("gathering open follow-ups", () => {
  it("merges a client's rows across calls the same day", () => {
    const g = gatherAsks([ask({ call_id: "call-1" }), ask({ call_id: "call-2" }), ask({ client: crust })], "me", now);
    expect(g.map((x) => x.rows.length)).toEqual([2, 1]);
  });
  it("keeps another day's follow-ups apart", () => {
    const g = gatherAsks([ask(), ask({ created_at: "2026-11-17T20:00:00Z" })], "me", now);
    expect(g).toHaveLength(2);
  });
  it("groups the ones about no client by call", () => {
    const g = gatherAsks([ask({ client: null, call_id: "x" }), ask({ client: null, call_id: "x" }), ask({ client: null, call_id: "y" })], "me", now);
    expect(g.map((x) => x.rows.length)).toEqual([2, 1]);
  });
  it("keeps tasks from others apart from my reminders", () => {
    const g = gatherAsks([ask(), ask({ kind: "task", asked_by: "dana" })], "me", now);
    expect(g).toHaveLength(2);
  });
});

describe("the Overview's cards", () => {
  it("shows one card with a checklist's lines and its progress", () => {
    const rows = [
      ask({ checklist: [{ text: "Confirm event", done: true }, { text: "Confirm budget", done: false }] }),
      ask({ title: "Check the landing page", detail: "" }),
    ];
    const [{ item, bucket }] = askRowsFor(rows, "me", now, "Hedwig");
    expect(bucket).toBe("now");
    expect(item.client).toBe("Hedgehog Co");
    expect(item.title).toBe("3 follow-ups from your call");
    expect(item.why).toMatch(/^From your call with Hedwig, \d{1,2}:\d{2} (AM|PM)$/);
    expect(item.why).not.toMatch(/reminder via/i);
    const g = item.askGroup!;
    expect(g.items).toHaveLength(3);
    expect(g.askIds).toHaveLength(2);
    expect(g.transcriptCallId).toBe("call-1");
    expect(groupProgress(g.items)).toEqual({ done: 1, total: 3 });
  });
  it("calls the unclientled card General", () => {
    const [{ item }] = askRowsFor([ask({ client: null }), ask({ client: null })], "me", now);
    expect(item.client).toBe("General");
  });
  it("leaves a lone plain reminder an ordinary row, without the boilerplate", () => {
    const [{ item }] = askRowsFor([ask()], "me", now, "Hedwig");
    expect(item.askGroup).toBeUndefined();
    expect(item.why).toMatch(/^From your call with Hedwig/);
  });
  it("credits a teammate's tasks once on the card", () => {
    const [{ item }] = askRowsFor([ask({ kind: "task", asked_by: "dana", askerName: "Dana Lee", roleLabel: "Meta buyer", detail: "Why" }), ask({ kind: "task", asked_by: "dana", askerName: "Dana Lee", roleLabel: "Meta buyer", detail: "Why 2" })], "me", now);
    expect(item.askGroup?.source).toMatch(/^From Dana via the Meta buyer/);
    expect(item.tone).toBe("warn");
  });
  it("puts a later-dated group in coming up and late ones in red", () => {
    const soon = askRowsFor([ask({ due_on: "2026-11-25" }), ask({ due_on: "2026-11-25" })], "me", now);
    expect(soon[0].bucket).toBe("coming");
    const late = askRowsFor([ask({ due_on: "2026-11-10" }), ask({ due_on: null })], "me", now);
    expect(late[0].item.tone).toBe("bad");
  });
});

describe("the assistant's rundown", () => {
  it("has one line per client with ids to clear together", () => {
    const rows = [ask(), ask(), ask({ client: crust })];
    const lines = askRundown(rows, "me", now);
    expect(lines).toHaveLength(2);
    expect(lines[0].title).toBe("Hedgehog Co: 2 follow-ups");
    expect(lines[0].id.startsWith("ag-")).toBe(true);
    expect(lines[1].id.startsWith("a-")).toBe(true);
  });
});
