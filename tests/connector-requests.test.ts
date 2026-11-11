import { describe, expect, it } from "vitest";
import { askNotices, declinedNotices, groupRequests, planRequest, readyNotices, REF_RE, rolesAfterEnable, type RequestRow } from "@/lib/connectors/requests-core";
import { browseState, chatConnectHref, chatMenu, connectionsHref } from "@/lib/connectors/shared";

const row = (id: string, profile: string, ref: string, status: RequestRow["status"] = "pending", at = "2026-11-10T12:00:00Z", note: string | null = null) => ({
  id,
  profile_id: profile,
  ref,
  title: ref.split("/").pop()!,
  icon_url: null,
  note,
  status,
  created_at: at,
});

describe("requests: one pending per person per connector", () => {
  it("asking again updates the pending one; a decided one doesn't count", () => {
    expect(planRequest([], "kaizen.directory/figma")).toEqual({ kind: "new" });
    expect(planRequest([{ id: "a", ref: "kaizen.directory/figma", status: "pending" }], "kaizen.directory/figma")).toEqual({ kind: "update", id: "a" });
    expect(planRequest([{ id: "a", ref: "kaizen.directory/figma", status: "declined" }], "kaizen.directory/figma")).toEqual({ kind: "new" });
    expect(planRequest([{ id: "a", ref: "kaizen.directory/canva", status: "pending" }], "kaizen.directory/figma")).toEqual({ kind: "new" });
  });
  it("only takes Directory names and team connectors as refs", () => {
    expect(REF_RE.test("kaizen.directory/asana")).toBe(true);
    expect(REF_RE.test("io.github.someone/server-name")).toBe(true);
    expect(REF_RE.test("connector:0b6f3c3e-8b8a-4a43-9a3e-0f2c9c1d2e3f")).toBe(true);
    expect(REF_RE.test("https://evil.example")).toBe(false);
    expect(REF_RE.test("")).toBe(false);
  });
  it("groups the pending ones per connector, the most asked first", () => {
    const g = groupRequests([
      { ...row("1", "p1", "kaizen.directory/figma", "pending", "2026-11-09T10:00:00Z", "For brand files"), name: "A", role: "Graphic designer" },
      { ...row("2", "p2", "kaizen.directory/canva"), name: "B", role: "Copywriter" },
      { ...row("3", "p3", "kaizen.directory/figma"), name: "C", role: "Video editor" },
      { ...row("4", "p4", "kaizen.directory/notion", "enabled"), name: "D", role: "Media buyer" },
    ]);
    expect(g.map((x) => x.ref)).toEqual(["kaizen.directory/figma", "kaizen.directory/canva"]);
    expect(g[0].people.map((p) => p.role)).toEqual(["Graphic designer", "Video editor"]);
    expect(g[0].people[0].note).toBe("For brand files");
  });
});

