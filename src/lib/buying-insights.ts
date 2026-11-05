import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, forgetAgent, type AgentKey } from "@/lib/ai";
import { clock } from "@/lib/loom";
import { businessModelOf, industryKey, MODEL_OF_INDUSTRY, playbookText, type BuyerPlatform, type BusinessModel, type PlaybookItem, type VerticalNode } from "@/lib/buyer-playbook";

// Kaizen's senior buyer, distilled. Every Loom where he reads or buys an account is taken apart into five layers:
// principles (what he believes and why), decision rules (if this, then that, with his thresholds), situational cases
// (the account, how he read it, what he did, the outcome), diagnostics (what he checks first, the columns, the order)
// and voice (how he explains and pushes back). Each item quotes the moment it came from. Consolidation merges the same
// point said in different videos (the support count is how many videos say it), sends contradictions (with another
// video, or with a hand-written skill) to an exec, and rewrites the Media Buyer's generated skills from what's best
// supported, so the agent reads, decides and talks the way he does. Hand-written skills are never touched: the
// generated ones are their own rows, marked in file_name.

type Admin = SupabaseClient;
export type Layer = "principle" | "rule" | "case" | "diagnostic" | "voice";
type Platform = "meta" | "google" | "both" | "none";

export const MARK = "loom-distilled:";
const SKILL_LAYERS: { layer: Exclude<Layer, "case">; title: string; intro: string }[] = [
  { layer: "principle", title: "From the senior buyer's audits: principles", intro: "What Kaizen's senior buyer believes about buying ads, and why, distilled from his Loom audits. The number is how many of his videos say it: lean hardest on the most said." },
  { layer: "rule", title: "From the senior buyer's audits: decision rules", intro: "How Kaizen's senior buyer decides, with his own thresholds: if the account shows this, he does that. The number is how many of his videos say it. Apply them the way he would, and say which one you're using." },
  { layer: "diagnostic", title: "From the senior buyer's audits: diagnostics", intro: "How Kaizen's senior buyer reads an account: what he checks first, the columns he pulls, and in what order. The number is how many of his videos show it. Read accounts in this order." },
  { layer: "voice", title: "From the senior buyer's audits: voice", intro: "How Kaizen's senior buyer explains things, the phrases he uses and how he pushes back. Write audits and answers so they sound like him: direct, specific, the reason before the action. Never name him; he is Kaizen's senior buyer." },
];
/** The skills each layer is written into: every Meta-side Media Buyer skill, and the Google auditor for Google */
export const META_AGENTS: AgentKey[] = ["auditor", "launcher", "fatigue"];
export const GOOGLE_AGENTS: AgentKey[] = ["google_auditor"];
const SKILL_CHARS = 3000;

// ─── Distilling one video ───────────────────────────────────────────────────

const ITEM = { quote: { type: "string" }, at: { type: "string" }, platform: { type: "string", enum: ["meta", "google", "both", "none"] } };
const obj = (props: Record<string, unknown>) => ({ type: "array", items: { type: "object", properties: { ...props, ...ITEM }, required: [...Object.keys(props), ...Object.keys(ITEM)], additionalProperties: false } });
export const DISTILL = {
  type: "object",
  properties: {
    key_points: { type: "array", items: { type: "string" } },
    principles: obj({ belief: { type: "string" }, why: { type: "string" } }),
    rules: obj({ if: { type: "string" }, then: { type: "string" }, thresholds: { type: "string" } }),
    cases: obj({ situation: { type: "string" }, read: { type: "string" }, action: { type: "string" }, outcome: { type: "string" }, industry: { type: "string" }, business_model: { type: "string" }, budget: { type: "string" }, this_client: { type: "boolean" } }),
    diagnostics: obj({ check: { type: "string" } }),
    voice: obj({ how: { type: "string" } }),
    situation: { type: "string" },
    memory: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["prefer", "avoid", "note"] }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false } },
  },
  required: ["key_points", "principles", "rules", "cases", "diagnostics", "voice", "situation", "memory"],
  additionalProperties: false,
};
type Base = { quote: string; at: string; platform: Platform };
export type Distilled = {
  key_points: string[];
  principles: (Base & { belief: string; why: string })[];
  rules: (Base & { if: string; then: string; thresholds: string })[];
  cases: (Base & { situation: string; read: string; action: string; outcome: string; industry: string; business_model: string; budget: string; this_client: boolean })[];
  diagnostics: (Base & { check: string })[];
  voice: (Base & { how: string })[];
  situation: string;
  memory: { kind: "prefer" | "avoid" | "note"; text: string }[];
};

export const DISTILL_RULES = `Take the video apart into what Kaizen's senior buyer teaches, so an AI media buyer can read, decide and talk exactly like him. Use only what he says or shows; never invent a number, rule or outcome. Each item: quote (his words, up to 25, verbatim from the transcript) and at (the [m:ss] mark of that moment, without brackets; empty when unknown), and platform.
principles: what he believes about buying ads and why (belief, why).
rules: his decisions as if/then, with his own thresholds (CPA vs target, frequency, spend before a read, days, ROAS, CTR, hook rate…) in thresholds; empty string when he gives none.
cases: each account situation he walks through: situation (the account, objective, spend, what the numbers showed), read (how he read it), action (what he did or recommended), outcome (what happened, only if said; else empty), industry, business_model (ecommerce, lead gen, local service, app…), budget (the spend level, e.g. "about $3k a month"; empty when unknown), this_client (true when it's the account of the client this video is about).
diagnostics: what he checks, in his order: first looks, the columns he pulls, the breakdowns, what makes him dig further.
voice: how he explains things, phrases he repeats, analogies, how he pushes back on a client or a buyer, what he refuses to do. Each "how" says the pattern and gives his wording.
Refer to him as Kaizen's senior buyer, never by name, and to others by role. Plain text, no em dashes.`;

