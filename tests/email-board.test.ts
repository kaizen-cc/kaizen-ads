import { describe, expect, it } from "vitest";
import {
  checkMove,
  emailStageForColumn,
  isDoneColumn,
  messageStatus,
  nextStage,
  ownerFor,
  pickEmailProject,
  pickSeat,
  routeFallback,
  sizeProblem,
  type MessageLite,
} from "@/lib/email-board-core";

const msg = (o: Partial<MessageLite> = {}): MessageLite => ({ channel: "email", copyApproved: true, hasDesign: true, aiReview: "done", clientStatus: null, builtAt: null, liveAt: null, ...o });
const sms = (o: Partial<MessageLite> = {}) => msg({ channel: "sms", hasDesign: false, aiReview: "none", ...o });

describe("email board stages", () => {
  it("walks an email batch through every stage", () => {
    const m = [msg(), msg()];
    const t = { kind: "batch" as const };
    expect(nextStage({ ...t, stage: "copy_review" }, m)).toBe("ready_for_design");
    expect(nextStage({ ...t, stage: "ready_for_design" }, m)).toBe("for_review");
    expect(nextStage({ ...t, stage: "for_review" }, m)).toBe("with_client");
    expect(nextStage({ ...t, stage: "with_client" }, m.map((x) => ({ ...x, clientStatus: "approved" as const })))).toBe("ready_for_build");
    expect(nextStage({ ...t, stage: "ready_for_build" }, m)).toBe("ready_to_send");
    expect(nextStage({ ...t, stage: "ready_to_send" }, m)).toBe("live");
  });

  it("sends a ticket to revisions when any message comes back, even when others are approved", () => {
    const m = [msg({ clientStatus: "approved" }), msg({ clientStatus: "changes" })];
    expect(nextStage({ kind: "batch", stage: "with_client" }, m)).toBe("revisions");
    expect(nextStage({ kind: "batch", stage: "revisions" }, m)).toBe("for_review");
    expect(messageStatus(m[0], "revisions")).toBe("approved");
    expect(messageStatus(m[1], "revisions")).toBe("changes");
  });

  it("skips design for texts, and the build for an all-text campaign batch but never for a flow", () => {
    const texts = [sms(), sms()];
    expect(nextStage({ kind: "batch", stage: "copy_review" }, texts)).toBe("with_client");
    expect(nextStage({ kind: "batch", stage: "with_client" }, texts.map((x) => ({ ...x, clientStatus: "approved" as const })))).toBe("ready_to_send");
    expect(nextStage({ kind: "flow", stage: "with_client" }, texts.map((x) => ({ ...x, clientStatus: "approved" as const })))).toBe("ready_for_build");
    expect(nextStage({ kind: "batch", stage: "revisions" }, texts)).toBe("with_client");
    // A mixed batch still goes through design
    expect(nextStage({ kind: "batch", stage: "copy_review" }, [sms(), msg()])).toBe("ready_for_design");
  });

  it("holds a batch to 5 messages and a flow to 6", () => {
    expect(sizeProblem("batch", 5)).toBeNull();
    expect(sizeProblem("batch", 6)).toMatch(/5/);
    expect(sizeProblem("flow", 6)).toBeNull();
    expect(sizeProblem("flow", 7)).toMatch(/6/);
    expect(sizeProblem("flow", 0)).toBeTruthy();
  });

  it("refuses a move past design without the designs, and says what happens", () => {
    const c = checkMove({ kind: "batch", stage: "ready_for_design" }, [msg({ hasDesign: false })], "for_review");
    expect(c.blockers.length).toBe(1);
    const back = checkMove({ kind: "batch", stage: "with_client" }, [msg()], "copy_review");
    expect(back.backwards).toBe(true);
    expect(back.effects.join(" ")).toMatch(/starts again/);
  });
});

