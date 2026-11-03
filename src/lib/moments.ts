import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// Marketing moments: the days in a client's year that can make a revenue spike (holidays, seasons, their industry's
// own days: Memorial Day for a grill box, Pancake Day for a breakfast spot, storm season for a roofer). Each client's
// calendar comes from their Brand Bible, their business model and what won for similar businesses. A few weeks ahead
// each becomes a suggested brief on Home (the creative with every asset defined, the email for the email team, the
// promotion to ask the client for, the landing page); after it, the moment's own campaign says whether it won
// (profitable) or lost, and the winners come back next year and for every business in the same sub-vertical.

type Moment = { name: string; on_date: string; lead_days: number; angle: string; offer_idea: string; why: string; match_terms: string[] };

const S = { type: "string" };
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: { name: S, on_date: S, lead_days: { type: "integer" }, angle: S, offer_idea: S, why: S, match_terms: { type: "array", items: S } },
        required: ["name", "on_date", "lead_days", "angle", "offer_idea", "why", "match_terms"],
        additionalProperties: false,
      },
    },
  },
  required: ["moments"],
  additionalProperties: false,
};

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The Bible's marketing moments section, if it has one */
function bibleMoments(markdown: string | null) {
  if (!markdown) return "";
  const parts = markdown.split(/\n(?=#{1,3} )/);
  return parts.filter((p) => /moment|season|calendar|holiday/i.test(p.split("\n")[0] ?? "")).join("\n\n").slice(0, 6000);
}

/** What won and lost at moments for businesses like this one (same sub-vertical first, then the same model), unnamed */
async function peerMoments(admin: SupabaseClient, clientId: string, verticalId: string | null, model: string | null) {
  let q = admin.from("client_moments").select("name, on_date, angle, offer_idea, status, result, vertical_id, business_model").in("status", ["won", "lost"]).neq("client_id", clientId).order("on_date", { ascending: false }).limit(60);
  if (verticalId) q = q.or(`vertical_id.eq.${verticalId}${model ? `,business_model.eq.${model}` : ""}`);
  else if (model) q = q.eq("business_model", model);
  else return [];
  const { data } = await q;
  return (data ?? []).sort((a, b) => Number(b.vertical_id === verticalId) - Number(a.vertical_id === verticalId)).slice(0, 20);
}

/** A client's moments for the next twelve months (planned once, then topped up when fewer than three are ahead) */
export async function planMoments(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: b }, { data: mine }, { businessModelOf, modelBlock }] = await Promise.all([
    admin.from("clients").select("name, industry, industry_detail, vertical_id, services, services_extra").eq("id", clientId).maybeSingle(),
    admin.from("client_brand_bibles").select("markdown").eq("client_id", clientId).maybeSingle(),
    admin.from("client_moments").select("name, on_date, status, angle, result").eq("client_id", clientId).order("on_date", { ascending: false }).limit(40),
    import("@/lib/business-model"),
  ]);
  if (!c) return 0;
  const model = await businessModelOf(admin, clientId).catch(() => null);
  const { data: v } = c.vertical_id ? await admin.from("verticals").select("name").eq("id", c.vertical_id).maybeSingle() : { data: null };
  const peers = await peerMoments(admin, clientId, (c.vertical_id as string | null) ?? null, model?.model ?? null);
  const now = today();
  const out = await askJson<{ moments: Moment[] }>({
    agent: "strategist",
    label: "marketing moments",
    override: { model: "sonnet", effort: "low" },
    system: `You plan a client's marketing moments for Kaizen Marketing, a paid social agency: the days in the next twelve months that can make a revenue or lead spike for this exact kind of business. US holidays and shopping days that fit (Valentine's, Mother's and Father's Day, Memorial Day, July 4th, Labor Day, Halloween, Thanksgiving, Black Friday, Cyber Monday, Christmas, New Year), seasons (grilling season, back to school, storm and roofing season, tax season, wedding season, summer travel), and the industry's own days (National Pancake Day for a breakfast spot, National Seafood Month for seafood, Small Business Saturday for a local shop, open enrollment for insurance). Only moments that truly fit this business, its customers and its business model: a roofer doesn't do Valentine's.
For each: name, on_date (the real date, YYYY-MM-DD, after today; a season's peak start), lead_days (how many days ahead the brief should start: 28 for a simple promo, up to 56 when it needs a new offer, a landing page or a shoot), angle (the idea in one line: "Memorial Day grill and barbecue box"), offer_idea (the promotion to ask the client for, specific to them), why (one line: why it fits them; say when a similar business won with it), match_terms (2 to 4 lowercase words a campaign or ad for it would be named with, e.g. ["memorial", "bbq"]).
Lean on what won for similar businesses and drop what lost, and on what this client already ran. 6 to 12 moments, in date order.`,
    schema: PLAN_SCHEMA,
    maxTokens: 5000,
    prompt: [
      `Today is ${now}.`,
      `<client>${c.name} · ${c.industry ?? "industry not set"}${v?.name ? ` · ${v.name}` : ""}${c.industry_detail ? ` · ${c.industry_detail}` : ""}</client>`,
      model ? modelBlock(model) : "",
      bibleMoments((b?.markdown as string | null) ?? null) ? `<their_brand_bible_moments>\n${bibleMoments(b?.markdown as string)}\n</their_brand_bible_moments>` : "",
      mine?.length ? `<their_past_moments>\n${mine.map((m) => `- ${m.on_date} ${m.name}: ${m.status}${m.angle ? ` (${m.angle})` : ""}`).join("\n")}\n</their_past_moments>` : "",
      peers.length ? `<similar_businesses_moments>\n${peers.map((p) => `- ${p.name} (${p.on_date.slice(0, 7)}): ${p.status === "won" ? "WON" : "lost"}${p.angle ? `: ${p.angle}` : ""}${p.offer_idea ? ` · offer: ${p.offer_idea}` : ""}`).join("\n")}\n</similar_businesses_moments>` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const rows = out.moments
    .filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.on_date) && m.on_date > now && m.on_date <= addDays(now, 400))
    .map((m) => ({
      client_id: clientId,
      name: m.name.slice(0, 120),
      on_date: m.on_date,
      lead_days: Math.max(21, Math.min(70, m.lead_days || 42)),
      angle: m.angle.slice(0, 300),
      offer_idea: m.offer_idea.slice(0, 400),
      why: m.why.slice(0, 400),
      match_terms: m.match_terms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3).slice(0, 4),
      vertical_id: (c.vertical_id as string | null) ?? null,
      business_model: model?.model ?? null,
    }));
  if (!rows.length) return 0;
  await admin.from("client_moments").upsert(rows, { onConflict: "client_id,name,on_date", ignoreDuplicates: true });
  return rows.length;
}