const seconds = (at: string) => {
  const m = at.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};
const tidy = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").trim();

/** One video's layers saved, once (a video read again doesn't add its teachings twice) */
export async function saveInsights(admin: Admin, v: { videoId: string; loomId: string; clientId: string | null; industry: string | null }, d: Distilled) {
  const { count } = await admin.from("media_buying_insights").select("id", { count: "exact", head: true }).eq("loom_id", v.loomId);
  if (count) return 0;
  const row = (layer: Layer, body: string, it: Base, tags: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    layer,
    body: tidy(body).slice(0, 1500),
    quote: it.quote ? tidy(it.quote).slice(0, 400) : null,
    at_seconds: seconds(it.at ?? ""),
    platform: it.platform ?? "none",
    tags,
    loom_video_id: v.videoId,
    loom_id: v.loomId,
    videos: [v.loomId],
    confidence: 1,
    industry: v.industry,
    ...extra,
  });
  const rows = [
    ...d.principles.filter((p) => p.belief.trim()).map((p) => row("principle", `${p.belief}${p.why ? ` Why: ${p.why}` : ""}`, p)),
    ...d.rules.filter((r) => r.if.trim() && r.then.trim()).map((r) => row("rule", `If ${r.if.replace(/^if\s+/i, "")}, then ${r.then.replace(/^then\s+/i, "")}${r.thresholds ? ` (${r.thresholds})` : ""}`, r, { thresholds: r.thresholds })),
    ...d.diagnostics.filter((x) => x.check.trim()).map((x) => row("diagnostic", x.check, x)),
    ...d.voice.filter((x) => x.how.trim()).map((x) => row("voice", x.how, x)),
    ...d.cases
      .filter((c) => c.situation.trim())
      .map((c) =>
        row(
          "case",
          caseText(c),
          c,
          { industry: c.industry, business_model: c.business_model, budget: c.budget, situation: c.situation, read: c.read, action: c.action, outcome: c.outcome },
          { industry: c.industry || v.industry, client_id: c.this_client ? v.clientId : null, consolidated_at: new Date().toISOString() },
        ),
      ),
  ];
  // Where it came from: the video's client's sub-vertical, else the industry he named (a case's own account first),
  // placed in our taxonomy once and remembered; the business model from what he said, else the client's industry
  const now = new Date().toISOString();
  const client = v.clientId ? ((await admin.from("clients").select("vertical_id, industry").eq("id", v.clientId).maybeSingle()).data ?? null) : null;
  const named = [...new Set(rows.map((r) => (r.layer === "case" ? str((r.tags as Record<string, unknown>).industry) : "") || r.industry || "").filter(Boolean))];
  const mapped = await mapIndustries(admin, named as string[]).catch(() => null);
  const caseModels = d.cases.map((c) => businessModelOf(c.business_model)).filter(Boolean) as BusinessModel[];
  const videoModel = majority(caseModels) ?? (client?.industry ? (MODEL_OF_INDUSTRY[client.industry as string] ?? null) : null) ?? businessModelOf(v.industry);
  const attributed = rows.map((r) => {
    const t = r.tags as Record<string, unknown>;
    const mineToo = Boolean((r as { client_id?: string | null }).client_id);
    const own = r.layer === "case" && !mineToo ? str(t.industry) : "";
    const viaText = (s: string) => (s && mapped ? (mapped.get(industryKey(s)) ?? null) : null);
    const vertical_id = (mineToo && (client?.vertical_id as string | null)) || viaText(own) || (client?.vertical_id as string | null) || viaText(r.industry ?? "") || null;
    return { ...r, vertical_id, business_model: businessModelOf(str(t.business_model)) ?? videoModel, attributed_at: mapped ? now : null };
  });
  const ids: string[] = [];
  for (let i = 0; i < attributed.length; i += 200) {
    const { data } = await admin.from("media_buying_insights").insert(attributed.slice(i, i + 200)).select("id");
    ids.push(...(data ?? []).map((x) => x.id as string));
  }
  // General or only for this kind of business (and the platform, when he didn't say); left for the backfill if the AI is busy
  await scopeInsights(admin, ids, { until: Date.now() + 150_000, parallel: 2 }).catch(() => null);
  return rows.length;
}

const caseText = (c: Distilled["cases"][number]) =>
  `Situation: ${c.situation}\nHow he read it: ${c.read}\nWhat he did: ${c.action}${c.outcome ? `\nOutcome: ${c.outcome}` : ""}`;

