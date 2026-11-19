import type { ClientRow, WeekLine } from "@/app/(team)/pipeline/views/creative-client-rows";
import type { OpenSuggestion } from "@/lib/suggestions";

// The creative leads' Clients tab with sample clients in every group (the design preview, development only)

const brief = (id: string, clientId: string, client: string, o: { title: string; hook: string; source: string; trigger: string; quote: string; format: "image" | "video" | "carousel"; n: number; v: number; thumb?: string | null; deadline?: string | null; track?: "iterate" | "net_new" }): OpenSuggestion =>
  ({
    id,
    clientId,
    client,
    clientSlug: client.toLowerCase().replace(/[^a-z]+/g, "-"),
    kind: o.trigger === "offer" ? "offer" : o.trigger === "fatigue" ? "fatigue" : "pacing",
    signal: o.quote,
    evidence: [o.quote],
    why: "",
    draft: { title: o.title, angle: "", audience: "", brief: "Sample", hooks: [o.hook], concepts: [{ name: o.title, hook: o.hook, visual: "", copy: "" }], formats: [{ format: o.format, new: o.n, variations: o.v, ...(o.format === "carousel" ? { cards: 5 } : {}) }], sizes: ["4x5", "9x16"], landing: "" },
    version: 1,
    createdAt: new Date().toISOString(),
    allotment: null,
    source: o.thumb ? { thumbnail: o.thumb, headline: o.title, client: "" } : null,
    batch: null,
    messages: [],
    drafted: { trigger: o.trigger, deadline: o.deadline ?? null, urgent: Boolean(o.deadline), mix: { track: o.track ?? "net_new", iterate: 40, netNew: 60, state: "behind", reason: "" }, pace: null, citation: { source: o.source as never, ref: null, quote: o.quote, at: null, numbers: null }, askedBy: o.trigger === "offer" ? "client" : "creative" },
  }) as OpenSuggestion;

const noBrand = { color: null, logo: null, light: false };
const pool = (p: Partial<ClientRow["pools"][number]> & { pool: "images" | "videos"; cap: number; requested: number }): ClientRow["pools"][number] => {
  const missing = Math.max(0, p.cap - p.requested);
  const over = Math.max(0, p.requested - p.cap);
  return {
    line: "",
    pace: missing ? `${p.dueThisWeek ?? 0} this week to catch up at a healthy pace` : "Nothing more to brief this cycle",
    detail: "",
    inMotion: Math.round(p.requested * 0.4),
    delivered: Math.round(p.requested * 0.6),
    missing,
    over,
    dueThisWeek: 0,
    state: over ? "over" : missing ? (p.requested ? "missing" : "nothing") : "covered",
    elapsed: 0.7,
    daysLeft: 9,
    urgent: false,
    nothing: p.requested === 0,
    format: p.pool === "videos" ? "video" : "image",
    ...p,
  };
};

export const sampleWeek: WeekLine[] = [
  { pool: "images", due: 42, capacity: 36, line: "" },
  { pool: "videos", due: 18, capacity: 20, line: "" },
];

export const sampleCreativeRows: ClientRow[] = [
  {
    clientId: "c1",
    client: "Best Tickets",
    slug: "best-tickets",
    brand: { color: "#2f6fed", logo: null, light: false },
    group: "now",
    pools: [pool({ pool: "images", cap: 25, requested: 4, dueThisWeek: 17, urgent: true, pace: "17 this week to catch up at a healthy pace" })],
    fresh: null,
    watch: [{ id: "w1", title: "Spending with nothing new in 3 weeks", severity: "warn", href: "/watch" }],
    ideas: [
      brief("b1", "c1", "Best Tickets", { title: "Courtside for less: resale price drop", hook: "Courtside tonight for less than the nosebleeds last week", source: "market", trigger: "pacing", quote: 'StubHub: "Last-minute seats, real prices", running 64 days', format: "image", n: 2, v: 2, thumb: "https://images.unsplash.com/photo-1504450758481-7338eba7524a?w=200&q=60" }),
      brief("b2", "c1", "Best Tickets", { title: "Price-lock guarantee, UGC style", hook: "I paid $40 less than my friend for the same row", source: "peer", trigger: "pacing", quote: 'A ticketing client\'s ad "Same seats, lower price": 2.4x better cost per purchase than its account\'s usual', format: "video", n: 1, v: 2, track: "iterate" }),
    ],
    noBriefsWhy: null,
  },
  {
    clientId: "c2",
    client: "Kaizen (sandbox)",
    slug: "kaizen-sandbox",
    brand: noBrand,
    group: "now",
    pools: [pool({ pool: "images", cap: 10, requested: 0, dueThisWeek: 8, pace: "8 this week to catch up at a healthy pace" })],
    fresh: null,
    watch: [],
    ideas: [brief("b3", "c2", "Kaizen (sandbox)", { title: "Black Friday 30% off statics", hook: "30% off everything, this weekend only", source: "email", trigger: "offer", quote: "Can we push 30% off for Black Friday? It starts Friday.", format: "carousel", n: 1, v: 1, deadline: "2026-11-27" })],
    noBriefsWhy: null,
  },
  {
    clientId: "c3",
    client: "Limelight Entertainment",
    slug: "limelight-entertainment",
    brand: { color: "#c0399b", logo: null, light: false },
    group: "pace",
    pools: [pool({ pool: "images", cap: 50, requested: 38 }), pool({ pool: "videos", cap: 10, requested: 7 })],
    fresh: null,
    watch: [],
    ideas: [],
    noBriefsWhy: null,
  },
  {
    clientId: "c4",
    client: "Sierra Dreams",
    slug: "sierra-dreams",
    brand: { color: "#2c9d6b", logo: null, light: false },
    group: "over",
    pools: [pool({ pool: "images", cap: 25, requested: 34 })],
    fresh: null,
    watch: [],
    ideas: [],
    noBriefsWhy: "No briefs suggested: over the allotment by 9 images this cycle (34 of 25)",
  },
  {
    clientId: "c5",
    client: "Nectr",
    slug: "nectr",
    brand: noBrand,
    group: "covered",
    pools: [pool({ pool: "images", cap: 10, requested: 10 })],
    fresh: null,
    watch: [],
    ideas: [],
    noBriefsWhy: null,
  },
  {
    clientId: "c6",
    client: "Crust Pizza Co.",
    slug: "crust-pizza-co",
    brand: { color: "#e2852f", logo: null, light: false },
    group: "covered",
    pools: [pool({ pool: "videos", cap: 4, requested: 4 })],
    fresh: null,
    watch: [],
    ideas: [],
    noBriefsWhy: null,
  },
];
