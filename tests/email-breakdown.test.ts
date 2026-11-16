import { describe, expect, it } from "vitest";
import { campaignRows, campaignsFor, flowRows, rateTone, sortFlows, type BFlow } from "@/lib/email-breakdown";

const c = (id: string, sendTime: string | null, channel = "email", recipients = 100, revenue = 10) => ({ id, name: id, channel, sendTime, recipients, openRate: 0.3, clickRate: 0.01, revenue });
const f = (id: string, o: Partial<BFlow> = {}): BFlow => ({ id, name: id, status: "live", recipients30: 100, openRate30: 0.4, clickRate30: 0.02, revenue30: 50, recipients90: 300, openRate90: 0.4, clickRate90: 0.02, revenue90: 150, ...o });

describe("campaign tabs", () => {
  const rows = campaignRows([c("a", "2026-11-01T10:00:00Z"), c("b", "2026-11-05T10:00:00Z", "sms"), c("draft", null), c("empty", "2026-11-06T10:00:00Z", "email", 0)]);
  it("drops unsent rows and orders newest first", () => expect(rows.map((r) => r.id)).toEqual(["b", "a"]));
  it("splits email and sms", () => {
    expect(campaignsFor(rows, "email").map((r) => r.id)).toEqual(["a"]);
    expect(campaignsFor(rows, "sms").map((r) => r.id)).toEqual(["b"]);
  });
  it("last 10 is the ten newest", () => {
    const many = campaignRows(Array.from({ length: 14 }, (_, i) => c(`c${i}`, `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00Z`)));
    expect(campaignsFor(many, "last10")).toHaveLength(10);
    expect(campaignsFor(many, "last10")[0].id).toBe("c13");
    expect(campaignsFor(many, "all")).toHaveLength(14);
  });
});

describe("rateTone", () => {
  it("colours against the bar", () => {
    expect(rateTone(0.3, 0.3)).toBe("ok");
    expect(rateTone(0.25, 0.3)).toBe("warn");
    expect(rateTone(0.1, 0.3)).toBe("bad");
    expect(rateTone(null, 0.3)).toBeNull();
  });
});

describe("flows", () => {
  it("keeps live flows only", () => expect(flowRows([f("a"), f("b", { status: "draft" })]).map((x) => x.id)).toEqual(["a"]));
  it("defaults to least performing first: lowest RPR, ties by click rate", () => {
    const list = [f("good", { revenue30: 500 }), f("lowclick", { revenue30: 10, clickRate30: 0.001 }), f("low", { revenue30: 10, clickRate30: 0.02 })];
    expect(sortFlows(list, null, "asc", 30).map((x) => x.id)).toEqual(["lowclick", "low", "good"]);
  });
  it("sorts a column both ways and keeps flows with nothing to rank last", () => {
    const list = [f("a", { recipients30: 50 }), f("b", { recipients30: 500 }), f("none", { recipients30: 0, revenue30: 0 })];
    expect(sortFlows(list, "rpr", "desc", 30).at(-1)?.id).toBe("none");
    expect(sortFlows(list, "recipients", "asc", 30).map((x) => x.id)).toEqual(["none", "a", "b"]);
    expect(sortFlows(list, "recipients", "desc", 30).map((x) => x.id)).toEqual(["b", "a", "none"]);
  });
  it("reads the 90 day window", () => {
    const list = [f("a", { revenue90: 900 }), f("b", { revenue90: 30 })];
    expect(sortFlows(list, null, "asc", 90).map((x) => x.id)).toEqual(["b", "a"]);
  });
});
