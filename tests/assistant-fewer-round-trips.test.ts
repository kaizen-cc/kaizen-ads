import { describe, expect, it } from "vitest";
import { clientDomain, gmailQueries, matchesName, parseAddresses, SEARCH_ORDER, suggestAddress } from "@/lib/assistant/recipient-core";
import { amountsIn, cleanDocument, confirmedPrices, PRICE_PLACEHOLDER } from "@/lib/documents/core";
import { HANDOVER_GAP_MS, keepsHandoverLine } from "@/lib/agent-call/core";
import { repeatKey } from "@/lib/agent-call/transcript";

describe("finding a recipient before asking", () => {
  it("looks in a fixed order: the client's contacts, all of Gmail, the client's Slack, then a pattern to confirm", () => {
    expect(SEARCH_ORDER[0]).toMatch(/client contacts/);
    expect(SEARCH_ORDER[1]).toMatch(/Gmail \(all mail: from, to and cc/);
    expect(SEARCH_ORDER[2]).toMatch(/Slack/);
    expect(SEARCH_ORDER[3]).toMatch(/pattern/);
  });

  it("searches all mail by name and by the client's domain", () => {
    const qs = gmailQueries("Jason", ["theyosttheater.com"]);
    expect(qs[0]).toBe("in:anywhere (from:\"jason\" OR to:\"jason\" OR cc:\"jason\")");
    expect(qs).toContain("in:anywhere (from:@theyosttheater.com OR to:@theyosttheater.com OR cc:@theyosttheater.com) jason");
    expect(qs.every((q) => q.startsWith("in:anywhere"))).toBe(true);
  });

  it("reads names and addresses from To and Cc lines, and matches the person", () => {
    const list = parseAddresses(`"Jaime Lopez" <jaime@theyosttheater.com>, Jason Reed <JASON@theyosttheater.com>, ops@theyosttheater.com`);
    expect(list.map((a) => a.email)).toEqual(["jaime@theyosttheater.com", "jason@theyosttheater.com", "ops@theyosttheater.com"]);
    expect(matchesName(list[1], "Jason")).toBe(true);
    expect(matchesName({ name: "", email: "jason.reed@x.com" }, "Jason Reed")).toBe(true);
    expect(matchesName({ name: "", email: "jreed@x.com" }, "Jason Reed")).toBe(true);
    expect(matchesName(list[0], "Jason")).toBe(false);
  });

  it("suggests the likely address from the client's pattern, only as a suggestion", () => {
    expect(suggestAddress("Jason", [{ name: "Jaime", email: "jaime@theyosttheater.com" }])).toEqual({ email: "jason@theyosttheater.com", why: "Jaime is jaime@theyosttheater.com, so Jason is likely jason@theyosttheater.com" });
    expect(suggestAddress("Jason Reed", [{ name: "Jaime Lopez", email: "jaime.lopez@x.com" }])?.email).toBe("jason.reed@x.com");
    expect(suggestAddress("Jason", [{ name: "", email: "info@x.com" }])).toBeNull();
    expect(clientDomain("jaime@theyosttheater.com")).toBe("theyosttheater.com");
    expect(clientDomain("someone@gmail.com")).toBeNull();
    expect(clientDomain("https://www.theyosttheater.com/tickets")).toBe("theyosttheater.com");
  });
});

describe("values the person confirms reach every document", () => {
  it("reads every way an amount is written", () => {
    expect(amountsIn("Basic is $1,000/mo and Silver $1,750, Gold 2.25k")).toEqual([1000, 1750, 2250]);
  });

  it("a price they confirmed is printed instead of a placeholder", () => {
    const said = "Yes, Basic is $1,000 a month and Silver is $1,750 a month.";
    const confirmed = confirmedPrices([{ item: "Basic", amount: 1000 }, { item: "Silver", amount: 1750 }, { item: "Gold", amount: 2250 }], said, false);
    expect(confirmed.map((p) => p.label)).toEqual(["Basic", "Silver"]);
    const { doc, placeholders } = cleanDocument(
      { kind: "sow", title: "Email management", summary: "A plan.", pricing: [{ item: "Basic", price: "$1,000", cadence: "month" }, { item: "Silver", price: "$1,750", cadence: "month" }] },
      { stored: confirmed, dataFigures: [], client: "The Yost Theater", preparedBy: "Kaizen" },
    );
    expect(placeholders).toEqual([]);
    expect(doc.pricing.every((p) => !p.placeholder && p.price !== PRICE_PLACEHOLDER)).toBe(true);
  });

  it("an amount nobody said stays a placeholder (unless an exec, who sets prices)", () => {
    expect(confirmedPrices([{ item: "Gold", amount: 2250 }], "Basic is $1,000.", false)).toEqual([]);
    expect(confirmedPrices([{ item: "Gold", amount: 2250 }], "", true)).toHaveLength(1);
  });
});

describe("no repeated lines in a conversation", () => {
  it("switching chat to call and back mid-conversation adds no 'Picking up where we left off'", () => {
    const now = Date.parse("2026-11-23T20:13:22Z");
    expect(keepsHandoverLine({ at: now - 60_000, role: "agent", content: "Both are on screen." }, now)).toBe(false);
    expect(keepsHandoverLine({ at: now - HANDOVER_GAP_MS - 1, role: "user", content: "Did you finish that?" }, now)).toBe(true);
    // Never right after another one
    expect(keepsHandoverLine({ at: now - HANDOVER_GAP_MS - 1, role: "agent", content: "Picking up where we left off: the Yost recap." }, now)).toBe(false);
    expect(keepsHandoverLine(null, now)).toBe(false);
  });

  it("the same words sent twice claim the same slot (answered once), short lines never do", () => {
    expect(repeatKey("Yeah. Did you finish that?")).toBe(repeatKey("yeah did you finish that"));
    expect(repeatKey("Yeah. Did you finish that?")).not.toBe(repeatKey("Yeah. Did you send that?"));
    expect(repeatKey("yes")).toBeNull();
    expect(repeatKey("Yeah. Did you finish that?")).toMatch(/^[0-9a-f]{16}$/);
  });
});
