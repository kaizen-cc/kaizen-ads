import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { draws } from "@/lib/allotment";
import { cycleFor } from "@/lib/creative-allotments";
import { describeFatigue } from "@/lib/fatigue";
import { LIVE } from "@/lib/live";
import { linesOf, lineOfPlatform } from "@/lib/service-gate";
import type { Signal, SuggestionDraft } from "@/lib/suggestions";
import {
  accountState,
  churning,
  cleanDeadline,
  groupByClient,
  hasRealReason,
  isoWeek,
  leadsFor,
  mixFor,
  pacingTake,
  paceFor,
  pickTrack,
  swapVerdict,
  outranks,
  TRACK_LABEL,
  weekPace,
  type AskedBy,
  type Citation,
  type Mix,
  type Pace,
  type Track,
  type Trigger,
} from "@/lib/brief-drafting-core";

// The system writes the creative briefs, the team approves them (the Nov 19 2026 meeting: "this thing should be
// developing ideas for you, not you giving it the ideas"). The rules are in src/lib/brief-drafting-core.ts; here:
// * runDrafting: looks for a reason to brief, client by client, and drafts one full brief per reason (never a batch):
//   a time-sensitive ask heard on a call, in Slack or email (with its deadline), hard fatigue, a KPI dropping, or the
//   allotment falling behind its even line this week. Each cites the data that set it off.
// * The creative leads hear about each draft in Kaizen OS (no Slack DMs for internal work); it waits on their
//   Overview, on the request form's "Ready to approve" list and on the client page until someone approves, edits or
//   rejects it with a reason (the strategist reads every reason).
// * approveDrafted: the creative leads, the account's media buyer, the head of Meta and the executives push it
//   through; it lands in Asana (the Creative board's usual task) for now, Kaizen tickets when Asana isn't connected.
// * swapIn: a new brief takes another's slot only when that one isn't made yet; work in production is adapted (a
//   direction change on it), never restarted, and a client churning the work (3+ swaps a cycle) warns the leads.

type Db = SupabaseClient;
const today = () => new Date().toISOString().slice(0, 10);
const OFFER = /\b(offer|promo|promotion|sale|discount|% ?off|deal|bogo|special|launch(ing)?|new (menu|product|service|location|collection)|holiday|black friday|cyber monday|giveaway|limited time|coupon|event|ends|deadline|this weekend|next week)\b/i;
const CLIENT_SOURCES = ["slack_external", "gmail", "call"];
const PACING_PER_PASS = 3;
const SOURCE_OF: Record<string, Citation["source"]> = { slack_external: "slack", gmail: "email", call: "call" };

type Candidate = {
  clientId: string;
  trigger: Trigger;
  key: string;
  kind: "offer" | "fatigue" | "kpi" | "pacing";
  askedBy: AskedBy;
  citation: Citation;
  deadline: string | null;
  track: Track | null; // null: the mix decides
  /** What the brief is to do, for the strategist */
  task: string;
  signal: Signal;
  /** A pacing draft's pool and what it may take */
  pool?: "images" | "videos";
  take?: number;
  weight: number;
};

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ─── The drafting rules every drafted brief is written with ────────────────────────────────────────────────────

const DRAFT_RULES = `THIS BRIEF WAS DRAFTED BY THE SYSTEM FOR A REASON IT FOUND; THE TEAM ONLY APPROVES IT. Hold it to these, on top of everything else:
- Build it on the reason given (the_reason): the client's own words, the ad and its numbers, or the numbers. Name that reason in why and in evidence exactly as given. Never a generic idea that could come from any account (e.g. "a video answering the price objection" with nothing behind it): if the reason doesn't support a specific idea, set suggest to false.
- Lead with results over features: the outcome the customer gets (proven by this client's numbers, reviews or claims in the context), then the product or service that delivers it.
- Nothing the Brand Bible or client memory forbids, not even close to it.
- Never reuse a layout, hook or format that's failing for this client (failing_for_this_client): say what this brief does differently.
- Follow the track: an iteration keeps the winner's angle, offer and proof and changes one thing per version (the hook, the visual, the first seconds); net new is a different idea, angle or offer framing.
- One concept. Keep it within the counts given; every version counts toward the allotment.`;

// ─── Reading what's there ──────────────────────────────────────────────────────────────────────────────────────

type Usage = { client_id: string; images_per_month: number | null; videos_per_month: number | null; images_used: number | null; videos_used: number | null; period_start: string | null; period_end: string | null; billing_day: number | null };
type SnapAd = { id?: string; name: string; headline: string | null; spend?: number; results?: number; costPerResult?: number | null; result?: string | null; ctr?: number };

function cycleOf(u: Pick<Usage, "period_start" | "period_end" | "billing_day">, day: string) {
  return u.period_start && u.period_end ? { start: String(u.period_start).slice(0, 10), end: String(u.period_end).slice(0, 10) } : cycleFor(u.billing_day, day);
}

/** What the drafts still waiting on approval would take from each pool, per client */
function openTakes(rows: readonly { client_id: string; draft: unknown }[]) {
  const out = new Map<string, { images: number; videos: number }>();
  for (const r of rows) {
    const f = ((r.draft as SuggestionDraft | null)?.formats ?? []) as SuggestionDraft["formats"];
    const d = draws(Object.fromEntries(f.map((x) => [x.format, x])));
    const t = out.get(r.client_id) ?? { images: 0, videos: 0 };
    out.set(r.client_id, { images: t.images + d.images, videos: t.videos + d.videos });
  }
  return out;
}

