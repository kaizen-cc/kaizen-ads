import { describe, expect, it } from "vitest";
import { channelMaySee } from "@/lib/kaizen-ai/channel-access";
import { QUICK_ACTIONS, groupsFor } from "@/lib/kaizen-ai/agents";

const open = { archived: false, services: ["email-marketing"], seatHolders: [] as string[] };

describe("channelMaySee", () => {
  it("lets the head of a line see clients with that service", () => {
    expect(channelMaySee({ id: "a", role: "head_of_email" }, open)).toBe(true);
    expect(channelMaySee({ id: "a", role: "head_of_social" }, open)).toBe(false);
    expect(channelMaySee({ id: "a", role: "head_of_social" }, { ...open, services: ["social-media"] })).toBe(true);
  });
  it("lets others see only clients they hold a seat on", () => {
    expect(channelMaySee({ id: "a", role: "email_strategist" }, open)).toBe(false);
    expect(channelMaySee({ id: "a", role: "email_strategist" }, { ...open, seatHolders: ["b", "a"] })).toBe(true);
  });
  it("hides an archived client from a head but not from their own seat holder", () => {
    expect(channelMaySee({ id: "a", role: "head_of_email" }, { ...open, archived: true })).toBe(false);
    expect(channelMaySee({ id: "a", role: "social_media_manager" }, { archived: true, services: [], seatHolders: ["a"] })).toBe(true);
  });
});

describe("starter prompts", () => {
  it("give the email and social teams their own line, never ads ones", () => {
    for (const [role, group] of [["email_builder", "email"], ["head_of_social", "social"]] as const) {
      const groups = groupsFor(role);
      expect(groups[0]).toBe(group);
      const shown = QUICK_ACTIONS.filter((a) => groups.includes(a.group));
      expect(shown.some((a) => a.group === "buyer" || a.group === "google")).toBe(false);
      expect(shown.filter((a) => a.group === group).length).toBeGreaterThanOrEqual(4);
    }
  });
});