describe("who gets it", () => {
  const seats = [
    { profile_id: "s2", role: "email_strategist", is_primary: false, created_at: "2026-01-01" },
    { profile_id: "s1", role: "email_strategist", is_primary: true, created_at: "2026-02-01" },
    { profile_id: "d1", role: "email_designer", is_primary: true },
    { profile_id: "b1", role: "email_builder", is_primary: true },
  ];
  it("picks the primary on a seat first", () => {
    expect(pickSeat(seats, "email_strategist")).toBe("s1");
    expect(pickSeat([], "email_designer")).toBeNull();
  });
  it("assigns each stage to its seat, revisions by route", () => {
    expect(ownerFor("copy_review", seats)).toBe("s1");
    expect(ownerFor("ready_for_design", seats)).toBe("d1");
    expect(ownerFor("ready_for_build", seats)).toBe("b1");
    expect(ownerFor("ready_to_send", seats)).toBe("s1");
    expect(ownerFor("revisions", seats, ["copy"])).toBe("s1");
    expect(ownerFor("revisions", seats, ["copy", "design"])).toBe("d1");
    expect(ownerFor("ready_for_design", seats.filter((s) => s.role !== "email_designer"))).toBeNull();
  });
});

describe("routing a client comment without the AI", () => {
  it("sends design words to design and the rest to copy", () => {
    expect(routeFallback("Can the hero image be brighter and the button bigger?")).toBe("design");
    expect(routeFallback("Change the subject line to mention the sale")).toBe("copy");
    expect(routeFallback("Love it but the discount code is wrong")).toBe("copy");
    expect(routeFallback("The logo looks too small", "sms")).toBe("copy");
  });
});

describe("the Asana email board", () => {
  it("maps its columns to the Email Board's stages", () => {
    expect(emailStageForColumn("Copy for Review")).toBe("copy_review");
    expect(emailStageForColumn("Ready for Design")).toBe("ready_for_design");
    expect(emailStageForColumn("For Review")).toBe("for_review");
    expect(emailStageForColumn("Sent to Client")).toBe("with_client");
    expect(emailStageForColumn("Client Revisions")).toBe("revisions");
    expect(emailStageForColumn("Ready for Build")).toBe("ready_for_build");
    expect(emailStageForColumn("Ready to Send")).toBe("ready_to_send");
    expect(emailStageForColumn("Scheduled")).toBeNull();
    expect(isDoneColumn("Sent")).toBe(true);
    expect(emailStageForColumn("Something else")).toBeNull();
  });
  it("finds the email project by its name", () => {
    expect(pickEmailProject([{ gid: "1", name: "Creative" }, { gid: "2", name: "Email Board" }, { gid: "3", name: "Email (archive)" }])?.gid).toBe("2");
    expect(pickEmailProject([{ gid: "4", name: "Email" }, { gid: "2", name: "Email Board" }])?.gid).toBe("4");
    expect(pickEmailProject([{ gid: "5", name: "Kaizen email team" }])?.gid).toBe("5");
    expect(pickEmailProject([{ gid: "1", name: "Creative" }])).toBeNull();
  });
});

describe("email tickets in the daily recap", () => {
  it("shows people their own late or due tickets, and the line head anyone's well over", async () => {
    const { emailTicketItems } = await import("@/lib/today-lines-core");
    const base = { client: "Acme", slug: "acme", clientId: "c1", stageLabel: "Ready for design", dueOn: null as string | null };
    const tickets = [
      { ...base, id: "a", number: 1, title: "Mine, over", stage: "ready_for_design", assigneeId: "me", minutesOver: 30 },
      { ...base, id: "b", number: 2, title: "Mine, on time", stage: "ready_for_design", assigneeId: "me", minutesOver: 0 },
      { ...base, id: "c", number: 3, title: "Theirs, way over", stage: "ready_for_build", assigneeId: "x", minutesOver: 20 * 60 },
      { ...base, id: "d", number: 4, title: "With the client, past its day", stage: "with_client", assigneeId: "me", minutesOver: 0, dueOn: "2026-11-01" },
    ];
    const seat = { line: "email" as const, all: false, seats: new Map([["c1", ["email_designer"]]]) };
    expect(emailTicketItems(tickets, { id: "me" }, seat, "2026-11-17").map((i) => i.key)).toEqual(["email-ticket:a", "email-ticket:d"]);
    const head = { line: "email" as const, all: true, seats: new Map() };
    expect(emailTicketItems(tickets, { id: "boss" }, head, "2026-11-17").map((i) => i.key)).toEqual(["email-ticket:c", "email-ticket:d"]);
  });
});
