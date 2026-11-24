import { describe, expect, it } from "vitest";
import { applyFilters, filterChoices, kindOf, placeOf, type FilterCard } from "@/lib/item-filters";

const c = (key: string, kind: string, client: string | null, href: string | null = null, line: string | null = null): FilterCard => ({ key, kind, client, line, action: { href } });

const cards = [
  c("owed:1", "owed", "Acme", "https://slack.com/archives/C1/p1", "meta"),
  c("owed:2", "owed", "Beta", "https://mail.google.com/mail/u/x/#all/1", "email"),
  c("said:3", "said", "Acme", "https://slack.com/archives/C2/p2", "meta"),
  c("approve:safety:2026-11-24", "approval", null),
  c("draft:4", "draft", "Beta"),
  c("ask:5", "mine", null, "/pipeline?block=needs&item=ask%3A5"),
];

describe("Needs me, narrowed down", () => {
  it("knows what each item is and where it was said", () => {
    expect(cards.map(kindOf)).toEqual(["reply", "reply", "promise", "approval", "email", "task"]);
    expect(cards.map(placeOf)).toEqual(["Slack", "Email", "Slack", "Kaizen OS", "Email", "Kaizen OS"]);
  });
  it("offers only the choices that have items, most first", () => {
    const f = filterChoices(cards);
    expect(f.kinds[0]).toEqual(["reply", 2]);
    expect(f.clients).toEqual([["Acme", 2], ["Beta", 2]]);
    expect(f.lines.map(([l]) => l)).toEqual(["meta", "email"]);
  });
  it("every filter set narrows it", () => {
    expect(applyFilters(cards, { kind: "reply" }).map((x) => x.key)).toEqual(["owed:1", "owed:2"]);
    expect(applyFilters(cards, { kind: "reply", client: "Acme" }).map((x) => x.key)).toEqual(["owed:1"]);
    expect(applyFilters(cards, { place: "Slack" }).map((x) => x.key)).toEqual(["owed:1", "said:3"]);
    expect(applyFilters(cards, {})).toHaveLength(6);
  });
});
