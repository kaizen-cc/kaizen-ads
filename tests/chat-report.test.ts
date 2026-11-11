import { describe, expect, it } from "vitest";
import { cantDo, cantDoSentence, chatReportMessage, fallShort, messageKey, sanitizeChatReport, trimTurns } from "@/lib/chat-report";
import { buildTranscript, fromAiMessages, fromTurns, launchState, orderEntries, redact, transcriptMarkdown, type TranscriptEntry } from "@/lib/chat-transcript";

describe("can't-do detection", () => {
  const says = [
    "I can't launch a search campaign from here.",
    "I cannot pull TikTok data yet.",
    "Sorry, I'm unable to change budgets on Google.",
    "I am not able to see the Shopify orders.",
    "I'm not able to open that file.",
    "I don't have access to the client's Drive folder.",
    "I do not have a tool for scheduling posts.",
    "I don’t have the ability to edit live ads.",
    "Unfortunately I couldn't load the ad account.",
    "I wasn't able to fetch the report.",
    "That isn't built yet in this app.",
    "Creating audiences is not supported yet.",
    "There's no tool for me to send emails.",
    "That's outside what I can do right now.",
    "Exporting to Sheets isn't wired up yet.",
    "I have no way to reach Asana from here.",
    "I'm not set up to post to Slack.",
  ];
  for (const text of says) it(`catches: ${text}`, () => expect(cantDo(text)).toBe(true));

  const fine = [
    "Here are the top three ads by ROAS this week.",
    "I can't stress enough how well the UGC ad is doing.",
    "I can't recommend raising the budget until CPA settles.",
    "You can't run two launches at once, so I queued the second.",
    "I couldn't find any tiring ads this week, which is good news.",
    "I can't tell which campaign you mean: the summer one or the evergreen one?",
    "Done. The copy set is ready.",
    "",
  ];
  for (const text of fine) it(`leaves alone: ${text || "(empty)"}`, () => expect(cantDo(text)).toBe(false));

  it("ignores quotes and code", () => {
    expect(cantDo("> I can't do this, you said\nHere's the plan.")).toBe(false);
    expect(cantDo("```\nthrow new Error(\"I cannot connect\")\n```\nFixed it.")).toBe(false);
  });

  it("finds the sentence that says it", () => expect(cantDoSentence("Sure. I can't pull TikTok data yet. Want Meta instead?")).toBe("I can't pull TikTok data yet."));
});

describe("which messages get an action", () => {
  it("offers Report this for an error or a failed tool, Ask for this for a can't-do, one per message", () => {
    expect(fallShort({ text: "I can't do that", error: "500: tool failed" })).toBe("error");
    expect(fallShort({ text: "All good", failed: true })).toBe("error");
    expect(fallShort({ text: "I can't do that yet." })).toBe("cant");
    expect(fallShort({ text: "All good" })).toBeNull();
    expect(fallShort({ text: "All good", error: "  " })).toBeNull();
  });
  it("keys a message without an id the same way each time", () => {
    expect(messageKey(3, "hello")).toBe(messageKey(3, "hello"));
    expect(messageKey(3, "hello")).not.toBe(messageKey(4, "hello"));
  });
});