describe("requests: who hears", () => {
  const execs = [{ id: "owner" }, { id: "exec2" }];
  it("every exec, the owner included, hears '<role> asked to enable <connector>' with Enable one click away", () => {
    const n = askNotices(execs, { id: "req-1", title: "Figma", ref: "kaizen.directory/figma", roleLabel: "Graphic designer", note: "Brand files", requester: "p1" }, "/settings?tab=connections&section=team&request=kaizen.directory%2Ffigma");
    expect(n.map((x) => x.profile_id)).toEqual(["owner", "exec2"]);
    expect(n[0]).toMatchObject({ kind: "connector", title: "Graphic designer asked to enable Figma", body: '"Brand files"', key: "connector-ask:req-1", actor_id: "p1" });
    expect(n[0].href).toContain("section=team");
  });
  it("never tells the person who asked about their own request", () => {
    expect(askNotices(execs, { id: "r", title: "X", ref: "a/b", roleLabel: "Executive", note: null, requester: "exec2" }, "/s").map((x) => x.profile_id)).toEqual(["owner"]);
  });
  it("when it's enabled, everyone who asked hears it's ready, once each, with the link to connect in Kaizen AI", () => {
    const n = readyNotices([row("1", "p1", "a/b"), row("2", "p2", "a/b"), row("3", "p1", "a/b")], { name: "Figma" }, chatConnectHref("figma"), "owner");
    expect(n.map((x) => x.profile_id)).toEqual(["p1", "p2"]);
    expect(n[0]).toMatchObject({ title: "Figma is ready to connect", href: "/ai?connectors=open&connector=figma", key: "connector-ready:1" });
  });
  it("when it's declined, the reason goes back", () => {
    const n = declinedNotices([row("1", "p1", "a/b")], "Figma", "We use Canva for this.", "/ai?connectors=browse", "owner");
    expect(n[0]).toMatchObject({ title: "Figma wasn't enabled", body: "We use Canva for this.", key: "connector-declined:1" });
    expect(declinedNotices([row("1", "p1", "a/b")], "Figma", null, "/ai", null)[0].body).toMatch(/decided not to enable/);
  });
  it("enabling from requests: everyone when new or already for everyone, else the people who asked gain it", () => {
    expect(rolesAfterEnable(null, ["copywriter"])).toEqual([]);
    expect(rolesAfterEnable({ roles: null }, ["copywriter"])).toEqual([]);
    expect(rolesAfterEnable({ roles: ["media_buyer"] }, ["copywriter", "media_buyer"])).toEqual(["media_buyer", "copywriter"]);
  });
});

describe("the chat's plug menu", () => {
  const c = (key: string, roles: string[] | null, enabled = true) => ({ id: `id-${key}`, key, name: key[0].toUpperCase() + key.slice(1), icon_url: null, note: null, auth: "oauth" as const, roles, enabled });
  const catalog = [c("notion", null), c("figma", ["graphic_designer"]), c("stripe", ["executive"]), c("slack", null, false)];
  it("lists the connectors enabled for the person's role, never off ones or other roles'", () => {
    expect(chatMenu(catalog, [], { role: "graphic_designer", isExec: false }).map((i) => i.key)).toEqual(["figma", "notion"]);
    expect(chatMenu(catalog, [], { role: "copywriter", isExec: false }).map((i) => i.key)).toEqual(["notion"]);
  });
  it("execs see every enabled one", () => {
    expect(chatMenu(catalog, [], { role: "executive", isExec: true }).map((i) => i.key)).toEqual(["figma", "notion", "stripe"]);
  });
  it("puts connected ones first with their state, and a lapsed one as Reconnect", () => {
    const m = chatMenu(catalog, [{ connector_id: "id-notion", status: "active", tools: [1, 2, 3], connected_at: "2026-11-01T00:00:00Z" }, { connector_id: "id-figma", status: "needs_reconnect", last_error: "expired" }], {
      role: "graphic_designer",
      isExec: false,
    });
    expect(m.map((i) => [i.key, i.state])).toEqual([
      ["notion", "connected"],
      ["figma", "reconnect"],
    ]);
    expect(m[0].tools).toBe(3);
  });
  it("Browse connectors: Connect when enabled for you, Requested once asked, Request to enable otherwise, Enable for execs", () => {
    expect(browseState({ enabledForMe: true, connected: true, requested: false, isExec: false })).toBe("connected");
    expect(browseState({ enabledForMe: true, connected: false, requested: true, isExec: false })).toBe("enabled");
    expect(browseState({ enabledForMe: false, connected: false, requested: true, isExec: false })).toBe("requested");
    expect(browseState({ enabledForMe: false, connected: false, requested: false, isExec: false })).toBe("request");
    expect(browseState({ enabledForMe: false, connected: false, requested: false, isExec: true })).toBe("enable");
  });
  it("old links to Your connections now open the plug menu in Kaizen AI", () => {
    expect(connectionsHref()).toBe("/ai?connectors=manage");
    expect(connectionsHref("notion")).toBe("/ai?connectors=manage&connector=notion");
  });
});
