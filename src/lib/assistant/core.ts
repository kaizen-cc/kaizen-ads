// Call my assistant: the plain parts (no keys, no network), shared by the server, the call screen and the tests.
// Who a turn is for when a specialist is on the line, which specialist fits a question, what counts as a spoken yes,
// the order of "what do I need to do today", which screens and links the assistant may open, the personal memory's
// checks and greetings, and the safety review's reading and audio retention.

import { looksSensitive } from "@/lib/agent-call/core";

export const ASSISTANT_KEY = "assistant";
export const ASSISTANT_LABEL = "Assistant";

// ─── Specialists ────────────────────────────────────────────────────────────

export type Specialist = { key: string; label: string; about: string; words: RegExp };

/** The agents the assistant can call in, with what they're for and the words that point to them */
export const SPECIALISTS: readonly Specialist[] = [
  { key: "media_buyer", label: "Media Buyer", about: "Meta ads: ROAS, budgets, ad sets, fatigue, launches on Meta", words: /\b(meta|facebook|instagram|fb|ig|ad ?sets?|cpm|frequency|roas|advantage\+?|campaign budget|cbo|abo|fatigue|ads manager)\b/i },
  { key: "google_buyer", label: "Google Ads Buyer", about: "Google Ads: search, Performance Max, keywords, conversions", words: /\b(google ads|google|search ads?|pmax|performance max|keywords?|negatives?|quality score|impression share|youtube ads?)\b/i },
  { key: "email_strategist", label: "Email Strategist", about: "email and SMS strategy: calendars, flows, revenue, Klaviyo", words: /\b(email strategy|klaviyo|flows?|campaign calendar|email revenue|sms|text messages?|list growth|segments?)\b/i },
  { key: "email_creative", label: "Email Designer", about: "email design and copy: subject lines, layouts, click rates", words: /\b(subject lines?|email design|email copy|open rate|click rate|ctr on (the )?email)\b/i },
  { key: "email_builder", label: "Email Builder", about: "building emails and flows, deliverability", words: /\b(deliverability|bounces?|spam|build (the )?(email|flow)|template build)\b/i },
  { key: "creative_director", label: "Creative Director", about: "creative: concepts, reviews, what's winning and wearing out", words: /\b(creative review|concepts?|hooks?|thumb ?stop|ugc|designs?|video edits?|what creative|winning ads?)\b/i },
  { key: "copywriter", label: "Copywriter", about: "ad copy and scripts", words: /\b(ad copy|copy ?writ\w*|headlines?|primary text|scripts?|captions?)\b/i },
  { key: "strategist", label: "Strategist", about: "client strategy and briefs across lines", words: /\b(strateg\w*|brief(s|ing)? strategy|go to market|positioning|brand bible|angles?)\b/i },
  { key: "market_analyst", label: "Market Analyst", about: "what's working across clients and the market", words: /\b(competitors?|market|trends?|industry|benchmarks?|other brands)\b/i },
  { key: "social_strategist", label: "Social Strategist", about: "organic social: posts, reels, engagement, followers, the posting plan", words: /\b(organic|social posts?|posts?|reels?|stories|engagement rate|followers?|content calendar|posting plan|social media)\b/i },
  { key: "account_manager", label: "Account Manager", about: "client relationships, what's owed and how clients feel", words: /\b(client (call|relationship|happy|upset|churn)|retention|renewal|owed|follow up with the client|check-?in)\b/i },
];

export const specialistOf = (key: string | null | undefined) => SPECIALISTS.find((s) => s.key === key) ?? null;

/**
 * The specialist a question is best for, if one stands out (the most matching words wins; a tie or nothing: none).
 * The assistant only offers ("Want me to call in the Media Buyer?"); it never calls one in without a yes.
 */
