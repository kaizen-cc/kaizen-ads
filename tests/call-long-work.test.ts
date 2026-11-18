import { describe, expect, it } from "vitest";
import { CARRY_ON, checkInDue, checkInLine, progressPct, runToolLoop, soundsUnfinished, stepLabel, type LoopMessage, type LoopTool } from "@/lib/agent-call/tool-loop";
import { createLengthGuard, nextCapFor, spokenCapFor, LIST_CAP_WORDS, SPOKEN_CAP_WORDS, MORE_LINE } from "@/lib/agent-call/spoken-length";

const tool = (name: string, run: LoopTool["run"] = async () => ({ ok: true })): LoopTool => ({ name, description: name, input_schema: { type: "object" }, run });

describe("a multi-step task runs to the end within the turn", () => {
  it("an interim 'working on it' line doesn't hand the turn back: the loop carries on to the tools and the result", async () => {
    const messages: LoopMessage[] = [{ role: "user", content: "make three campaigns for Ocean Box" }];
    const said: string[] = [];
    let round = 0;
    const ran: string[] = [];
    const out = await runToolLoop({
      tools: [tool("deliverable", async () => (ran.push("deliverable"), { next: "brainstorm" }))],
      messages,
      maxRounds: 6,
      unfinished: (content) => soundsUnfinished(content.map((b) => b.text ?? "").join(" ")),
      step: async () => {
        round++;
        if (round === 1) return (said.push("On it, give me a sec while I pull their context."), { stop: "end_turn", content: [{ type: "text", text: "On it, give me a sec while I pull their context." }] });
        if (round === 2) return { stop: "tool_use", content: [{ type: "tool_use", id: "t1", name: "deliverable", input: { action: "context" } }] };
        return (said.push("Here are three ideas."), { stop: "end_turn", content: [{ type: "text", text: "Here are three ideas: 1. Scratch to Win. 2. VIP early access. 3. Restock alert." }] });
      },
    });
    expect(out.nudged).toBe(1);
    expect(ran).toEqual(["deliverable"]);
    expect(said.at(-1)).toBe("Here are three ideas.");
    expect(messages.some((m) => m.role === "user" && m.content === CARRY_ON)).toBe(true);
  });

  it("never nudges a real answer or a question, and at most twice a turn", async () => {
    expect(soundsUnfinished("Your open rate is 41%, well above the 35% bar.")).toBe(false);
    expect(soundsUnfinished("Want me to pull the flows too?")).toBe(false);
    expect(soundsUnfinished("Still working on it.")).toBe(true);
    expect(soundsUnfinished("Let me pull that together.")).toBe(true);
    let rounds = 0;
    const out = await runToolLoop({ tools: [], messages: [{ role: "user", content: "x" }], maxRounds: 8, unfinished: () => true, step: async () => (rounds++, { stop: "end_turn", content: [{ type: "text", text: "One sec." }] }) });
    expect(out.nudged).toBe(2);
    expect(rounds).toBe(3);
  });
});

describe("voiced check-ins while an agent works", () => {
  it("the first after about three quiet seconds, then every four to five", () => {
    expect(checkInDue(2000, 0)).toBe(false);
    expect(checkInDue(3100, 0)).toBe(true);
    expect(checkInDue(3100, 1)).toBe(false);
    expect(checkInDue(4600, 1)).toBe(true);
  });
  it("varied, never the same line twice in a row", () => {
    let last: string | null = null;
    for (let i = 0; i < 30; i++) {
      const line = checkInLine(last, i * 7);
      expect(line).not.toBe(last);
      last = line;
    }
  });
  it("the step bar: a step named from the tool, a share that climbs but never reads done", () => {
    expect(stepLabel({ name: "create_copy_doc", status: () => "Writing 3 emails into the doc…" }, {})).toBe("Writing 3 emails into the doc");
    expect(stepLabel({ name: "get_client_context" }, {})).toBe("Reading brand rules and context");
    expect(progressPct(0)).toBe(0);
    expect(progressPct(1)).toBeLessThan(progressPct(3));
    expect(progressPct(20)).toBeLessThan(100);
  });
});

describe("spoken length: only long monologues are cut", () => {
  it("a planning answer with three numbered ideas is said whole", () => {
    expect(spokenCapFor("brainstorm three campaign ideas for Ocean Box")).toBe(LIST_CAP_WORDS);
    const g = createLengthGuard(SPOKEN_CAP_WORDS);
    const idea = (n: number) => `${n}. ${"A short campaign idea with an angle, an offer and who it goes to. ".repeat(3)}`;
    let out = "";
    for (const piece of ["Here are three for this month. ", idea(1), idea(2), idea(3), "Want me to write them up?"]) out += g.feed(piece);
    expect(g.capped).toBe(false);
    expect(out).toContain("3. ");
  });
  it("a long monologue is still cut, and never two answers in a row", () => {
    const g = createLengthGuard(SPOKEN_CAP_WORDS);
    for (let i = 0; i < 40; i++) g.feed("This is one more sentence that keeps on going. ");
    expect(g.capped).toBe(true);
    expect(g.tail).toBe(` ${MORE_LINE}`);
    expect(nextCapFor("how is it going", true)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextCapFor("how is it going", false)).toBe(SPOKEN_CAP_WORDS);
  });
});
