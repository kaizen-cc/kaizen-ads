import { describe, expect, it } from "vitest";
import { askSource, dedupeAsks, lineClosed, sameAsk } from "@/lib/agent-asks-core";
import { reminderDone, safetySub, subsLeft, type SubItem } from "@/lib/exec-overview-core";

const a = (title: string, at: string, over: Partial<{ owner_id: string; asked_by: string | null }> = {}) => ({ owner_id: "owner", asked_by: "asker", title, created_at: at, ...over });

describe("asks saved twice", () => {
  it("the same asker, owner and near-identical title within minutes is one ask", () => {
    const x = a("Build a way to push assets from Kaizen OS into Google Drive (folders and uploads)", "2026-11-21T06:28:01Z");
    const y = a("Build a way to push assets from Kaizen OS into Google Drive (folders and files, like case studies)", "2026-11-21T06:28:03Z");
    expect(sameAsk(x, y)).toBe(true);
    expect(dedupeAsks([y, x])).toEqual([x]);
  });
  it("a different asker, owner, title or a later save stays its own", () => {
    const x = a("Integrate Shopify into Kaizen OS as soon as possible", "2026-11-21T06:28:01Z");
    expect(sameAsk(x, a(x.title, "2026-11-21T06:28:05Z", { asked_by: "someone else" }))).toBe(false);
    expect(sameAsk(x, a(x.title, "2026-11-21T06:28:05Z", { owner_id: "another" }))).toBe(false);
    expect(sameAsk(x, a("Build a way to push assets into Drive", "2026-11-21T06:28:05Z"))).toBe(false);
    expect(sameAsk(x, a(x.title, "2026-11-21T07:00:00Z"))).toBe(false);
    expect(dedupeAsks([x, a("Fix it", "2026-11-21T06:28:02Z"), a("Fix it", "2026-11-21T06:28:03Z")])).toHaveLength(3);
  });
});

describe("where an ask came from", () => {
  it("a call opens the call, a chat the assistant", () => {
    expect(askSource({ call_id: "c1", role_key: "assistant" })).toEqual({ label: "From a call", href: "/assistant?call=c1" });
    expect(askSource({ call_id: null, role_key: null }).label).toBe("From a chat");
  });
});

describe("each flagged call on its own", () => {
  it("carries the caller's role and name, when, what, how serious, and the first moment", () => {
    const s = safetySub(
      { call_id: "k1", severity: "high", distress: false, categories: ["harassment", "self_harm"], reviewed_at: "2026-11-22T12:00:00Z", moments: [{ at_seconds: 200, category: "x", note: "later" }, { at_seconds: 75, category: "harassment", note: "first thing" }] },
      { started_at: "2026-11-22T11:00:00Z", profiles: { full_name: "Pat Doe", role: "media_buyer" } },
    );
    expect(s.key).toBe("safety:k1");
    expect(s.href).toBe("/safety/k1");
    expect(s.title).toBe("Media buyer · Pat Doe: harassment, self harm");
    expect(s.meta).toContain("high severity");
    expect(s.detail).toBe("At 1:15: first thing");
  });
  it("without the call or moments it still reads", () => {
    const s = safetySub({ call_id: "k2", severity: null, distress: true, categories: null, reviewed_at: null, summary: "Raised voices" }, null);
    expect(s.title).toBe("Someone: flagged");
    expect(s.meta).toBe("distress");
    expect(s.detail).toBe("Raised voices");
  });
});

describe("a reminder's lines, each closed on its own", () => {
  const line = (id: string, n: number, extra: Partial<SubItem> = {}): SubItem => ({ key: `ask:${id}#${n}`, title: `Line ${n}`, meta: "From a call", href: "/assistant?call=c", group: "3 follow-ups from your call", ...extra });
  const subs = [line("a", 1, { overdue: true }), line("a", 2), line("a", 3), { key: "ask:b", title: "Call the client back", meta: "From a chat", href: "/assistant" }, line("c", 1)];
  const card = { title: "5 reminders you saved from your calls and chats", detail: "1 overdue · Open each, or mark it done right here", subs, subsTitle: { one: "reminder you saved from your calls and chats", many: "reminders you saved from your calls and chats" }, stat: { value: "5", label: "reminders" } };

  it("the parent auto-completes when its last open line is done", () => {
    expect(lineClosed([{ text: "x", done: true }, { text: "y", done: false }]).close).toBe(false);
    expect(lineClosed([{ text: "x", done: true }, { text: "y", done: true }]).close).toBe(true);
    expect(lineClosed([]).close).toBe(false);
    const closed = new Set(["ask:a#1", "ask:a#2"]);
    expect(reminderDone(subs, closed, "a")).toBe(false);
    closed.add("ask:a#3");
    expect(reminderDone(subs, closed, "a")).toBe(true);
    expect(reminderDone(subs, closed, "b")).toBe(false);
  });

  it("closing one recounts the card's title, overdue and number", () => {
    const next = subsLeft(card, new Set(["ask:a#1"]))!;
    expect(next.subs).toHaveLength(4);
    expect(next.title).toBe("4 reminders you saved from your calls and chats");
    expect(next.detail).toBe("Open each, or mark it done right here");
    expect(next.stat).toEqual({ value: "4", label: "reminders" });
    expect(subsLeft(card, new Set(["ask:a#1", "ask:a#2", "ask:a#3", "ask:c#1"]))!.title).toBe("1 reminder you saved from your calls and chats");
  });

  it("a whole reminder closed takes its lines; everything closed ends the card", () => {
    expect(subsLeft(card, new Set(["ask:a"]))!.subs!.map((s) => s.key)).toEqual(["ask:b", "ask:c#1"]);
    expect(subsLeft(card, new Set(subs.map((s) => s.key)))).toBeNull();
    expect(subsLeft(card, new Set())).toBe(card);
  });
});