export function suggestSpecialist(text: string, exclude: string | null = null): Specialist | null {
  const scored = SPECIALISTS.filter((s) => s.key !== exclude)
    .map((s) => ({ s, n: (text.match(new RegExp(s.words.source, "gi")) ?? []).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].n === scored[1].n) return null;
  return scored[0].s;
}

const TO_ASSISTANT = /^\s*(?:hey|ok(?:ay)?|so|and)?[,\s]*assistant\b|\bassistant[,:]?\s+(?:note|take a note|write (?:that|this) down|remind|add|put|log|remember)\b/i;
const HAND_BACK = /\b(?:i'?ll take it from here|that'?s all(?: i need)?(?: from you)?|you can (?:go|drop off|hop off|leave)|thanks?,? (?:that'?s it|we'?re good|you can go)|back to (?:the|my) assistant|dismiss (?:the )?(?:specialist|agent)|let (?:them|him|her) go)\b/i;

export type Route = { to: "assistant" | "guest"; dismiss: boolean };

/**
 * Who a turn is for. Without a specialist on the line it's the assistant. With one: the specialist, unless the person
 * speaks to the assistant by name ("assistant, note that") or hands the call back ("thanks, I'll take it from here"),
 * which also lets the specialist go.
 */
export function routeTurn(text: string, guest: string | null): Route {
  if (!guest) return { to: "assistant", dismiss: false };
  if (HAND_BACK.test(text)) return { to: "assistant", dismiss: true };
  if (TO_ASSISTANT.test(text)) return { to: "assistant", dismiss: false };
  return { to: "guest", dismiss: false };
}

const YES = /\b(?:yes|yeah|yep|yup|sure|go ahead|do it|go for it|please do|confirm(?:ed)?|absolutely|correct|that'?s right|send it|launch it|ship it|approved?|okay,? do|ok,? do|sounds good,? do|that(?:'d| would)? be (?:fine|great|good|perfect)|that'?s fine|that works|works for me|sounds (?:good|great|perfect)|perfect|let'?s do it)\b/i;
const NO = /\b(?:no|nope|don'?t|do not|wait|hold on|stop|cancel|not yet|never ?mind)\b/i;

/**
 * Whether what the person just said is a clear yes. Anything that sends to a client, spends money or credits or goes
 * live runs only on a turn that is a spoken yes (and not a no: "yes, but wait" is not a yes).
 */
export function saidYes(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (NO.test(t)) return false;
  return YES.test(t);
}

// ─── What do I need to do today ─────────────────────────────────────────────

export type DayItem = { id: string; tier: "critical" | "high" | "normal"; title: string; kind: string; score?: number };

/** How much work an item is, from its kind and wording: 1 a quick look or reply, up to 4 an audit or a launch */
export function effortOf(i: Pick<DayItem, "kind" | "title">): number {
  const t = `${i.kind} ${i.title}`.toLowerCase();
  if (/\b(audit|launch|build|report|deck|strategy|sprint)\b/.test(t)) return 4;
  if (/\b(make|write|design|edit|brief|copy|produc)/.test(t)) return 3;
  if (/\b(chase|send|follow|call|ask|move)\b/.test(t)) return 2;
  return 1;
}

const TIER_RANK = { critical: 0, high: 1, normal: 2 } as const;

/**
 * "What do I need to do today?": the critical items first (most at risk first), then everything else from simple to
 * complex, so quick wins clear before the long work. Ties keep their order.
 */
export function orderForToday<T extends DayItem>(items: readonly T[]): T[] {
  const critical = items.filter((i) => i.tier === "critical").sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rest = items
    .map((i, at) => ({ i, at }))
    .filter((x) => x.i.tier !== "critical")
    .sort((a, b) => effortOf(a.i) - effortOf(b.i) || TIER_RANK[a.i.tier] - TIER_RANK[b.i.tier] || a.at - b.at)
    .map((x) => x.i);
  return [...critical, ...rest];
}

// ─── Screens and links ──────────────────────────────────────────────────────

/** The places in the app the assistant may open during a call */
const APP_PREFIXES = ["/pipeline", "/board", "/clients", "/kpis", "/reports", "/ai", "/ideas", "/lab", "/settings", "/feedback", "/assistant", "/requests", "/winners", "/market", "/notifications", "/fatigue", "/team", "/next", "/profile", "/watch", "/csuite", "/copy"];

/**
 * The named places open_screen knows (each screen's own address, with its URL state where a place is a view inside a
 * page: a Settings tab, the Email or Social KPI board, the assistant's settings or what it knows)
 */
export const SCREEN_PLACES: Record<string, string> = {
  overview: "/pipeline",
  // Emails drafted for the person to send to clients, on their Overview
  "emails ready to send": "/pipeline#emails-ready",
  // The executives' weekly account review, each step its own address
  "account review": "/kpis?p=review",
  "account review scorecard": "/kpis?p=review&step=scorecard",
  "account review critical accounts": "/kpis?p=review&step=critical",
  "account review issues": "/kpis?p=review&step=issues",
  "account review upsells": "/kpis?p=review&step=upsell",
  "account review financial": "/kpis?p=review&step=financial",
  "account review to-dos": "/kpis?p=review&step=todos",
  // The Overview's tabs (?tab=): the email and social teams have all of them, the other teams Today and My work
  "overview clients": "/pipeline?tab=clients",
  "overview campaign ideas": "/pipeline?tab=ideas",
  "overview audits and sprints": "/pipeline?tab=audits",
  "overview setup": "/pipeline?tab=setup",
  "overview my work": "/pipeline?tab=work",
  "overview watch": "/pipeline?tab=watch",
  // The account watch, each tab its own address
  "account watch": "/watch",
  "account watch idle": "/watch",
  "account watch accounts": "/watch?tab=accounts",
  "account watch creative": "/watch?tab=creative",
  "account watch people": "/watch?tab=people",
  "account watch billing": "/watch?tab=billing",
  "stripe check": "/watch?tab=billing",
  "account watch paused": "/watch?tab=paused",
  boards: "/board",
  "creative board": "/board",
  "email board": "/board/email",
  "new email request": "/board/email/new",
  // The team KPI boards, each tab its own address (execs and the line heads; the page checks)
  "email team kpis": "/board/email?view=kpis&tab=design",
  "email team kpis design": "/board/email?view=kpis&tab=design",
  "email team kpis build": "/board/email?view=kpis&tab=build",
  "email team kpis copy": "/board/email?view=kpis&tab=copy",
  "email team kpis strategy": "/board/email?view=kpis&tab=strategy",
  "creative team kpis": "/board?view=kpis&tab=design",
  "creative team kpis design": "/board?view=kpis&tab=design",
  "creative team kpis video": "/board?view=kpis&tab=video",
  "creative team kpis copy": "/board?view=kpis&tab=copy",
  "new brief": "/requests/new",
  clients: "/clients",
  // The Clients list in a meeting's order (?sort=), each line's tab narrowing it to that line's KPI
  "clients most critical": "/clients?sort=critical",
  "clients best performing": "/clients?sort=best",
  "clients by name": "/clients?sort=name",
  "clients off target": "/clients?sort=critical&kpi=off",
  "meta clients most critical": "/clients?sort=critical&filter=facebook-ads",
  "google clients most critical": "/clients?sort=critical&filter=google-ads",
  "email clients most critical": "/clients?sort=critical&filter=email-marketing",
  "social clients most critical": "/clients?sort=critical&filter=social-media",
  kpis: "/kpis",
  "meta kpis": "/kpis?p=meta",
  "google kpis": "/kpis?p=google",
  "tiktok kpis": "/kpis?p=tiktok",
  "email kpis": "/kpis?p=email",
  "social kpis": "/kpis?p=social",
  reports: "/reports",
  "kaizen ai": "/ai",
  ideas: "/ideas",
  "ads lab": "/lab",
  market: "/market",
  winners: "/winners",
  fatigue: "/fatigue",
  feedback: "/feedback",
  notifications: "/notifications",
  team: "/team",
  settings: "/settings",
  "settings ai agents": "/settings?tab=agents",
  "settings team": "/settings?tab=team",
  "settings raw data": "/settings?tab=data",
  "settings sync health": "/settings?tab=sync",
  "settings connections": "/settings?tab=connections",
  "settings errors": "/settings?tab=errors",
  "settings deleted": "/settings?tab=deleted",
  "my assistant": "/assistant",
  "assistant settings": "/assistant#make-it-yours",
  // Ring me or chat only, and quiet hours, for urgent heads-ups
  "urgent call settings": "/assistant#ring-title",
  "what my assistant knows": "/assistant?tab=memory",
};

/** A card's tabs on the ads KPI board, and on the Email and Social sheets */
export const KPI_CARD_TABS = ["overview", "numbers", "actions", "policy", "creative", "notes", "settings"] as const;
export const CHANNEL_SHEET_TABS = ["overview", "numbers", "campaigns", "flows", "posts", "actions", "notes", "settings"] as const;

/** One account's card on the ads KPI board, open on a tab (?target= opens it, with everyone's accounts showing) */
export function kpiCardHref(targetId: string, tab?: string | null): string {
  const t = tab && (KPI_CARD_TABS as readonly string[]).includes(tab) && tab !== "overview" ? `&tab=${tab}` : "";
  return `/kpis?target=${encodeURIComponent(targetId)}${t}`;
}

/** A client's sheet on the Email or Social KPI board, open on a tab */
export function channelSheetHref(line: "email" | "social", clientId: string, tab?: string | null): string {
  const t = tab && (CHANNEL_SHEET_TABS as readonly string[]).includes(tab) && tab !== "overview" ? `&tab=${tab}` : "";
  return `/kpis?p=${line}&open=${encodeURIComponent(clientId)}${t}`;
}

/** An in-app address the assistant may open (its path checked against the app's places), or null */
export function safeAppPath(href: unknown): string | null {
  const s = String(href ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || /[\s<>"']/.test(s)) return null;
  const path = s.split(/[?#]/)[0];
  if (path.split("/").some((p) => p === "..")) return null;
  return APP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ? s.slice(0, 500) : null;
}

/** Outside sites a link card may open in a new tab: the ad platforms, Klaviyo and Google's docs */
const LINK_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|google\.com|klaviyo\.com|tiktok\.com|loom\.com|youtube\.com)$/i;

/** The app's own host name (from its public address), so a full link to it opens in the app */
function appHost(): string | null {
  try {
    return process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname : null;
  } catch {
    return null;
  }
}

/** A link card's address: in the app, or a known outside site over https (opened in a new tab), else null */
export function safeLink(href: unknown): { href: string; external: boolean } | null {
  const inApp = safeAppPath(href);
  if (inApp) return { href: inApp, external: false };
  try {
    const u = new URL(String(href ?? ""));
    // A full link to the app itself opens in the app (with the call kept up), not in a new tab
    const own = appHost();
    if (own && u.hostname === own) {
      const path = safeAppPath(`${u.pathname}${u.search}${u.hash}`);
      if (path) return { href: path, external: false };
    }
    if (u.protocol !== "https:" || u.username || u.password || !LINK_HOSTS.test(u.hostname)) return null;
    return { href: u.toString().slice(0, 1000), external: true };
  } catch {
    return null;
  }
}

// ─── Personal memory ────────────────────────────────────────────────────────

export const FACT_TOPICS = ["birthday", "family", "trip", "preference", "work", "hobby", "likes", "needs", "goals", "focus", "routine", "uses", "favorites", "other"] as const;

/**
 * Casual questions the assistant drops in now and then at the start of a call, like a friend would ("so I've been
 * thinking since we last talked, what's your favorite movie?"). Each is asked once; the answer is kept under favorites
 * and used later in conversation and for the odd analogy. The key is what the saved note starts with.
 */
export const CASUAL: { key: string; ask: string }[] = [
  { key: "Favorite movie", ask: "what's your all-time favorite movie?" },
  { key: "Favorite food", ask: "what's the one meal you'd never get tired of?" },
  { key: "Music", ask: "what have you had on repeat lately?" },
  { key: "Favorite show", ask: "what's the last show you binged?" },
  { key: "Sports team", ask: "do you root for a team? Which one?" },
  { key: "Coffee", ask: "coffee or tea, and how do you take it?" },
  { key: "Dream trip", ask: "if you could be anywhere in the world next week, where?" },
  { key: "Weekend", ask: "what's your ideal Saturday look like?" },
  { key: "Childhood dream job", ask: "what did you want to be when you were a kid?" },
  { key: "Hidden talent", ask: "got a hidden talent most people at work don't know about?" },
];

/** About one call in three that starts fresh or a few hours later, a casual question they haven't been asked yet */
export function casualFor(memory: readonly Pick<MemoryRow, "kind" | "topic" | "body">[], seed: number): { key: string; ask: string } | null {
  if (Math.abs(seed) % 3 !== 0) return null;
  const known = memory.filter((m) => m.kind === "fact" && m.topic === "favorites").map((m) => m.body.toLowerCase());
  const left = CASUAL.filter((c) => !known.some((b) => b.startsWith(c.key.toLowerCase())));
  return left.length ? left[Math.abs(seed >> 3) % left.length] : null;
}

/**
 * Getting to know them at work, asked on the first call and over the next ones until each is known: what they love
 * about the job, what they need help with, what they're working toward, the clients they find hard or want to watch,
 * their day's rhythm, and what they'll use the assistant for. The memory grows from every call after that.
 */
export const DISCOVERY: { topic: string; ask: string }[] = [
  { topic: "likes", ask: "what they enjoy most about their job" },
  { topic: "needs", ask: "what eats their time or what they'd most like help with" },
  { topic: "focus", ask: "which clients are the most challenging right now, or the ones they want to keep a close eye on" },
  { topic: "goals", ask: "what they're working toward this quarter (for themselves or their clients)" },
  { topic: "routine", ask: "how their day usually runs and when a rundown from you would help most" },
  { topic: "uses", ask: "what they picture using you for day to day" },
];

/** The discovery questions not answered yet, in order (an empty list: they're known, just talk) */
export function discoveryLeft(memory: readonly Pick<MemoryRow, "kind" | "topic">[]): { topic: string; ask: string }[] {
  const known = new Set(memory.filter((m) => m.kind === "fact").map((m) => m.topic));
  return DISCOVERY.filter((d) => !known.has(d.topic));
}
export const STYLE_TOPICS = ["length", "humor", "numbers", "pace", "other"] as const;

export type MemoryRow = { id: string; profile_id: string; kind: "fact" | "style"; topic: string; body: string; on_date: string | null; follow_up_on: string | null; followed_up_at: string | null };
export type MemoryNote = { kind: "fact" | "style"; topic: string; body: string; on_date: string | null; follow_up_on: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Health, beliefs and the like: never kept, even when said (the assistant is a work buddy, not a profile) */
const SPECIAL = /\b(diagnos\w*|illness|disease|medication|therapy|pregnan\w*|religio\w*|church|mosque|synagogue|politic\w*|vote[ds]?|sexual\w*|immigration status|salary|debt)\b/i;

/**
 * What the after-call read says to remember, checked before anything is saved: only facts the person said about
 * themselves and how they talk, nothing secret or sensitive (keys, numbers, health, beliefs), real dates only, no
 * repeats of what's already kept, at most six.
 */
export function cleanMemory(raw: unknown, existing: readonly Pick<MemoryRow, "kind" | "topic" | "body">[] = []): MemoryNote[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { notes?: unknown }).notes) ? (raw as { notes: unknown[] }).notes : [];
  const seen = new Set(existing.map((m) => `${m.kind}:${m.body.toLowerCase()}`));
  const out: MemoryNote[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const kind = r.kind === "style" ? "style" : r.kind === "fact" ? "fact" : null;
    if (!kind) continue;
    const topics: readonly string[] = kind === "fact" ? FACT_TOPICS : STYLE_TOPICS;
    const topic = topics.includes(String(r.topic)) ? String(r.topic) : "other";
    const body = clip(r.body, 300);
    if (body.length < 4 || looksSensitive(body) || SPECIAL.test(body)) continue;
    const key = `${kind}:${body.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const on = DAY.test(String(r.on_date ?? "")) ? String(r.on_date) : null;
    const follow = DAY.test(String(r.follow_up_on ?? "")) ? String(r.follow_up_on) : null;
    out.push({ kind, topic, body, on_date: on, follow_up_on: kind === "fact" ? follow : null });
    if (out.length >= 6) break;
  }
  return out;
}

/** A person's memory as anyone reads it: only their own rows, whoever is asking (an exec included) */
export function ownMemory<T extends Pick<MemoryRow, "profile_id">>(rows: readonly T[], viewerId: string): T[] {
  return rows.filter((r) => r.profile_id === viewerId);
}

const mmdd = (d: string) => d.slice(5, 10);

/** The memory as the assistant reads it each turn: how they like to talk first, then what they've shared */
export function memoryForPrompt(rows: readonly MemoryRow[], today: string): string {
  if (!rows.length) return "";
  const style = rows.filter((r) => r.kind === "style").map((r) => `- ${r.topic}: ${r.body}`);
  const facts = rows
    .filter((r) => r.kind === "fact")
    .slice(0, 40)
    .map((r) => `- ${r.topic}: ${r.body}${r.on_date ? ` (${r.topic === "birthday" ? `on ${mmdd(r.on_date)}${mmdd(r.on_date) === mmdd(today) ? ", that's today" : ""}` : r.on_date})` : ""}`);
  return [style.length ? `How they like to talk:\n${style.join("\n")}` : "", facts.length ? `What they've told you:\n${facts.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

/**
 * The assistant's hello: a happy birthday on the day, else a question about something they mentioned that's due
 * ("How was the trip to Lisbon?"), else a warm plain hello. `followed` is the memory row asked about (marked so it's
 * asked once).
 */
export function assistantGreeting(input: {
  name: string;
  memory: readonly MemoryRow[];
  today: string;
  seed?: number;
  /** How this call follows the last one (the same timing the agents' calls use) */
  mode?: "continue" | "again" | "soon" | "later_today" | "fresh";
  /** The agents' timing hello for that mode ("Hey again! Good to hear from you so soon"), used for soon and later today */
  timed?: string | null;
  /** The hour in New York, for a hello that fits the time of day */
  hour?: number;
}): { text: string; followed: string | null } {
  const { name, memory, today } = input;
  const seed = Math.abs(input.seed ?? 0);
  const birthday = memory.find((m) => m.kind === "fact" && m.topic === "birthday" && m.on_date && mmdd(m.on_date) === mmdd(today));
  if (birthday) return { text: `Happy birthday, ${name}! I hope it's a good one. What can I take off your plate today?`, followed: null };
  // Called back a few hours later, or again late in the day: the same hellos the agents use, so it feels like one person
  if ((input.mode === "soon" || input.mode === "later_today") && input.timed && memory.length) return { text: input.timed, followed: null };
  // Back a few minutes after ending it themselves: a casual "hey again", never a fresh hello or a getting-to-know-you
  if (input.mode === "again" && input.timed) return { text: input.timed, followed: null };
  const due = memory
    .filter((m) => m.kind === "fact" && m.follow_up_on && m.follow_up_on <= today && !m.followed_up_at)
    .sort((a, b) => String(b.follow_up_on).localeCompare(String(a.follow_up_on)))[0];
  if (due) {
    const about = due.body.replace(/[.!?\s]+$/, "");
    const ask = due.topic === "trip" ? `How was ${/^(the|a|your|my)\b/i.test(about) ? about.replace(/^my\b/i, "your") : `the trip: ${about}`}?` : `Last time you mentioned ${about.replace(/^(i|i'm|i am)\b/i, "you")}. How did that go?`;
    return { text: `Hey ${name}! ${ask}`, followed: due.id };
  }
  // The very first call: hello, and ask to get to know them before diving in
  if (!memory.length) return { text: `Hey ${name}! I'm your new assistant. Before we dive in, mind if I ask you a few quick questions so I can actually be useful to you?`, followed: null };
  // Now and then, instead of a plain hello, a casual question (after birthdays, call-backs and follow-ups, never on the first call)
  const casual = memory.length && input.mode !== "continue" ? casualFor(memory, seed) : null;
  if (casual) {
    const lead = [`Hey ${name}! Random one before we start: I've been thinking since we last talked,`, `Hi ${name}! Quick one first, totally unrelated:`, `Hey ${name}! Before anything else, I've been curious:`];
    return { text: `${lead[seed % lead.length]} ${casual.ask}`, followed: null };
  }
  // A fresh start: a hello that fits the time of day (a morning call usually wants the day's rundown)
  const h = input.hour ?? 12;
  const plain =
    h < 12
      ? [`Morning, ${name}! Want the rundown of your day, or something specific?`, `Good morning, ${name}. Ready to plan the day?`]
      : h < 17
        ? [`Hey ${name}, it's your assistant. What can I do for you?`, `Hi ${name}! What are we tackling this afternoon?`]
        : [`Hey ${name}, working late? What can I help you wrap up?`, `Evening, ${name}. Want a quick look at what's left for today, or tomorrow's plan?`];
  return { text: plain[seed % plain.length], followed: null };
}

// ─── Safety review ──────────────────────────────────────────────────────────

/** What the review looks for: genuinely concerning content only, never ordinary frustration or swearing */
export const SAFETY_CATEGORIES = ["threat", "harassment", "discrimination", "confidential_data", "fraud", "deceiving_clients", "distress"] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export type SafetyMoment = { at_seconds: number; category: SafetyCategory; note: string };
export type SafetyResult = { flagged: boolean; categories: SafetyCategory[]; severity: "low" | "medium" | "high" | null; summary: string; moments: SafetyMoment[]; distress: boolean };

export const SAFETY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flagged", "categories", "severity", "summary", "moments", "distress"],
  properties: {
    flagged: { type: "boolean" },
    categories: { type: "array", items: { type: "string", enum: [...SAFETY_CATEGORIES] } },
    severity: { type: "string", enum: ["none", "low", "medium", "high"] },
    summary: { type: "string", description: "One or two plain sentences on what is concerning, empty when nothing is" },
    moments: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["at_seconds", "category", "note"], properties: { at_seconds: { type: "number" }, category: { type: "string", enum: [...SAFETY_CATEGORIES] }, note: { type: "string" } } },
    },
    distress: { type: "boolean", description: "The person sounds in genuine personal distress (not just a busy or annoyed day)" },
  },
};

/**
 * The review's answer, checked: only the listed categories; flagged only when there is a category (distress counts);
 * moments within the call's length, at most ten. A malformed answer flags nothing (it is retried by the cron).
 */
export function parseSafetyReview(raw: unknown, callSeconds = Infinity): SafetyResult {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const cats = Array.isArray(r.categories) ? [...new Set(r.categories.filter((c): c is SafetyCategory => SAFETY_CATEGORIES.includes(c as SafetyCategory)))] : [];
  const distress = r.distress === true || cats.includes("distress");
  if (distress && !cats.includes("distress")) cats.push("distress");
  const flagged = r.flagged === true && cats.length > 0;
  const moments = (Array.isArray(r.moments) ? r.moments : [])
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
    .filter((m) => SAFETY_CATEGORIES.includes(m.category as SafetyCategory) && Number.isFinite(Number(m.at_seconds)))
    .map((m) => ({ at_seconds: Math.max(0, Math.min(Math.round(Number(m.at_seconds)), Number.isFinite(callSeconds) ? callSeconds : Number.MAX_SAFE_INTEGER)), category: m.category as SafetyCategory, note: clip(m.note, 300) }))
    .slice(0, 10);
  const sev = r.severity === "low" || r.severity === "medium" || r.severity === "high" ? r.severity : null;
  return { flagged, categories: flagged ? cats : [], severity: flagged ? (sev ?? "low") : null, summary: flagged ? clip(r.summary, 600) : "", moments: flagged ? moments : [], distress: flagged && distress };
}

/** Flagged audio is kept this many days; everything else is deleted right after the review */
export const FLAGGED_AUDIO_DAYS = 90;
/** Audio of a call whose review never ran is deleted after this many days anyway (the review retries until then) */
export const UNREVIEWED_AUDIO_DAYS = 2;

/** When a call's audio must be deleted: about 90 days after a flagged review, right away for an unflagged one */
export function audioDeleteAfter(flagged: boolean, reviewedAt: Date): Date {
  return flagged ? new Date(reviewedAt.getTime() + FLAGGED_AUDIO_DAYS * 86_400_000) : reviewedAt;
}

/** Whether a call's audio should go now: its review's date has passed, or it was never reviewed and is too old */
export function audioDue(c: { endedAt: string | null; deleteAfter: string | null; deletedAt: string | null }, now = new Date()): boolean {
  if (c.deletedAt) return false;
  if (c.deleteAfter) return Date.parse(c.deleteAfter) <= now.getTime();
  return Boolean(c.endedAt) && now.getTime() - Date.parse(c.endedAt as string) > UNREVIEWED_AUDIO_DAYS * 86_400_000;
}

/** "[2:13] Name: words" for each line, timed from the call's start (what the review and the execs' page read) */
export function timedTranscript(rows: readonly { who: string; text: string; at: string }[], startedAt: string): string {
  const t0 = Date.parse(startedAt);
  return rows
    .map((r) => {
      const s = Math.max(0, Math.round((Date.parse(r.at) - t0) / 1000));
      return `[${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}] ${r.who}: ${r.text}`;
    })
    .join("\n");
}

/** The audio part a moment falls in, and where in it (parts are recorded back to back, each `partSeconds` long) */
export function partAt(atSeconds: number, partSeconds: number): { part: number; offset: number } {
  const part = Math.max(0, Math.floor(atSeconds / partSeconds));
  return { part, offset: Math.max(0, atSeconds - part * partSeconds) };
}

/** Length of one recorded audio part, in seconds (each part is a whole file, so a dropped call loses one part at most) */
export const AUDIO_PART_SECONDS = 120;
