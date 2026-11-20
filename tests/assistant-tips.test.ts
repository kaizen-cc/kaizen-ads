import { describe, expect, it } from "vitest";
import { TIPS, assistantGreeting, tipFor } from "@/lib/assistant/core";

const buyer = { role: "meta_buyer", isExec: false };
const coordinator = { role: "customer_success", isExec: false };
const memory = [{ id: "m1", kind: "style", topic: "length", body: "short answers" }] as never[];

describe("did-you-know tips in the assistant's hello", () => {
  it("shows a tip on about half of fresh hellos, and only to someone it fits", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => i);
    const shown = seeds.filter((s) => tipFor(buyer, s));
    expect(shown.length).toBe(100);
    for (const s of seeds) expect(["handoffs", "audits"]).not.toContain(tipFor(coordinator, s)?.key);
  });
  it("never offers calendar booking before it's live", () => {
    for (let s = 0; s < 400; s++) expect(tipFor({ role: "executive", isExec: true }, s)?.key).not.toBe("calendar");
  });
  it("shuffles through several different tips", () => {
    const keys = new Set(Array.from({ length: 400 }, (_, s) => tipFor(buyer, s)?.key).filter(Boolean));
    expect(keys.size).toBeGreaterThan(5);
  });
  it("adds the tip to a plain daytime hello, never to a first call", () => {
    const seed = Array.from({ length: 64 }, (_, i) => i).find((s) => tipFor(buyer, s) && s % 3 !== 0)!; // a seed with no casual question
    const hello = assistantGreeting({ name: "Dana", memory, today: "2026-11-20", seed, hour: 14, mode: "fresh", person: buyer }).text;
    expect(hello).toContain("did you know");
    expect(assistantGreeting({ name: "Dana", memory: [], today: "2026-11-20", seed, hour: 14, mode: "fresh", person: buyer }).text).not.toContain("did you know");
  });
  it("every tip reads as a 'did you know' question", () => {
    for (const t of TIPS) expect(t.text.trim().length).toBeGreaterThan(20);
  });
});
