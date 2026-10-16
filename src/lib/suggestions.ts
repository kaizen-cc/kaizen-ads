import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
import { describeFatigue } from "@/lib/fatigue";
import { MAX_VARIATIONS, toAllotment, type Allotment, type UsageRow } from "@/lib/allotment";

// The strategist: watches every account for what needs new creative and suggests a full brief, with concepts, to execs
// and leads on Home. A person approves it (tickets are made), edits it, declines it with a reason, or talks it through.
// Every decision and reason goes back into the next suggestions.

import type { SuggestionKind } from "@/lib/suggestion-kinds";
export { KIND_LABEL, type SuggestionKind } from "@/lib/suggestion-kinds";

export type Concept = { name: string; hook: string; visual: string; copy: string };
export type SuggestionDraft = {
  title: string;
  angle: string;
  audience: string;
  brief: string;
  hooks: string[];
  concepts: Concept[];
  formats: { format: "image" | "video" | "carousel"; new: number; variations: number }[];
  sizes: ("1x1" | "4x5" | "9x16")[];
  landing: string;
  refs?: string[]; // links the request builds on (a Motion item, a market ad), for the creative team
};

export type Signal = { kind: SuggestionKind; weight: number; line: string; facts: string[] };

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

type SnapAd = { name: string; headline: string | null; live?: boolean; spend?: number; results?: number; costPerResult?: number | null; frequency?: number; ctr?: number; result?: string | null };

const OFFER = /\b(offer|promo|promotion|sale|discount|% ?off|deal|bogo|special|launch(ing)?|new (menu|product|service|location)|holiday|black friday|giveaway|limited time|coupon|event)\b/i;
const UNHAPPY = /\b(unhappy|not happy|disappointed|frustrat\w*|concern(ed)?|underwhelm\w*|not working|cancel\w*|complain\w*|upset|worried|not (seeing|getting) results|waste)\b/i;

