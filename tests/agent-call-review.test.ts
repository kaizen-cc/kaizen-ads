import { describe, expect, it } from "vitest";
import {
  RESUME_CONTINUE_MINUTES,
  RESUME_SOON_HOURS,
  decide,
  greetingFor,
  keyOf,
  parseTopic,
  pendingItems,
  pendingOf,
  resumeModeFor,
  seedOf,
  statusOf,
  type LearnedItem,
  type PreviousCall,
} from "@/lib/agent-call/core";
import { askItem, callReviewItem, dayWord, onDay, reviewHref } from "@/lib/agent-call/next-items";
import { ASKED_ACTIONS, CARD_TOOLS, READ_TOOLS, fillerFor, gateTools, resultText, runToolLoop, type LoopMessage, type LoopTool } from "@/lib/agent-call/tool-loop";
import { focusFor } from "@/lib/agent-call/role-focus";
import { asPeriod, periodRange, rankEntries, rankLinesFor, sumDays, vsTarget } from "@/lib/kaizen-ai/rank-core";

// Calls with the agents: picking up where you left off (by timing), learnings held for keep or toss, what waits on
// the Overview, the lookup loop on a call, and ranking clients.

const at = (iso: string) => new Date(iso);
const prev = (lastTurnAt: string, turns = 3): PreviousCall => ({ startedAt: lastTurnAt, endedAt: null, lastTurnAt, turns });

describe("how a call follows the last one", () => {
  // Tuesday Nov 17, New York (EST, UTC-5)
  const now = at("2026-11-17T16:00:00-05:00");

  it("starts fresh with no earlier call, or one where nothing was said", () => {
    expect(resumeModeFor(null, now)).toBe("fresh");
    expect(resumeModeFor(prev("2026-11-17T15:58:00-05:00", 0), now)).toBe("fresh");
  });

  it("carries on after a cut-off within the window", () => {
    expect(resumeModeFor(prev("2026-11-17T15:57:00-05:00"), now)).toBe("continue");
    expect(resumeModeFor(prev(new Date(now.getTime() - RESUME_CONTINUE_MINUTES * 60_000).toISOString()), now)).toBe("continue");
  });

  it("says hey again a few hours later the same day", () => {
    expect(resumeModeFor(prev("2026-11-17T15:40:00-05:00"), now)).toBe("soon");
    expect(resumeModeFor(prev(new Date(now.getTime() - RESUME_SOON_HOURS * 3_600_000).toISOString()), now)).toBe("soon");
  });

  it("offers to pick up the morning's call at the end of the day", () => {
    expect(resumeModeFor(prev("2026-11-17T09:10:00-05:00"), now)).toBe("later_today");
  });

  it("starts fresh the next day, by New York's day not UTC's", () => {
    expect(resumeModeFor(prev("2026-11-16T17:00:00-05:00"), now)).toBe("fresh");
    // 11pm in New York is already the next day in UTC: still the same day here
    expect(resumeModeFor(prev("2026-11-17T18:00:00-05:00"), at("2026-11-17T23:30:00-05:00"))).toBe("later_today");
  });

  it("keeps a cut-off just before midnight going after it", () => {
    expect(resumeModeFor(prev("2026-11-17T23:58:00-05:00"), at("2026-11-18T00:03:00-05:00"))).toBe("continue");
  });

  it("uses the call's end, then its start, when no turn was stamped", () => {
    expect(resumeModeFor({ startedAt: "2026-11-17T15:00:00-05:00", endedAt: "2026-11-17T15:55:00-05:00", lastTurnAt: null, turns: 2 }, now)).toBe("continue");
  });
});