/** The ads that are failing for a client (well over the account's usual, or tired), in lines, so a draft never reuses them */
function failingBlock(ads: readonly SnapAd[], tired: readonly { headline: string | null; ad_name: string }[]) {
  const priced = ads.filter((a) => (a.spend ?? 0) >= 100 && a.costPerResult && (a.results ?? 0) >= 2);
  const usual = priced.length ? priced.map((a) => a.costPerResult!).sort((a, b) => a - b)[Math.floor(priced.length / 2)] : 0;
  const flops = usual ? ads.filter((a) => (a.spend ?? 0) >= 150 && (a.costPerResult ? a.costPerResult >= usual * 1.8 : (a.results ?? 0) === 0)) : [];
  const lines = [
    ...flops.slice(0, 5).map((a) => `- "${a.headline ?? a.name}" (${a.name}): ${money(a.spend ?? 0)} spent, ${a.costPerResult ? `${money(a.costPerResult)} per ${a.result ?? "result"}` : "no results"} vs the usual ${money(usual)}`),
    ...tired.slice(0, 4).map((t) => `- "${t.headline ?? t.ad_name}" (${t.ad_name}): worn out`),
  ];
  return lines.length ? `<failing_for_this_client>\n${lines.join("\n")}\n</failing_for_this_client>` : "";
}

/** The account's best ad by cost per result with enough behind it: what an iteration builds on */
function topWinner(ads: readonly SnapAd[]) {
  const priced = ads.filter((a) => (a.spend ?? 0) >= 100 && a.costPerResult && (a.results ?? 0) >= 3);
  if (priced.length < 2) return null;
  const sorted = [...priced].sort((a, b) => a.costPerResult! - b.costPerResult!);
  const usual = sorted[Math.floor(sorted.length / 2)].costPerResult!;
  const w = sorted[0];
  return w.costPerResult! < usual * 0.85 ? { ad: w, usual } : null;
}

// ─── The run ───────────────────────────────────────────────────────────────────────────────────────────────────

export type DraftingResult = { lookedAt: number; made: number; skipped: string[] };

/**
 * One pass over every live creative client: the reasons to brief right now, at most one new draft per client per pass
 * (never a batch), the urgent ones first. Runs every working hour (vercel.json, /api/cron/context?step=suggest).
 */
