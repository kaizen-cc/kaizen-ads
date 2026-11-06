import { describe, expect, it } from "vitest";
import { applyMarks, bucketKey, bucketsOf, countLooks, hideKeyOf, lookChip, lookHeadline, openOf, recapKeysOf, rowStat, topicGroups, withLooks } from "@/lib/today-counts";
import type { Tier, TodayItem, TopicKey } from "@/lib/today";

const tierOf = (score: number): Tier => (score >= 80 ? "critical" : score >= 60 ? "high" : "normal");
let n = 0;
const item = (topic: TopicKey, client: string, score: number, stat = { value: "1", label: "thing" }): TodayItem => ({
  key: `${topic}:${++n}`,
  topic,
  tier: tierOf(score),
  score,
  client,
  clientSlug: "",
  clientId: null,
  stat,
  title: `${client} ${n}`,
  story: "",
  why: "",
  evidence: [],
  action: { label: "Open", href: "#" },
  state: "new",
  carried: false,
});

describe("the recap's counting (one row per client, per topic)", () => {
  it("gathers a client by name, whatever the spacing or case, and items without a client as one Team row", () => {
    expect(bucketKey({ client: "  Granite  Plus " })).toBe(bucketKey({ client: "granite plus" }));
    const bs = bucketsOf([item("promises", "Team", 84), item("promises", "Granite Plus", 70), item("promises", "team", 90), item("promises", "granite plus", 95)]);
    expect(bs.map((b) => [b.client, b.items.length])).toEqual([
      ["granite plus", 2],
      ["team", 2],
    ]);
  });

  it("makes a client's row as urgent as its most urgent item, and leads with it", () => {
    const [b] = bucketsOf([item("accounts", "Nectr", 50), item("accounts", "Nectr", 85), item("accounts", "Nectr", 65)]);
    expect(b.tier).toBe("critical");
    expect(b.items.map((i) => i.score)).toEqual([85, 65, 50]);
  });

  it("counts 30 waiting-on-us items from 17 clients as 17, and the total is the sum of the topics", () => {
    const items: TodayItem[] = [];
    for (let c = 0; c < 17; c++) items.push(item("promises", `Client ${c}`, c < 3 ? 90 : 70));
    for (let c = 0; c < 13; c++) items.push(item("promises", `Client ${c}`, 50));
    items.push(item("accounts", "Client 0", 62), item("accounts", "Client 0", 81), item("ads", "Other", 46));
    const looks = countLooks(items);
    expect(looks.byTopic.promises).toEqual({ n: 17, critical: 3 });
    expect(looks.byTopic.accounts).toEqual({ n: 1, critical: 1 });
    expect(looks.byTopic.ads).toEqual({ n: 1, critical: 0 });
    expect(looks.byTopic.briefs).toEqual({ n: 0, critical: 0 });
    expect(looks.total).toBe(19);
    expect(looks.total).toBe(Object.values(looks.byTopic).reduce((s, t) => s + t.n, 0));
    expect(looks.byTier).toEqual({ critical: 4, high: 14, normal: 1 });
    expect(looks.byTier.critical + looks.byTier.high + looks.byTier.normal).toBe(looks.total);
  });

  it("orders topics most critical first, as the recap plays them", () => {
    const gs = topicGroups([item("briefs", "A", 52), item("promises", "B", 95), item("accounts", "C", 70)]);
    expect(gs.map((g) => g.topic)).toEqual(["promises", "accounts", "briefs"]);
  });

  it("works out the counts for a snapshot saved before they were kept", () => {
    const old = { items: [item("promises", "A", 90), item("promises", "a", 70)], resolved: [] };
    expect(withLooks(old).looks.total).toBe(1);
    const kept = { ...old, looks: countLooks([]) };
    expect(withLooks(kept).looks.total).toBe(0);
  });

  it("says the same number the same way on the recap and on the Overview", () => {
    expect(lookHeadline("promises", 17)).toBe("17 things are waiting on us: promised, said yes to, or not answered");
    expect(lookChip("promises", 17)).toBe("17 waiting on us");
    expect(lookHeadline("allotments", 1)).toBe("1 client is behind on creative");
    expect(lookChip("accounts", 2)).toBe("2 clients with accounts off or near target");
    for (const t of ["mine", "promises", "onboarding", "accounts", "work", "briefs", "ads", "allotments"] as TopicKey[]) {
      expect(lookHeadline(t, 4).startsWith("4 ")).toBe(true);
      expect(lookChip(t, 4).startsWith("4 ")).toBe(true);
      expect(lookHeadline(t, 4) + lookChip(t, 4)).not.toMatch(/—/);
    }
  });
});

describe("one done, read in both places", () => {
  it("maps each recap key to the Overview's key for the same item, and back", () => {
    expect(hideKeyOf("owed2:abc")).toBe("owed:abc");
    expect(hideKeyOf("said-lead:abc")).toBe("said:abc");
    expect(hideKeyOf("promise:c1")).toBe("call:c1");
    expect(hideKeyOf("attention:a1")).toBe("alert:a1");
    expect(hideKeyOf("kpi:t1")).toBeNull();
    expect(recapKeysOf("call:c1")).toEqual(["promise:c1"]);
    expect(recapKeysOf("alert:a1")).toEqual(["attention:a1"]);
    expect(recapKeysOf("owed-lead:x")).toEqual(["owed:x", "owed2:x", "owed-lead:x"]);
    expect(recapKeysOf("fatigue:c:ad")).toEqual(["fatigue:c:ad"]);
  });

  it("drops what's done, set aside or cleared off the Overview from a saved review, shows what's saved, and recounts", () => {
    const a = { ...item("promises", "Acme", 90), key: "promise:p1" };
    const b = { ...item("promises", "Bolt", 85), key: "owed-lead:o1" };
    const c = { ...item("ads", "Crust", 46), key: "fatigue:c:ad1" };
    const d = { ...item("work", "Dune", 66), key: "attention:a1" };
    const t = { items: [a, b, c, d], looks: countLooks([a, b, c, d]) };
    const out = applyMarks(t, new Map([["fatigue:c:ad1", "dismissed"], ["attention:a1", "saved"]]), new Set(["call:p1"]));
    expect(out.items.map((i) => i.key)).toEqual(["owed-lead:o1", "attention:a1"]);
    expect(out.items[1].state).toBe("saved");
    expect(out.looks.total).toBe(2);
    expect(applyMarks(t, new Map(), new Set())).toBe(t);
  });
});

describe("a client's row and its overview", () => {
  it("shows how many are open as the big number when there are several, and the item's own when there's one", () => {
    const late = item("promises", "Granite-Plus", 92, { value: "7", label: "business days past when it was due" });
    const other = item("promises", "Granite-Plus", 80, { value: "2", label: "business days without a reply" });
    const [b] = bucketsOf([other, late]);
    const open = openOf(b.items, {});
    expect(open).toHaveLength(2);
    expect(rowStat(open, b.items[0])).toEqual({ value: "2", label: "open · top: 7 business days past when it was due" });
    // One handled: the row and the overview both count the one still open, and it shows its own number
    const marks = { [late.key]: "done" };
    const left = openOf(b.items, marks);
    expect(left.map((i) => i.key)).toEqual([other.key]);
    expect(rowStat(left, b.items[0])).toEqual(other.stat);
    // Saved for later is still open; set aside is not
    expect(openOf(b.items, { [late.key]: "saved", [other.key]: "dismissed" }).map((i) => i.key)).toEqual([late.key]);
  });
});
