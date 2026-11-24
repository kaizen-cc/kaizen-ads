import { describe, expect, it } from "vitest";
import { cleanChoice, gallery, lineOfService, monthsLeft, moveWidget, mrrByLine } from "@/lib/widgets-core";

const exec = { isExec: true, isLead: false };
const lead = { isExec: false, isLead: true };
const ic = { isExec: false, isLead: false };

describe("Overview widgets", () => {
  it("execs get finance and sales; leads the client and team ones; everyone their own", () => {
    expect(gallery(exec).map((g) => g.group)).toEqual(["Finance and sales", "Clients and performance", "You"]);
    expect(gallery(lead).map((g) => g.group)).toEqual(["Clients and performance", "You"]);
    expect(gallery(ic).flatMap((g) => g.widgets.map((w) => w.id))).toEqual(["my-targets", "my-load"]);
  });
  it("a saved choice keeps only what they may add, once each, in their order", () => {
    expect(cleanChoice(["mrr", "my-load", "nope", "my-load", "pipeline"], ic)).toEqual(["my-load"]);
    expect(cleanChoice(["pipeline", "mrr"], exec)).toEqual(["pipeline", "mrr"]);
    expect(cleanChoice("junk", exec)).toEqual([]);
  });
  it("reorders one place at a time", () => {
    expect(moveWidget(["mrr", "pipeline", "spend"], "spend", -1)).toEqual(["mrr", "spend", "pipeline"]);
    expect(moveWidget(["mrr", "pipeline"], "mrr", -1)).toEqual(["mrr", "pipeline"]);
  });
  it("revenue by line from billed services", () => {
    expect(lineOfService("facebook-ads")).toBe("Meta");
    expect(lineOfService("email-marketing")).toBe("Email");
    const r = mrrByLine([{ billed_services: { "google-ads": { amount: 875 }, "facebook-ads": { amount: 875 }, "email-marketing": { amount: 750 } } }, { billed_services: { "facebook-ads": { amount: 1000 } } }, { billed_services: null }]);
    expect(r.total).toBe(3500);
    expect(r.lines[0]).toEqual(["Meta", 1875]);
  });
  it("months left to collect this month and quarter", () => {
    const m = monthsLeft(new Date("2026-11-16T17:00:00Z"));
    expect(m.month).toBeCloseTo(15 / 30, 5);
    expect(m.quarter).toBeCloseTo(15 / 30 + 1, 5);
  });
});
