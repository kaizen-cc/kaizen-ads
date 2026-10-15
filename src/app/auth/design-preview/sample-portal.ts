import type { Ad } from "@/lib/copy";
import type { PortalData } from "@/lib/portal";

// Design preview: a client portal with drawn placeholder creatives (no real files).

const art = (w: number, h: number, bg: string, fg: string, line1: string, line2: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${bg}"/><circle cx="${w * 0.72}" cy="${h * 0.62}" r="${w * 0.26}" fill="${fg}" opacity=".22"/><text x="${w * 0.08}" y="${h * 0.2}" font-family="Arial Black,Arial" font-weight="900" font-size="${w * 0.1}" fill="${fg}">${line1}</text><text x="${w * 0.08}" y="${h * 0.31}" font-family="Arial Black,Arial" font-weight="900" font-size="${w * 0.1}" fill="${fg}">${line2}</text><rect x="${w * 0.08}" y="${h * 0.84}" width="${w * 0.36}" height="${h * 0.07}" rx="${h * 0.035}" fill="${fg}"/></svg>`,
  )}`;

const file = (id: string, aspect: "4x5" | "1x1" | "9x16", bg: string, fg: string, l1: string, l2: string) => {
  const [w, h] = aspect === "4x5" ? [1080, 1350] : aspect === "1x1" ? [1080, 1080] : [1080, 1920];
  const url = art(w, h, bg, fg, l1, l2);
  return { id, url, thumbUrl: url, aspect, mime: "image/svg+xml", width: w, height: h, card: null };
};

const ad = (kind: "short" | "long", primaryText: string, headline: string, linkDescription: string, cta: string): Ad => ({ kind, formula: "", angle: "", primaryText, headline, linkDescription, cta });

const ADS: Ad[] = [
  ad("short", "Two large pizzas, one free calzone. Friday night, sorted. 🍕", "2 Pizzas In, Calzone Free", "This week only", "Order Now"),
  ad("short", "The cheese pull you've been thinking about all week is 20 minutes away.", "Hot, Fresh, Yours", "Order online", "Order Now"),
  ad("short", "Family night shouldn't need a plan. It needs two pizzas and a calzone on us.", "Family Night, Covered", "Pick up or delivery", "Order Now"),
  ad("long", Array.from({ length: 14 }, (_, i) => (i % 3 === 0 ? "Friday night used to mean a debate about where to order from. Then someone found the Weekly Deal, and the debate was over before it started." : i % 3 === 1 ? "Two large pizzas, made the way they've been made for twenty years, and a calzone on us. It's the kind of deal that makes the whole table quiet for a minute." : "Order online in under a minute, pick it up hot, or have it at your door in about thirty.")).join("\n\n"), "The Friday Night Deal", "Two pizzas, calzone free", "Order Now"),
];

export const samplePortal: PortalData = {
  items: [
    {
      id: "p1",
      number: 1044,
      title: "Weekly Deals · Calzone free",
      format: "image",
      designs: [
        { id: "d1", position: 1, name: "Calzone pull", isVariation: false, version: 2, files: [file("f1", "4x5", "#b21e2c", "#fff4e0", "2 PIZZAS IN.", "CALZONE FREE."), file("f2", "9x16", "#b21e2c", "#fff4e0", "2 PIZZAS IN.", "CALZONE FREE.")], clientStatus: null },
        { id: "d2", position: 2, name: "Calzone pull · yellow", isVariation: true, version: 1, files: [file("f3", "4x5", "#f5c400", "#1b1b1b", "FRIDAY NIGHT,", "SORTED.")], clientStatus: null },
      ],
      ads: ADS.map((ad) => ({ ad, status: null })),
      revised: null,
      landingUrl: "https://crustpizza.com/weekly-deals",
      summary: {
        why: "Weekly Deals is your biggest traffic driver, and this week's offer (two large pizzas, a calzone free) is the strongest yet. We want it in front of hungry locals before Friday.",
        audience: "Families within 10 miles who order dinner on Thursdays and Fridays, plus people who visited the menu page in the last month.",
        strategy: "Lead with the cheese pull, put the offer in the first three words, and make ordering one tap. One variation tests a brighter look to see what stops the scroll.",
      },
    },
    {
      id: "p2",
      number: 1039,
      title: "Rewards · Join and get $5",
      format: "image",
      designs: [{ id: "d3", position: 1, name: "Rewards card", isVariation: false, version: 3, files: [file("f4", "1x1", "#14213d", "#fca311", "JOIN CRUST", "REWARDS")], clientStatus: "changes" }],
      ads: [{ ad: ADS[0], status: "approved" }, { ad: ADS[1], status: "changes" }],
      landingUrl: "https://crustpizza.com/rewards",
      summary: null,
      revised: {
        round: 1,
        changes: [
          { asked: "Make the logo bigger", changed: "The logo is now twice the size, top left, on every size." },
          { asked: "Don't say 'cheap' in the copy", changed: "Removed 'cheap' from both ads and led with the $5 instead." },
        ],
      },
    },
  ],
  revising: [{ id: "r1", title: "Donation Program · in-store poster", note: "You asked: make the Crust & St Jude logos larger", thumbUrl: art(400, 400, "#2a9d8f", "#ffffff", "GIVE", "BACK") }],
  approved: [{ id: "a1", title: "Spooky Monster · 2 designs", note: "Approved Oct 10 · we're setting it up", thumbUrl: art(400, 400, "#3a0ca3", "#f72585", "SPOOKY", "SLICE") }],
  running: {
    syncedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    ads: [
      { id: "m1", name: "Pick 2", headline: "Pick 2 for $12", text: null, thumbnail: art(400, 500, "#e63946", "#fff", "PICK 2", "FOR $12") },
      { id: "m2", name: "Pepperoni Roll", headline: "Pepperoni Roll", text: null, thumbnail: art(400, 500, "#f4a261", "#1d3557", "PEPPERONI", "ROLL") },
      { id: "m3", name: "Rewards", headline: "Crust Rewards", text: null, thumbnail: art(400, 500, "#264653", "#e9c46a", "REWARDS", "") },
    ],
  },
};
