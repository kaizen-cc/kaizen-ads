import { describe, expect, it } from "vitest";
import { PAYOFF_RULE, checkPayoff, conceptPays, promiseIn } from "@/lib/brief-payoff";
import { lintBrief } from "@/lib/brief-lint";
import { SPEC_RULE, parseBrief } from "@/lib/brief-spec";

// A hook that promises a reveal (a hack, a tip, a secret, "what most people miss") has to be paid off in the brief.

describe("promiseIn", () => {
  it("finds the promises an editor would ask about", () => {
    expect(promiseIn("The hack most people miss when buying a seat")).toMatch(/hack/i);
    expect(promiseIn("3 tips for your first game")).toBe("3 tips");
    expect(promiseIn("Most fans miss this section")).toMatch(/most fans miss/i);
    expect(promiseIn("What nobody tells you about season tickets")).toMatch(/nobody tells you/i);
    expect(promiseIn("The secret to a quiet seat")).toMatch(/secret/i);
  });
  it("leaves plain hooks alone", () => {
    expect(promiseIn("Your seat, your view. Book tonight.")).toBeNull();
    expect(promiseIn("Fresh coffee, roasted Tuesday")).toBeNull();
  });
});

const unpaid = `Show the hack most people miss when buying a seat.

Insight: There's a hack most people miss.

Hook: The hack most people miss when buying a seat

Your call: Style and pacing are yours.`;

const paid = `Show the aisle-seat hack.

Insight: Rows ending in an aisle in sections 101 to 104 sell last, so they drop to face value the week of the game. (Source: call Oct 12)

Hook: The hack most people miss when buying a seat

Your call: Style and pacing are yours.`;

describe("checkPayoff", () => {
  it("an insight that only repeats the tease doesn't pay it off", () => {
    const p = parseBrief(unpaid);
    const c = checkPayoff({ overview: p.overview, spec: p.spec, text: unpaid });
    expect(c.promise).toBeTruthy();
    expect(c.paid).toBe(false);
  });
  it("a specific insight with its source does", () => {
    const p = parseBrief(paid);
    expect(checkPayoff({ overview: p.overview, spec: p.spec, text: paid }).paid).toBe(true);
  });
  it("sees a fallback line and a question waiting on the client", () => {
    const text = `${unpaid}\n\nConfirm with client:\n- Which hack exactly, and why?`.replace("Show the hack", "Fallback: a seat-view comparison if the client can't confirm it.\nShow the hack");
    const p = parseBrief(text);
    const c = checkPayoff({ overview: p.overview, spec: p.spec, text });
    expect(c.pending).toBe(true);
    expect(c.fallback).toBe(true);
  });
});

describe("the brief lint", () => {
  const ids = (text: string) => lintBrief({ text, sizes: ["9x16"], formats: ["video"] }).map((x) => `${x.id}:${x.severity}`);
  it("flags a promise the brief never pays off (a warning, never a block)", () => {
    expect(ids(unpaid)).toContain("payoff:soft");
  });
  it("is quiet when the brief says what it is", () => {
    expect(ids(paid).some((x) => x.startsWith("payoff"))).toBe(false);
  });
  it("asks for a fallback when the payoff waits on the client", () => {
    const text = `${unpaid}\n\nConfirm with client:\n- Which hack exactly, and why?`;
    expect(ids(text)).toContain("payoff-fallback:soft");
    expect(ids(text.replace("Show the hack", "Fallback: show the view from the upper deck instead.\nShow the hack")).some((x) => x.startsWith("payoff"))).toBe(false);
  });
  it("doesn't read tips in the Do list as a promise", () => {
    expect(ids("A clean product shot.\n\nHook: Roasted this morning\n\nDo:\n- Follow the barista tips in the Bible").some((x) => x.startsWith("payoff"))).toBe(false);
  });
});

describe("conceptPays (the quick preview)", () => {
  it("knows a concept that names the payoff", () => {
    expect(conceptPays("The hack: aisle rows in sections 101 to 104 drop to face value the week of the game.")).toBe(true);
    expect(conceptPays("Rows on the aisle drop to face value the week of the game; we show the seat map and the price.")).toBe(true);
  });
  it("and one that only teases it or leaves it to confirm", () => {
    expect(conceptPays("Show the hack most people miss when buying a seat.")).toBe(false);
    expect(conceptPays("A walk to the seat. Payoff to confirm with the client: which seat and why.")).toBe(false);
  });
});

describe("every writer gets the rule", () => {
  it("is in the brief's shape, with no em dashes", () => {
    expect(SPEC_RULE).toContain(PAYOFF_RULE);
    expect(PAYOFF_RULE).not.toMatch(/—/);
  });
});
