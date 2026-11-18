import { describe, expect, it } from "vitest";
import { asanaSortFields, compareBy, defaultDir, parseDir, parseSort, sortCards, type SortFields } from "@/lib/board-sort";
import { historyLine, linkify, mapAttachments, mapSubtasks, readList } from "@/lib/asana-context";

const card = (o: Partial<SortFields> & { title: string }): SortFields => ({ start: null, due: null, createdBy: null, createdOn: null, modifiedOn: null, completedOn: null, priority: "normal", ...o });
const titles = (l: SortFields[]) => l.map((x) => x.title);

describe("board sort", () => {
  const list = [card({ title: "b", due: "2026-12-05" }), card({ title: "none" }), card({ title: "a", due: "2026-12-01" }), card({ title: "c", due: "2026-12-09" })];

  it("puts missing values last in both directions", () => {
    expect(titles(sortCards(list, "due", "asc", (x) => x))).toEqual(["a", "b", "c", "none"]);
    expect(titles(sortCards(list, "due", "desc", (x) => x))).toEqual(["c", "b", "a", "none"]);
  });

  it("is stable for ties and leaves the list alone with no key", () => {
    const tied = [card({ title: "1", due: "2026-12-01" }), card({ title: "2", due: "2026-12-01" }), card({ title: "3", due: "2026-12-01" })];
    expect(titles(sortCards(tied, "due", "desc", (x) => x))).toEqual(["1", "2", "3"]);
    expect(sortCards(list, null, "asc", (x) => x)).toBe(list);
  });

  it("sorts alphabetically ignoring case and by created by", () => {
    const l = [card({ title: "beta", createdBy: "zed" }), card({ title: "Alpha", createdBy: "Amy" }), card({ title: "gamma" })];
    expect(titles(sortCards(l, "alpha", "asc", (x) => x))).toEqual(["Alpha", "beta", "gamma"]);
    expect(titles(sortCards(l, "created_by", "asc", (x) => x))).toEqual(["Alpha", "beta", "gamma"]);
    expect(titles(sortCards(l, "created_by", "desc", (x) => x))).toEqual(["beta", "Alpha", "gamma"]);
  });

  it("ranks urgent first when ascending", () => {
    const l = [card({ title: "n" }), card({ title: "h", priority: "high" }), card({ title: "u", priority: "urgent" })];
    expect(titles(sortCards(l, "priority", "asc", (x) => x))).toEqual(["u", "h", "n"]);
    expect(compareBy(l[0], l[1], "priority", "desc")).toBeLessThan(0);
  });

  it("reads the key and direction from the address", () => {
    expect(parseSort("due")).toBe("due");
    expect(parseSort("nope")).toBeNull();
    expect(parseDir("desc")).toBe("desc");
    expect(parseDir("x")).toBeNull();
    expect(defaultDir("created")).toBe("desc");
    expect(defaultDir("due")).toBe("asc");
  });

  it("reads an Asana card", () => {
    const f = asanaSortFields({ title: "T", dueOn: "2026-12-01", startOn: null, createdBy: "Sam", createdAt: "2026-11-01T00:00:00Z", modifiedAt: "2026-11-02T00:00:00Z", priority: "high" });
    expect(f).toMatchObject({ due: "2026-12-01", start: null, createdBy: "Sam", modifiedOn: "2026-11-02T00:00:00Z", completedOn: null });
  });
});

describe("Asana context mapping", () => {
  it("keeps the permanent link of an attachment, not the expiring download", () => {
    const [a] = mapAttachments([{ gid: "1", name: "brief.pdf", download_url: "https://s3.example/x", permanent_url: "https://app.asana.com/app/asana/-/get_asset?asset_id=1", size: 2048, host: "asana" }]);
    expect(a.url).toContain("get_asset");
    expect(a).toMatchObject({ name: "brief.pdf", size: 2048 });
    expect(mapAttachments([{ gid: "2" }, null, { name: "no gid" }])).toEqual([]);
    expect(mapAttachments(undefined)).toEqual([]);
  });

  it("maps subtasks and refuses non-web links", () => {
    const out = mapSubtasks([{ gid: "9", name: "Design", completed: true, assignee: { name: "Ana" }, due_on: "2026-12-01", permalink_url: "javascript:alert(1)" }]);
    expect(out).toEqual([{ gid: "9", name: "Design", done: true, assignee: "Ana", dueOn: "2026-12-01", url: null }]);
  });

  it("linkifies http links and leaves line breaks to the text", () => {
    const parts = linkify("See https://example.com/a?b=1, then\nhttp://x.co.");
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual(["https://example.com/a?b=1", "http://x.co"]);
    expect(parts.map((p) => p.text).join("")).toBe("See https://example.com/a?b=1, then\nhttp://x.co.");
    expect(linkify("javascript:alert(1)").some((p) => p.href)).toBe(false);
  });

  it("describes history and reads stored lists safely", () => {
    expect(historyLine({ at: "", kind: "moved", from: "A", to: "B", by: null })).toBe("Moved from A to B");
    expect(historyLine({ at: "", kind: "assigned", to: null, by: null })).toBe("Unassigned");
    expect(readList(null)).toEqual([]);
    expect(readList([1])).toEqual([1]);
  });
});