describe("the greeting", () => {
  it("keeps the first fresh greeting as it was", () => {
    expect(greetingFor("Kyle Smith", "Media Buyer")).toBe("Hey Kyle, it's the Media Buyer. What can I help you with?");
  });

  it("apologises for a cut-off and names what they were asking", () => {
    const g = greetingFor("Dana Lee", "Email Strategist", "continue", "Crust Pizza's last 30 days.", 0);
    expect(g).toBe("Sorry Dana, we got cut off. You were asking about Crust Pizza's last 30 days.");
  });

  it("is warm on a quick call back and offers to pick up later in the day", () => {
    expect(greetingFor("Dana Lee", "Email Strategist", "soon", null, 0)).toBe("Hey again, Dana! Good to hear from you so soon. What's up?");
    expect(greetingFor("Dana Lee", "Email Strategist", "later_today", "the welcome flow", 0)).toBe("Hey Dana! Want to pick up from our conversation earlier today about the welcome flow, or something new?");
  });

  it("varies with the seed, always by first name, never with an em dash", () => {
    const lines = new Set([0, 1, 2, 3, 4, 5].map((s) => greetingFor("Ana Ruiz", "Copywriter", "fresh", null, s)));
    expect(lines.size).toBeGreaterThan(1);
    for (const mode of ["fresh", "continue", "soon", "later_today"] as const)
      for (let s = 0; s < 4; s++) {
        const g = greetingFor("Ana Ruiz", "Copywriter", mode, "briefs", s);
        expect(g).toContain("Ana");
        expect(g).not.toMatch(/[—–]/);
        expect(g[0]).toBe(g[0].toUpperCase());
      }
  });

  it("falls back when there's no topic or no name", () => {
    expect(greetingFor(null, "Strategist", "continue", null, 0)).toBe("Sorry there, we got cut off. Where were we?");
    expect(seedOf("abc")).toBe(seedOf("abc"));
  });
});