/** The cases as a knowledge text: each one tagged (industry, business model, platform, budget) so a similar account finds it */
export function casesDoc(title: string, url: string, d: Distilled, only?: (c: Distilled["cases"][number]) => boolean) {
  const cases = d.cases.filter((c) => c.situation.trim() && (!only || only(c)));
  if (!cases.length) return null;
  const tag = (c: Distilled["cases"][number]) => [c.industry, c.business_model, c.platform === "none" ? "" : c.platform === "both" ? "Meta and Google" : c.platform === "google" ? "Google Ads" : "Meta", c.budget].filter(Boolean).join(" · ");
  return tidy(
    `# Cases from "${title}"\nAccounts Kaizen's senior buyer walked through in this Loom (${url}): how he read each one and what he did.\n\n${cases
      .map((c) => `## Case: ${tag(c) || "account"}\n${caseText(c)}${c.quote ? `\nIn his words${c.at ? ` (at ${c.at})` : ""}: "${c.quote}"` : ""}`)
      .join("\n\n")}`,
  );
}

// ─── Consolidating across videos ────────────────────────────────────────────

type Insight = { id: string; layer: Layer; body: string; platform: Platform; videos: string[]; confidence: number; quote: string | null; loom_id: string | null; at_seconds: number | null };

const CONSOLIDATE = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { ref: { type: "string" }, same_as: { type: "string" }, contradicts: { type: "string" }, contradicts_skill: { type: "string" }, note: { type: "string" } },
        required: ["ref", "same_as", "contradicts", "contradicts_skill", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const LAYER_NAME: Record<Layer, string> = { principle: "principles", rule: "decision rules", case: "cases", diagnostic: "diagnostics", voice: "voice notes" };

/**
 * New items merged into what's known: the same point (said differently, in another video) joins the existing item and
 * adds its video to the support count; a contradiction (with an item or a hand-written skill) waits for an exec.
 * Runs in batches within the time budget, then rewrites the generated skills.
 */
export async function consolidateInsights(admin: Admin, { budgetMs = 300_000 }: { budgetMs?: number } = {}) {
  const until = Date.now() + budgetMs;
  const out = { merged: 0, conflicts: 0, kept: 0, left: 0 };
  // The hand-written skills the generated ones must not contradict silently
  const { data: hand } = await admin.from("ai_knowledge").select("title, body, file_name").in("agent_key", [...META_AGENTS, ...GOOGLE_AGENTS]).eq("active", true);
  const written = new Map<string, string>();
  for (const h of hand ?? []) if (!String(h.file_name ?? "").startsWith(MARK)) written.set(h.title as string, (h.body as string).slice(0, 1800));
  const skills = [...written].map(([t, b]) => `<skill title="${t.replace(/"/g, "'")}">\n${b}\n</skill>`).join("\n");

  for (const { layer } of SKILL_LAYERS) {
    while (Date.now() < until - 60_000) {
      const { data: fresh } = await admin.from("media_buying_insights").select("id, layer, body, platform, videos, confidence, quote, loom_id, at_seconds").eq("layer", layer).is("consolidated_at", null).is("merged_into", null).order("created_at").limit(30);
      if (!fresh?.length) break;
      const { data: known } = await admin.from("media_buying_insights").select("id, layer, body, platform, videos, confidence, quote, loom_id, at_seconds").eq("layer", layer).not("consolidated_at", "is", null).is("merged_into", null).eq("excluded", false).order("confidence", { ascending: false }).limit(400);
      const K = (known ?? []) as Insight[];
      const N = fresh as Insight[];
      const res = await askJson<{ items: { ref: string; same_as: string; contradicts: string; contradicts_skill: string; note: string }[] }>({
        agent: "auditor",
        label: "insight consolidate",
        override: { model: "sonnet", effort: "medium" },
        maxTokens: 6000,
        system: "You keep the distilled teachings of Kaizen's senior buyer tidy: one item per point, however many videos make it.",
        schema: CONSOLIDATE,
        prompt: `Layer: ${LAYER_NAME[layer]}.\n\n<known>\n${K.map((k, i) => `K${i + 1} [${k.platform}] ${k.body.slice(0, 350)}`).join("\n") || "(none yet)"}\n</known>\n\n<new>\n${N.map((n, i) => `N${i + 1} [${n.platform}] ${n.body.slice(0, 500)}`).join("\n")}\n</new>\n${layer === "voice" ? "" : `\n<hand_written_skills note="the agency's own written method">\n${skills}\n</hand_written_skills>\n`}\nFor every new item (ref N1, N2…): same_as: the K or earlier N item that makes the same point (the same belief, the same rule with roughly the same thresholds, the same check), even in other words; empty when it's a distinct point. contradicts: the K or earlier N item it truly contradicts (opposite advice for the same situation; different situations or platforms are not a contradiction); empty when none. contradicts_skill: the title of a hand-written skill it truly contradicts, else empty. note: when it contradicts, one sentence on how they differ; else empty.`,
      });
      const pick = (ref: string, upto: number): Insight | null => {
        const m = ref.trim().match(/^([KN])(\d+)$/i);
        if (!m) return null;
        const i = Number(m[2]) - 1;
        if (m[1].toUpperCase() === "K") return K[i] ?? null;
        return i < upto ? (N[i] ?? null) : null;
      };
      const now = new Date().toISOString();
      const mergedInto = new Map<string, string>();
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        const r = res.items.find((x) => x.ref.trim().toUpperCase() === `N${i + 1}`);
        let target = r ? pick(r.same_as, i) : null;
        // An earlier new item that itself merged: follow it to where it went
        while (target && mergedInto.has(target.id)) target = K.find((k) => k.id === mergedInto.get(target!.id)) ?? N.find((x) => x.id === mergedInto.get(target!.id)) ?? null;
        if (target && target.id !== n.id) {
          const videos = [...new Set([...target.videos, ...n.videos])];
          target.videos = videos;
          target.confidence = videos.length;
          // The fuller wording and its quote stay; the support count grows
          await admin.from("media_buying_insights").update({ videos, confidence: videos.length, updated_at: now }).eq("id", target.id);
          await admin.from("media_buying_insights").update({ merged_into: target.id, consolidated_at: now, updated_at: now }).eq("id", n.id);
          mergedInto.set(n.id, target.id);
          out.merged++;
          continue;
        }
        const against = r ? pick(r.contradicts, i) : null;
        const skill = r?.contradicts_skill && written.has(r.contradicts_skill.trim()) ? r.contradicts_skill.trim() : null;
        if ((against && against.id !== n.id) || skill) {
          await admin.from("media_buying_insights").update({ conflict_with: against?.id ?? null, conflict_skill: skill, conflict_note: (r?.note ?? "").slice(0, 600) || null, consolidated_at: now, updated_at: now }).eq("id", n.id);
          out.conflicts++;
        } else {
          await admin.from("media_buying_insights").update({ consolidated_at: now, updated_at: now }).eq("id", n.id);
          out.kept++;
        }
      }
    }
  }
  const { count } = await admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("consolidated_at", null).is("merged_into", null);
  out.left = count ?? 0;
  await rewriteBuyerSkills(admin);
  // New contradictions go to the people who rule on them (the bell)
  if (out.conflicts) await (await import("@/lib/insight-conflicts")).notifyContradictions(admin).catch(() => null);
  return out;
}

