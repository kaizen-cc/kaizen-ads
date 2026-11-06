import { describe, expect, it, vi } from "vitest";
import { followLanding, homeOf, isJunk, kindOf, labelOf, landingVerdict, matchPage, normalizeUrl, parseSitemap, rankPages, robotsSitemaps, sameSite, shortUrl, sitemapOrder, urlIn, type LandingPage, type LandingSet } from "@/lib/landing-pages-core";
import type { LaunchQuestion } from "@/lib/launch-sheet/types";

vi.mock("@/lib/references", () => ({ isPublicHost: () => true }));
vi.mock("@/lib/launch-cache", () => ({ cachedRead: vi.fn() }));

const page = (url: string, o: Partial<LandingPage> = {}): LandingPage => ({ url, label: labelOf(url, o.title), kind: kindOf(url), sources: ["sitemap"], ads: 0, conversions: 0, spend: 0, title: null, ...o });
const SITE = "https://oceanbox.com/";
const set: LandingSet = {
  site: SITE,
  at: "",
  pages: [
    page(SITE, { sources: ["home"], ads: 2 }),
    page("https://oceanbox.com/collections/seafood-box"),
    page("https://oceanbox.com/collections/salmon", { ads: 3, conversions: 12 }),
    page("https://oceanbox.com/products/wild-salmon-fillets"),
    page("https://oceanbox.com/pages/how-it-works"),
    page("https://oceanbox.com/blogs/news/salmon-recipes"),
  ],
};

describe("urls", () => {
  it("normalizes to https, drops tracking and fragments, keeps the homepage slash", () => {
    expect(normalizeUrl("oceanbox.com")).toBe("https://oceanbox.com/");
    expect(normalizeUrl("https://OceanBox.com/collections/salmon?utm_source=x&variant=2#top")).toBe("https://oceanbox.com/collections/salmon?variant=2");
    expect(normalizeUrl("not a link")).toBeNull();
    expect(homeOf("www.oceanbox.com/about")).toBe("https://www.oceanbox.com/");
    expect(homeOf(null)).toBeNull();
  });
  it("shortens for display and finds a link in text", () => {
    expect(shortUrl("https://www.oceanbox.com/collections/salmon/")).toBe("oceanbox.com/collections/salmon");
    expect(shortUrl(SITE)).toBe("oceanbox.com");
    expect(urlIn("use https://oceanbox.com/pages/faq, thanks")).toBe("https://oceanbox.com/pages/faq");
  });
  it("knows the same site, junk pages and kinds", () => {
    expect(sameSite("https://shop.oceanbox.com/x", SITE)).toBe(true);
    expect(sameSite("https://www.oceanbox.com/", SITE)).toBe(true);
    expect(sameSite("https://other.com/", SITE)).toBe(false);
    expect(isJunk("https://oceanbox.com/cart")).toBe(true);
    expect(isJunk("https://oceanbox.com/policies/refund-policy")).toBe(true);
    expect(isJunk("https://oceanbox.com/collections/salmon")).toBe(false);
    expect(kindOf(SITE)).toBe("home");
    expect(kindOf("https://oceanbox.com/collections/salmon")).toBe("collection");
    expect(kindOf("https://oceanbox.com/products/wild-salmon-fillets")).toBe("product");
    expect(kindOf("https://oceanbox.com/blogs/news/x")).toBe("blog");
  });
  it("labels from the title, else the path", () => {
    expect(labelOf(SITE)).toBe("Homepage");
    expect(labelOf("https://oceanbox.com/collections/seafood-box")).toBe("Seafood box");
    expect(labelOf("https://oceanbox.com/collections/salmon", "Wild Salmon | OceanBox")).toBe("Wild Salmon");
  });
});

describe("sitemaps", () => {
  it("reads an index and a urlset (Shopify, with image tags and CDATA)", () => {
    const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://oceanbox.com/sitemap_products_1.xml?from=1&amp;to=99</loc></sitemap><sitemap><loc>https://oceanbox.com/sitemap_collections_1.xml</loc></sitemap><sitemap><loc>https://oceanbox.com/sitemap_blogs_1.xml</loc></sitemap><sitemap><loc>https://oceanbox.com/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`;
    const p = parseSitemap(index);
    expect(p.urls).toEqual([]);
    expect(p.index).toHaveLength(4);
    expect(p.index[0]).toBe("https://oceanbox.com/sitemap_products_1.xml?from=1&to=99");
    expect(sitemapOrder(p.index).map((u) => u.match(/sitemap_(\w+)_1/)?.[1])).toEqual(["collections", "pages", "products", "blogs"]);
    const urlset = `<urlset><url><loc>https://oceanbox.com/products/wild-salmon-fillets</loc><image:image><image:loc>https://cdn.shopify.com/x.jpg</image:loc></image:image></url><url><loc><![CDATA[https://oceanbox.com/collections/salmon]]></loc></url></urlset>`;
    expect(parseSitemap(urlset)).toEqual({ index: [], urls: ["https://oceanbox.com/products/wild-salmon-fillets", "https://oceanbox.com/collections/salmon"] });
  });
  it("reads robots.txt Sitemap lines", () => {
    expect(robotsSitemaps("User-agent: *\nDisallow: /cart\nSitemap: https://oceanbox.com/sitemap.xml\nsitemap:https://oceanbox.com/extra.xml")).toEqual(["https://oceanbox.com/sitemap.xml", "https://oceanbox.com/extra.xml"]);
  });
});