export async function runDrafting(admin: Db, opts: { max?: number; runId?: string | null; clientId?: string | null } = {}): Promise<DraftingResult> {
  const max = opts.max ?? 8;
  const day = today();
  const { data: lastRuns } = await admin.from("suggestion_runs").select("started_at").not("finished_at", "is", null).is("error", null).order("started_at", { ascending: false }).limit(1);
  // Messages that came in since the last pass (with an hour's overlap), and never more than three days back
  const since = new Date(Math.max(Date.now() - 3 * 86_400_000, lastRuns?.[0] ? Date.parse(lastRuns[0].started_at) - 3_600_000 : Date.now() - 86_400_000)).toISOString();
  let clientsQ = admin.from("clients").select("id, name, services, services_extra, services_removed").is("archived_at", null).in("status", LIVE);
  if (opts.clientId) clientsQ = clientsQ.eq("id", opts.clientId);
  const [{ data: clients }, { data: usage }, { data: drafted }, { data: kpis }, { data: tired }, { data: items }, { data: snaps }, { data: recentReqs }] = await Promise.all([
    clientsQ,
    admin.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used, period_start, period_end, billing_day"),
    admin.from("creative_suggestions").select("client_id, kind, status, trigger_key, draft, mix, created_at, source").not("trigger_key", "is", null).gte("created_at", new Date(Date.now() - 45 * 86_400_000).toISOString()),
    admin.from("kpi_snapshots").select("target_id, client_id, status, trend, deviation, kpi_targets(label, target, platform, conversion)"),
    admin.from("ad_fatigue").select("client_id, ad_id, ad_name, headline, severity, signals, state").eq("state", "open"),
    admin.from("context_items").select("id, client_id, source, occurred_at, author, title, body, url").in("source", CLIENT_SOURCES).gte("created_at", since).order("occurred_at", { ascending: false }).limit(800),
    admin.from("meta_snapshots").select("client_id, ads, fetched_at").gte("fetched_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).order("fetched_at", { ascending: false }).limit(1000),
    admin.from("requests").select("client_id, created_at").gte("created_at", new Date(Date.now() - 3 * 86_400_000).toISOString()).is("deleted_at", null),
  ]);
  const creative = new Map((clients ?? []).filter((c) => linesOf(c).has("creative")).map((c) => [c.id as string, c]));
  const usageBy = new Map(((usage ?? []) as Usage[]).filter((u) => creative.has(u.client_id)).map((u) => [u.client_id, u]));
  const keys = new Set((drafted ?? []).map((d) => `${d.client_id}:${d.trigger_key}`));
  const openDrafts = (drafted ?? []).filter((d) => d.status === "open");
  const takes = openTakes(openDrafts);
  const adsBy = new Map<string, SnapAd[]>();
  for (const s of snaps ?? []) if (!adsBy.has(s.client_id)) adsBy.set(s.client_id, (s.ads ?? []) as SnapAd[]);
  const lastReq = new Map<string, string>();
  for (const r of recentReqs ?? []) if (!lastReq.has(r.client_id) || r.created_at > lastReq.get(r.client_id)!) lastReq.set(r.client_id, r.created_at);
  const fresh = (clientId: string, key: string) => !keys.has(`${clientId}:${key}`);
  const out: Candidate[] = [];

  // 1. A time-sensitive ask heard on a call, in Slack or email: read once, with its deadline
  const byClient = new Map<string, NonNullable<typeof items>>();
  for (const i of items ?? []) {
    if (!i.client_id || !usageBy.has(i.client_id)) continue;
    if (!OFFER.test(`${i.title ?? ""} ${i.body ?? ""}`)) continue;
    if (lastReq.get(i.client_id) && lastReq.get(i.client_id)! > i.occurred_at) continue;
    if (!fresh(i.client_id, `offer:${i.id}`)) continue;
    byClient.set(i.client_id, [...(byClient.get(i.client_id) ?? []), i]);
  }
  for (const [clientId, list] of byClient) {
    // One ask per client per pass, the newest; an open offer draft already answers the client
    if (openDrafts.some((d) => d.client_id === clientId && d.kind === "offer")) continue;
    const ask = await readAsk(clientId, (creative.get(clientId)?.name as string) ?? "", list.slice(0, 4), day).catch((e) => {
      console.error("[drafting] reading an ask", clientId, e instanceof Error ? e.message : e);
      return null;
    });
    if (!ask) continue;
    const item = list.find((i) => i.id === ask.itemId) ?? list[0];
    out.push({
      clientId,
      trigger: "offer",
      key: `offer:${item.id}`,
      kind: "offer",
      askedBy: "client",
      citation: { source: SOURCE_OF[item.source] ?? "slack", ref: (item.url as string | null) ?? (item.id as string), quote: clip(ask.quote || (item.body ?? item.title ?? ""), 300), at: item.occurred_at, numbers: null },
      deadline: ask.deadline,
      track: "net_new",
      weight: 10 + (ask.deadline ? 5 : 0),
      signal: { kind: "offer", weight: 10, line: `The client asked for ${ask.what}${ask.deadline ? ` (live by ${ask.deadline})` : ""}`, facts: [`${item.occurred_at.slice(0, 10)} · ${item.source === "gmail" ? "Email" : item.source === "call" ? "Call" : "Slack"}${item.author ? ` · ${item.author}` : ""}: ${clip((item.body ?? item.title ?? "").replace(/\s+/g, " "), 400)}`] },
      task: `<the_reason>\nThe client asked for this (${item.source === "gmail" ? "by email" : item.source === "call" ? "on a call" : "in Slack"}, ${item.occurred_at.slice(0, 10)}): ${ask.what}\nTheir words: "${clip(ask.quote, 400)}"${ask.deadline ? `\nIt has to be live by ${ask.deadline}: say so at the top of the brief.` : ""}\n</the_reason>\n\nWrite the creative for exactly this ask. Facts only from what they said and the context; anything not confirmed goes under Confirm with client. kind: "offer". signal: one line naming the ask. evidence: the quote with its date and source first, then 1 to 3 facts.`,
    });
  }

  // 2. Hard fatigue: an ad that's tired (not only tiring), once per ad
  for (const f of tired ?? []) {
    if (f.severity !== "tired" || !usageBy.has(f.client_id) || !fresh(f.client_id, `fatigue:${f.ad_id}`)) continue;
    const line = describeFatigue([f] as Parameters<typeof describeFatigue>[0]).replace(/^- /, "");
    out.push({
      clientId: f.client_id,
      trigger: "fatigue",
      key: `fatigue:${f.ad_id}`,
      kind: "fatigue",
      askedBy: "media_buyer",
      citation: { source: "ad", ref: f.ad_id, quote: clip(line, 300), at: null, numbers: line.match(/\d[^,]*/g)?.slice(0, 3).join(", ") ?? null },
      deadline: null,
      track: "iterate",
      weight: 8,
      signal: { kind: "fatigue", weight: 8, line: `"${f.headline ?? f.ad_name}" is tired`, facts: [line] },
      task: `<the_reason>\nThis ad is tired: ${line}\nIt worked before (it ran long enough to be judged against itself): keep its angle, offer and proof; change what people are tired of (the visual, the hook, the first seconds, the format).\n</the_reason>\n\nWrite the refresh. Usually 2 to 4 versions of one concept. kind: "fatigue". signal: one line on what the watcher saw. evidence: the ad and its numbers first.`,
    });
  }

  // 3. A KPI dropping on the account: off target and slipping (or well off), at most once a week per KPI
  for (const k of kpis ?? []) {
    const kt = k.kpi_targets as unknown as { label: string | null; target: number | null; platform: string | null; conversion: string | null } | null;
    if (!usageBy.has(k.client_id) || kt?.target == null) continue;
    if ((lineOfPlatform(kt.platform) ?? "meta") !== "meta") continue;
    const dev = k.deviation == null ? null : Math.round(Number(k.deviation) * 100);
    if (k.status !== "off" || !(k.trend === "slipping" || (dev ?? 0) >= 25)) continue;
    const key = `kpi:${k.target_id}:${isoWeek(day)}`;
    if (!fresh(k.client_id, key)) continue;
    const numbers = `${kt.label ?? "Account"}: target ${kt.target}${kt.conversion ? ` per ${kt.conversion}` : ""}${dev != null ? `, ${dev}% worse over 14 days` : ", spending with no results"}${k.trend ? `, ${k.trend}` : ""}`;
    out.push({
      clientId: k.client_id,
      trigger: "kpi",
      key,
      kind: "kpi",
      askedBy: "media_buyer",
      citation: { source: "numbers", ref: k.target_id as string, quote: numbers, at: null, numbers },
      deadline: null,
      track: "net_new",
      weight: 6 + Math.min(3, (dev ?? 50) / 25),
      signal: { kind: "kpi", weight: 7, line: `${kt.label ?? "The account"} is off target and dropping`, facts: [numbers] },
      task: `<the_reason>\n${numbers}\n</the_reason>\n\nWrite the creative most likely to bring this KPI back: a different angle or offer framing than what's running (patterns across clients first). kind: "kpi". signal: one line on the drop. evidence: the numbers first.`,
    });
  }

  // 4. Pacing: a pool behind this week's share of the even line, one brief's worth at a time
  for (const [clientId, u] of usageBy) {
    if (openDrafts.some((d) => d.client_id === clientId && d.kind === "pacing")) continue;
    const cycle = cycleOf(u, day);
    const t = takes.get(clientId) ?? { images: 0, videos: 0 };
    for (const pool of ["videos", "images"] as const) {
      const cap = Number(pool === "images" ? u.images_per_month : u.videos_per_month) || 0;
      if (!cap) continue;
      const asked = Number(pool === "images" ? u.images_used : u.videos_used) || 0;
      const w = weekPace({ cap, asked, open: t[pool], cycleStart: cycle.start, cycleEnd: cycle.end, today: day });
      const take = pacingTake(w.room);
      const key = `pacing:${cycle.start}:${pool}:w${w.week}`;
      if (!take || !fresh(clientId, key)) continue;
      const numbers = `${asked} of ${cap} ${pool} asked this cycle, ${w.dueByWeekEnd} due by the end of this week on an even line (${w.weekShare} a week), ${w.daysLeft} days to the reset`;
      out.push({
        clientId,
        trigger: "pacing",
        key,
        kind: "pacing",
        askedBy: "creative",
        citation: { source: "numbers", ref: key, quote: numbers, at: null, numbers },
        deadline: null,
        track: null,
        pool,
        take,
        weight: 2 + w.room / Math.max(1, w.weekShare),
        signal: { kind: "pacing", weight: 2, line: `Behind this week's share of the allotment (${pool})`, facts: [numbers] },
        task: "",
      });
      break; // one pool per client per pass
    }
  }

  // Urgent first, one per client, then the strongest
  const ranked = [...out].sort((a, b) => b.weight - a.weight);
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of ranked) {
    if (seen.has(c.clientId)) continue;
    seen.add(c.clientId);
    picked.push(c);
  }
  const urgent = picked.filter((c) => c.trigger !== "pacing");
  // Pacing evenly through the day too: a few per hourly pass, so the leads never get a wall of them at once
  const pacing = picked.filter((c) => c.trigger === "pacing").slice(0, Math.max(0, Math.min(PACING_PER_PASS, max - urgent.length)));
  const todo = [...urgent.slice(0, max), ...pacing];

  const { workload } = await import("@/lib/suggestions");
  const load = await workload(admin);
  let made = 0;
  const skipped: string[] = [];
  for (let i = 0; i < todo.length; i += 3) {
    const done = await Promise.allSettled(
      todo.slice(i, i + 3).map((c) => draftOne(admin, c, { usage: usageBy.get(c.clientId)!, kpis: (kpis ?? []).filter((k) => k.client_id === c.clientId), drafted: (drafted ?? []).filter((d) => d.client_id === c.clientId), ads: adsBy.get(c.clientId) ?? [], tired: (tired ?? []).filter((f) => f.client_id === c.clientId), openTake: takes.get(c.clientId) ?? { images: 0, videos: 0 }, client: (creative.get(c.clientId)?.name as string) ?? "", load })),
    );
    for (const [j, d] of done.entries()) {
      if (d.status === "fulfilled" && d.value === true) made++;
      else skipped.push(`${todo[i + j].key}: ${d.status === "rejected" ? (d.reason instanceof Error ? d.reason.message : String(d.reason)) : d.value}`);
    }
  }
  // A pacing draft nobody took in its week (and a few days' grace) has missed its moment
  await admin.from("creative_suggestions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("status", "open").eq("kind", "pacing").not("trigger_key", "is", null).lt("created_at", new Date(Date.now() - 10 * 86_400_000).toISOString());
  // A time-sensitive brief past its deadline can't be made in time any more
  await admin.from("creative_suggestions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("status", "open").not("trigger_key", "is", null).lt("deadline", day);
  return { lookedAt: todo.length, made, skipped };
}

/** Is this message a real ask from the client for creative, and by when? A small, fast read (never a brief) */
async function readAsk(clientId: string, client: string, list: { id: string; source: string; occurred_at: string; author: string | null; title: string | null; body: string | null }[], day: string) {
  const r = await askJson<{ isAsk: boolean; itemId: string; what: string; quote: string; deadline: string }>({
    agent: "strategist",
    label: "read a client ask",
    clientId,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 1200,
    bare: true,
    system: `You read messages from a paid ads agency's client (${client}) and decide whether one of them asks for new ad creative tied to something specific and time-bound: an offer, a promotion, a sale, a launch, an event, a holiday push. Today is ${day}. isAsk: true only for a real ask or announcement from the client (or what we agreed with them on a call) that needs ads; general chat, reporting, invoices, our own team talking, or something already running is false. itemId: the message's id. what: the ask in under 12 words ("ads for the 20% off Black Friday sale"). quote: the client's exact words that say it (under 300 characters, copied, never reworded). deadline: the date it has to be live by as YYYY-MM-DD when the message gives or clearly implies one (a sale starting Friday: that Friday), else "".`,
    schema: { type: "object", properties: { isAsk: { type: "boolean" }, itemId: { type: "string" }, what: { type: "string" }, quote: { type: "string" }, deadline: { type: "string" } }, required: ["isAsk", "itemId", "what", "quote", "deadline"], additionalProperties: false },
    prompt: list.map((i) => `<message id="${i.id}" source="${i.source}" at="${i.occurred_at}" author="${(i.author ?? "").replace(/"/g, "'")}">\n${clip(`${i.title ?? ""}\n${i.body ?? ""}`.trim(), 2500)}\n</message>`).join("\n\n"),
  });
  if (!r.isAsk || !r.quote?.trim()) return null;
  return { itemId: r.itemId, what: clip(r.what || "new creative", 120), quote: r.quote.trim(), deadline: cleanDeadline(r.deadline, day) };
}

type Ctx = {
  usage: Usage;
  kpis: { status: string | null; trend: string | null }[];
  drafted: { kind: string; status: string; mix: unknown; created_at: string }[];
  ads: SnapAd[];
  tired: { headline: string | null; ad_name: string }[];
  openTake: { images: number; videos: number };
  client: string;
  load: Awaited<ReturnType<typeof import("@/lib/suggestions").workload>>;
};

/** One brief for one reason: the mix, the pace and the seed it builds on decided here, the brief written by the strategist */
async function draftOne(admin: Db, c: Candidate, x: Ctx): Promise<true | string> {
  const day = today();
  const cycle = cycleOf(x.usage, day);
  const base = mixFor(accountState(x.kpis));
  // The cycle's drafts so far, by track, for the split
  const so = { iterate: 0, netNew: 0 };
  for (const d of x.drafted) {
    if (d.created_at.slice(0, 10) < cycle.start || !(d.status === "open" || d.status === "approved")) continue;
    const t = (d.mix as Mix | null)?.track;
    if (t === "iterate") so.iterate++;
    else if (t === "net_new") so.netNew++;
  }
  let track: Track = c.track ?? pickTrack(base, so);
  let citation = c.citation;
  let seed = "";
  if (c.trigger === "pacing") {
    // An iteration needs a winner to iterate on; net new builds on what's proven for businesses like this one
    const win = topWinner(x.ads);
    let pattern: { title: string; detail: string; evidence: { clients: number; of: number } } | null = null;
    if (track === "net_new" || !win) {
      const { patternsForClient } = await import("@/lib/patterns");
      const { patterns } = await patternsForClient(admin, c.clientId).catch(() => ({ patterns: [] as Awaited<ReturnType<typeof patternsForClient>>["patterns"] }));
      const p = patterns.filter((p) => p.verdict === "works").sort((a, b) => Number(b.opportunity) - Number(a.opportunity) || b.evidence.clients - a.evidence.clients)[0];
      pattern = p ? { title: p.title, detail: p.detail, evidence: p.evidence } : null;
    }
    if (track === "iterate" && !win) track = "net_new";
    if (track === "net_new" && !pattern) track = win ? "iterate" : track;
    if (track === "iterate" && win) {
      const a = win.ad;
      const nums = `${money(a.costPerResult!)} per ${a.result ?? "result"} vs the account's usual ${money(win.usual)}, ${money(a.spend ?? 0)} spent, ${a.results} ${a.result ?? "results"}`;
      citation = { source: "ad", ref: a.id ?? a.name, quote: `"${a.headline ?? a.name}": ${nums}`, at: null, numbers: `${c.citation.numbers}; ${nums}` };
      seed = `<winner_to_iterate_on>\n"${a.headline ?? a.name}" (${a.name}): ${nums}\n</winner_to_iterate_on>\nIterate on this winner: keep its angle, offer and proof; each version changes one thing.`;
    } else if (pattern) {
      const nums = `proven for ${pattern.evidence.clients} of ${pattern.evidence.of} businesses like this one`;
      citation = { source: "pattern", ref: null, quote: `${pattern.title}: ${nums}`, at: null, numbers: `${c.citation.numbers}; ${nums}` };
      seed = `<pattern_to_build_on>\n${pattern.title} (${nums})\n${pattern.detail}\n</pattern_to_build_on>\nBuild this client's version of the pattern, never a copy, never naming another client.`;
    } else return "Nothing real to build on (no winner, no proven pattern): no pacing brief";
  }
  if (!hasRealReason(citation)) return "No real reason to cite";
  const mix: Mix = { ...base, track };
  const pool = c.pool;
  const counts =
    c.trigger === "pacing"
      ? `This brief makes ${c.take} version${c.take === 1 ? "" : "s"} in total (${pool === "videos" ? "videos only" : "single images or a carousel, no video"}): this week's share of the allotment, no more.`
      : "Keep it small: 2 to 4 versions of one concept, within what's left of the allotment.";
  const task = `${c.task || `<the_reason>\n${citation.quote}\nThe client's allotment is behind its even line this week: ${c.citation.quote}.\n</the_reason>\n\nkind: "pacing". signal: one line on what it builds on. evidence: the winner or the pattern with its numbers first, then the pacing numbers.`}
${seed ? `\n${seed}\n` : ""}
<the_track>
${TRACK_LABEL[track]}. ${mix.reason} This client's split is ${mix.iterate}% iterations of winners, ${mix.netNew}% net new.
</the_track>
${failingBlock(x.ads, x.tired)}

${counts}

${DRAFT_RULES}`;
  const { writeDraftedBrief } = await import("@/lib/suggestions");
  const w = await writeDraftedBrief(admin, c.clientId, [c.signal], task, x.load);
  if (!w) return "Client not found";
  if ("skip" in w) return w.skip ?? "Not needed";
  let draft = w.draft;
  // A pacing brief is held to the week's share and its pool, whatever came back
  if (c.trigger === "pacing" && pool) draft = holdToTake(draft, pool, c.take ?? 1);
  if (!draft.formats.length) return "No formats";
  // How it sits against this week's share: an urgent one may go over, and says why
  const take = draws(Object.fromEntries(draft.formats.map((f) => [f.format, f])));
  const p: "images" | "videos" = take.videos > 0 ? "videos" : "images";
  const cap = Number(p === "images" ? x.usage.images_per_month : x.usage.videos_per_month) || 0;
  const asked = Number(p === "images" ? x.usage.images_used : x.usage.videos_used) || 0;
  let pace: Pace | null = null;
  if (cap) {
    const wk = weekPace({ cap, asked, open: x.openTake[p], cycleStart: cycle.start, cycleEnd: cycle.end, today: day });
    pace = paceFor(p, cap, wk, asked, take[p], c.trigger === "offer" ? `the client asked${c.deadline ? ` for it by ${c.deadline}` : ""}` : c.trigger === "fatigue" ? "an ad is worn out now" : c.trigger === "kpi" ? "the KPI is dropping now" : null);
  }
  const urgent = c.trigger !== "pacing" && Boolean(pace?.over || c.deadline);
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({
      client_id: c.clientId,
      kind: c.kind,
      signal: (w.signal || c.signal.line).slice(0, 300),
      // The real reason first, as the data said it; then the strategist's
      evidence: [citation.quote, ...w.evidence.filter((e) => e !== citation.quote)].slice(0, 5),
      why: w.why,
      draft,
      original: draft,
      trigger_key: c.key,
      deadline: c.deadline,
      urgent,
      mix,
      pace,
      citation,
      asked_by: c.askedBy,
      source: c.trigger === "fatigue" ? { adId: citation.ref, headline: c.signal.line.replace(/^"|" is tired$/g, ""), client: "this account", fatigue: true } : null,
    })
    .select("id")
    .single();
  if (error || !data) return error?.code === "23505" ? "Already drafted" : (error?.message ?? "Couldn't save");
  await notifyLeads(admin, { id: data.id as string, clientId: c.clientId, client: x.client, title: draft.title, formats: draft.formats.map((f) => f.format), reason: citation.quote, deadline: c.deadline, urgent, over: pace?.over ? pace.line : null });
  return true;
}

/** A pacing draft held to its pool and the week's share: the counts trimmed, never more than it may take */
export function holdToTake(d: SuggestionDraft, pool: "images" | "videos", take: number): SuggestionDraft {
  const fits = d.formats.filter((f) => (pool === "videos" ? f.format === "video" : f.format !== "video"));
  const first = fits[0] ?? { format: pool === "videos" ? ("video" as const) : ("image" as const), new: 1, variations: 0 };
  const per = first.format === "carousel" ? Math.max(2, first.cards ?? 3) : 1;
  const versions = Math.max(1, Math.floor(take / per));
  const n = Math.min(first.new || 1, versions);
  const v = Math.max(0, Math.min(first.variations ?? 0, versions - n));
  return { ...d, formats: [{ ...first, new: n, variations: v }] };
}

/** The creative leads hear about a new draft in Kaizen OS (never a Slack DM): it waits for them to approve, edit or reject */
async function notifyLeads(admin: Db, b: { id: string; clientId: string; client: string; title: string; formats: string[]; reason: string; deadline: string | null; urgent: boolean; over: string | null }) {
  const { data: people } = await admin.from("profiles").select("id").in("role", leadsFor(b.formats)).eq("is_active", true).not("joined_at", "is", null);
  if (!people?.length) return;
  await admin.from("notifications").upsert(
    people.map((p) => ({
      profile_id: p.id,
      kind: "brief",
      title: `Brief to approve: ${b.client} · ${clip(b.title, 80)}${b.deadline ? ` (live by ${b.deadline})` : ""}`,
      body: clip(`${b.reason}${b.over ? ` · ${b.over}` : ""}`, 900),
      href: `/requests/new?approve=${b.id}`,
      client_id: b.clientId,
      key: `drafted:${b.id}`,
      priority: b.urgent ? "critical" : "normal",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

// ─── Hard fatigue on its own (the fatigue watcher's run) ──────────────────────────────────────────────────────────

/** Right after the fatigue watcher: draft for every client with a tired ad now, instead of a summary for every tiring one */
export async function draftFatigue(admin: Db, max = 6) {
  const { data: watch } = await admin.from("ad_fatigue").select("client_id").eq("state", "open").eq("severity", "tired").limit(300);
  const ids = [...new Set((watch ?? []).map((w) => w.client_id as string))].slice(0, max);
  let written = 0;
  for (const id of ids) written += (await runDrafting(admin, { clientId: id, max: 1 }).catch(() => ({ made: 0 }))).made;
  return { waiting: Math.max(0, ids.length - written), written };
}

// ─── Reading: the Ready to approve list ───────────────────────────────────────────────────────────────────────────

/** Drafted briefs waiting on a decision, read with the viewer's access (RLS lets only approvers see them), cited only */
export async function loadReady(db: Db, opts: { clientId?: string | null; limit?: number } = {}) {
  const { OPEN_COLS, loadSuggestionRows } = await import("@/lib/suggestions");
  let q = db.from("creative_suggestions").select(OPEN_COLS).eq("status", "open").not("trigger_key", "is", null).order("created_at", { ascending: false }).limit(opts.limit ?? 60);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const { data } = await q;
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).filter((r) => hasRealReason(r.citation as Citation | null));
  const open = await loadSuggestionRows(db, rows);
  return groupByClient(open.map((s) => ({ ...s, urgent: Boolean(s.drafted?.urgent), deadline: s.drafted?.deadline ?? null, askedBy: s.drafted?.askedBy ?? null })));
}

export type ReadyGroups = Awaited<ReturnType<typeof loadReady>>;

// ─── Approving ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The clients someone holds the Meta buyer seat on */
export async function buyerSeats(db: Db, profileId: string) {
  const { data } = await db.from("client_assignments").select("client_id").eq("profile_id", profileId).eq("role", "meta_buyer");
  return new Set((data ?? []).map((r) => r.client_id as string));
}

// ─── Swaps ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SwapOption = { kind: "draft" | "request" | "asana"; ref: string; title: string; stage: string | null; stageLabel: string; verdict: "swap" | "adapt" | "never"; askedBy: AskedBy };

/** What the client has this cycle that a new brief could take the slot of: drafts, then what's not started, then the rest */
export async function swapOptions(db: Db, clientId: string, except: string): Promise<{ options: SwapOption[]; swaps: number; cycleStart: string }> {
  const day = today();
  const [{ data: u }, { data: drafts }, { data: reqs }, { data: tasks }] = await Promise.all([
    db.from("client_allotment_usage").select("period_start, period_end, billing_day").eq("client_id", clientId).maybeSingle(),
    db.from("creative_suggestions").select("id, draft, asked_by").eq("client_id", clientId).eq("status", "open").not("trigger_key", "is", null).neq("id", except),
    db.from("requests").select("id, number, title, stage").eq("client_id", clientId).is("deleted_at", null).neq("stage", "launched").order("created_at", { ascending: false }).limit(30),
    db.from("asana_tasks").select("gid, name, stage").eq("client_id", clientId).eq("open", true).is("request_id", null).limit(30),
  ]);
  const cycle = cycleOf((u ?? { period_start: null, period_end: null, billing_day: null }) as Usage, day);
  const { count } = await db.from("brief_swaps").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("cycle_start", cycle.start);
  const { stageInfo } = await import("@/lib/stages");
  const label = (s: string | null) => (s ? (stageInfo(s as never)?.label ?? s.replace(/_/g, " ")) : "No column");
  const options: SwapOption[] = [
    ...(drafts ?? []).map((d) => ({ kind: "draft" as const, ref: d.id as string, title: (d.draft as SuggestionDraft).title, stage: null, stageLabel: "Waiting on approval", verdict: "swap" as const, askedBy: ((d.asked_by as AskedBy | null) ?? "creative") as AskedBy })),
    ...(reqs ?? []).map((r) => ({ kind: "request" as const, ref: r.id as string, title: `#${r.number} ${r.title}`, stage: r.stage as string, stageLabel: label(r.stage as string), verdict: swapVerdict({ kind: "request", stage: r.stage as string }, true), askedBy: "creative" as AskedBy })),
    ...(tasks ?? []).map((t) => ({ kind: "asana" as const, ref: t.gid as string, title: t.name as string, stage: (t.stage as string | null) ?? null, stageLabel: label(t.stage as string | null), verdict: swapVerdict({ kind: "asana", stage: (t.stage as string | null) ?? null }, true), askedBy: "creative" as AskedBy })),
  ].filter((o) => o.verdict !== "never");
  // Not started first: those cost nobody any hours
  options.sort((a, b) => Number(a.verdict === "adapt") - Number(b.verdict === "adapt"));
  return { options, swaps: count ?? 0, cycleStart: cycle.start };
}

export type SwapMe = import("@/lib/auth").Staff;

/**
 * A drafted brief takes another piece's slot. Not made yet (a draft, an approved piece not started): it's given up,
 * nobody loses hours. In production or later: only forced by a lead, and then the piece is adapted, not restarted (a
 * direction change on it, so the maker sees what to keep and what to change). Every swap is logged; three or more in
 * a cycle warn the leads that the client is churning the work.
 */
export async function swapIn(db: Db, admin: Db, me: SwapMe, newId: string, target: { kind: SwapOption["kind"]; ref: string }, forced: boolean, reason: string | null) {
  const { data: s } = await db.from("creative_suggestions").select("id, client_id, status, draft, asked_by, clients(name, slug)").eq("id", newId).maybeSingle();
  if (!s || s.status !== "open") return { ok: false as const, error: "That brief isn't open any more." };
  const clientId = s.client_id as string;
  const { options, swaps, cycleStart } = await swapOptions(db, clientId, newId);
  const t = options.find((o) => o.kind === target.kind && o.ref === target.ref);
  if (!t) return { ok: false as const, error: "That piece can't give up its slot: it's launched, or it isn't this client's." };
  const verdict = swapVerdict({ kind: t.kind, stage: t.stage, status: "open" }, forced);
  if (verdict === "never") return { ok: false as const, error: "It's already in production, so it keeps its slot: the new brief takes the next open one. A lead can force the swap, and the piece is adapted, not restarted." };
  const incoming = ((s.asked_by as AskedBy | null) ?? "creative") as AskedBy;
  if (!forced && !outranks(incoming, t.askedBy)) return { ok: false as const, error: "The piece it would replace was asked for by someone ahead in line (the client, then the media buyer, then the creative team). A lead can force it." };
  const { canForceSwap } = await import("@/lib/brief-drafting-core");
  if (forced && !canForceSwap(me)) return { ok: false as const, error: "Only the creative leads and the executives can force a swap." };
  const now = new Date().toISOString();
  const title = (s.draft as SuggestionDraft).title;
  let changeId: string | null = null;
  if (verdict === "swap") {
    if (t.kind === "draft") await admin.from("creative_suggestions").update({ status: "expired", replaced_by: newId, decline_reason: `Swapped for "${title}"`.slice(0, 600), decided_by: me.id, decided_at: now }).eq("id", t.ref).eq("status", "open");
    else if (t.kind === "request") await admin.from("requests").update({ deleted_at: now, deleted_by: me.id, delete_reason: `Swapped before it started for "${title}"`.slice(0, 300) }).eq("id", t.ref).eq("stage", "requested");
    else {
      const { asanaConfigured, asanaUpdate, asanaWrite } = await import("@/lib/asana");
      if (asanaConfigured()) {
        await asanaWrite(`/tasks/${t.ref}/stories`, { text: `Swapped before it started for "${title}" (${me.fullName}, in Kaizen OS). Nothing to make here.` }).catch(() => null);
        await asanaUpdate(`/tasks/${t.ref}`, { completed: true }).catch(() => null);
      }
      await admin.from("asana_tasks").update({ open: false, completed_at: now }).eq("gid", t.ref);
    }
  } else {
    // Forced on work in production: adapt what's done (the direction-change flow shows the maker what to keep)
    const { logChange } = await import("@/lib/direction-changes");
    const said = `Swap: "${t.title}" (now ${t.stageLabel}) is to become "${title}". Adapt what's already made to the new brief instead of restarting it: keep what still fits (footage, layout, copy), change only what the new brief needs.${reason ? ` Why: ${reason}` : ""}`;
    const r = await logChange(db, admin, me, clientId, said, "team", "creative");
    if (!r.ok) return { ok: false as const, error: r.error };
    changeId = r.id;
  }
  await admin.from("brief_swaps").insert({ client_id: clientId, cycle_start: cycleStart, replaced_kind: t.kind, replaced_ref: t.ref, replaced_title: t.title.slice(0, 300), replaced_stage: t.stage, replacement_id: newId, forced, reason: reason?.slice(0, 600) ?? null, direction_change_id: changeId, swapped_by: me.id });
  const total = swaps + 1;
  if (churning(total)) {
    const c = s.clients as unknown as { name: string; slug: string } | null;
    const { data: leads } = await admin.from("profiles").select("id").in("role", ["head_of_creative", "lead_graphic_designer", "lead_video_editor"]).eq("is_active", true).not("joined_at", "is", null);
    await admin.from("notifications").upsert(
      (leads ?? []).map((p) => ({ profile_id: p.id, kind: "brief", title: `${c?.name ?? "A client"} has swapped ${total} pieces this cycle`, body: "Swaps eat the team's hours. Worth a word with the client and their media buyer about locking the month's plan.", href: `/clients/${c?.slug ?? ""}`, client_id: clientId, key: `churn:${clientId}:${cycleStart}:${total}`, priority: "normal" })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  const slug = (s.clients as unknown as { slug: string } | null)?.slug ?? "";
  return { ok: true as const, verdict, swaps: total, churning: churning(total), href: changeId ? `/clients/${slug}?direction=${changeId}` : null };
}

// ─── Approving: the ticket and its Asana task ─────────────────────────────────────────────────────────────────────

/** A drafted brief as the Creative board's Asana task(s): the same layout as a request sent from the form */
export async function asanaDraftOf(clientId: string, d: SuggestionDraft, urgent: boolean): Promise<import("@/lib/asana-request").AsanaDraft> {
  const { composeBrief, parseBrief } = await import("@/lib/brief-spec");
  const parsed = parseBrief(d.brief ?? "");
  const structured = parsed.structured && (d.concepts?.length ?? 0) <= 1;
  const concepts = d.concepts?.length && !structured ? `\n\nConcepts:\n${d.concepts.map((c, i) => `${i + 1}. ${c.name}\n   Hook: ${c.hook}\n   Visual: ${c.visual}\n   Copy: ${c.copy}`).join("\n")}` : "";
  const hooks = d.hooks?.length && !(structured && parsed.spec.versions.length) ? `\n\nHooks to try:\n${d.hooks.map((h) => `- ${h}`).join("\n")}` : "";
  return {
    clientId,
    title: d.title.trim(),
    formats: Object.fromEntries(d.formats.filter((f) => f.new + f.variations > 0).map((f) => [f.format, { new: f.new, variations: f.variations, ...(f.cards ? { cards: f.cards } : {}) }])),
    sizes: d.sizes.filter((x) => x === "4x5" || x === "9x16"),
    angle: d.angle,
    ...(d.avatar?.trim() ? { avatar: d.avatar.trim(), avatarTest: Boolean(d.avatarTest) } : {}),
    audience: d.audience,
    brief: structured ? composeBrief(`${parsed.overview}${hooks}`, parsed.spec) : `${d.brief}${concepts}${hooks}`,
    refs: (d.refs ?? []).join("\n"),
    landing: d.landing || "",
    priority: urgent ? "urgent" : "normal",
  };
}

export type ApproveResult = { ok: true; where: "asana" | "board"; links: { label: string; href: string }[] } | { ok: false; error: string };

/**
 * Pushes a drafted brief through, as the person (their own access reads it, so only an approver gets this far): the
 * creative leads, the head of Meta, the executives, or the account's Meta buyer. It lands in Asana as the Creative
 * board's usual task (counted once in the allotment); Kaizen tickets when Asana isn't connected.
 */
export async function approveDrafted(db: Db, admin: Db, me: import("@/lib/auth").Staff, id: string): Promise<ApproveResult> {
  const { canApprove } = await import("@/lib/brief-drafting-core");
  const { data: s } = await db.from("creative_suggestions").select("id, client_id, status, draft, original, urgent, signal, kind, trigger_key, source").eq("id", id).maybeSingle();
  if (!s || !s.trigger_key) return { ok: false, error: "That brief isn't one you can approve." };
  if (s.status !== "open") return { ok: false, error: "This brief was already decided." };
  const clientId = s.client_id as string;
  if (!canApprove(me, await buyerSeats(db, me.id), clientId)) return { ok: false, error: "Drafted briefs are approved by the creative leads, the account's media buyer, the head of Meta and the executives." };
  const draft = s.draft as SuggestionDraft;
  if (draft.summary || !draft.brief?.trim()) return { ok: false, error: "Only its summary is written so far." };
  if (!draft.title.trim()) return { ok: false, error: "Give it a title." };
  if (!draft.formats.some((f) => f.new + f.variations > 0)) return { ok: false, error: "Pick at least one format." };
  // A tired ad's refresh: the watch list shows it's being replaced
  const adId = (s.source as { adId?: string | null } | null)?.adId;
  const refreshing = () => (s.kind === "fatigue" && adId ? admin.from("ad_fatigue").update({ state: "refreshing", updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("ad_id", adId).then(() => null) : null);
  const { asanaConfigured } = await import("@/lib/asana");
  if (asanaConfigured()) {
    try {
      const { sendAsanaRequest } = await import("@/lib/asana-request");
      const r = await sendAsanaRequest(admin, await asanaDraftOf(clientId, draft, Boolean(s.urgent)), { id: me.id, email: me.email ?? null }, { suggestionId: id, origin: { kind: "brief", label: String(s.signal).slice(0, 200), suggestionId: id } });
      await admin.from("creative_suggestions").update({ draft, edited: JSON.stringify(draft) !== JSON.stringify(s.original) }).eq("id", id);
      await refreshing();
      return { ok: true, where: "asana", links: r.tasks.filter((t) => t.url).map((t) => ({ label: t.name, href: t.url! })) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't send it to Asana." };
    }
  }
  // No Asana here: Kaizen tickets, the same way an approved suggestion is made
  const { data: batch, error } = await db.rpc("create_request_batch", {
    p_client: clientId,
    p_title: draft.title.trim(),
    p_items: draft.formats.filter((f) => f.new + f.variations > 0),
    p_priority: s.urgent ? "urgent" : "normal",
    p_angle: draft.angle.trim() || null,
    p_audience: draft.audience.trim() || null,
    p_brief: `${(await asanaDraftOf(clientId, draft, false)).brief}\n\n(Drafted by the system: ${s.signal})`,
    p_refs: (draft.refs ?? []).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20),
    p_sizes: draft.sizes,
    p_ai_review: null,
  });
  if (error) return { ok: false, error: error.message };
  const { data: made } = await db.from("requests").select("id, number").eq("batch_id", batch).order("number");
  const numbers = (made ?? []).map((r) => r.number as number);
  await admin.from("creative_suggestions").update({ status: "approved", draft, edited: JSON.stringify(draft) !== JSON.stringify(s.original), decided_by: me.id, decided_at: new Date().toISOString(), request_numbers: numbers }).eq("id", id);
  await refreshing();
  return { ok: true, where: "board", links: numbers.map((n) => ({ label: `#${n}`, href: `/board?t=${n}` })) };
}