/** The generated skills, rewritten from the best-supported items (each under ~3k characters); hand-written ones untouched */
export async function rewriteBuyerSkills(admin: Admin) {
  const { data } = await admin
    .from("media_buying_insights")
    .select("layer, body, platform, confidence, quote, conflict_with, conflict_skill, ruling")
    .neq("layer", "case")
    // Only what holds for any account: a point that only makes sense for one kind of business comes with that
    // business's accounts (buyerPlaybookBlock), never taught to every account
    .eq("scope", "general")
    .is("merged_into", null)
    .eq("excluded", false)
    .not("consolidated_at", "is", null)
    .order("confidence", { ascending: false })
    .limit(3000);
  // A contradiction waiting for a ruling isn't taught yet
  const usable = (data ?? []).filter((i) => !((i.conflict_with || i.conflict_skill) && !i.ruling));
  const written: string[] = [];
  for (const group of [
    { agents: META_AGENTS, fits: (p: string) => p !== "google" },
    { agents: GOOGLE_AGENTS, fits: (p: string) => p === "google" || p === "both" },
  ]) {
    for (const s of SKILL_LAYERS) {
      const items = usable.filter((i) => i.layer === s.layer && group.fits(i.platform as string));
      let body = `${s.intro}\n`;
      for (const i of items) {
        const voiceQuote = s.layer === "voice" && i.quote ? ` In his words: "${(i.quote as string).slice(0, 160)}"` : "";
        const line = `- (${i.confidence}) ${i.body as string}${voiceQuote}\n`;
        if (body.length + line.length > SKILL_CHARS) break;
        body += line;
      }
      for (const agent of group.agents) {
        const file = `${MARK}${s.layer}`;
        const { data: had } = await admin.from("ai_knowledge").select("id").eq("agent_key", agent).eq("file_name", file).limit(1);
        if (!items.length) {
          // Nothing to teach on this layer (yet): the generated row rests, it isn't deleted
          if (had?.length) await admin.from("ai_knowledge").update({ active: false, updated_at: new Date().toISOString() }).eq("id", had[0].id);
          continue;
        }
        if (had?.length) await admin.from("ai_knowledge").update({ title: s.title, body: body.trim(), active: true, updated_at: new Date().toISOString() }).eq("id", had[0].id);
        else await admin.from("ai_knowledge").insert({ agent_key: agent, kind: "skill", title: s.title, body: body.trim(), file_name: file, active: true });
        written.push(`${agent}: ${s.layer}`);
      }
    }
  }
  forgetAgent();
  return written;
}

/** An exec's ruling on a contradiction: keep this one (the other is ruled out), drop this one, or both hold */
export async function ruleInsight(admin: Admin, id: string, ruling: "keep" | "drop" | "both", by: string) {
  const { data: i } = await admin.from("media_buying_insights").select("id, conflict_with").eq("id", id).single();
  if (!i) throw new Error("Not found.");
  const now = new Date().toISOString();
  await admin.from("media_buying_insights").update({ ruling, ruled_by: by, ruled_at: now, excluded: ruling === "drop", updated_at: now }).eq("id", id);
  if (ruling === "keep" && i.conflict_with) await admin.from("media_buying_insights").update({ excluded: true, ruling: "drop", ruled_by: by, ruled_at: now, updated_at: now }).eq("id", i.conflict_with);
  await (await import("@/lib/insight-conflicts")).settleNotices(admin, id).catch(() => null);
  await rewriteBuyerSkills(admin);
}

