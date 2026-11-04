import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, forgetAgent, type AgentKey } from "@/lib/ai";
import { clock } from "@/lib/loom";

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

const MARK = "loom-distilled:";
const SKILL_LAYERS: { layer: Exclude<Layer, "case">; title: string; intro: string }[] = [
  { layer: "principle", title: "From the senior buyer's audits: principles", intro: "What Kaizen's senior buyer believes about buying ads, and why, distilled from his Loom audits. The number is how many of his videos say it: lean hardest on the most said." },
  { layer: "rule", title: "From the senior buyer's audits: decision rules", intro: "How Kaizen's senior buyer decides, with his own thresholds: if the account shows this, he does that. The number is how many of his videos say it. Apply them the way he would, and say which one you're using." },
  { layer: "diagnostic", title: "From the senior buyer's audits: diagnostics", intro: "How Kaizen's senior buyer reads an account: what he checks first, the columns he pulls, and in what order. The number is how many of his videos show it. Read accounts in this order." },
  { layer: "voice", title: "From the senior buyer's audits: voice", intro: "How Kaizen's senior buyer explains things, the phrases he uses and how he pushes back. Write audits and answers so they sound like him: direct, specific, the reason before the action. Never name him; he is Kaizen's senior buyer." },
];
/** The skills each layer is written into: every Meta-side Media Buyer skill, and the Google auditor for Google */
const META_AGENTS: AgentKey[] = ["auditor", "launcher", "fatigue"];
const GOOGLE_AGENTS: AgentKey[] = ["google_auditor"];
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
  for (let i = 0; i < rows.length; i += 200) await admin.from("media_buying_insights").insert(rows.slice(i, i + 200));
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
  return out;
}

/** The generated skills, rewritten from the best-supported items (each under ~3k characters); hand-written ones untouched */
export async function rewriteBuyerSkills(admin: Admin) {
  const { data } = await admin
    .from("media_buying_insights")
    .select("layer, body, platform, confidence, quote, conflict_with, conflict_skill, ruling")
    .neq("layer", "case")
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
  await rewriteBuyerSkills(admin);
}

// ─── What Settings shows ────────────────────────────────────────────────────

export type InsightsStatus = {
  byLayer: Record<Layer, number>;
  waiting: number;
  conflicts: { id: string; layer: Layer; body: string; quote: string | null; at: string | null; url: string | null; note: string | null; against: string | null; againstSkill: string | null }[];
  top: { layer: Layer; body: string; confidence: number }[];
  skillsAt: string | null;
};

export async function insightsStatus(admin: Admin): Promise<InsightsStatus> {
  const [{ data: rows }, { data: conflicts }, { data: skill }, { count: waiting }] = await Promise.all([
    admin.from("media_buying_insights").select("layer, body, confidence").is("merged_into", null).eq("excluded", false).order("confidence", { ascending: false }).limit(5000),
    admin.from("media_buying_insights").select("id, layer, body, quote, at_seconds, loom_id, conflict_note, conflict_skill, other:conflict_with(body)").is("ruling", null).eq("excluded", false).is("merged_into", null).or("conflict_with.not.is.null,conflict_skill.not.is.null").order("created_at").limit(30),
    admin.from("ai_knowledge").select("updated_at").like("file_name", `${MARK}%`).order("updated_at", { ascending: false }).limit(1),
    admin.from("media_buying_insights").select("id", { count: "exact", head: true }).is("consolidated_at", null).is("merged_into", null),
  ]);
  const byLayer: Record<Layer, number> = { principle: 0, rule: 0, case: 0, diagnostic: 0, voice: 0 };
  for (const r of rows ?? []) byLayer[r.layer as Layer]++;
  return {
    byLayer,
    waiting: waiting ?? 0,
    conflicts: (conflicts ?? []).map((c) => ({
      id: c.id as string,
      layer: c.layer as Layer,
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