/**
 * Judge a moment that's passed: the ads in its window whose campaign or ad is named for it (its match terms), read
 * from the client's playbook. Profitable (the KPI's verdict) is a win; spend that missed is a loss; nothing named
 * for it means it didn't run.
 */
async function judge(admin: SupabaseClient, m: { id: string; client_id: string; on_date: string; lead_days: number; match_terms: string[] }) {
  const from = addDays(m.on_date, -m.lead_days);
  const to = addDays(m.on_date, 14);
  const { data } = await admin.from("client_ledger").select("title, detail, verdict, spend, results, first_seen, last_seen").eq("client_id", m.client_id).eq("kind", "creative").lte("first_seen", to).gte("last_seen", from).limit(400);
  const terms = m.match_terms.filter(Boolean);
  const hits = (data ?? []).filter((r) => {
    const d = (r.detail ?? {}) as { campaign?: string; adset?: string };
    const name = `${r.title} ${d.campaign ?? ""} ${d.adset ?? ""}`.toLowerCase();
    return terms.some((t) => name.includes(t));
  });
  if (!hits.length) return { status: "skipped" as const, result: { note: "Nothing ran named for it", from, to } };
  const spend = hits.reduce((n, r) => n + Number(r.spend || 0), 0);
  const results = hits.reduce((n, r) => n + Number(r.results || 0), 0);
  const win = hits.filter((r) => r.verdict === "winner").reduce((n, r) => n + Number(r.spend || 0), 0);
  const lose = hits.filter((r) => r.verdict === "loser").reduce((n, r) => n + Number(r.spend || 0), 0);
  const campaigns = [...new Set(hits.map((r) => ((r.detail ?? {}) as { campaign?: string }).campaign).filter(Boolean))].slice(0, 5);
  // Rule one: profitable is a win. Most of the money on winners (against the KPI) means it won
  const status = win > 0 && win >= lose ? ("won" as const) : lose > 0 ? ("lost" as const) : ("ran" as const);
  return { status, result: { spend: Math.round(spend), results: Math.round(results), ads: hits.length, campaigns, from, to } };
}

/**
 * Every hour: plan one client that needs moments, brief one moment that's due (a suggestion on Home), and judge the
 * moments that have passed.
 */