/** What the data says about each client right now. Only clients we make creative for. */
export async function gatherSignals(admin: SupabaseClient): Promise<Map<string, Signal[]>> {
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: usage }, { data: open }, { data: kpis }, { data: snaps }, { data: items }, { data: rounds }, { data: recentReqs }, { data: watched }] = await Promise.all([
    admin.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used"),
    admin.from("board_requests").select("client_id, stage, new_count").neq("stage", "launched"),
    admin.from("kpi_snapshots").select("client_id, status, trend, deviation, kpi_targets(label)"),
    admin.from("meta_snapshots").select("client_id, ads, weekly, fetched_at").gte("fetched_at", since7).order("fetched_at", { ascending: false }).limit(1000),
    admin.from("context_items").select("client_id, source, occurred_at, author, title, body").gte("occurred_at", since7).neq("source", "drive").order("occurred_at", { ascending: false }).limit(3000),
    admin.from("client_rounds").select("decision, created_at, requests(client_id)").gte("created_at", since30),
    admin.from("requests").select("client_id, created_at").gte("created_at", since7).is("deleted_at", null),
    admin.from("ad_fatigue").select("client_id, ad_name, headline, severity, signals, state").in("state", ["open", "refreshing"]),
  ]);

  const creative = new Set((usage ?? []).map((u) => u.client_id as string));
  const out = new Map<string, Signal[]>();
  const add = (id: string, s: Signal) => creative.has(id) && out.set(id, [...(out.get(id) ?? []), s]);

  // Behind on the month's creative: used + already in the works well short of where the month is
  const now = new Date();
  const elapsed = now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const inWorks = new Map<string, number>();
  for (const r of open ?? []) inWorks.set(r.client_id, (inWorks.get(r.client_id) ?? 0) + (r.new_count ?? 0));
  for (const u of usage ?? []) {
    const allot = (u.images_per_month ?? 0) + (u.videos_per_month ?? 0);
    if (!allot) continue;
    const used = u.images_used + u.videos_used;
    const covered = (used + (inWorks.get(u.client_id) ?? 0)) / allot;
    if (elapsed > 0.25 && covered < elapsed - 0.3)
      add(u.client_id, {
        kind: "pacing",
        weight: 2 + (elapsed - covered) * 4,
        line: `${used} of ${allot} creatives used with ${Math.round(elapsed * 100)}% of the month gone`,
        facts: [`Images: ${u.images_used}/${u.images_per_month ?? 0}, videos: ${u.videos_used}/${u.videos_per_month ?? 0}`, `${inWorks.get(u.client_id) ?? 0} net new already in the works`],
      });
  }

  // KPIs off or slipping
  for (const k of kpis ?? []) {
    const label = (k.kpi_targets as unknown as { label: string } | null)?.label ?? "Account";
    const dev = k.deviation == null ? null : Math.round(Number(k.deviation) * 100);
    if (k.status === "off")
      add(k.client_id, { kind: "kpi", weight: 5 + Math.min(3, (dev ?? 50) / 25), line: `${label} is off target${dev != null ? ` (${dev}% worse over 14 days)` : " (spending with no results)"}`, facts: [`Trend: ${k.trend ?? "unknown"}`] });
    else if (k.status === "close" && k.trend === "slipping")
      add(k.client_id, { kind: "kpi", weight: 3, line: `${label} is close to target and slipping${dev != null ? ` (${dev}% off)` : ""}`, facts: [] });
  }

  // Fatigue (live ads seen too often, costing more) and angles not landing (well above the account's usual)
  const seen = new Set<string>();
  for (const s of snaps ?? []) {
    if (seen.has(s.client_id)) continue;
    seen.add(s.client_id);
    const ads = ((s.ads ?? []) as SnapAd[]).filter((a) => (a.spend ?? 0) >= 100);
    const priced = ads.filter((a) => a.costPerResult && (a.results ?? 0) >= 2);
    const usual = median(priced.map((a) => a.costPerResult!));
    // The fatigue watcher's flags (each ad against its own last three weeks); ones already being refreshed are handled
    const tired = (watched ?? []).filter((w) => w.client_id === s.client_id && w.state === "open");
    // The account as a whole: cost per result up a quarter or more over three weeks while people see the ads more
    const wk = ((s.weekly ?? []) as { costPerResult?: number | null; frequency?: number; from: string }[]).filter((w) => w.costPerResult);
    const first = wk[0];
    const last = wk[wk.length - 1];
    const accountTiring = wk.length >= 3 && first.costPerResult && last.costPerResult! >= first.costPerResult * 1.25 && (last.frequency ?? 0) >= (first.frequency ?? 0);
    if (tired.length || accountTiring)
      add(s.client_id, {
        kind: "fatigue",
        weight: 3 + tired.length + tired.filter((t) => t.severity === "tired").length + (accountTiring ? 2 : 0),
        line: accountTiring
          ? `Cost per result is up ${Math.round((last.costPerResult! / first.costPerResult! - 1) * 100)}% over three weeks while frequency climbs`
          : `${tired.length} ${tired.length === 1 ? "ad is" : "ads are"} wearing out against their own last three weeks`,
        facts: describeFatigue(tired as Parameters<typeof describeFatigue>[0]).split("\n").filter(Boolean).slice(0, 4),
      });
    const flops = usual ? ads.filter((a) => (a.spend ?? 0) >= 150 && (a.costPerResult ? a.costPerResult >= usual * 1.8 : (a.results ?? 0) === 0)) : [];
    if (flops.length >= 2)
      add(s.client_id, {
        kind: "flop",
        weight: 2 + flops.length,
        line: `${flops.length} ads are costing well over the account's usual`,
        facts: flops.slice(0, 4).map((a) => `"${a.headline ?? a.name}": ${money(a.spend ?? 0)} spent, ${a.costPerResult ? `${money(a.costPerResult)}/${a.result ?? "result"}` : "no results"} vs usual ${money(usual)}`),
      });
  }

  // A new offer in Slack or email this week with no request since
  const lastReq = new Map<string, string>();
  for (const r of recentReqs ?? []) if (!lastReq.has(r.client_id) || r.created_at > lastReq.get(r.client_id)!) lastReq.set(r.client_id, r.created_at);
  const offers = new Map<string, typeof items>();
  const unhappy = new Map<string, typeof items>();
  for (const i of items ?? []) {
    if (!i.client_id) continue;
    const text = `${i.title ?? ""} ${i.body ?? ""}`;
    if (OFFER.test(text) && (!lastReq.get(i.client_id) || i.occurred_at > lastReq.get(i.client_id)!)) offers.set(i.client_id, [...(offers.get(i.client_id) ?? []), i]);
    if (UNHAPPY.test(text)) unhappy.set(i.client_id, [...(unhappy.get(i.client_id) ?? []), i]);
  }
  const quote = (i: NonNullable<typeof items>[number]) => `${i.occurred_at.slice(0, 10)} · ${i.source === "gmail" ? "Email" : "Slack"}${i.author ? ` · ${i.author}` : ""}: ${(i.body ?? i.title ?? "").replace(/\s+/g, " ").slice(0, 220)}`;
  for (const [id, list] of offers) add(id, { kind: "offer", weight: 4, line: "Something new was mentioned this week (an offer, launch or event) and no request has been made since", facts: list!.slice(0, 3).map(quote) });

  // A client who isn't happy: their words, or rounds of changes
  const revises = new Map<string, number>();
  for (const r of rounds ?? []) {
    const c = (r.requests as unknown as { client_id: string } | null)?.client_id;
    if (c && r.decision === "revise") revises.set(c, (revises.get(c) ?? 0) + 1);
  }
  for (const id of new Set([...unhappy.keys(), ...[...revises].filter(([, n]) => n >= 3).map(([c]) => c)])) {
    const said = unhappy.get(id) ?? [];
    add(id, {
      kind: "unhappy",
      weight: 4 + said.length,
      line: said.length ? "The client sounded unhappy this week" : `${revises.get(id)} rounds of client changes in 30 days`,
      facts: [...said.slice(0, 3).map(quote), ...(revises.get(id) ? [`${revises.get(id)} client revision rounds in 30 days`] : [])],
    });
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: {
    suggest: { type: "boolean" },
    skipReason: { type: "string" },
    kind: { type: "string", enum: ["fatigue", "kpi", "pacing", "offer", "unhappy", "flop"] },
    signal: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    why: { type: "string" },
    draft: {
      type: "object",
      properties: {
        title: { type: "string" },
        angle: { type: "string" },
        audience: { type: "string" },
        brief: { type: "string" },
        hooks: { type: "array", items: { type: "string" } },
        concepts: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, hook: { type: "string" }, visual: { type: "string" }, copy: { type: "string" } }, required: ["name", "hook", "visual", "copy"], additionalProperties: false },
        },
        formats: {
          type: "array",
          items: {
            type: "object",
            properties: { format: { type: "string", enum: ["image", "video", "carousel"] }, new: { type: "integer" }, variations: { type: "integer" } },
            required: ["format", "new", "variations"],
            additionalProperties: false,
          },
        },
        sizes: { type: "array", items: { type: "string", enum: ["1x1", "4x5", "9x16"] } },
        landing: { type: "string" },
        refs: { type: "array", items: { type: "string" } },
      },
      required: ["title", "angle", "audience", "brief", "hooks", "concepts", "formats", "sizes", "landing", "refs"],
      additionalProperties: false,
    },
    reply: { type: "string" },
  },
  required: ["suggest", "skipReason", "kind", "signal", "evidence", "why", "draft", "reply"],
  additionalProperties: false,
};

type Out = { suggest: boolean; skipReason: string; kind: SuggestionKind; signal: string; evidence: string[]; why: string; draft: SuggestionDraft; reply: string };

