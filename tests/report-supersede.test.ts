import { describe, expect, it } from "vitest";
import { supersededBy, supersedeEntry, type Rep } from "@/lib/reports/supersede";
import { reasonLabel } from "@/lib/reports/skip-log";

// Once a newer report exists for the same client, service and cadence, the older unsent one is cleared (skipped, never
// deleted); sent ones are never touched, and another service's or cadence's report doesn't count.
const r = (id: string, end: string, status = "draft", o: Partial<Rep> = {}): Rep => ({ id, client_id: "c1", platform: "meta", kind: "weekly", target_id: "t1", period_start: end.replace(/\d\d$/, "01"), period_end: end, status, ...o });

describe("an older unsent report a newer one replaced", () => {
  it("is cleared, pointing at the newest one", () => {
    const out = supersededBy([r("oct", "2026-10-25"), r("nov9", "2026-11-15", "submitted"), r("nov16", "2026-11-22")]);
    expect(out.map((x) => [x.old.id, x.by.id])).toEqual([["oct", "nov16"], ["nov9", "nov16"]]);
  });
  it("never a sent one, the newest itself, or one being written", () => {
    const out = supersededBy([r("sent", "2026-10-25", "posted"), r("writing", "2026-11-01", "drafting"), r("skipped", "2026-11-08", "skipped"), r("new", "2026-11-22")]);
    expect(out).toEqual([]);
  });
  it("only within the same client, service, cadence and account", () => {
    const out = supersededBy([
      r("meta", "2026-10-25"),
      r("google", "2026-11-22", "draft", { platform: "google" }),
      r("monthly", "2026-11-30", "draft", { kind: "monthly" }),
      r("other", "2026-11-22", "draft", { client_id: "c2" }),
      r("built", "2026-11-22", "draft", { kind: "built" }),
    ]);
    expect(out).toEqual([]);
  });
  it("a newer report that was itself skipped still replaces it", () => {
    expect(supersededBy([r("old", "2026-10-25"), r("newer", "2026-11-22", "skipped")]).map((x) => x.old.id)).toEqual(["old"]);
  });
  it("says why on its log", () => {
    const e = supersedeEntry(r("nov16", "2026-11-22"), "2026-11-24T12:00:00Z");
    expect(e).toMatchObject({ action: "skipped", reason: "superseded", byName: "Kaizen OS" });
    expect(e.note).toMatch(/^Superseded by the .*Nov.*22.* report$/);
    expect(reasonLabel("superseded")).toBe("Superseded by a newer report");
  });
});