export async function keepMoments(admin: SupabaseClient) {
  const out: Record<string, string> = {};
  const now = today();
  const { LIVE } = await import("@/lib/live");
  // 1. A client with a Brand Bible and fewer than three moments ahead gets planned (one a run)
  const [{ data: clients }, { data: ahead }] = await Promise.all([
    admin.from("clients").select("id, name, client_brand_bibles!inner(generated_at)").is("archived_at", null).in("status", LIVE).not("client_brand_bibles.generated_at", "is", null),
    admin.from("client_moments").select("client_id, created_at").gte("on_date", now),
  ]);
  const count = new Map<string, number>();
  const planned = new Map<string, string>();
  for (const a of ahead ?? []) {
    count.set(a.client_id as string, (count.get(a.client_id as string) ?? 0) + 1);
    if ((planned.get(a.client_id as string) ?? "") < (a.created_at as string)) planned.set(a.client_id as string, a.created_at as string);
  }
  // Not re-planned more than once a month
  const need = (clients ?? []).find((c) => (count.get(c.id as string) ?? 0) < 3 && (!planned.get(c.id as string) || Date.parse(planned.get(c.id as string)!) < Date.now() - 30 * 86_400_000));
  if (need) out[`planned ${need.name}`] = String(await planMoments(admin, need.id as string).catch((e) => (e instanceof Error ? e.message : String(e))));

  // 2. A moment inside its lead time becomes a brief on Home (one a run)
  const { data: due } = await admin.from("client_moments").select("id, client_id, name, on_date, lead_days, angle, offer_idea, why").eq("status", "planned").gte("on_date", now).lte("on_date", addDays(now, 70)).order("on_date").limit(30);
  const ready = (due ?? []).find((m) => addDays(m.on_date as string, -(m.lead_days as number)) <= now);
  if (ready) {
    const { suggestForMoment } = await import("@/lib/suggestions");
    const id = await suggestForMoment(admin, ready.client_id as string, ready as never).catch((e) => {
      out[`brief ${ready.name}`] = e instanceof Error ? e.message : String(e);
      return null;
    });
    if (id) {
      await admin.from("client_moments").update({ status: "briefed", suggestion_id: id, updated_at: new Date().toISOString() }).eq("id", ready.id);
      out[`briefed ${ready.name}`] = id;
    }
  }

  // 3. Moments two weeks past are judged on their campaign
  const { data: past } = await admin.from("client_moments").select("id, client_id, name, on_date, lead_days, match_terms").in("status", ["planned", "briefed", "ran"]).lt("on_date", addDays(now, -14)).limit(20);
  for (const m of past ?? []) {
    const j = await judge(admin, m as never);
    await admin.from("client_moments").update({ status: j.status, result: j.result, updated_at: new Date().toISOString() }).eq("id", m.id);
    out[`judged ${m.name}`] = j.status;
  }
  return out;
}

/** For the strategist and briefs: this client's moments coming up, and what won at moments for similar businesses */
export async function momentsBlock(db: SupabaseClient, clientId: string) {
  const now = today();
  const [{ data: c }, { data: mine }] = await Promise.all([
    db.from("clients").select("vertical_id").eq("id", clientId).maybeSingle(),
    db.from("client_moments").select("name, on_date, lead_days, angle, offer_idea, status, result").eq("client_id", clientId).gte("on_date", addDays(now, -400)).order("on_date").limit(40),
  ]);
  const ahead = (mine ?? []).filter((m) => (m.on_date as string) >= now).slice(0, 5);
  const before = (mine ?? []).filter((m) => (m.on_date as string) < now && ["won", "lost"].includes(m.status as string));
  const { data: peers } = c?.vertical_id ? await db.from("client_moments").select("name, angle, offer_idea, status").eq("vertical_id", c.vertical_id).neq("client_id", clientId).eq("status", "won").order("on_date", { ascending: false }).limit(8) : { data: [] };
  if (!ahead.length && !before.length && !peers?.length) return "";
  return `<marketing_moments>
The moments in this client's year that can make a spike. A brief for one starts its lead time ahead; build briefs that ride the next one when it fits.
${ahead.length ? `Coming up:\n${ahead.map((m) => `- ${m.on_date} ${m.name}${m.angle ? `: ${m.angle}` : ""}${m.offer_idea ? ` (offer to ask for: ${m.offer_idea})` : ""}${m.status === "briefed" ? " · already briefed" : ""}`).join("\n")}` : ""}
${before.length ? `How their past moments went:\n${before.map((m) => `- ${m.name} (${(m.on_date as string).slice(0, 7)}): ${m.status === "won" ? "won, do it again" : "lost, change it or skip it"}${m.angle ? ` · ${m.angle}` : ""}`).join("\n")}` : ""}
${peers?.length ? `Won for similar businesses (unnamed):\n${peers.map((p) => `- ${p.name}${p.angle ? `: ${p.angle}` : ""}${p.offer_idea ? ` · offer: ${p.offer_idea}` : ""}`).join("\n")}` : ""}
</marketing_moments>`;
}