const SYSTEM = `${AGENCY_SYSTEM}

You are the agency's strategist. You watch the accounts and, when the data says a client needs new creative, you write a full creative request an exec or lead can approve in one click: the brief, the angle, the audience, the formats and counts, and 2 to 4 concrete concepts.
- Start from the signal: say plainly what the data shows and why this creative answers it. Ads tiring: fresh designs on what's working, or variations of the winners. KPI off: a different angle or offer framing. Behind on creative: enough net new to catch up. A new offer: creative for that offer. Client not happy: answer what they said. Angle not landing: a new angle, and say what to stop.
- Only facts from the context. Never invent prices, offers, dates or claims. If the offer's details aren't known, say what to confirm in the brief.
- Formats and counts: net new must fit what's left of the allotment; variations up to ${MAX_VARIATIONS} per format.
- Concepts: name, the hook (first line or on-image headline), the visual (what's shown, in a sentence or two), and the copy direction.
- The brief is what the designer reads: 5 to 10 lines, specific.
- The team's past decisions on your suggestions are the most important thing you read. Never suggest again what they declined for a reason that still holds; lean into what they approved.
- Balance the team's time across clients (work_in_motion). If what's already in motion for this client answers the signal, don't add more: set suggest to false. A client with well above the average open work needs a strong reason for more; a client nobody has touched in weeks deserves the attention. When designers or editors are near capacity, keep it small (variations of what works, 1 to 2 net new) and say so in why.
- If the signal isn't real or something is already in the works that covers it, set suggest to false and say why in skipReason (the rest can be empty).`;

/** What the team decided about past suggestions, for the strategist to learn from. */
async function teamDecisions(admin: SupabaseClient, clientId: string) {
  const { data } = await admin
    .from("creative_suggestions")
    .select("client_id, kind, signal, draft, original, status, decline_reason, edited, decided_at, clients(name)")
    .in("status", ["approved", "declined"])
    .order("decided_at", { ascending: false })
    .limit(40);
  const rows = data ?? [];
  const line = (r: (typeof rows)[number]) => {
    const d = r.draft as SuggestionDraft;
    const o = r.original as SuggestionDraft;
    const changed = r.edited ? (["title", "angle", "audience", "brief"] as const).filter((k) => d[k] !== o[k]) : [];
    return `- ${r.status === "declined" ? `DECLINED: "${r.decline_reason ?? "no reason"}"` : `APPROVED${changed.length ? ` after the team changed ${changed.join(", ")}${d.angle !== o.angle ? ` (angle "${o.angle}" → "${d.angle}")` : ""}` : " as written"}`} · ${r.kind} · "${d.title}"`;
  };
  const mine = rows.filter((r) => r.client_id === clientId);
  const others = rows.filter((r) => r.client_id !== clientId).slice(0, 20);
  return `<team_decisions_on_your_suggestions>
For this client:
${mine.length ? mine.map(line).join("\n") : "None yet."}
For other clients (general lessons only):
${others.length ? others.map(line).join("\n") : "None yet."}
</team_decisions_on_your_suggestions>`;
}

// ─── Balance: what's already in motion, per client and for the team ───

export type Workload = {
  clients: Map<string, { open: number; making: number; netNew: number; lastRequest: string | null; tickets: string[] }>;
  team: { designers: { active: number; capacity: number }; editors: { active: number; capacity: number } };
  fairShare: number; // open tickets per client with a creative package, on average
};

const MAKING = new Set(["requested", "in_production", "client_revision"]);

/** Everything in motion right now, so suggestions spread the team's time instead of piling onto one client. */
export async function workload(admin: SupabaseClient): Promise<Workload> {
  const since60 = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [{ data: open }, { data: people }, { data: recent }, { data: usage }] = await Promise.all([
    admin.from("board_requests").select("client_id, number, title, format, stage, new_count").neq("stage", "launched").limit(3000),
    admin.from("profiles").select("role").eq("is_active", true).in("role", ["graphic_designer", "video_editor"]),
    admin.from("requests").select("client_id, created_at").gte("created_at", since60).is("deleted_at", null).order("created_at", { ascending: false }).limit(3000),
    admin.from("client_allotment_usage").select("client_id"),
  ]);
  const clients: Workload["clients"] = new Map();
  const blank = () => ({ open: 0, making: 0, netNew: 0, lastRequest: null as string | null, tickets: [] as string[] });
  const team = { designers: { active: 0, capacity: 0 }, editors: { active: 0, capacity: 0 } };
  for (const p of people ?? []) {
    if (p.role === "graphic_designer") team.designers.capacity += 10;
    else team.editors.capacity += 6;
  }
  for (const r of open ?? []) {
    const c = clients.get(r.client_id) ?? blank();
    c.open++;
    c.netNew += r.new_count ?? 0;
    if (MAKING.has(r.stage)) {
      c.making++;
      if (r.format === "video") team.editors.active++;
      else team.designers.active++;
    }
    if (c.tickets.length < 8) c.tickets.push(`#${r.number} ${r.title} (${r.format}, ${String(r.stage).replace(/_/g, " ")})`);
    clients.set(r.client_id, c);
  }
  for (const r of recent ?? []) {
    const c = clients.get(r.client_id) ?? blank();
    if (!c.lastRequest) c.lastRequest = r.created_at;
    clients.set(r.client_id, c);
  }
  const served = Math.max(1, (usage ?? []).length);
  return { clients, team, fairShare: Math.round(((open ?? []).length / served) * 10) / 10 };
}

const loadPct = (x: { active: number; capacity: number }) => (x.capacity ? Math.round((x.active / x.capacity) * 100) : null);

/** The workload in lines, for the strategist. */
function workloadBlock(w: Workload, clientId: string) {
  const c = w.clients.get(clientId);
  const days = c?.lastRequest ? Math.round((Date.now() - Date.parse(c.lastRequest)) / 86_400_000) : null;
  const d = loadPct(w.team.designers);
  const e = loadPct(w.team.editors);
  const lines = [
    `This client: ${c?.open ? `${c.open} open ${c.open === 1 ? "ticket" : "tickets"} (${c.making} being made, ${c.netNew} net new in the works)` : "nothing in motion"}; ${days == null ? "no request in the last 60 days" : `last request ${days} ${days === 1 ? "day" : "days"} ago`}. The average client has ${w.fairShare} open.`,
    ...(c?.tickets ?? []).map((t) => `- ${t}`),
    `Team: designers have ${w.team.designers.active} pieces being made${d != null ? ` (${d}% of capacity)` : ""}; video editors ${w.team.editors.active}${e != null ? ` (${e}% of capacity)` : ""}.`,
  ];
  return `<work_in_motion>\n${lines.join("\n")}\n</work_in_motion>`;
}

