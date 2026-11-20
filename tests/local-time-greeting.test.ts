import { describe, expect, it } from "vitest";
import { AFTER_HOURS_GREETINGS, dayPartOf, greetingFor, isAfterHours, localDayIn, localHourIn, timeZoneOf } from "@/lib/agent-call/core";
import { assistantGreeting } from "@/lib/assistant/core";

const memory = [{ id: "m1", kind: "fact", topic: "role", body: "Runs the agency", on_date: null, follow_up_on: null, followed_up_at: null }] as unknown as Parameters<typeof assistantGreeting>[0]["memory"];

describe("greeting by the person's own time zone", () => {
  // 01:13 UTC on Nov 20 is 8:13pm on Nov 19 in New York, 5:13pm in Los Angeles
  const now = new Date("2026-11-20T01:13:00Z");

  it("reads the hour and day where they are, falling back to New York", () => {
    expect(localHourIn("America/New_York", now)).toBe(20);
    expect(localHourIn("America/Los_Angeles", now)).toBe(17);
    expect(localHourIn("Europe/London", now)).toBe(1);
    expect(localHourIn("Not/AZone", now)).toBe(20);
    expect(localHourIn(null, now)).toBe(20);
    expect(localDayIn("America/New_York", now)).toBe("2026-11-19");
    expect(localDayIn("Europe/London", now)).toBe("2026-11-20");
    expect(timeZoneOf("Bogus")).toBe("America/New_York");
    expect(timeZoneOf("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("knows work hours and the part of the day", () => {
    expect(isAfterHours(9)).toBe(false);
    expect(isAfterHours(17)).toBe(false);
    expect(isAfterHours(18)).toBe(true);
    expect(isAfterHours(6)).toBe(true);
    expect(dayPartOf(8)).toBe("morning");
    expect(dayPartOf(14)).toBe("afternoon");
    expect(dayPartOf(20)).toBe("evening");
    expect(dayPartOf(2)).toBe("late");
  });

  it("keeps the standard greeting in the afternoon and says good morning before noon", () => {
    expect(greetingFor("Kyle Smith", "Media Buyer", "fresh", null, 0, 14)).toBe("Hey Kyle, it's the Media Buyer. What can I help you with?");
    expect(greetingFor("Kyle Smith", "Media Buyer", "fresh", null, 0, 9)).toBe("Good morning, Kyle! It's the Media Buyer. What can I help you with?");
    // No hour known: as before
    expect(greetingFor("Kyle Smith", "Media Buyer")).toBe("Hey Kyle, it's the Media Buyer. What can I help you with?");
  });

  it("after hours, picks from many playful lines that fit the hour", () => {
    for (const lines of Object.values(AFTER_HOURS_GREETINGS)) expect(lines.length).toBeGreaterThanOrEqual(5);
    const evening = new Set(Array.from({ length: 20 }, (_, s) => greetingFor("Santi Lozano", "Assistant", "fresh", null, s, 20)));
    expect(evening.size).toBeGreaterThanOrEqual(5);
    for (const g of evening) {
      expect(g).toMatch(/Santi/);
      expect(g).not.toMatch(/\{name\}|\{label\}|[—–]/);
      expect(AFTER_HOURS_GREETINGS.evening.map((l) => l.replace("{name}", "Santi"))).toContain(g);
    }
    expect(greetingFor("Santi Lozano", "Assistant", "fresh", null, 0, 20)).toMatch(/^Good evening, Santi! Was just taking a little rest/);
    expect(AFTER_HOURS_GREETINGS.late.map((l) => l.replace("{name}", "Santi"))).toContain(greetingFor("Santi Lozano", "Assistant", "fresh", null, 3, 1));
    expect(AFTER_HOURS_GREETINGS.morning.map((l) => l.replace("{name}", "Santi"))).toContain(greetingFor("Santi Lozano", "Assistant", "fresh", null, 2, 6));
  });

  it("a call back after hours nods to the hour; a cut-off or a topic stays as it was", () => {
    expect(greetingFor("Santi Lozano", "Assistant", "soon", null, 0, 20)).toBe("Hey again, Santi! Still at it? What's up?");
    expect(greetingFor("Santi Lozano", "Assistant", "soon", "the report", 0, 20)).toMatch(/the report/);
    expect(greetingFor("Santi Lozano", "Assistant", "continue", null, 0, 20)).toMatch(/^Sorry Santi, we got cut off/);
    expect(greetingFor("Santi Lozano", "Assistant", "again", null, 0, 20)).toBe("Hey again, Santi! What's up?");
  });

  it("the assistant's fresh hello goes playful after hours, never a day's rundown past midnight", () => {
    const evening = new Set(Array.from({ length: 12 }, (_, s) => assistantGreeting({ name: "Santi", memory, today: "2026-11-19", mode: "fresh", hour: 20, seed: s }).text));
    expect([...evening].some((t) => /didn't expect you|rest|feet up|winding down/i.test(t))).toBe(true);
    for (let s = 0; s < 8; s++) {
      const t = assistantGreeting({ name: "Santi", memory, today: "2026-11-19", mode: "fresh", hour: 1, seed: s }).text;
      expect(t).not.toMatch(/rundown|plan the day|morning/i);
    }
    for (let s = 0; s < 8; s++) {
      const t = assistantGreeting({ name: "Santi", memory, today: "2026-11-19", mode: "fresh", hour: 14, seed: s }).text;
      expect(Object.values(AFTER_HOURS_GREETINGS).flat().map((l) => l.replace("{name}", "Santi"))).not.toContain(t);
    }
  });
});