// ─── Where each point came from: platform, industry, business model, scope ──

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const majority = <T extends string>(xs: T[]): T | null => {
  if (!xs.length) return null;
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0][0];
};

async function taxonomy(admin: Admin) {
  const { data } = await admin.from("verticals").select("id, name, parent_id, description").eq("active", true).order("sort_order");
  return (data ?? []) as (VerticalNode & { description: string | null })[];
}

const MAP_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "object", properties: { n: { type: "integer" }, ref: { type: "string" } }, required: ["n", "ref"], additionalProperties: false } } },
  required: ["items"],
  additionalProperties: false,
};

/**
 * Free-text industries ("restaurant (pizza)", "medical (mental health practice)") placed in our verticals: the
 * sub-vertical that fits best, else the vertical, else none. Each string is asked once (one call per batch of new
 * ones) and remembered in media_buying_industry_map. Returns key → vertical id (null: nothing fits).
 */
export async function mapIndustries(admin: Admin, texts: string[]) {
  const out = new Map<string, string | null>();
  const keys = [...new Map(texts.filter((t) => t.trim()).map((t) => [industryKey(t), t.trim()])).entries()];
  if (!keys.length) return out;
  for (let i = 0; i < keys.length; i += 300) {
    const { data } = await admin.from("media_buying_industry_map").select("key, vertical_id").in("key", keys.slice(i, i + 300).map(([k]) => k));
    for (const r of data ?? []) out.set(r.key as string, (r.vertical_id as string | null) ?? null);
  }
  const fresh = keys.filter(([k]) => !out.has(k));
  if (!fresh.length) return out;
  const tree = await taxonomy(admin);
  if (!tree.length) return out;
  // Short refs (V1, S1) for the model; ids only on our side
  const ref = new Map<string, string>();
  const lines: string[] = [];
  let sub = 0;
  tree
    .filter((v) => !v.parent_id)
    .forEach((v, vi) => {
      ref.set(`V${vi + 1}`, v.id);
      lines.push(`V${vi + 1} ${v.name}${v.description ? `: ${v.description.slice(0, 140)}` : ""}`);
      for (const s of tree.filter((x) => x.parent_id === v.id)) {
        sub++;
        ref.set(`S${sub}`, s.id);
        lines.push(`  S${sub} ${s.name}${s.description ? `: ${s.description.slice(0, 140)}` : ""}`);
      }
    });
  for (let i = 0; i < fresh.length; i += 80) {
    const batch = fresh.slice(i, i + 80);
    const res = await askJson<{ items: { n: number; ref: string }[] }>({
      agent: "verticals",
      label: "insight industry map",
      bare: true,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 4000,
      system: "You place the kinds of business a senior media buyer mentions into an ad agency's own verticals (V) and sub-verticals (S, indented under their vertical).",
      schema: MAP_SCHEMA,
      prompt: `<verticals>\n${lines.join("\n")}\n</verticals>\n\n<industries>\n${batch.map(([, t], j) => `${j + 1}. ${t.slice(0, 160)}`).join("\n")}\n</industries>\n\nFor every industry by number: ref is the sub-vertical (S…) it belongs to when one clearly fits (how the business sells and to whom, not just a shared word), else its vertical (V…) when only that fits, else empty when none fits or it's too vague ("unknown", "various", "agency").`,
    });
    const rows = batch.map(([k, t], j) => {
      const r = res.items.find((x) => x.n === j + 1)?.ref.trim().toUpperCase() ?? "";
      return { key: k, label: t.slice(0, 200), vertical_id: ref.get(r) ?? null };
    });
    await admin.from("media_buying_industry_map").upsert(rows, { onConflict: "key" });
    for (const r of rows) out.set(r.key, r.vertical_id);
  }
  return out;
}

const SCOPE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties: { ref: { type: "string" }, scope: { type: "string", enum: ["general", "industry"] }, platform: { type: "string", enum: ["meta", "google", "both", "none"] } }, required: ["ref", "scope", "platform"], additionalProperties: false },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/**
 * General or industry: does the point hold for any account on its platform, or only make sense for that kind of
 * business? Asked in batches of 40 (beliefs, rules and checks; a case is always about its account, a voice note always
 * general). Points with no platform get one when they clearly name Meta or Google things.
 */