async function promptFor(admin: SupabaseClient, clientId: string, signals: Signal[], load?: Workload) {
  const [ctx, { sources }, decisions, w] = await Promise.all([clientContext(admin, clientId), getAgent("strategist"), teamDecisions(admin, clientId), load ?? workload(admin)]);
  if (!ctx) return null;
  // What's live in this client's market right now (Motion), so a brief can build on it
  const { marketBlock } = await import("@/lib/market");
  const market = await marketBlock(admin, clientId, ctx.industry ?? null).catch(() => "");
  return `${contextBlock(ctx, undefined, sources)}
${market ? `
${market}
` : ""}
${decisions}

${workloadBlock(w, clientId)}

<signals>
${signals
  .sort((a, b) => b.weight - a.weight)
  .map((s) => `- [${s.kind}] ${s.line}${s.facts.length ? `\n${s.facts.map((f) => `  · ${f}`).join("\n")}` : ""}`)
  .join("\n")}
</signals>`;
}

const clean = (d: SuggestionDraft): SuggestionDraft => ({
  ...d,
  title: d.title.slice(0, 80),
  formats: d.formats
    .filter((f, i, all) => all.findIndex((x) => x.format === f.format) === i)
    .map((f) => ({ ...f, new: Math.max(0, Math.min(10, f.new)), variations: Math.max(0, Math.min(MAX_VARIATIONS, f.variations)) }))
    .filter((f) => f.new + f.variations > 0),
  sizes: d.sizes.length ? d.sizes : ["4x5", "9x16"],
  hooks: d.hooks.slice(0, 6),
  concepts: d.concepts.slice(0, 4),
  refs: [...new Set((d.refs ?? []).filter((u) => /^https?:\/\/\S+$/i.test(u)))].slice(0, 6),
});

/** One suggestion for one client from its signals. Returns null when the strategist decides it isn't needed. */
async function suggestFor(admin: SupabaseClient, clientId: string, signals: Signal[], load?: Workload) {
  const prompt = await promptFor(admin, clientId, signals, load);
  if (!prompt) return null;
  const out = await askJson<Out>({
    agent: "strategist",
    label: "suggested brief",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

Decide whether this client needs new creative now, and if so write the request. kind: the main signal it answers. signal: one line on what the data shows. evidence: 2 to 4 short facts from the signals and context. why: 2 or 3 sentences making the case to an exec. reply: "".`,
  });
  if (!out.suggest || !out.draft.formats.length) return null;
  const draft = clean(out.draft);
  const { error } = await admin.from("creative_suggestions").insert({ client_id: clientId, kind: out.kind, signal: out.signal, evidence: out.evidence.slice(0, 5), why: out.why, draft, original: draft });
  return error ? null : true;
}

/**
 * A strategist run: the strongest signals first, a few clients at a time. Clients with an open suggestion are left
 * alone, and so is a signal the team declined in the last 10 days.
 */
export async function runStrategist(admin: SupabaseClient, startedBy: string | null, max = 8) {
  const { data: run } = await admin.from("suggestion_runs").insert({ started_by: startedBy }).select("id").single();
  try {
    const signals = await gatherSignals(admin);
    const since10 = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { data: busy } = await admin.from("creative_suggestions").select("client_id, kind, status, decided_at").or(`status.eq.open,and(status.eq.declined,decided_at.gte.${since10})`);
    const open = new Set((busy ?? []).filter((b) => b.status === "open" && b.kind !== "lab").map((b) => b.client_id));
    const declined = new Set((busy ?? []).filter((b) => b.status === "declined").map((b) => `${b.client_id}:${b.kind}`));
    // Balance: the strongest signals first, but a client already full of work drops back and one nobody has touched
    // in weeks moves up. A client with lots in motion only gets more when they're unhappy.
    const load = await workload(admin);
    const busiest = Math.max(loadPct(load.team.designers) ?? 0, loadPct(load.team.editors) ?? 0);
    const score = (id: string, list: readonly Signal[]) => {
      const c = load.clients.get(id);
      const days = c?.lastRequest ? (Date.now() - Date.parse(c.lastRequest)) / 86_400_000 : 60;
      return (list.reduce((t, s) => t + s.weight, 0) / (1 + 0.35 * (c?.open ?? 0))) * (1 + Math.min(1, days / 30) * 0.5);
    };
    const ranked = [...signals]
      .filter(([id]) => !open.has(id))
      .map(([id, list]) => [id, list.filter((s) => !declined.has(`${id}:${s.kind}`))] as const)
      .filter(([, list]) => list.length)
      .filter(([id, list]) => (load.clients.get(id)?.open ?? 0) < Math.max(6, load.fairShare * 2.5) || list.some((s) => s.kind === "unhappy"))
      .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]))
      // A stretched team gets fewer suggestions at once
      .slice(0, busiest >= 90 ? Math.min(max, 4) : max);
    let made = 0;
    for (let i = 0; i < ranked.length; i += 3) {
      const done = await Promise.allSettled(ranked.slice(i, i + 3).map(([id, list]) => suggestFor(admin, id, [...list], load)));
      made += done.filter((d) => d.status === "fulfilled" && d.value).length;
      for (const d of done) if (d.status === "rejected") console.error("[strategist]", d.reason);
    }
    // Open suggestions older than two weeks have gone stale
    await admin.from("creative_suggestions").update({ status: "expired" }).eq("status", "open").lt("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString());
    if (run) await admin.from("suggestion_runs").update({ finished_at: new Date().toISOString(), looked_at: ranked.length, made }).eq("id", run.id);
    return { lookedAt: ranked.length, made };
  } catch (e) {
    if (run) await admin.from("suggestion_runs").update({ finished_at: new Date().toISOString(), error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", run.id);
    throw e;
  }
}

/** Talking it through: the strategist answers and rewrites the suggestion from the conversation. */
export async function regenerate(admin: SupabaseClient, id: string) {
  const { data: s } = await admin.from("creative_suggestions").select("id, client_id, kind, signal, evidence, why, draft, version").eq("id", id).single();
  if (!s) throw new Error("Suggestion not found");
  const { data: msgs } = await admin.from("suggestion_messages").select("role, body").eq("suggestion_id", id).order("created_at");
  const prompt = await promptFor(admin, s.client_id, [{ kind: s.kind, weight: 1, line: s.signal, facts: (s.evidence ?? []) as string[] }]);
  if (!prompt) throw new Error("Client not found");
  const out = await askJson<Out>({
    agent: "strategist",
    label: "suggested brief chat",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<your_current_suggestion>
${JSON.stringify({ why: s.why, ...(s.draft as SuggestionDraft) }, null, 1)}
</your_current_suggestion>

<conversation>
${(msgs ?? []).map((m) => `${m.role === "user" ? "Exec/lead" : "You"}: ${m.body}`).join("\n")}
</conversation>

Answer the last message in reply (one to three sentences, plain). If it asks for changes, return the whole suggestion with them made; otherwise return it as it is. Keep suggest true, the same kind, signal and evidence.`,
  });
  const draft = clean(out.draft);
  await admin.from("creative_suggestions").update({ draft, why: out.why || s.why, version: s.version + 1, updated_at: new Date().toISOString() }).eq("id", id);
  await admin.from("suggestion_messages").insert({ suggestion_id: id, role: "ai", body: out.reply || "Updated." });
  return { draft, why: out.why || s.why, reply: out.reply };
}

