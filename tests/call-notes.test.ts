import { describe, expect, it } from "vitest";
import { keepNoteItems, MIN_PERSON_WORDS, personWords } from "@/lib/assistant/notes-core";

// Peter's call, Nov 26 2026 (anonymized): three short turns while the voice was failing; the assistant listed his
// urgent items, and the notes came back with four "follow-ups" from that list and a "decision" nobody made.
const peter = [
  { role: "agent", content: "Hey! Want to pick up from earlier, or something new? I still need your Asana. Want me to bring up Connect now?" },
  { role: "user", content: "what are those urgent things" },
  { role: "agent", content: "Three critical items. First, a reminder you saved. Second, settle the discount before the Black Friday sends." },
  { role: "user", content: "hello" },
  { role: "agent", content: "I'm here. Want to start with the coffee client, since it's off target?" },
  { role: "user", content: "Jarvis are you there" },
];
const readOut = [
  { what: "Confirm the abandoned-cart discount before Black Friday", client: "A", from: "assistant_read_out" },
  { what: "Reply to the relaunch dispute", client: "B", from: "assistant_read_out" },
  { what: "Get the sale-ending videos approved", client: "C", from: "assistant_read_out" },
  { what: "Review social performance, off target", client: "D", from: "assistant_offered" },
];

describe("call notes keep only what the person said, asked for or agreed to", () => {
  it("a call where the person barely spoke has no follow-ups and no decisions", () => {
    expect(personWords(peter)).toBeLessThan(MIN_PERSON_WORDS);
    expect(keepNoteItems({ decisions: ["Asana connection was offered but not confirmed"], followUps: readOut, personWords: personWords(peter) })).toEqual({ decisions: [], followUps: [] });
  });
  it("never turns the assistant's rundown of their open items, or an unanswered offer, into follow-ups", () => {
    const talked = [{ role: "user", content: "Okay, can you draft the reply to the relaunch dispute and remind me to check the Black Friday sends on Friday" }];
    expect(personWords(talked)).toBeGreaterThanOrEqual(MIN_PERSON_WORDS);
    const kept = keepNoteItems({
      decisions: ["Draft the relaunch reply"],
      followUps: [...readOut, { what: "Check the Black Friday sends", client: "A", from: "they_asked" }, { what: "Send the relaunch reply", client: "B", from: "they_said_they_will" }],
      personWords: personWords(talked),
    });
    expect(kept.followUps.map((f) => f.what)).toEqual(["Check the Black Friday sends", "Send the relaunch reply"]);
    expect(kept.decisions).toEqual(["Draft the relaunch reply"]);
  });
  it("counts what the person said, not greetings or checking the line", () => {
    expect(personWords([{ role: "user", content: "hello? are you there? Jarvis? ok" }])).toBe(0);
    expect(personWords([{ role: "agent", content: "lots of words from the assistant here about many things" }])).toBe(0);
  });
});