export async function scopeInsights(admin: Admin, ids?: string[], { until = Date.now() + 600_000, parallel = 4 }: { until?: number; parallel?: number } = {}) {
  const out = { scoped: 0, industry: 0, platform: 0 };
  const now = () => new Date().toISOString();
  // Cases and voice need no call
  for (const [layer, scope] of [
    ["case", "industry"],
    ["voice", "general"],
  ] as const) {
    let q = admin.from("media_buying_insights").update({ scope, scoped_at: now() }).eq("layer", layer).is("scoped_at", null);
    if (ids) q = q.in("id", ids);
    await q;
  }
  const names = new Map((await taxonomy(admin)).map((v) => [v.id, v.name]));
  for (;;) {
    if (Date.now() > until - 45_000) break;
    let q = admin.from("media_buying_insights").select("id, layer, body, platform, vertical_id, business_model, industry").is("scoped_at", null).is("merged_into", null).eq("excluded", false).in("layer", ["principle", "rule", "diagnostic"]).order("created_at").limit(40 * parallel);
    if (ids) q = q.in("id", ids.slice(0, 1000));
    const { data } = await q;
    if (!data?.length) break;
    const batches: (typeof data)[] = [];
    for (let i = 0; i < data.length; i += 40) batches.push(data.slice(i, i + 40));
    const done = await Promise.all(
      batches.map(async (b) => {
        try {
          const res = await askJson<{ items: { ref: string; scope: "general" | "industry"; platform: Platform }[] }>({
            agent: "auditor",
            label: "insight scope",
            bare: true,
            override: { model: "sonnet", effort: "low" },
            maxTokens: 5000,
            system: "You sort the distilled teachings of Kaizen's senior buyer so each reaches the right accounts.",
            schema: SCOPE_SCHEMA,
            prompt: `<points>\n${b.map((x, i) => `P${i + 1} [${x.layer}; platform ${x.platform}; from ${[x.vertical_id ? names.get(x.vertical_id as string) : x.industry, x.business_model].filter(Boolean).join(", ") || "unknown business"}] ${(x.body as string).slice(0, 450)}`).join("\n")}\n</points>\n\nFor every point (ref P1, P2…):\nscope: industry when the point only makes sense for a certain kind of business (it hinges on that business's offer, customer or sales motion: reservations, ticketed events, a consult or a quote, a product category, a delivery radius, a seasonal rush specific to it); general when it holds for any account on its platform, even if he said it about one account. A buying mechanic (budgets, bidding, structure, testing, frequency, fatigue, reading the numbers) is general even when his example was one industry.\nplatform: meta when it's about Meta things (Ads Manager, ad sets, Advantage+, CBO or ABO, Reels, Stories, the pixel, lead forms, frequency), google when it's about Google Ads things (search terms, keywords, match types, Performance Max, Quality Score, impression share, responsive search ads, Shopping), both when it names both, none when it's about neither.`,
          });
          const at = now();
          const byScope = new Map<string, string[]>();
          for (let i = 0; i < b.length; i++) {
            const r = res.items.find((x) => x.ref.trim().toUpperCase() === `P${i + 1}`);
            const scope = r?.scope === "industry" ? "industry" : "general";
            byScope.set(scope, [...(byScope.get(scope) ?? []), b[i].id as string]);
            if (scope === "industry") out.industry++;
            // Only a point with no platform gets one; a platform he said stays
            if (b[i].platform === "none" && r && r.platform !== "none") {
              await admin.from("media_buying_insights").update({ platform: r.platform }).eq("id", b[i].id);
              out.platform++;
            }
          }
          for (const [scope, list] of byScope) await admin.from("media_buying_insights").update({ scope, scoped_at: at }).in("id", list);
          out.scoped += b.length;
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (!done.some(Boolean)) break;
  }
  return out;
}

type AttrRow = { id: string; layer: Layer; industry: string | null; tags: Record<string, unknown> | null; client_id: string | null; loom_video_id: string | null };

/**
 * The backfill, resumable (Settings button and the Loom cron step): every point not yet attributed gets its sub-vertical
 * (its own client's; a case's named industry; the video's one client's; the industry it names, mapped once; or the one
 * industry its video's cases share) and its business model (what he said, else the video's cases, else the client's
 * industry); then each live point's scope. The generated skills are rewritten from the general ones after.
 */
export async function attributeInsights(admin: Admin, { budgetMs = 420_000 }: { budgetMs?: number } = {}) {
  const until = Date.now() + budgetMs;
  const out = { attributed: 0, mapped: 0, scoped: 0, industry: 0, platform: 0, left: 0 };
  while (Date.now() < until - 90_000) {
    const { data } = await admin.from("media_buying_insights").select("id, layer, industry, tags, client_id, loom_video_id").is("attributed_at", null).order("created_at").limit(1000);
    const rows = (data ?? []) as AttrRow[];
    if (!rows.length) break;
    const videoIds = [...new Set(rows.map((r) => r.loom_video_id).filter(Boolean))] as string[];
    const [{ data: videos }, { data: cases }] = await Promise.all([
      videoIds.length ? admin.from("loom_videos").select("id, client_id, client_ids").in("id", videoIds) : Promise.resolve({ data: [] }),
      videoIds.length ? admin.from("media_buying_insights").select("loom_video_id, industry, tags").eq("layer", "case").in("loom_video_id", videoIds) : Promise.resolve({ data: [] }),
    ]);
    // The video's client counts only when it's about one client
    const videoClient = new Map<string, string | null>();
    for (const v of videos ?? []) videoClient.set(v.id as string, v.client_id && ((v.client_ids as string[] | null) ?? []).length <= 1 ? (v.client_id as string) : null);
    const clientIds = [...new Set([...rows.map((r) => r.client_id), ...videoClient.values()].filter(Boolean))] as string[];
    const { data: clients } = clientIds.length ? await admin.from("clients").select("id, vertical_id, industry").in("id", clientIds) : { data: [] };
    const client = new Map((clients ?? []).map((c) => [c.id as string, c as { id: string; vertical_id: string | null; industry: string | null }]));
    const named = [...rows.flatMap((r) => [str(r.tags?.industry), r.industry ?? ""]), ...(cases ?? []).flatMap((c) => [str((c.tags as Record<string, unknown>)?.industry), (c.industry as string | null) ?? ""])];
    const mapped = await mapIndustries(admin, named);
    out.mapped = mapped.size;
    const via = (s: string | null | undefined) => (s && s.trim() ? (mapped.get(industryKey(s)) ?? null) : null);
    // Per video: the one industry its cases share (if they all agree), and its cases' business model
    const videoVertical = new Map<string, string | null>();
    const videoModel = new Map<string, BusinessModel | null>();
    for (const vid of videoIds) {
      const vc = (cases ?? []).filter((c) => c.loom_video_id === vid);
      const vs = [...new Set(vc.map((c) => via(str((c.tags as Record<string, unknown>)?.industry) || (c.industry as string | null))).filter(Boolean))];
      videoVertical.set(vid, vs.length === 1 ? (vs[0] as string) : null);
      videoModel.set(vid, majority(vc.map((c) => businessModelOf(str((c.tags as Record<string, unknown>)?.business_model))).filter(Boolean) as BusinessModel[]));
    }
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const own = r.client_id ? client.get(r.client_id) : undefined;
      const vClient = r.loom_video_id ? client.get(videoClient.get(r.loom_video_id) ?? "") : undefined;
      const caseText = r.layer === "case" && !r.client_id ? str(r.tags?.industry) : "";
      const vertical = own?.vertical_id || via(caseText) || vClient?.vertical_id || via(r.industry) || via(str(r.tags?.industry)) || (r.loom_video_id ? videoVertical.get(r.loom_video_id) : null) || null;
      const ind = own?.industry ?? vClient?.industry ?? null;
      const model = businessModelOf(str(r.tags?.business_model)) ?? (r.loom_video_id ? videoModel.get(r.loom_video_id) : null) ?? (ind ? (MODEL_OF_INDUSTRY[ind] ?? null) : null) ?? businessModelOf(r.industry);
      const key = `${vertical ?? ""}|${model ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), r.id]);
    }
    const at = new Date().toISOString();
    for (const [key, ids] of groups) {
      const [vertical_id, business_model] = key.split("|");
      for (let i = 0; i < ids.length; i += 200) await admin.from("media_buying_insights").update({ vertical_id: vertical_id || null, business_model: business_model || null, attributed_at: at }).in("id", ids.slice(i, i + 200));
    }
    out.attributed += rows.length;
  }
  if (Date.now() < until - 60_000) {
    const s = await scopeInsights(admin, undefined, { until });
    out.scoped = s.scoped;
    out.industry = s.industry;
    out.platform = s.platform;
  }
  const [{ count: a }, { count: s }] = await Promise.all([
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("attributed_at", null),
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("scoped_at", null).is("merged_into", null).eq("excluded", false),
  ]);
  out.left = (a ?? 0) + (s ?? 0);
  if (out.scoped || out.attributed) await rewriteBuyerSkills(admin);
  return out;
}

/** Whether the backfill still has work (the cron step runs it only then) */
export async function attributionPending(admin: Admin) {
  const [{ count: a }, { count: s }] = await Promise.all([
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("attributed_at", null),
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("scoped_at", null).is("merged_into", null).eq("excluded", false),
  ]);
  return (a ?? 0) + (s ?? 0);
}

// ─── The playbook for one account, at call time ─────────────────────────────

const playbookCache = new Map<string, { at: number; text: string }>();

/**
 * The senior buyer's points for this client's platform and kind of business (sub-vertical, then vertical, then business
 * model), with the closest cases, about 3.5k characters. Kept 10 minutes per client and platform. "" when none fit.
 */
export async function buyerPlaybookBlock(admin: Admin, clientId: string, platform: BuyerPlatform) {
  const key = `${clientId}:${platform}`;
  const hit = playbookCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.text;
  const [{ data: c }, tree] = await Promise.all([admin.from("clients").select("vertical_id, industry, industry_detail").eq("id", clientId).maybeSingle(), taxonomy(admin)]);
  let text = "";
  const verticalId = (c?.vertical_id as string | null) ?? null;
  const model = c?.industry ? (MODEL_OF_INDUSTRY[c.industry as string] ?? null) : null;
  if (c && (verticalId || model)) {
    const mine = tree.find((v) => v.id === verticalId);
    const parentId = mine ? (mine.parent_id ?? mine.id) : null;
    const family = parentId ? tree.filter((v) => v.id === parentId || v.parent_id === parentId).map((v) => v.id) : [];
    const or = [family.length ? `vertical_id.in.(${family.join(",")})` : "", model ? `business_model.eq.${model}` : ""].filter(Boolean).join(",");
    const { data } = await admin
      .from("media_buying_insights")
      .select("layer, body, platform, vertical_id, business_model, scope, confidence, at_seconds, tags, conflict_with, conflict_skill, ruling")
      .in("platform", [platform, "both"])
      .neq("layer", "voice")
      .is("merged_into", null)
      .eq("excluded", false)
      .or(or)
      .order("confidence", { ascending: false })
      .limit(800);
    const items = (data ?? []).filter((i) => !((i.conflict_with || i.conflict_skill) && !i.ruling)) as unknown as PlaybookItem[];
    const parent = parentId ? tree.find((v) => v.id === parentId) : undefined;
    const industry = [parent?.name, mine && mine.id !== parent?.id ? mine.name : null].filter(Boolean).join(" > ") || (c.industry_detail as string | null) || (c.industry as string | null) || "this business";
    text = playbookText(items, { platform, verticalId, businessModel: model }, tree, industry);
  }
  playbookCache.set(key, { at: Date.now(), text });
  return text;
}

// ─── What Settings shows ────────────────────────────────────────────────────

export type InsightsStatus = {
  byLayer: Record<Layer, number>;
  /** Live points by the platform they're about */
  byPlatform: Record<Platform, number>;
  total: number;
  waiting: number;
  conflicts: { id: string; layer: Layer; platform: Platform; body: string; quote: string | null; at: string | null; url: string | null; note: string | null; against: string | null; againstSkill: string | null }[];
  top: { layer: Layer; body: string; confidence: number }[];
  skillsAt: string | null;
  /** Where the live points came from: general (taught to every account) or industry-only, by platform and vertical */
  attribution: {
    general: number;
    industry: number;
    unmapped: number;
    pending: number;
    verticals: { name: string; meta: number; google: number; both: number; none: number; total: number; industry: number }[];
  };
};

export async function insightsStatus(admin: Admin): Promise<InsightsStatus> {
  const [{ data: rows }, { data: conflicts }, { data: skill }, { count: waiting }] = await Promise.all([
    admin.from("media_buying_insights").select("layer, body, confidence, platform").is("merged_into", null).eq("excluded", false).order("confidence", { ascending: false }).limit(5000),
    admin.from("media_buying_insights").select("id, layer, body, platform, quote, at_seconds, loom_id, conflict_note, conflict_skill, other:conflict_with(body)").is("ruling", null).eq("excluded", false).is("merged_into", null).or("conflict_with.not.is.null,conflict_skill.not.is.null").order("created_at").limit(500),
    admin.from("ai_knowledge").select("updated_at").like("file_name", `${MARK}%`).order("updated_at", { ascending: false }).limit(1),
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("consolidated_at", null).is("merged_into", null),
  ]);
  const byLayer: Record<Layer, number> = { principle: 0, rule: 0, case: 0, diagnostic: 0, voice: 0 };
  const byPlatform: Record<Platform, number> = { meta: 0, google: 0, both: 0, none: 0 };
  for (const r of rows ?? []) {
    byLayer[r.layer as Layer]++;
    byPlatform[((r.platform as Platform | null) ?? "none") as Platform]++;
  }
  const [{ data: counts }, tree] = await Promise.all([admin.rpc("buying_insight_counts"), taxonomy(admin)]);
  const byId = new Map(tree.map((v) => [v.id, v]));
  const attribution: InsightsStatus["attribution"] = { general: 0, industry: 0, unmapped: 0, pending: 0, verticals: [] };
  const per = new Map<string, InsightsStatus["attribution"]["verticals"][number]>();
  for (const c of (counts ?? []) as { platform: Platform; vertical_id: string | null; scope: string; attributed: boolean; scoped: boolean; n: number }[]) {
    const n = Number(c.n);
    if (!c.attributed || !c.scoped) attribution.pending += n;
    if (c.scope === "industry") attribution.industry += n;
    else attribution.general += n;
    const v = c.vertical_id ? byId.get(c.vertical_id) : undefined;
    if (!v) {
      if (c.attributed) attribution.unmapped += n;
      continue;
    }
    const top = v.parent_id ? (byId.get(v.parent_id) ?? v) : v;
    const row = per.get(top.id) ?? { name: top.name, meta: 0, google: 0, both: 0, none: 0, total: 0, industry: 0 };
    row[c.platform] += n;
    row.total += n;
    if (c.scope === "industry") row.industry += n;
    per.set(top.id, row);
  }
  attribution.verticals = [...per.values()].sort((a, b) => b.total - a.total).slice(0, 8);
  return {
    byLayer,
    byPlatform,
    total: (rows ?? []).length,
    attribution,
    waiting: waiting ?? 0,
    conflicts: (conflicts ?? []).map((c) => ({
      id: c.id as string,
      layer: c.layer as Layer,
      platform: c.platform as Platform,
      body: c.body as string,
      quote: (c.quote as string | null) ?? null,
      at: c.at_seconds == null ? null : clock(c.at_seconds as number),
      url: c.loom_id ? `https://www.loom.com/share/${c.loom_id}${c.at_seconds ? `?t=${c.at_seconds}` : ""}` : null,
      note: (c.conflict_note as string | null) ?? null,
      against: (c.other as unknown as { body: string } | null)?.body ?? null,
      againstSkill: (c.conflict_skill as string | null) ?? null,
    })),
    top: (rows ?? []).filter((r) => r.layer !== "case").slice(0, 6).map((r) => ({ layer: r.layer as Layer, body: r.body as string, confidence: r.confidence as number })),
    skillsAt: (skill?.[0]?.updated_at as string | undefined) ?? null,
  };
}
