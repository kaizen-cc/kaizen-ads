import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { clientOfTask } from "@/lib/asana-person";

describe("a person's own Asana tasks (Nov 25 2026)", () => {
  const clients = [
    { id: "shupe", name: "Shupe Legal" },
    { id: "ob", name: "OceanBox" },
    { id: "x", name: "Ace" },
  ];
  it("finds the client from the project, else the task's own name; never a short name inside a word", () => {
    expect(clientOfTask({ name: "[Slack 11/24] Send registrations to Oscar", projects: ["Shupe Legal [474] - WHITELABEL"] }, clients)).toBe("shupe");
    expect(clientOfTask({ name: "[Call 11/24] Oceanbox BFCM offer check", projects: [] }, clients)).toBe("ob");
    expect(clientOfTask({ name: "Replace the old deck", projects: [] }, clients)).toBeNull();
  });
});
