import { describe, expect, it } from "vitest";
import { clientProgress, readyForClient, reworkAds } from "@/lib/partial-approval";

describe("readyForClient", () => {
  it("shows a ticket with approved copy and designs", () => {
    expect(readyForClient("client_review", true, { status: "approved" })).toBe(true);
  });
  it("shows a ticket with no copy set of its own (the angle's copy lives on another ticket)", () => {
    expect(readyForClient("client_review", true, null)).toBe(true);
  });
  it("holds a ticket whose copy is still being written", () => {
    expect(readyForClient("client_review", true, { status: "drafting" })).toBe(false);
  });
  it("holds a ticket with nothing to look at, or not waiting on the client", () => {
    expect(readyForClient("client_review", false, { status: "approved" })).toBe(false);
    expect(readyForClient("client_revision", true, { status: "approved" })).toBe(false);
  });
});

describe("reworkAds", () => {
  const a = { primaryText: "Fresh, hand cut", headline: "Build your box", linkDescription: "Ships free" };
  const b = { primaryText: "Rewritten after the client's note", headline: "Pick your fish", linkDescription: "" };
  it("launches only the rewritten ads on a copy-only rework", () => {
    expect(reworkAds([a, b], [a])).toEqual([b]);
  });
  it("ignores case and stray spaces when matching what already went out", () => {
    expect(reworkAds([{ ...a, headline: " build YOUR box " }], [a])).toEqual([]);
  });
  it("keeps everything when nothing went ahead", () => {
    expect(reworkAds([a, b], [])).toEqual([a, b]);
  });
});

describe("clientProgress", () => {
  it("says how many the client approved when they approved some (single image, carousel or video alike)", () => {
    expect(clientProgress([{ client_status: "approved" }, { client_status: "approved" }, { client_status: "changes" }], [])).toBe("2 of 3 approved by the client");
  });
  it("says where the approved part went once it split off", () => {
    expect(clientProgress([{ client_status: "changes" }], [412])).toBe("Approved part went ahead as #412");
  });
  it("says nothing before the client decides, or when everything was approved", () => {
    expect(clientProgress([{ client_status: null }, { client_status: null }], [])).toBeNull();
    expect(clientProgress([{ client_status: "approved" }], [])).toBeNull();
  });
  it("says the client sent everything back", () => {
    expect(clientProgress([{ client_status: "changes" }, { client_status: "changes" }], [])).toBe("2 sent back by the client");
  });
});
