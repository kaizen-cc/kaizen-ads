import { describe, expect, it } from "vitest";
import { linesFor, matchPerson, mayTransferAny, mayTransferSeat, planMoves, type HeldSeat, type Person } from "@/lib/seat-transfer-core";

const exec = { role: "executive", isExec: true };
const headMeta = { role: "head_of_meta", isExec: false };
const headEmail = { role: "head_of_email", isExec: false };
const buyer = { role: "media_buyer", isExec: false };

const people: Person[] = [
  { id: "matheus", full_name: "Matheus Santos", role: "media_buyer" },
  { id: "lucas", full_name: "Lucas Silva", role: "media_buyer" },
  { id: "ana", full_name: "Ana Google", role: "google_buyer" },
  { id: "eve", full_name: "Eve Email", role: "email_designer" },
  { id: "luca", full_name: "Luca Brown", role: "graphic_designer" },
];

const seat = (client: string, role: string, primary = true, services: string[] = ["paid-ads"]): HeldSeat => ({ clientId: client.toLowerCase(), client, services, role, primary });

describe("who may move which seats", () => {
  it("executives move every seat; heads only their own line's", () => {
    expect(mayTransferSeat(exec, "email_designer")).toBe(true);
    expect(mayTransferSeat(headMeta, "meta_buyer")).toBe(true);
    expect(mayTransferSeat(headMeta, "tiktok_buyer")).toBe(true);
    expect(mayTransferSeat(headMeta, "google_buyer")).toBe(false);
    expect(mayTransferSeat(headMeta, "email_designer")).toBe(false);
    expect(mayTransferSeat(headEmail, "email_builder")).toBe(true);
    expect(mayTransferSeat(headEmail, "meta_buyer")).toBe(false);
    expect(mayTransferSeat(buyer, "meta_buyer")).toBe(false);
    expect(mayTransferSeat(exec, "copywriter")).toBe(false);
  });
  it("only execs and heads get the tools", () => {
    expect(mayTransferAny(exec)).toBe(true);
    expect(mayTransferAny(headEmail)).toBe(true);
    expect(mayTransferAny(buyer)).toBe(false);
    expect(linesFor(exec)).toHaveLength(5);
    expect(linesFor(headMeta)).toEqual(["meta"]);
  });
});

describe("planning the moves", () => {
  const held = [seat("Limelight", "meta_buyer"), seat("Limelight", "google_buyer"), seat("Ocean Box", "meta_buyer", false), seat("Ocean Box", "email_designer", true, ["paid-ads", "email-marketing"])];

  it("each seat goes to someone who can hold it; others wait for a pick", () => {
    const moves = planMoves(exec, "matheus", held, people, "lucas");
    const by = (c: string, r: string) => moves.find((m) => m.client === c && m.role === r)!;
    expect(by("Limelight", "meta_buyer").toId).toBe("lucas");
    expect(by("Ocean Box", "meta_buyer")).toMatchObject({ toId: "lucas", primary: false });
    expect(by("Limelight", "google_buyer").toId).toBeNull();
    expect(by("Limelight", "google_buyer").why).toMatch(/can't hold the Google buyer seat/);
    expect(by("Ocean Box", "email_designer").toId).toBeNull();
  });

  it("names someone per line", () => {
    const moves = planMoves(exec, "matheus", held, people, "lucas", { google: "ana", email: "eve" });
    expect(moves.every((m) => m.toId)).toBe(true);
    expect(moves.find((m) => m.role === "google_buyer")!.to).toBe("Ana Google");
  });

  it("a head plans only their line's seats", () => {
    const moves = planMoves(headMeta, "matheus", held, people, "lucas");
    expect(moves.map((m) => m.role).sort()).toEqual(["meta_buyer", "meta_buyer"]);
  });

  it("skips seats on a service the client stopped buying, and never gives a seat back to its holder", () => {
    const moves = planMoves(exec, "matheus", [seat("Gone", "email_designer", true, ["paid-ads"]), seat("Limelight", "meta_buyer")], people, "matheus");
    expect(moves).toHaveLength(1);
    expect(moves[0].toId).toBeNull();
  });
});

describe("finding a person by name", () => {
  it("matches a first name, a possessive and full names", () => {
    expect(matchPerson(people, "Matheus")).toEqual({ one: people[0] });
    expect(matchPerson(people, "Matheus'")).toEqual({ one: people[0] });
    expect(matchPerson(people, "lucas's")).toEqual({ one: people[1] });
    expect(matchPerson(people, "Lucas Silva")).toEqual({ one: people[1] });
  });
  it("asks when several match, and says when nobody does", () => {
    expect(matchPerson(people, "Luc")).toEqual({ many: [people[1], people[4]] });
    expect(matchPerson(people, "Zed")).toEqual({ none: true });
  });
});