describe("ranking and matching", () => {
  it("ranks the page that fits the theme first, with live ads breaking ties, blogs last", () => {
    const r = rankPages(set.pages, "salmon fillets [wild salmon] buy salmon online");
    expect(r[0].page.url).toMatch(/salmon/);
    expect(r.findIndex((x) => x.page.kind === "blog")).toBeGreaterThan(r.findIndex((x) => x.page.kind === "collection"));
    const plain = rankPages(set.pages, "gift cards");
    expect(plain[plain.length - 1].page.kind).toBe("blog");
    expect(plain[0].page.url).toBe("https://oceanbox.com/collections/salmon");
    expect(rankPages(set.pages, "seafood box delivery")[0].page.url).toBe("https://oceanbox.com/collections/seafood-box");
  });
  it("maps the homepage in words", () => {
    expect(matchPage("let's use the one for the home page", set)?.url).toBe(SITE);
    expect(matchPage("just the homepage", set)?.url).toBe(SITE);
    expect(matchPage("send them to the main site", set)?.url).toBe(SITE);
  });
  it("maps a page by name, a pasted link and a bare domain", () => {
    expect(matchPage("the seafood box page", set)?.url).toBe("https://oceanbox.com/collections/seafood-box");
    expect(matchPage("the how it works page", set)?.url).toBe("https://oceanbox.com/pages/how-it-works");
    expect(matchPage("the salmon collection", set)?.url).toBe("https://oceanbox.com/collections/salmon");
    expect(matchPage("https://oceanbox.com/pages/new-thing", set)).toEqual({ url: "https://oceanbox.com/pages/new-thing", page: null, typed: true });
    expect(matchPage("oceanbox.com", set)?.url).toBe(SITE);
    expect(matchPage("the lobster page", set)).toBeNull();
  });
});

describe("the question", () => {
  const q: LaunchQuestion = { key: "final_url", question: "Which page?", why: "", proposal: "The page that matches", options: [], required: true, answer: null };
  it("offers the best pages plus the homepage, the best as the proposal, with short names", () => {
    const [out] = followLanding([q], "final_url", set, "salmon fillets");
    expect(out.proposal).toMatch(/salmon/);
    expect(out.options[0]).toBe(out.proposal);
    expect(out.options).toContain(SITE);
    expect(out.options.length).toBeLessThanOrEqual(5);
    expect(out.labels?.[SITE]).toBe("Homepage");
    expect(out.options.every((o) => o.startsWith("https://"))).toBe(true);
  });
  it("turns an answer in words into the link, and leaves it alone without pages", () => {
    const [out] = followLanding([{ ...q, answer: "the homepage" }], "final_url", set, "");
    expect(out.answer).toBe(SITE);
    expect(followLanding([q], "final_url", { site: null, pages: [], at: "" }, "x")[0]).toEqual(q);
  });
});

describe("a typed link", () => {
  it("isn't taken when it's gone", () => {
    expect(landingVerdict("https://oceanbox.com/x", SITE, { status: 404, finalUrl: null }).url).toBeNull();
  });
  it("follows a redirect and says so", () => {
    const v = landingVerdict("https://oceanbox.com/salmon", SITE, { status: 200, finalUrl: "https://oceanbox.com/collections/salmon" });
    expect(v.url).toBe("https://oceanbox.com/collections/salmon");
    expect(v.note).toMatch(/redirects/);
  });
  it("ignores a trailing-slash or www redirect, and warns on another site", () => {
    expect(landingVerdict("https://oceanbox.com/a", SITE, { status: 200, finalUrl: "https://www.oceanbox.com/a/" })).toEqual({ url: "https://oceanbox.com/a", note: null });
    expect(landingVerdict("https://other.com/a", SITE, { status: 200, finalUrl: "https://other.com/a" }).note).toMatch(/isn't the client's site/);
  });
});

describe("settling the answer after a chat turn", () => {
  it("takes the homepage the buyer named even when the chat didn't", async () => {
    const { settleLanding } = await import("@/lib/landing-pages");
    const q: LaunchQuestion = { key: "final_url", question: "Which page?", why: "", proposal: "", options: [], required: true, answer: null };
    const r = await settleLanding([q], "final_url", set, "let's use the one for the home page", false);
    expect(r.took).toBe(true);
    expect(r.questions[0].answer).toBe(SITE);
    expect(r.note).toContain(SITE);
  });
  it("clears an answer in words that matches no page", async () => {
    const { settleLanding } = await import("@/lib/landing-pages");
    const q: LaunchQuestion = { key: "final_url", question: "Which page?", why: "", proposal: "", options: [], required: true, answer: "the lobster one" };
    const r = await settleLanding([q], "final_url", set, "the lobster one", true);
    expect(r.questions[0].answer).toBeNull();
    expect(r.note).toMatch(/couldn't match/);
  });
});
