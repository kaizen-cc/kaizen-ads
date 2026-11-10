import { describe, expect, it } from "vitest";
import { STAGES, type Stage } from "@/lib/stages";
import { activeTab, ticketLayout, ticketRole, type TicketRole } from "@/lib/ticket-layout";

const ROLES: TicketRole[] = ["lead", "copywriter", "maker", "team"];

describe("ticketLayout: each stage opens on what its person acts on", () => {
  it("requested opens on the brief with Start production", () => {
    const l = ticketLayout("requested", "maker");
    expect(l.focus).toBe("brief");
    expect(l.defaultTab).toBe("brief");
    expect(l.action).toEqual({ kind: "move", to: "in_production", label: "Start production" });
    expect(l.tabs).toEqual(["brief", "creative", "activity"]);
  });

  it("in production opens on the creative: upload, then the AI review gate sends it on (going back sits with the gate)", () => {
    const l = ticketLayout("in_production", "maker");
    expect(l.focus).toBe("make");
    expect(l.defaultTab).toBe("creative");
    expect(l.action).toMatchObject({ kind: "panel", tab: "creative", target: "ai-gate" });
    expect(l.secondary).toEqual([]);
    expect(l.gateBack).toEqual({ to: "requested", label: "Back to request" });
  });

  it("creative review: the reviewer approves or sends back; anyone else sees who has it", () => {
    const lead = ticketLayout("internal_review", "lead");
    expect(lead.focus).toBe("review");
    expect(lead.defaultTab).toBe("creative");
    expect(lead.action).toMatchObject({ kind: "panel", target: "review", label: "Approve or send back" });
    for (const r of ["copywriter", "maker", "team"] as TicketRole[]) expect(ticketLayout("internal_review", r).action?.kind).toBe("wait");
    for (const r of ROLES) expect(ticketLayout("internal_review", r).secondary).toEqual([]);
  });

  it("copy opens the copy tab, for every role", () => {
    for (const s of ["copy", "copy_review"] as Stage[])
      for (const r of ROLES) {
        const l = ticketLayout(s, r);
        expect(l.focus).toBe("copy");
        expect(l.defaultTab).toBe("copy");
        expect(l.action).toMatchObject({ kind: "panel", tab: "copy", target: "copy" });
      }
    expect(ticketLayout("copy_review", "copywriter").action?.label).toBe("Review and approve the copy");
    expect(ticketLayout("copy_review", "team").action?.label).toBe("Open the copy");
  });

  it("with the client: what the client said, Client approved, and the way back for their changes", () => {
    const l = ticketLayout("client_review", "team");
    expect(l.focus).toBe("client");
    expect(l.defaultTab).toBe("creative");
    expect(l.clientView).toBe(true);
    expect(l.action).toEqual({ kind: "move", to: "ready_for_launch", label: "Client approved" });
    expect(l.secondary).toEqual([{ to: "client_revision", label: "Client asked for changes" }]);
  });

  it("client changes: the maker fixes what the client pinned, then sends it to review", () => {
    const l = ticketLayout("client_revision", "maker");
    expect(l.focus).toBe("fix");
    expect(l.defaultTab).toBe("creative");
    expect(l.action).toMatchObject({ kind: "panel", target: "ai-gate" });
    expect(l.tabs).toContain("copy");
  });

  it("ready to launch opens the launcher; Mark launched and Back to client stay one tap away", () => {
    const l = ticketLayout("ready_for_launch", "lead");
    expect(l.focus).toBe("launch");
    expect(l.defaultTab).toBe("launch");
    expect(l.action).toMatchObject({ kind: "panel", tab: "launch", target: "launch" });
    expect(l.secondary.map((m) => m.to)).toEqual(["client_review", "launched"]);
    expect(l.tabs).toEqual(["brief", "creative", "copy", "launch", "activity"]);
  });

  it("launched has no action and shows the launch", () => {
    const l = ticketLayout("launched", "team");
    expect(l.action).toBeNull();
    expect(l.defaultTab).toBe("launch");
    expect(l.clientView).toBe(false);
  });

  it("every stage and role gives a default tab it shows, Brief and Activity always, and at most five tabs", () => {
    for (const s of STAGES.map((x) => x.key))
      for (const r of ROLES) {
        const l = ticketLayout(s, r);
        expect(l.tabs).toContain(l.defaultTab);
        expect(l.tabs[0]).toBe("brief");
        expect(l.tabs.at(-1)).toBe("activity");
        expect(l.tabs.length).toBeLessThanOrEqual(5);
        if (l.action?.kind === "panel") expect(l.tabs).toContain(l.action.tab);
      }
  });

  it("Copy and Launch tabs only once there is copy or a launch", () => {
    expect(ticketLayout("in_production", "lead").tabs).not.toContain("copy");
    expect(ticketLayout("internal_review", "lead").tabs).not.toContain("copy");
    expect(ticketLayout("client_review", "lead").tabs).not.toContain("launch");
  });
});

describe("activeTab", () => {
  const l = ticketLayout("in_production", "maker");
  it("takes the address's tab when the stage has it", () => expect(activeTab(l, "brief")).toBe("brief"));
  it("falls back to the stage's own for none or one this stage doesn't have", () => {
    expect(activeTab(l, null)).toBe("creative");
    expect(activeTab(l, "copy")).toBe("creative");
    expect(activeTab(l, "nonsense")).toBe("creative");
  });
});

describe("ticketRole", () => {
  it("reads the role from what the person can do and whether it's theirs", () => {
    expect(ticketRole({ review: true, approveCopy: true })).toBe("lead");
    expect(ticketRole({ review: false, approveCopy: true }, true)).toBe("copywriter");
    expect(ticketRole({ review: false, approveCopy: false }, true)).toBe("maker");
    expect(ticketRole({})).toBe("team");
  });
});