describe("the report's payload", () => {
  it("keeps the last few turns, each cut short", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i} ${"x".repeat(900)}` }));
    const out = trimTurns(turns);
    expect(out).toHaveLength(6);
    expect(out[0].text.startsWith("turn 4")).toBe(true);
    expect(out[5].role).toBe("ai");
    expect(out.every((t) => t.text.length <= 600)).toBe(true);
    expect(trimTurns([{ role: "user", text: "  " }, { role: "user", text: "hi" }])).toEqual([{ role: "user", text: "hi" }]);
  });

  it("clamps what the browser sends and drops junk", () => {
    expect(sanitizeChatReport(null)).toBeNull();
    expect(sanitizeChatReport({ mode: "error", chat: "nope", messageId: "1" })).toBeNull();
    const r = sanitizeChatReport({
      mode: "cant",
      chat: "kaizen-ai",
      messageId: "m1",
      threadId: "t1",
      turns: [{ role: "user", text: "launch a search campaign" }, { role: "assistant", text: "I can't launch search campaigns yet." }, { role: "user" }],
      note: "  we need this  ",
      error: { text: "", code: "" },
      state: { draft: "a".repeat(10) },
    });
    expect(r).toMatchObject({ mode: "cant", chat: "kaizen-ai", threadId: "t1", note: "we need this", error: null, state: { draft: "aaaaaaaaaa" } });
    expect(r?.turns).toHaveLength(2);
    expect(r?.entries).toHaveLength(2);
  });

  it("says what happened in words", () => {
    const base = { turns: [{ role: "user" as const, text: "pull TikTok spend" }, { role: "ai" as const, text: "Sure. I can't pull TikTok data yet." }], note: "" };
    expect(chatReportMessage({ ...base, mode: "cant", chat: "kaizen-ai", error: null })).toContain(`Asked for in Kaizen AI: "pull TikTok spend"`);
    expect(chatReportMessage({ ...base, mode: "cant", chat: "kaizen-ai", error: null })).toContain("I can't pull TikTok data yet.");
    expect(chatReportMessage({ ...base, mode: "error", chat: "launch", error: { text: "Meta said 400", code: "E400" }, note: "again" })).toBe(
      'Error in a Meta launch card (E400): Meta said 400\nThey had asked: "pull TikTok spend"\nTheir note: again',
    );
  });
});

describe("the whole transcript", () => {
  it("orders entries by time, keeping untimed ones in place", () => {
    const e = (text: string, at: string | null): TranscriptEntry => ({ role: "user", at, text });
    expect(orderEntries([e("b", "2026-11-11T10:02:00Z"), e("c", null), e("a", "2026-11-11T10:01:00Z")]).map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  it("keeps tool calls, in full, between the words", () => {
    const entries = fromAiMessages([
      { role: "user", content: "How is Nectr doing?", created_at: "2026-11-11T10:00:00Z" },
      { role: "assistant", content: "Spend is up.", tools: [{ name: "meta_insights", label: "Read Meta", ok: false, input: { account: "1" }, summary: "Meta said 500" }], error: "Meta failed", agent_key: "media_buyer", created_at: "2026-11-11T10:00:05Z" },
    ]);
    expect(entries.map((e) => e.role)).toEqual(["user", "tool", "ai"]);
    expect(entries[1]).toMatchObject({ name: "meta_insights", ok: false });
    expect(entries[1].text).toContain('input: {"account":"1"}');
    expect(entries[2]).toMatchObject({ name: "media_buyer", error: { text: "Meta failed" } });
  });

  it("redacts keys and tokens", () => {
    const text = 'key sk-ant-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstuvwx and "api_key": "supersecret123" and ghp_abcdefghijklmnopqrstuvwxyz0123 and EAAB' + "x".repeat(40);
    const out = redact(text);
    expect(out).not.toContain("sk-ant-abc");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx and");
    expect(out).not.toContain("supersecret123");
    expect(out).not.toContain("ghp_abc");
    expect(out).not.toContain("EAABxxx");
    expect(redact("Spend was $1,234 on 2026-11-10")).toBe("Spend was $1,234 on 2026-11-10");
    const t = buildTranscript({ chat: "kaizen-ai", source: "server", threadId: "t", state: { token: "abc123456", nested: { note: "Bearer abcdefghijklmnopqrstuvwxyz" } }, entries: [{ role: "user", at: null, text: "my key is sk-abcdefghijklmnopqrstuvwxyz" }] });
    expect(JSON.stringify(t)).not.toMatch(/abc123456|sk-abcdef|Bearer abcdefghij/);
  });

  it("cuts long tool output first to fit, never a person's words", () => {
    const human = "please fix this ".repeat(300);
    const t = buildTranscript(
      {
        chat: "kaizen-ai",
        source: "server",
        threadId: null,
        state: null,
        entries: [
          { role: "user", at: "2026-11-11T10:00:00Z", text: human },
          { role: "tool", at: "2026-11-11T10:00:01Z", name: "big", text: "y".repeat(50_000) },
          { role: "ai", at: "2026-11-11T10:00:02Z", text: "z".repeat(3_000) },
        ],
      },
      20_000,
    );
    expect(t.entries[0].text).toBe(human);
    expect(t.entries[1].text.length).toBeLessThan(20_000);
    expect(t.entries[1].text).toMatch(/\[cut: \d+ more characters\]/);
    expect(t.entries[2].text).toBe("z".repeat(3_000));
    expect(t.cut).toBeGreaterThan(30_000);
    expect(transcriptMarkdown(t)).toContain("characters of tool output and long replies cut");
  });

  it("reads turns stored as { role, text, at }", () => {
    const e = fromTurns([{ role: "user", text: "launch these", at: "2026-11-11T09:00:00Z", by: "Media buyer" }, { role: "assistant", text: "Reading the sheet", at: "2026-11-11T09:00:02Z", launch: { id: "r1" } }]);
    expect(e[0]).toMatchObject({ role: "user", name: "Media buyer" });
    expect(e[1].role).toBe("ai");
    expect(e[1].text).toContain('launch card: {"id":"r1"}');
  });
});

describe("a launch run's state", () => {
  it("carries status, questions, the plan in short, its warnings and the lines that failed", () => {
    const s = launchState(
      { id: "r1", platform: "google", status: "partial", summary: "3 ad groups", questions: [{ q: "Which campaign?", answer: "Brand" }], plan: { summary: "Add 3 ad groups", adGroups: [1, 2, 3], ads: [1] }, plan_warnings: ["Budget is low"], error: null, progress: "2 of 3" },
      [
        { key: "ag1", kind: "adset", status: "created", error: null },
        { key: "ag2", kind: "adset", status: "failed", error: "Google said 400: duplicate name" },
        { key: "ad1", kind: "ad", status: "invalid", error: "Headline too long" },
      ],
    );
    expect(s).toMatchObject({ launchRun: "r1", platform: "google", status: "partial", questions: [{ q: "Which campaign?", answer: "Brand" }], plan: { summary: "Add 3 ad groups", adGroups: 3, ads: 1 }, planWarnings: ["Budget is low"] });
    expect(s.lineErrors).toEqual([
      { key: "ag2", kind: "adset", status: "failed", error: "Google said 400: duplicate name" },
      { key: "ad1", kind: "ad", status: "invalid", error: "Headline too long" },
    ]);
  });
});
