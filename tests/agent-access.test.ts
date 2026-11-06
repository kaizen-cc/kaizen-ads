import { describe, expect, it } from "vitest";
import { canTrainAgent, describeChange, isHeadTrainer, roleOfAgent, ROLE_SKILLS, trainableRoles } from "@/lib/agent-access";

const exec = { role: "executive", isExec: true };
const meta = { role: "head_of_meta", isExec: false };
const google = { role: "head_of_google", isExec: false };
const creative = { role: "head_of_creative", isExec: false };

describe("canTrainAgent", () => {
  it("lets executives train every agent, skill and shared item", () => {
    for (const [role, skills] of Object.entries(ROLE_SKILLS)) {
      expect(canTrainAgent(exec, role)).toBe(true);
      for (const s of skills) expect(canTrainAgent(exec, s)).toBe(true);
    }
    expect(canTrainAgent(exec, null)).toBe(true);
    expect(canTrainAgent(exec, "coach")).toBe(true);
  });

  it("an executive with a head's position still trains everything", () => {
    expect(canTrainAgent({ role: "head_of_meta", isExec: true }, "copy")).toBe(true);
  });

  it("the Head of Meta trains the Media Buyer and its skills only", () => {
    expect(canTrainAgent(meta, "media_buyer")).toBe(true);
    for (const s of ["auditor", "launcher", "fatigue", "reporter", "report_qa"]) expect(canTrainAgent(meta, s)).toBe(true);
    for (const s of ["google_buyer", "google_auditor", "google_launcher", "google_reporter", "creative_director", "creativereview", "copy", "strategist", "suggest", "account_manager", "briefing"]) expect(canTrainAgent(meta, s)).toBe(false);
  });

  it("the Head of Google trains the Google Ads Buyer and its skills only", () => {
    expect(canTrainAgent(google, "google_buyer")).toBe(true);
    for (const s of ["google_auditor", "google_launcher", "google_reporter"]) expect(canTrainAgent(google, s)).toBe(true);
    for (const s of ["media_buyer", "auditor", "reporter", "report_qa", "creativereview", "scripts"]) expect(canTrainAgent(google, s)).toBe(false);
  });

  it("the Head of Creative trains the Creative Director only, not the Copywriter", () => {
    expect(canTrainAgent(creative, "creative_director")).toBe(true);
    for (const s of ["creativereview", "creativecheck", "review"]) expect(canTrainAgent(creative, s)).toBe(true);
    for (const s of ["copywriter", "copy", "scripts", "media_buyer", "auditor", "google_auditor"]) expect(canTrainAgent(creative, s)).toBe(false);
  });

  it("reads a knowledge target's role:<key>", () => {
    expect(canTrainAgent(google, "role:google_buyer")).toBe(true);
    expect(canTrainAgent(google, "role:media_buyer")).toBe(false);
  });

  it("keeps shared items, unknown agents and the strategy with executives", () => {
    for (const head of [meta, google, creative]) {
      expect(canTrainAgent(head, null)).toBe(false);
      expect(canTrainAgent(head, undefined)).toBe(false);
      expect(canTrainAgent(head, "")).toBe(false);
      expect(canTrainAgent(head, "coach")).toBe(false);
      expect(canTrainAgent(head, "spine")).toBe(false);
    }
  });

  it("gives everyone else nothing", () => {
    for (const role of ["media_buyer", "google_buyer", "graphic_designer", "video_editor", "copywriter", "customer_success", "lead_graphic_designer"]) {
      expect(trainableRoles({ role, isExec: false })).toEqual([]);
      expect(canTrainAgent({ role, isExec: false }, "media_buyer")).toBe(false);
      expect(canTrainAgent({ role, isExec: false }, "copy")).toBe(false);
      expect(isHeadTrainer({ role, isExec: false })).toBe(false);
    }
    expect(canTrainAgent({ role: null }, "auditor")).toBe(false);
  });

  it("marks heads (not executives) as head trainers", () => {
    expect(isHeadTrainer(meta)).toBe(true);
    expect(isHeadTrainer(exec)).toBe(false);
  });
});

describe("roleOfAgent", () => {
  it("maps skills, roles and role:<key> to their role agent", () => {
    expect(roleOfAgent("report_qa")).toBe("media_buyer");
    expect(roleOfAgent("google_reporter")).toBe("google_buyer");
    expect(roleOfAgent("creativecheck")).toBe("creative_director");
    expect(roleOfAgent("scripts")).toBe("copywriter");
    expect(roleOfAgent("copywriter")).toBe("copywriter");
    expect(roleOfAgent("role:strategist")).toBe("strategist");
    expect(roleOfAgent("coach")).toBeNull();
    expect(roleOfAgent(null)).toBeNull();
  });
});

describe("describeChange", () => {
  const base = { who: "Head of Google", roleLabel: "Google Ads Buyer", skillLabel: "Google account audit" };
  it("names the head, the agent and the skill", () => {
    expect(describeChange({ ...base, record: "agent:google_auditor", before: { instructions: "a", model: "opus", effort: "high" }, after: { instructions: "b", model: "opus", effort: "high" } })).toBe("Head of Google updated the Google Ads Buyer's Google account audit skill's instructions");
    expect(describeChange({ ...base, record: "role:google_buyer", skillLabel: null, before: { core: "a" }, after: { core: "b" } })).toBe("Head of Google updated the Google Ads Buyer's core");
  });
  it("says what happened to an item", () => {
    expect(describeChange({ ...base, record: "item:1", before: null, after: { title: "IS rule", active: true } })).toBe('Head of Google added "IS rule" to the Google Ads Buyer\'s Google account audit skill');
    expect(describeChange({ ...base, record: "item:1", before: { title: "IS rule", active: true }, after: { title: "IS rule", active: false } })).toBe('Head of Google turned off "IS rule" in the Google Ads Buyer\'s Google account audit skill');
    expect(describeChange({ ...base, record: "item:1", before: { title: "IS rule", active: true, body: "a" }, after: { title: "IS rule", active: true, body: "b" } })).toBe('Head of Google edited "IS rule" in the Google Ads Buyer\'s Google account audit skill');
  });
});
