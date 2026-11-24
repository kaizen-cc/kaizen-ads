import { describe, expect, it } from "vitest";
import { ARCHIVE_LABEL, ARCHIVE_REASONS, archiveReasonFrom, archiveText, isArchiveReason, PROSPECT_STATUSES } from "@/lib/sales-core";
import { callBriefText, cleanCallBrief } from "@/lib/sales-briefs-core";

describe("archiving prospects", () => {
  it("has the owner's quick reasons, each labelled", () => {
    expect(ARCHIVE_REASONS).toEqual(["not_a_fit", "no_budget", "went_elsewhere", "no_response", "duplicate", "not_real", "other"]);
    for (const r of ARCHIVE_REASONS) expect(ARCHIVE_LABEL[r]).toBeTruthy();
    expect(isArchiveReason("lost")).toBe(false);
  });
  it("reads a reason said in plain words (the assistant asks; any answer works)", () => {
    expect(archiveReasonFrom("no_budget")).toBe("no_budget");
    expect(archiveReasonFrom("they can't afford it")).toBe("no_budget");
    expect(archiveReasonFrom("they went with another agency")).toBe("went_elsewhere");
    expect(archiveReasonFrom("ghosted us after the call")).toBe("no_response");
    expect(archiveReasonFrom("dupe of Glow Med Spa")).toBe("duplicate");
    expect(archiveReasonFrom("the business closed down")).toBe("not_real");
    expect(archiveReasonFrom("too small for paid media")).toBe("not_a_fit");
    expect(archiveReasonFrom("owner moved to Spain")).toBe("other");
    expect(archiveReasonFrom("")).toBeNull();
  });
  it("says why in one line", () => {
    expect(archiveText("no_budget", "under $1k a month")).toBe("No budget: under $1k a month");
    expect(archiveText("duplicate", null)).toBe("Duplicate");
  });
  it("lost stays a pipeline outcome, not an archive reason", () => {
    expect(PROSPECT_STATUSES).toContain("lost");
    expect(ARCHIVE_REASONS as readonly string[]).not.toContain("lost");
  });
  it("a call booked with an archived prospect still gets its brief, flagged", () => {
    const b = cleanCallBrief({ who: "A med spa" }, { archived: "previously archived 2026-11-20: No budget: under $1k a month" });
    expect(b.archived).toMatch(/previously archived/);
    expect(callBriefText("Glow", "tomorrow 10am", b)).toMatch(/Heads-up: previously archived 2026-11-20: No budget/);
    // kept on the stored brief, so the page reads it back
    expect(cleanCallBrief(JSON.parse(JSON.stringify(b))).archived).toBe(b.archived);
  });
});
