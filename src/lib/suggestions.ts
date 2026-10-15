import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, askJson, clientContext, contextBlock, getAgent } from "@/lib/ai";
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
  const [{ data: usage }, { data: open }, { data: kpis }, { data: snaps }, { data: items }, { data: rounds }, { data: recentReqs }] = await Promise.all([
    admin.from("client_allotment_usage").select("client_id, images_per_month, videos_per_month, images_used, videos_used"),
    admin.from("board_requests").select("client_id, stage, new_count").neq("stage", "launched"),
    admin.from("kpi_snapshots").select("client_id, status, trend, deviation, kpi_targets(label)"),
    admin.from("meta_snapshots").select("client_id, ads, weekly, fetched_at").gte("fetched_at", since7).order("fetched_at", { ascending: false }).limit(1000),
    admin.from("context_items").select("client_id, source, occurred_at, author, title, body").gte("occurred_at", since7).neq("source", "drive").order("occurred_at", { ascending: false }).limit(3000),
    admin.from("client_rounds").select("decision, created_at, requests(client_id)").gte("created_at", since30),
    admin.from("requests").select("client_id, created_at").gte("created_at", since7).is("deleted_at", null),
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
    // Frequency is over the sync window, so "high" is relative to the account: well above its usual and costing more
    const freqUsual = median(ads.map((a) => a.frequency ?? 0).filter(Boolean));
    const tired = ads.filter((a) => a.live && (a.frequency ?? 0) >= Math.max(1.5, freqUsual * 1.3) && usual && a.costPerResult && a.costPerResult >= usual * 1.2);
    // The account as a whole: cost per result up a quarter or more over three weeks while people see the ads more
    const wk = ((s.weekly ?? []) as { costPerResult?: number | null; frequency?: number; from: string }[]).filter((w) => w.costPerResult);
    const first = wk[0];
    const last = wk[wk.length - 1];
    const accountTiring = wk.length >= 3 && first.costPerResult && last.costPerResult! >= first.costPerResult * 1.25 && (last.frequency ?? 0) >= (first.frequency ?? 0);
    if (tired.length || accountTiring)
      add(s.client_id, {
        kind: "fatigue",
        weight: 3 + tired.length + (accountTiring ? 2 : 0),
        line: accountTiring
          ? `Cost per result is up ${Math.round((last.costPerResult! / first.costPerResult! - 1) * 100)}% over three weeks while frequency climbs`
          : `${tired.length} live ${tired.length === 1 ? "ad is" : "ads are"} being seen more than usual and costing more`,
        facts: tired.slice(0, 4).map((a) => `"${a.headline ?? a.name}": frequency ${a.frequency}, ${money(a.spend ?? 0)} spent${a.costPerResult ? `, ${money(a.costPerResult)}/${a.result ?? "result"} vs usual ${money(usual)}` : ""}`),
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
      },
      required: ["title", "angle", "audience", "brief", "hooks", "concepts", "formats", "sizes", "landing"],
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

async function promptFor(admin: SupabaseClient, clientId: string, signals: Signal[]) {
  const [ctx, { sources }, decisions] = await Promise.all([clientContext(admin, clientId), getAgent("strategist"), teamDecisions(admin, clientId)]);
  if (!ctx) return null;
  return `${contextBlock(ctx, undefined, sources)}

${decisions}

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
});

/** One suggestion for one client from its signals. Returns null when the strategist decides it isn't needed. */
async function suggestFor(admin: SupabaseClient, clientId: string, signals: Signal[]) {
  const prompt = await promptFor(admin, clientId, signals);
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
    const ranked = [...signals]
      .filter(([id]) => !open.has(id))
      .map(([id, list]) => [id, list.filter((s) => !declined.has(`${id}:${s.kind}`))] as const)
      .filter(([, list]) => list.length)
      .sort((a, b) => b[1].reduce((t, s) => t + s.weight, 0) - a[1].reduce((t, s) => t + s.weight, 0))
      .slice(0, max);
    let made = 0;
    for (let i = 0; i < ranked.length; i += 3) {
      const done = await Promise.allSettled(ranked.slice(i, i + 3).map(([id, list]) => suggestFor(admin, id, [...list])));
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
    db.from("creative_suggestions").select(OPEN_COLS).eq("status", "open").neq("kind", "winner").order("created_at", { ascending: false }).limit(20),
    db.from("suggestion_runs").select("started_at, finished_at").order("started_at", { ascending: false }).limit(1),
    db.from("creative_suggestions").select("status").in("status", ["approved", "declined"]).neq("kind", "winner").gte("decided_at", since30),
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
