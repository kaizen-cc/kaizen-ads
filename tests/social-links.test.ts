import { describe, expect, it } from "vitest";
import { accountLabel, clientPages, fold, locationOf, mergeAccountDays, nameWords } from "@/lib/social/links-core";
import { matchPage } from "@/lib/social/core";

const page = (id: string, name: string) => ({ id, name });

describe("a client's Pages, one per location", () => {
  const clients = ["Mama Betty's", "McIntyres", "Café Diario", "Tejas Beer", "Tejas Brewery", "EP Window Films", "Green Leaf Pro", "Gold Rush Cabaret"];
  const others = (me: string) => clients.filter((c) => c !== me);
  it("links every location's Page, with the location from its name", () => {
    const pages = [page("1", "Mama Betty's Tex-Mex - Parmer Ln"), page("2", "Mama Betty's Tex-Mex - Burnett Rd"), page("3", "Betty's Bakery")];
    expect(clientPages(pages, "Mama Betty's", others("Mama Betty's")).map((m) => [m.page.id, m.location])).toEqual([
      ["1", "Parmer Ln"],
      ["2", "Burnett Rd"],
    ]);
  });
  it("reads accents and apostrophes the same way", () => {
    expect(fold("Café")).toBe("Cafe");
    expect(clientPages([page("1", "Cafe Diario")], "Café Diario").length).toBe(1);
    expect(clientPages([page("1", "McIntyre's (Ocala)")], "McIntyres").map((m) => m.location)).toEqual(["Ocala"]);
    expect(matchPage([page("1", "Café Diario"), page("2", "Other")], "Café Diario")?.id).toBe("1");
  });
  it("never guesses between two clients a Page could belong to", () => {
    const pages = [page("1", "Tejas Beer"), page("2", "Tejas Brewery"), page("3", "Tejas Brewery & Beer Garden")];
    expect(clientPages(pages, "Tejas Beer", others("Tejas Beer")).map((m) => m.page.id)).toEqual(["1"]);
    expect(clientPages(pages, "Tejas Brewery", others("Tejas Brewery")).map((m) => m.page.id)).toEqual(["2"]);
  });
  it("links none when Pages of two brands carry the client's name (Giant Texas and Giant Texas Distillers)", () => {
    const pages = [page("1", "Giant Texas"), page("2", "Giant Texas Distillers"), page("3", "Mama Betty's Tex-Mex - Parmer Ln")];
    expect(clientPages(pages, "Giant Texas")).toEqual([]);
    expect(clientPages(pages, "Giant Texas Distillers").map((m) => m.page.id)).toEqual(["2"]);
    expect(clientPages(pages, "Giant Texas", ["Giant Texas Distillers"]).map((m) => m.page.id)).toEqual(["1"]);
    expect(clientPages([page("1", "Mama Betty's Tex-Mex - Parmer Ln"), page("2", "Mama Betty's Tex-Mex (Burnett)")], "Mama Betty's").length).toBe(2);
  });
  it("matches a plural against a singular and needs every word", () => {
    expect(clientPages([page("1", "EP Window Film")], "EP Window Films").length).toBe(1);
    expect(clientPages([page("1", "Window World")], "EP Window Films").length).toBe(0);
    expect(nameWords("The Gold Rush Cabaret LLC")).toEqual(["gold", "rush", "cabaret"]);
  });
  it("gives no location to a Page that's just the client's name", () => {
    expect(locationOf("Green Leaf Pro", "Green Leaf Pro")).toBeNull();
  });
});

describe("several accounts' days, one platform for the client", () => {
  it("adds up each number per platform and day, null where none has it", () => {
    const rows = [
      { platform: "facebook", date: "2026-11-18", account_id: "a", followers: 1000, reach: 200, views: null },
      { platform: "facebook", date: "2026-11-18", account_id: "b", followers: 500, reach: null, views: null },
      { platform: "instagram", date: "2026-11-18", account_id: "c", followers: 300, reach: 90, views: 400 },
    ];
    const out = mergeAccountDays(rows, ["followers", "reach", "views"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ platform: "facebook", followers: 1500, reach: 200, views: null });
    expect(out[1]).toMatchObject({ platform: "instagram", followers: 300, reach: 90, views: 400 });
  });
});

describe("an account in words", () => {
  it("names the platform, the location and the account", () => {
    expect(accountLabel({ platform: "instagram", name: "mama.bettys", location: "Parmer" })).toBe("Instagram · Parmer (@mama.bettys)");
    expect(accountLabel({ platform: "facebook", name: "McIntyre's", location: null })).toBe("Facebook (McIntyre's)");
  });
});

describe("a client's locations", () => {
  const acct = (id: string, platform: "facebook" | "instagram", name: string, location: string | null) => ({ id, platform, accountId: id, name, location, pageId: null, source: "manual" as const });
  it("pairs a location's Page and Instagram by their label, and keeps an unlabeled account on its own", async () => {
    const { locationGroups } = await import("@/lib/social/links-core");
    const g = locationGroups([acct("1", "facebook", "Mama Betty's - Parmer Ln", "Parmer"), acct("2", "instagram", "mama.bettys", "parmer "), acct("3", "facebook", "Mama Betty's - Burnett Rd", "Burnett"), acct("4", "instagram", "other.account", null)]);
    expect(g.map((x) => [x.label, x.accounts.map((a) => a.id)])).toEqual([
      ["@other.account", ["4"]],
      ["Burnett", ["3"]],
      ["Parmer", ["1", "2"]],
    ]);
  });
  it("says where each account stands", async () => {
    const { accountStatus } = await import("@/lib/social/links-core");
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(accountStatus({ lastReadAt: "2026-11-19T09:00:00Z", lastError: null }, now).state).toBe("reading");
    expect(accountStatus({ lastReadAt: null, lastError: null }, now).state).toBe("pending");
    expect(accountStatus({ lastReadAt: null, lastError: "The Meta system user has no access to this Page" }, now)).toEqual({ state: "access", text: "The Meta system user has no access to this Page" });
    expect(accountStatus({ lastReadAt: "2026-11-10T09:00:00Z", lastError: null }, now).state).toBe("access");
  });
  it("lets executives, leads and the Head of Social change the connections", async () => {
    const { canConnectSocial } = await import("@/lib/social/links-core");
    expect(canConnectSocial({ isExec: true })).toBe(true);
    expect(canConnectSocial({ isLead: true, role: "head_of_meta" })).toBe(true);
    expect(canConnectSocial({ role: "head_of_social" })).toBe(true);
    expect(canConnectSocial({ role: "social_media_manager" })).toBe(false);
  });
});