export type OpenSuggestion = {
  id: string;
  clientId: string;
  client: string;
  clientSlug: string;
  kind: SuggestionKind;
  signal: string;
  evidence: string[];
  why: string;
  draft: SuggestionDraft;
  version: number;
  createdAt: string;
  allotment: Allotment | null;
  source: { thumbnail: string | null; headline: string | null; client: string } | null; // the winning ad, for one from a winner
  messages: { role: "user" | "ai"; body: string; at: string }[];
};
export type SuggestionsState = { open: OpenSuggestion[]; running: boolean; lastRun: string | null; decided30: { approved: number; declined: number } };

const OPEN_COLS = "id, client_id, kind, signal, evidence, why, draft, version, created_at, source, clients(name, slug)";

/** Open suggestions as the sheet shows them: with their conversation and the client's allotment. */
async function toOpen(db: SupabaseClient, rows: Record<string, unknown>[]): Promise<OpenSuggestion[]> {
  const ids = rows.map((r) => r.id as string);
  const clientIds = [...new Set(rows.map((r) => r.client_id as string))];
  const [{ data: msgs }, { data: usage }] = await Promise.all([
    ids.length ? db.from("suggestion_messages").select("suggestion_id, role, body, created_at").in("suggestion_id", ids).order("created_at") : Promise.resolve({ data: [] as never[] }),
    clientIds.length ? db.from("client_allotment_usage").select("*").in("client_id", clientIds) : Promise.resolve({ data: [] as never[] }),
  ]);
  return rows.map((r) => {
    const c = r.clients as { name: string; slug: string } | null;
    const u = (usage ?? []).find((x: UsageRow) => x.client_id === r.client_id) as UsageRow | undefined;
    return {
      id: r.id as string,
      clientId: r.client_id as string,
      client: c?.name ?? "",
      clientSlug: c?.slug ?? "",
      kind: r.kind as SuggestionKind,
      signal: r.signal as string,
      evidence: (r.evidence ?? []) as string[],
      why: r.why as string,
      draft: r.draft as SuggestionDraft,
      version: r.version as number,
      createdAt: r.created_at as string,
      allotment: u ? toAllotment(u) : null,
      source: (r.source as OpenSuggestion["source"]) ?? null,
      messages: (msgs ?? []).filter((m: { suggestion_id: string }) => m.suggestion_id === r.id).map((m: { role: string; body: string; created_at: string }) => ({ role: m.role as "user" | "ai", body: m.body, at: m.created_at })),
    };
  });
}

/** One suggestion, for the sheet (read with the viewer's access). */
export async function loadSuggestion(db: SupabaseClient, id: string) {
  const { data } = await db.from("creative_suggestions").select(OPEN_COLS).eq("id", id).maybeSingle();
  return data ? (await toOpen(db, [data]))[0] : null;
}

/** What Home shows execs and leads. Read with their own access. Drafts someone started from a winner stay theirs. */
export async function loadSuggestions(db: SupabaseClient): Promise<SuggestionsState> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [{ data: rows }, { data: runs }, { data: decided }] = await Promise.all([
    db.from("creative_suggestions").select(OPEN_COLS).eq("status", "open").not("kind", "in", "(winner,refresh,onboarding,call)").order("created_at", { ascending: false }).limit(20),
    db.from("suggestion_runs").select("started_at, finished_at").order("started_at", { ascending: false }).limit(1),
    db.from("creative_suggestions").select("status").in("status", ["approved", "declined"]).not("kind", "in", "(winner,refresh)").gte("decided_at", since30),
  ]);
  const run = runs?.[0];
  return {
    open: await toOpen(db, rows ?? []),
    running: Boolean(run && !run.finished_at && Date.now() - Date.parse(run.started_at) < 10 * 60_000),
    lastRun: run?.finished_at ?? null,
    decided30: { approved: (decided ?? []).filter((d) => d.status === "approved").length, declined: (decided ?? []).filter((d) => d.status === "declined").length },
  };
}

export type WinnerSource = { adId: string; client: string; detail: string | null; headline: string | null; text: string | null; thumbnail: string | null; ratio: number; result: string | null; costPerResult: number; usual: number };

/**
 * "Start a request from this" in the winners library: the strategist writes a full brief for the chosen client,
 * built on what made the winning ad work. Saved as a draft only its author (and execs and leads) can see.
 */
