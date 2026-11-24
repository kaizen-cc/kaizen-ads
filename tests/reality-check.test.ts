import { describe, expect, it } from "vitest";
import { decide, keyWords, likeness, realityLine, sameWork, type Existing } from "@/lib/reality-check-core";

const ex = (o: Partial<Existing>): Existing => ({ source: "item", id: "e1", title: "Launch the BFCM ad set", clientId: "c1", ownerId: "p1", owner: "The Meta buyer", open: true, href: "/pipeline", at: "2026-11-20T10:00:00Z", ...o });

describe("dedupe against reality (Nov 24 2026)", () => {
  it("reads what the work is, not the filler", () => {
    expect(keyWords("[Call 11/20] Please send the BFCM warm-up email to Jordan")).toEqual(expect.arrayContaining(["bfcm", "warm", "jordan"]));
    expect(keyWords("Please send it today")).toEqual([]);
  });
  it("the same work, said differently, matches; different work doesn't", () => {
    expect(likeness("Launch BFCM ad set", "[Slack 11/21] Launch the BFCM ad set on Meta")).toBeGreaterThanOrEqual(0.6);
    expect(likeness("Launch BFCM ad set", "Fix the Klaviyo to Meta re-authentication")).toBeLessThan(0.6);
  });
  it("another client's work is never the same work", () => {
    expect(sameWork({ title: "Launch the BFCM ad set", clientId: "c2" }, ex({}))).toBe(false);
    expect(sameWork({ title: "Launch the BFCM ad set", clientId: "c1" }, ex({}))).toBe(true);
  });
  it("in motion links the open item and who's on it; done when only a closed one matches; else new", () => {
    const motion = decide({ title: "BFCM ad set launch", clientId: "c1" }, [ex({})]);
    expect(motion.state).toBe("in_motion");
    expect(realityLine(motion)).toContain("The Meta buyer is on it");
    const done = decide({ title: "BFCM ad set launch", clientId: "c1" }, [ex({ open: false })]);
    expect(done.state).toBe("done");
    expect(realityLine(done)).toMatch(/^Already done/);
    expect(decide({ title: "Write the case study", clientId: "c1" }, [ex({})]).state).toBe("new");
  });
  it("an open match wins over an older closed one (it came back)", () => {
    expect(decide({ title: "BFCM ad set launch", clientId: "c1" }, [ex({ open: false, id: "old" }), ex({ id: "new" })]).match?.id).toBe("new");
  });
});
