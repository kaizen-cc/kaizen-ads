import { describe, expect, it } from "vitest";
import { LINES, lineOfRole, parseLine, summarizeLines } from "@/lib/agent-lines";
import { OFFLINE_ROLE_OF } from "@/lib/ai";
import { ROLE_SKILLS, SHIPS_OFFLINE, canTrainAgent, offlineRoleOfSkill, roleOfAgent } from "@/lib/agent-access";

const roles = [
  { key: "strategist" }, { key: "market_analyst" }, { key: "account_manager" },
  { key: "media_buyer" }, { key: "google_buyer" }, { key: "tiktok_buyer", offline: true },
  { key: "email_strategist", offline: true }, { key: "email_creative", offline: true }, { key: "email_builder", offline: true },
  { key: "creative_director" }, { key: "copywriter" },
];

describe("lineOfRole", () => {
  it("maps every role agent to its service line", () => {
    expect(lineOfRole("strategist")).toBe("strategy");
    expect(lineOfRole("market_analyst")).toBe("strategy");
    expect(lineOfRole("account_manager")).toBe("strategy");
    expect(lineOfRole("media_buyer")).toBe("meta");
    expect(lineOfRole("google_buyer")).toBe("google");
    expect(lineOfRole("tiktok_buyer")).toBe("tiktok");
    for (const r of ["email_strategist", "email_creative", "email_builder"]) expect(lineOfRole(r)).toBe("email");
    expect(lineOfRole("creative_director")).toBe("creative");
    expect(lineOfRole("copywriter")).toBe("copy");
  });
  it("puts an unknown role with the whole team", () => {
    expect(lineOfRole("something_new")).toBe("strategy");
    expect(lineOfRole(null)).toBe("strategy");
  });
  it("gives every role agent in ROLE_SKILLS a line", () => {
    for (const r of Object.keys(ROLE_SKILLS)) expect(LINES.map((l) => l.key)).toContain(lineOfRole(r));
  });
  it("reads a line from the URL", () => {
    expect(parseLine("email")).toBe("email");
    expect(parseLine("nope")).toBeNull();
    expect(parseLine(null)).toBeNull();
  });
});

describe("summarizeLines", () => {
  const by = Object.fromEntries(summarizeLines(roles).map((l) => [l.key, l]));
  it("counts online and parked per line", () => {
    expect(by.email).toMatchObject({ agents: 3, online: 0, parked: 3 });
    expect(by.tiktok).toMatchObject({ agents: 1, online: 0, parked: 1 });
    expect(by.meta).toMatchObject({ agents: 1, online: 1, parked: 0 });
    expect(by.strategy).toMatchObject({ agents: 3, online: 3, parked: 0 });
  });
  it("hides a line with no agents (a head sees only theirs)", () => {
    expect(summarizeLines([{ key: "google_buyer" }]).map((l) => l.key)).toEqual(["google"]);
  });
});

describe("the email agents", () => {
  it("have their skills, owned by the right role", () => {
    expect(ROLE_SKILLS.email_strategist).toEqual(["email_calendar", "email_audit"]);
    expect(roleOfAgent("email_flow_build")).toBe("email_builder");
  });
  it("are execs only to train for now", () => {
    expect(canTrainAgent({ role: "executive", isExec: true }, "email_copy")).toBe(true);
    for (const role of ["head_of_meta", "head_of_google", "head_of_creative"]) expect(canTrainAgent({ role, isExec: false }, "email_strategist")).toBe(false);
  });
  it("are offline: every email skill resolves to a parked role, so no AI path calls it", () => {
    for (const role of ["email_strategist", "email_creative", "email_builder"]) {
      expect(SHIPS_OFFLINE).toContain(role);
      for (const s of ROLE_SKILLS[role]) {
        expect(offlineRoleOfSkill(s)).toBe(role);
        expect(OFFLINE_ROLE_OF[s]).toBe(role);
      }
    }
    expect(OFFLINE_ROLE_OF.tiktok_auditor).toBe("tiktok_buyer");
    expect(OFFLINE_ROLE_OF.auditor).toBeUndefined();
  });
});