export async function suggestFromWinner(admin: SupabaseClient, clientId: string, w: WinnerSource, by: string) {
  const same = w.client;
  const prompt = await promptFor(admin, clientId, [
    { kind: "winner", weight: 1, line: `A winning ad from another account to build on`, facts: [`${w.ratio}x better cost per ${w.result ?? "result"} than its account's usual`] },
  ]);
  if (!prompt) throw new Error("Client not found");
  const out = await askJson<Out>({
    agent: "strategist",
    label: "brief from a winner",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<winning_ad>
From another Kaizen account (${w.detail ?? "another business"}). Getting ${w.ratio}x better cost per ${w.result ?? "result"} than that account's usual ($${w.costPerResult.toFixed(2)} vs $${w.usual.toFixed(2)}).
Headline: ${w.headline ?? "(none)"}
Primary text: ${w.text ?? "(none)"}
</winning_ad>

Someone on the team wants a request for this client built on this winning ad. Work out why the ad works (the angle, the hook, the format, the structure, the proof) and translate that into a request that fits this client's brand, offer, audience and allotment. Don't copy it word for word and never name the other business. Write the full request: brief, angle, audience, formats and counts within what's left of the allotment, sizes, 2 to 4 concepts and hooks. suggest: true. kind: "kpi". signal: "Built on a winning ad". evidence: 2 to 4 lines on what makes the ad work and why it fits this client. why: two or three sentences. reply: "".`,
  });
  const draft = clean(out.draft);
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({
      client_id: clientId,
      kind: "winner",
      signal: `Built on a winning ad (${w.ratio}x its account's usual)`,
      evidence: out.evidence.slice(0, 5),
      why: out.why,
      draft,
      original: draft,
      created_by: by,
      source: { adId: w.adId, thumbnail: w.thumbnail, headline: w.headline, client: same },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the brief");
  return data.id as string;
}

/**
 * A lab test reaching one client: the strategist writes that client's brief for it, as a suggestion on Home, so a
 * person checks it before anything is made.
 */
export async function suggestForTest(
  admin: SupabaseClient,
  clientId: string,
  test: { id: string; title: string; hypothesis: string; change: string; success: string },
) {
  const prompt = await promptFor(admin, clientId, [{ kind: "lab", weight: 1, line: `Ads Lab test: ${test.title}`, facts: [test.hypothesis, `What changes: ${test.change}`, `A win: ${test.success}`] }]);
  if (!prompt) return false;
  const out = await askJson<Out>({
    agent: "strategist",
    label: "lab test brief",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<lab_test>
${test.title}
Hypothesis: ${test.hypothesis}
What the creative does differently: ${test.change}
What counts as a win: ${test.success}
</lab_test>

The team chose this client for this test. Write the request that runs the test for this client: keep the test's change exactly, fit it to this client's brand, offer and audience, and keep it small and clean enough to read the result (usually 2 to 3 net new, or variations of a current winner). suggest: true. kind: "flop" if it replaces an angle, otherwise "kpi" (it's replaced by the lab kind). signal: "Ads Lab test: <the test's title>". evidence: what about this client makes it a fit. why: two sentences. reply: "".`,
  });
  const draft = clean(out.draft);
  if (!draft.formats.length) return false;
  const { error } = await admin.from("creative_suggestions").insert({
    client_id: clientId,
    kind: "lab",
    lab_test_id: test.id,
    signal: `Ads Lab test: ${test.title}`,
    evidence: out.evidence.slice(0, 5),
    why: out.why,
    draft,
    original: draft,
  });
  if (error) console.error("[lab] couldn't save the test brief:", error.message);
  return !error;
}

/**
 * A refresh for one tiring ad: the strategist keeps what made it work (it was spending for a reason) and changes what
 * people are tired of. Drafted for whoever asked, like a brief from a winner.
 */
export async function suggestRefresh(admin: SupabaseClient, clientId: string, adId: string, by: string | null) {
  const { data: f } = await admin.from("ad_fatigue").select("ad_name, campaign, adset, headline, thumbnail, severity, signals").eq("client_id", clientId).eq("ad_id", adId).single();
  if (!f) throw new Error("That ad isn't on the watch list");
  const { data: snap } = await admin.from("meta_snapshots").select("ads").eq("client_id", clientId).order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  const ad = ((snap?.ads ?? []) as { id: string; text: string | null; headline: string | null }[]).find((a) => a.id === adId);
  const watch = describeFatigue([f] as Parameters<typeof describeFatigue>[0]);
  const prompt = await promptFor(admin, clientId, [{ kind: "fatigue", weight: 1, line: `"${f.headline ?? f.ad_name}" is ${f.severity === "tired" ? "tired" : "tiring"}`, facts: [watch] }]);
  if (!prompt) throw new Error("Client not found");
  const out = await askJson<Out>({
    agent: "strategist",
    label: "refresh a tiring ad",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<tiring_ad>
Name: ${f.ad_name}${f.campaign ? ` · campaign: ${f.campaign}` : ""}${f.adset ? ` · ad set: ${f.adset}` : ""}
Headline: ${ad?.headline ?? f.headline ?? "(none)"}
Primary text: ${ad?.text ?? "(not synced)"}
What the watcher saw: ${watch.replace(/^- /, "")}
</tiring_ad>

This ad needs a refresh. It worked before (it ran long enough to be judged against itself), so keep what made it work: the angle, the offer, the proof. Change what people have grown tired of: the visual, the hook, the first seconds of a video, the format. Usually variations and 1 to 2 net new designs on the same angle, within what's left of the allotment. Say in the brief what to keep and what to change, and why, from the numbers. suggest: true. kind: "fatigue". signal: one line on what the watcher saw. evidence: 2 to 4 facts. why: two sentences. reply: "".`,
  });
  const draft = clean(out.draft);
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({
      client_id: clientId,
      kind: "refresh",
      signal: out.signal || `Refresh for "${f.headline ?? f.ad_name}"`,
      evidence: out.evidence.slice(0, 5),
      why: out.why,
      draft,
      original: draft,
      created_by: by,
      source: { adId, thumbnail: f.thumbnail, headline: f.headline ?? f.ad_name, client: "this account", fatigue: true },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the brief");
  return data.id as string;
}

/**
 * The first round for a new (or returning) client: built from their marketing intake and what's winning for similar
 * clients across our accounts. Replaces an earlier draft (say, one written before the intake arrived).
 */
export async function suggestOnboarding(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: intake }] = await Promise.all([
    admin.from("clients").select("name, industry, industry_detail, reonboarded_at").eq("id", clientId).single(),
    admin.from("client_intakes").select("summary, answers").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!c) throw new Error("Client not found");
  const { industryWinners, winnersBlock } = await import("@/lib/industry");
  const winners = c.industry && c.industry !== "other" ? await industryWinners(admin, c.industry, clientId, 10) : [];
  const prompt = await promptFor(admin, clientId, [
    { kind: "onboarding", weight: 1, line: c.reonboarded_at ? "Returning client: their first round back" : "New client: their first round of creative", facts: intake ? ["The marketing intake form is in"] : ["No marketing intake form yet: work from what's known and list what to confirm"] },
  ]);
  if (!prompt) throw new Error("Client not found");
  const out = await askJson<Out>({
    agent: "strategist",
    label: "onboarding first round",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

${winners.length ? winnersBlock(c.industry, c.industry_detail, winners) : "No winning ads in this industry across our accounts yet."}

${intake ? "" : "The marketing intake form hasn't come in yet. Build from what's known, keep claims general, and put what to confirm in the brief."}

This is ${c.name}'s ${c.reonboarded_at ? "first round since they came back" : "first round with Kaizen"}: the first impression, and the first read on what works for them. Write the request:
- Start from the client: their offer, audience, voice and what they told us to avoid (marketing_intake and client memory are hard rules).
- Lean on what's winning for similar clients: the angles, hooks and structures that are beating their accounts, translated to this client (never copied, never naming the other business). Say in why which winners shaped it.
- Test distinct angles so the first month teaches us something: 3 to 4 concepts, each a different angle or hook, not variations of one idea.
- Use the month's allotment well (a new client's first month should show range), with variations only where a hook test makes sense.
- In the brief, list anything the team must confirm with the client before production (from the intake's open questions).
suggest: true. kind: "kpi". signal: one line on what this first round sets out to learn. evidence: 2 to 4 lines from the intake and the winners. why: two or three sentences. reply: "".`,
  });
  const draft = clean(out.draft);
  // One open first round per client: a newer one replaces it
  await admin.from("creative_suggestions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("kind", "onboarding").eq("status", "open");
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({ client_id: clientId, kind: "onboarding", signal: out.signal || "First round", evidence: out.evidence.slice(0, 5), why: out.why, draft, original: draft })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the first round");
  return data.id as string;
}

export type OnboardingCard = {
  clientId: string;
  name: string;
  slug: string;
  since: string; // enrolled, or came back
  returning: boolean;
  creative: boolean;
  industry: string | null;
  intake: { status: string; at: string; business: string | null } | null;
  firstRound: OpenSuggestion | null; // ready for review
  inProduction: number[]; // tickets from an approved first round
};
export type OnboardingState = { clients: OnboardingCard[]; unmatched: { id: string; name: string | null; at: string }[] };

/** Clients being onboarded, with where each one is: intake, first round, production. For execs and leads. */
export async function loadOnboarding(db: SupabaseClient): Promise<OnboardingState> {
  // Clients being onboarded, plus any client with a first round waiting (an intake can arrive after they're active)
  const { data: waiting } = await db.from("creative_suggestions").select("client_id").eq("kind", "onboarding").eq("status", "open");
  const waitingIds = [...new Set((waiting ?? []).map((w) => w.client_id as string))];
  const [{ data: clients }, { data: unmatched }] = await Promise.all([
    db
      .from("clients")
      .select("id, name, slug, created_at, reonboarded_at, creative_package, industry_detail")
      .or(waitingIds.length ? `status.eq.onboarding,id.in.(${waitingIds.join(",")})` : "status.eq.onboarding")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
    db.from("client_intakes").select("id, business_name, received_at").eq("status", "unmatched").order("received_at", { ascending: false }).limit(10),
  ]);
  const ids = (clients ?? []).map((c) => c.id);
  const [{ data: intakes }, { data: rounds }] = ids.length
    ? await Promise.all([
        db.from("client_intakes").select("client_id, status, received_at, summary").in("client_id", ids).order("received_at", { ascending: false }),
        db.from("creative_suggestions").select(OPEN_COLS + ", status, request_numbers").eq("kind", "onboarding").in("client_id", ids).in("status", ["open", "approved"]).order("created_at", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }];
  const open = await toOpen(db, ((rounds ?? []) as unknown as Record<string, unknown>[]).filter((r) => r.status === "open"));
  return {
    clients: (clients ?? []).map((c) => {
      const intake = (intakes ?? []).find((i) => i.client_id === c.id);
      const approved = ((rounds ?? []) as unknown as { client_id: string; status: string; request_numbers: number[] }[]).find((r) => r.client_id === c.id && r.status === "approved");
      return {
        clientId: c.id,
        name: c.name,
        slug: c.slug,
        since: c.reonboarded_at ?? c.created_at,
        returning: Boolean(c.reonboarded_at),
        creative: c.creative_package,
        industry: c.industry_detail,
        intake: intake ? { status: intake.status, at: intake.received_at, business: (intake.summary as { business?: string } | null)?.business ?? null } : null,
        firstRound: open.find((o) => o.clientId === c.id) ?? null,
        inProduction: approved?.request_numbers ?? [],
      };
    }),
    unmatched: (unmatched ?? []).map((u) => ({ id: u.id, name: u.business_name, at: u.received_at })),
  };
}

/**
 * A promise from a client call with nothing in motion two business days later: the strategist writes the brief from
 * the call, for the client's buyer, leads and execs to push into production.
 */
export async function suggestFromCall(
  admin: SupabaseClient,
  clientId: string,
  commitment: { id: string; what: string; why: string; kind: string },
  call: { title: string; occurred_at: string; summary: { summary?: string; clientSaid?: string[]; decisions?: string[] } | null },
) {
  const prompt = await promptFor(admin, clientId, [
    { kind: "offer", weight: 1, line: `Promised on the call "${call.title}" (${call.occurred_at.slice(0, 10)}), not in motion yet`, facts: [commitment.what, commitment.why].filter(Boolean) },
  ]);
  if (!prompt) throw new Error("Client not found");
  const s = call.summary ?? {};
  const out = await askJson<Out>({
    agent: "strategist",
    label: "brief from a call",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<the_call>
"${call.title}" on ${call.occurred_at.slice(0, 10)}
${s.summary ?? ""}
${s.clientSaid?.length ? `The client said: ${s.clientSaid.join("; ")}` : ""}
${s.decisions?.length ? `Decided: ${s.decisions.join("; ")}` : ""}
</the_call>

<what_we_promised>
${commitment.what}${commitment.why ? `\nContext: ${commitment.why}` : ""}
</what_we_promised>

On this call Kaizen promised the above, and two business days later nothing is in production for it. Write the request that delivers exactly what was promised: use what the client said on the call (offer, dates, details, likes and dislikes) and the rest of the client context. Keep it to what was promised; don't expand it. If the call left something to confirm (a price, a date), say so in the brief. This request is for the paid ads and creative team: if what was promised isn't ad creative or ad copy for paid ads (it's an email, SMS, flow, organic post, flyer, website or other service), or this client doesn't run paid ads with us, set suggest to false and say why in skipReason. Otherwise suggest: true. kind: "offer". signal: "Promised on the call <date>: <the promise, short>". evidence: 2 to 4 lines from the call. why: two sentences. reply: "".`,
  });
  // Not work for the ads team: no brief
  if (!out.suggest) return { skip: out.skipReason || "Not paid ads or creative work" };
  const draft = clean(out.draft);
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({
      client_id: clientId,
      kind: "call",
      call_commitment_id: commitment.id,
      signal: out.signal || `Promised on the call ${call.occurred_at.slice(0, 10)}`,
      evidence: out.evidence.slice(0, 5),
      why: out.why,
      draft,
      original: draft,
      source: { headline: commitment.what, client: call.title, callAt: call.occurred_at },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the brief");
  return data.id as string;
}

export type CallPromise = { commitmentId: string; client: string; clientSlug: string; what: string; callTitle: string; callAt: string; dueAt: string; suggestion: OpenSuggestion | null };

/** Promises from calls that turned into briefs and still wait for someone to push them. Read with the viewer's access. */
export async function loadCallPromises(db: SupabaseClient): Promise<CallPromise[]> {
  const { data } = await db
    .from("call_commitments")
    .select("id, what, due_at, suggestion_id, clients(name, slug), client_calls(title, occurred_at)")
    .eq("status", "briefed")
    .order("due_at")
    .limit(20);
  const rows = data ?? [];
  const ids = rows.map((r) => r.suggestion_id).filter(Boolean) as string[];
  const { data: sugg } = ids.length ? await db.from("creative_suggestions").select(OPEN_COLS).in("id", ids).eq("status", "open") : { data: [] };
  const open = await toOpen(db, (sugg ?? []) as unknown as Record<string, unknown>[]);
  return rows
    .map((r) => {
      const c = r.clients as unknown as { name: string; slug: string } | null;
      const call = r.client_calls as unknown as { title: string; occurred_at: string } | null;
      return {
        commitmentId: r.id,
        client: c?.name ?? "",
        clientSlug: c?.slug ?? "",
        what: r.what,
        callTitle: call?.title ?? "A call",
        callAt: call?.occurred_at ?? r.due_at,
        dueAt: r.due_at,
        suggestion: open.find((o) => o.id === r.suggestion_id) ?? null,
      };
    })
    .filter((p) => p.suggestion);
}

/**
 * A request for one client built on a live ad from the market (Motion): why it works, translated to this client.
 * The Motion link (or the ad itself) rides along in the references so the creative team sees the idea.
 */
export async function suggestFromMarket(admin: SupabaseClient, clientId: string, adId: string, by: string) {
  const { loadMarketAd } = await import("@/lib/market");
  const a = await loadMarketAd(admin, adId);
  if (!a) throw new Error("That ad isn't in the market library any more");
  const prompt = await promptFor(admin, clientId, [{ kind: "offer", weight: 1, line: `A live ad from the market to build on (${a.brand})`, facts: [a.daysActive != null ? `Running ${a.daysActive} days` : "Run time unknown"] }]);
  if (!prompt) throw new Error("Client not found");
  const link = a.motionUrl ?? a.media[0]?.url ?? a.landingUrl ?? null;
  const out = await askJson<Out>({
    agent: "strategist",
    label: "brief from a market ad",
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `${prompt}

<market_ad>
${a.brand}${a.detail ? ` (${a.detail})` : ""} · ${a.format ?? "ad"}${a.daysActive != null ? ` · running ${a.daysActive} days${a.proven ? " (still paying for it after a month: a good sign it works)" : ""}` : ""}${a.testing ? " · this brand is testing a lot right now" : ""}
${a.angle ? `Angle: ${a.angle}\n` : ""}${a.hook ? `Hook: ${a.hook}\n` : ""}${a.why ? `Why it likely works: ${a.why}\n` : ""}Headline: ${a.headline ?? "(none)"}
Copy: ${a.body ?? "(none)"}
CTA: ${a.cta ?? "(none)"}
Link: ${link ?? "(none)"}
</market_ad>

Someone on the team wants a request for this client built on this live ad from the market. There are no performance numbers for it: how long it has run is the signal. Work out why it works (the angle, the hook, the format, the structure, the offer mechanics) and translate that into a request that fits this client's brand, offer, audience and allotment. Never copy it, never name the other brand in the brief, and never borrow their offer or claims. Write the full request: brief, angle, audience, formats and counts within what's left of the allotment, sizes, 2 to 4 concepts and hooks. draft.refs: ${link ? `"${link}" first, then any other market links you used` : "any market links you used"}. suggest: true. kind: "offer". signal: "Built on a live ad in the market". evidence: 2 to 4 lines on what makes the ad work and why it fits this client. why: two or three sentences. reply: "".`,
  });
  const draft = clean({ ...out.draft, refs: [...(link ? [link] : []), ...(out.draft.refs ?? [])] });
  const { data, error } = await admin
    .from("creative_suggestions")
    .insert({
      client_id: clientId,
      kind: "market",
      signal: `Built on a live ad in the market (${a.brand})`,
      evidence: out.evidence.slice(0, 5),
      why: out.why,
      draft,
      original: draft,
      created_by: by,
      source: { marketAdId: a.id, thumbnail: a.media[0]?.thumb ?? (a.media[0]?.type === "image" ? a.media[0].url : null), headline: a.headline ?? a.angle, client: a.brand },
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the brief");
  return data.id as string;
}
