import { describe, expect, it } from "vitest";
import { linkLabel, linksIn, withLinks } from "@/lib/item-facts";

// Nov 25 2026: routine-made items opened to empty sheets; every item now carries its source links
describe("item facts", () => {
  it("finds every link in an item's words, labeled by where it goes", () => {
    const d = `Asked in Slack https://kaizen-marketing-hq.slack.com/archives/C0B99TEB09M/p1795556699307429?thread_ts=1794846150.035949&cid=C0B99TEB09M.\nAsana: https://app.asana.com/1/1/project/2/task/3 and <https://mail.google.com/mail/#all/1a2|thread>`;
    expect(linksIn(d).map((l) => l.label)).toEqual(["Slack thread", "Asana task", "Gmail thread"]);
    expect(linksIn(d)[0].url.endsWith("cid=C0B99TEB09M")).toBe(true);
    expect(linksIn(null)).toEqual([]);
  });
  it("labels and merges without repeats", () => {
    expect(linkLabel("https://drive.google.com/file/d/x")).toBe("Drive file");
    const f = withLinks({ links: [{ label: "PDF", url: "https://a" }], options: ["Yes"] }, [{ label: "Link", url: "https://a" }, { label: "Link", url: "https://b" }]);
    expect(f).toEqual({ links: [{ label: "PDF", url: "https://a" }, { label: "Link", url: "https://b" }], options: ["Yes"] });
  });
});