describe("learnings held for keep or toss", () => {
  let n = 0;
  const key = () => `k${++n}`;
  const heard = pendingItems(
    [
      { type: "note", skill: "auditor", kind: "skill", title: "Check frequency first", body: "Check frequency before calling fatigue on any ad set." },
      { type: "rewrite", skill: "core", kind: "knowledge", title: "Shorter answers", body: "Keep every answer to three sentences unless asked for more." },
      { type: "note", skill: "reporter", kind: "knowledge", title: "Lead with ROAS", body: "Reports lead with ROAS for ecommerce clients, then spend." },
    ],
    key,
  );

  it("captures what's heard as pending, with a key each and nothing written", () => {
    expect(heard.map(statusOf)).toEqual(["pending", "pending", "pending"]);
    expect(heard.every((h) => h.id === null && h.key)).toBe(true);
    expect(pendingOf(heard)).toHaveLength(3);
  });

  it("needs a decision on every pending item", () => {
    const r = decide(heard, { [keyOf(heard[0])]: { keep: true } });
    expect(r).toEqual({ ok: false, error: "Keep or toss every item first." });
  });

  it("keeps (with edits) and tosses, leaving nothing pending", () => {
    const r = decide(heard, {
      [keyOf(heard[0])]: { keep: true, body: "Always check frequency before calling fatigue on an ad set." },
      [keyOf(heard[1])]: { keep: false },
      [keyOf(heard[2])]: { keep: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map(statusOf)).toEqual(["kept", "tossed", "kept"]);
    expect(r.keep.map((k) => k.title)).toEqual(["Check frequency first", "Lead with ROAS"]);
    expect(r.keep[0].body).toBe("Always check frequency before calling fatigue on an ad set.");
    expect(r.tossed).toBe(1);
    expect(pendingOf(r.items)).toHaveLength(0);
  });

  it("leaves decided and older items alone", () => {
    const old: LearnedItem = { id: "item-1", type: "note", skill: "auditor", title: "Saved before reviews", body: "Saved straight away under the old rule." };
    expect(statusOf(old)).toBe("kept");
    const r = decide([old, { ...heard[0], status: "tossed" }], {});
    expect(r.ok && r.items).toEqual([old, { ...heard[0], status: "tossed" }]);
  });

  it("refuses an edit that empties a note or adds a secret", () => {
    expect(decide([heard[0]], { [keyOf(heard[0])]: { keep: true, body: "short" } }).ok).toBe(false);
    const bad = decide([heard[0]], { [keyOf(heard[0])]: { keep: true, body: "Log in with password hunter2 to check frequency first." } });
    expect(bad.ok).toBe(false);
    // Tossing it is always fine
    expect(decide([heard[0]], { [keyOf(heard[0])]: { keep: false, body: "x" } }).ok).toBe(true);
  });

  it("reads the topic of a moment, never a secret", () => {
    expect(parseTopic({ topic: "  Crust Pizza   email numbers " })).toBe("Crust Pizza email numbers");
    expect(parseTopic({ topic: "" })).toBeNull();
    expect(parseTopic({ topic: "the login is dana@example.com" })).toBeNull();
    expect(parseTopic(null)).toBeNull();
  });
});

describe("what waits on the Overview", () => {
  const now = at("2026-11-19T10:00:00-05:00"); // Thursday

  it("names the day a call was on", () => {
    expect(dayWord("2026-11-19T08:00:00-05:00", now)).toBe("today");
    expect(dayWord("2026-11-18T08:00:00-05:00", now)).toBe("yesterday");
    expect(dayWord("2026-11-17T08:00:00-05:00", now)).toBe("Tuesday");
    expect(dayWord("2026-11-05T08:00:00-05:00", now)).toBe("Nov 5");
    expect(onDay("2026-11-17T08:00:00-05:00", now)).toBe("on Tuesday");
    expect(onDay("2026-11-19T08:00:00-05:00", now)).toBe("today");
  });

  it("asks to review a call's learnings, opening the agent's page with the sheet", () => {
    const it = callReviewItem({ callId: "c1", roleKey: "media_buyer", roleLabel: "Media Buyer", startedAt: "2026-11-17T14:00:00-05:00", items: [1, 2] }, now);
    expect(it.kind).toBe("call-learnings");
    expect(it.title).toBe("Review what you taught the Media Buyer on Tuesday");
    expect(it.why).toBe("2 things heard on the call wait for you to keep or toss. Nothing is applied until you do.");
    expect(it.href).toBe(reviewHref("media_buyer", "c1"));
    expect(it.href).toBe("/settings?tab=agents&role=media_buyer&review=c1");
    expect(callReviewItem({ callId: "c2", roleKey: "copywriter", roleLabel: "Copywriter", startedAt: "2026-11-19T09:00:00-05:00", items: [1] }, now).title).toBe("Review what you taught the Copywriter today");
  });

  it("credits a task to who asked and which agent, for now or coming up", () => {
    const base = { id: "a1", kind: "task" as const, title: "Resend the welcome flow test", detail: "Open rate fell to 18% this week", created_at: "2026-11-19T09:00:00-05:00", asked_by: "p-kyle", askerName: "Kyle Smith", roleLabel: "Email Strategist", client: { name: "Crust Pizza", slug: "crust-pizza" } };
    const a = askItem({ ...base, due_on: null }, "p-dana", now);
    expect(a.bucket).toBe("now");
    expect(a.item.kind).toBe("ask");
    expect(a.item.why).toBe("From Kyle via the Email Strategist: Open rate fell to 18% this week");
    expect(a.item.client).toBe("Crust Pizza");
    expect(a.item.ask).toEqual({ id: "a1" });
    expect(askItem({ ...base, due_on: "2026-11-24" }, "p-dana", now).bucket).toBe("coming");
    const late = askItem({ ...base, due_on: "2026-11-18" }, "p-dana", now);
    expect(late.item.tone).toBe("bad");
    expect(late.item.when).toBe("Was due Nov 18");
  });

  it("calls the person's own reminder theirs", () => {
    const r = askItem({ id: "a2", kind: "reminder", title: "Check the Q4 budget", detail: "", due_on: "2026-11-19", created_at: "2026-11-19T09:00:00-05:00", asked_by: "p-dana", askerName: "Dana Lee", roleLabel: "Media Buyer", client: null }, "p-dana", now);
    expect(r.item.why).toBe("Your reminder via the Media Buyer");
    expect(r.item.client).toBe("Reminder");
    expect(r.bucket).toBe("now");
  });
});

describe("lookups on a call", () => {
  const tool = (name: string, run: LoopTool["run"] = async () => ({ ok: true })): LoopTool => ({ name, description: name, input_schema: { type: "object", properties: {} }, run });

  it("keeps read-only tools, drops card-only ones and asks first for the rest", async () => {
    const out = gateTools([tool("rank_clients"), tool("create_brief"), tool("save_client_note"), tool("remind_me"), { ...tool("higgsfield_generate"), input_schema: { type: "object", properties: { confirmed: { type: "boolean" } } } }]);
    expect(out.map((t) => t.name)).toEqual(["rank_clients", "save_client_note", "remind_me", "higgsfield_generate"]);
    const gated = out.find((t) => t.name === "save_client_note")!;
    expect((gated.input_schema as { properties: Record<string, unknown> }).properties.confirmed).toBeTruthy();
    await expect(gated.run({ note: "x" })).rejects.toThrow(/ask the person first/);
    await expect(gated.run({ note: "x", confirmed: true })).resolves.toEqual({ ok: true });
    expect(READ_TOOLS.has("email_marketing") && CARD_TOOLS.has("plan_ad_changes") && ASKED_ACTIONS.has("ask_teammate")).toBe(true);
  });

  it("runs tools until the model answers, sending results and errors back", async () => {
    const seen: string[] = [];
    const tools = [tool("rank_clients", async (i) => ({ top: [i.line] })), tool("broken", async () => Promise.reject(new Error("no access")))];
    const messages: LoopMessage[] = [{ role: "user", content: "top clients?" }];
    let calls = 0;
    const out = await runToolLoop({
      tools,
      messages,
      maxRounds: 4,
      onTools: (c) => seen.push(...c.map((x) => x.name)),
      step: async (_m, last) => {
        calls++;
        if (calls === 1)
          return {
            stop: "tool_use",
            content: [
              { type: "tool_use", id: "t1", name: "rank_clients", input: { line: "email" } },
              { type: "tool_use", id: "t2", name: "broken", input: {} },
            ],
          };
        expect(last).toBe(false);
        return { stop: "end_turn", content: [{ type: "text", text: "Crust leads." }] };
      },
    });
    expect(out.rounds).toBe(2);
    expect(out.stop).toBe("end_turn");
    expect(seen).toEqual(["rank_clients", "broken"]);
    expect(out.runs.map((r) => [r.name, r.ok])).toEqual([
      ["rank_clients", true],
      ["broken", false],
    ]);
    const results = messages[2].content as { tool_use_id: string; content: string; is_error?: boolean }[];
    expect(results[0]).toMatchObject({ tool_use_id: "t1", content: JSON.stringify({ top: ["email"] }) });
    expect(results[1]).toMatchObject({ tool_use_id: "t2", is_error: true, content: "no access" });
  });

  it("answers without tools on the last round", async () => {
    const lasts: boolean[] = [];
    const out = await runToolLoop({
      tools: [tool("list_clients")],
      messages: [{ role: "user", content: "hi" }],
      maxRounds: 2,
      step: async (_m, last) => {
        lasts.push(last);
        return { stop: last ? "end_turn" : "tool_use", content: [{ type: "tool_use", id: `t${lasts.length}`, name: "list_clients", input: {} }] };
      },
    });
    expect(lasts).toEqual([false, true]);
    expect(out.runs).toHaveLength(1);
  });

  it("stops when the person talks over it", async () => {
    const ac = new AbortController();
    let rounds = 0;
    await runToolLoop({
      tools: [tool("list_clients", async () => (ac.abort(), []))],
      messages: [{ role: "user", content: "hi" }],
      maxRounds: 5,
      signal: ac.signal,
      step: async () => {
        rounds++;
        return { stop: "tool_use", content: [{ type: "tool_use", id: "t", name: "list_clients", input: {} }] };
      },
    });
    expect(rounds).toBe(1);
  });

  it("says a short line while it looks, naming the client", () => {
    expect(fillerFor([{ name: "email_marketing", input: { client: "Crust Pizza" } }], 0)).toBe("One sec, pulling Crust Pizza's email numbers.");
    expect(fillerFor([{ name: "rank_clients", input: { line: "email" } }], 1)).toBe("Give me a second, I'm pulling the rankings.");
    expect(fillerFor([{ name: "account_metrics", input: { client: "Sierra Dreams" } }], 0)).toBe("One sec, pulling Sierra Dreams' numbers.");
    expect(resultText("x".repeat(50), 10)).toMatch(/^x{10}\n…\(cut/);
  });

  it("gives each role the metrics it leads with", () => {
    expect(focusFor("email_creative")).toMatch(/click rate/);
    expect(focusFor("email_strategist")).toMatch(/revenue per recipient/);
    expect(focusFor("unknown_role")).toMatch(/main KPI/);
  });
});

describe("ranking clients", () => {
  it("ranks best or worst first, leaving out clients with no number", () => {
    const rows = [
      { client: "A", value: 0.5, shown: "", why: "" },
      { client: "B", value: null, shown: "", why: "" },
      { client: "C", value: 0.9, shown: "", why: "" },
      { client: "D", value: 0.1, shown: "", why: "" },
    ];
    expect(rankEntries(rows, "top", 3).ranked.map((r) => [r.rank, r.client])).toEqual([
      [1, "C"],
      [2, "A"],
      [3, "D"],
    ]);
    expect(rankEntries(rows, "bottom", 1).ranked.map((r) => r.client)).toEqual(["D"]);
    expect(rankEntries(rows, "top", 3).without).toBe(1);
    expect(rankEntries(rows, "top", 999).ranked).toHaveLength(3);
  });

  it("lets each person rank only their own lines", () => {
    expect(rankLinesFor({ role: "executive", isExec: true }, null, null)).toEqual(["email", "social", "meta", "google"]);
    expect(rankLinesFor({ role: "email_strategist" }, "email", null)).toEqual(["email"]);
    expect(rankLinesFor({ role: "head_of_email", isLead: true }, "email", null)).toEqual(["email"]);
    expect(rankLinesFor({ role: "head_of_meta", isLead: true }, null, "meta")).toEqual(["email", "social", "meta", "google"]);
    expect(rankLinesFor({ role: "media_buyer" }, null, "meta")).toEqual(["meta"]);
    expect(rankLinesFor({ role: "graphic_designer" }, null, null)).toEqual(["meta", "google"]);
  });

  it("reads periods and sums days in range", () => {
    expect(periodRange("7", "2026-11-17")).toEqual({ from: "2026-11-11", to: "2026-11-17", label: "the last 7 days" });
    expect(periodRange("month", "2026-11-17").from).toBe("2026-11-01");
    expect(asPeriod(90)).toBe("90");
    expect(asPeriod("nonsense")).toBe("30");
    const days = [
      { date: "2026-11-10", revenue: 5 },
      { date: "2026-11-12", revenue: 7 },
      { date: "2026-11-13", revenue: null },
    ];
    expect(sumDays(days, "revenue", "2026-11-11", "2026-11-17")).toBe(7);
    expect(sumDays(days, "orders", "2026-11-11", "2026-11-17")).toBeNull();
  });

  it("turns the KPI deviation into better or worse than target", () => {
    expect(vsTarget(-0.2)).toEqual({ value: 0.2, shown: "20% better than target" });
    expect(vsTarget(0.35)).toEqual({ value: -0.35, shown: "35% worse than target" });
    expect(vsTarget(null).value).toBeNull();
  });
});
