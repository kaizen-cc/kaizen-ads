import { describe, expect, it } from "vitest";
import { normAsset, waiverFor, waiversBlock } from "@/lib/asset-waivers-core";
import { assetGate } from "@/lib/brief-assets";

describe("asset waivers", () => {
  const waived = [
    { label: "drone footage", how: "waived" as const },
    { label: "Lifestyle photos of customers", how: "unavailable" as const },
  ];
  it("matches the same asset asked for in other words", () => {
    expect(waiverFor("Drone footage of the venue", waived)?.how).toBe("waived");
    expect(waiverFor("Client to shoot: lifestyle photo of a customer", waived)?.how).toBe("unavailable");
    expect(waiverFor("Product shots on white", waived)).toBeNull();
  });
  it("keys a waiver by its words", () => {
    expect(normAsset("Drone Footage!")).toBe(normAsset("footage, drone"));
  });
  it("tells the writer never to ask", () => {
    expect(waiversBlock([])).toBe("");
    expect(waiversBlock(waived)).toContain("- drone footage (waived)");
  });
  it("never chases a waived asset in the brief's asset check", () => {
    const g = assetGate({
      assets: [
        { item: "Drone footage of the venue", status: "need" },
        { item: "Owner interview", status: "shoot" },
      ] as never,
      links: [],
      formats: ["image"],
      drive: { videos: 0, images: 3, matching: 0 },
      due: null,
      today: new Date("2026-11-20T12:00:00Z"),
      waived,
    });
    expect(g.items.find((x) => x.label.startsWith("Drone"))?.status).toBe("waived");
    expect(g.waiting.map((x) => x.label)).toEqual(["Owner interview"]);
  });
});
