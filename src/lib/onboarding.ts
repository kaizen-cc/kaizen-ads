import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { INDUSTRIES } from "@/lib/industries";
import { pickLoose, stableKey } from "@/lib/zapier";
import type { IntakeSummary } from "@/lib/intake-format";
import { isLive } from "@/lib/live";

// A new client's marketing intake form: kept as they answered it, read by the AI into what the team needs (what they
// sell, to whom, the offer, voice, what to avoid), and turned into the first round of creative, built on what's
// winning for similar clients. Execs and leads see it on Home as an onboarding callout until it's under way.

export type { IntakeSummary } from "@/lib/intake-format";
export { describeIntake } from "@/lib/intake-format";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const NAME_KEYS = ["businessname", "companyname", "nameofbusiness", "business", "company", "clientname", "brandname", "brand"];
const ID_KEYS = ["clientid", "clientnumber", "accountid"];

/** Which client an intake is for: their Client ID if given, then the business name. */
export async function matchClient(admin: SupabaseClient, raw: Record<string, string>) {
  const name = pickLoose(raw, NAME_KEYS);
  const idText = pickLoose(raw, ID_KEYS);
  const ext = idText && /^\s*\d+\s*$/.test(idText) ? Number(idText) : null;
  if (ext != null) {
    const { data } = await admin.from("clients").select("id").eq("kaizen_id", ext).maybeSingle();
    if (data) return { clientId: data.id as string, name };
  }
  if (name) {
    const { data } = await admin.from("clients").select("id, name, status").order("created_at", { ascending: false });
    const hit = (data ?? []).find((c) => norm(c.name) === norm(name)) ?? (data ?? []).find((c) => norm(name).length >= 5 && (norm(c.name).includes(norm(name)) || norm(name).includes(norm(c.name))));
    if (hit) return { clientId: hit.id as string, name };
  }
  return { clientId: null, name };
}

/** Saves an intake submission once (Zapier retries are ignored). */
export async function receiveIntake(admin: SupabaseClient, raw: Record<string, string>) {
  const key = stableKey("intake", raw);
  const { data: dup } = await admin.from("client_intakes").select("id, client_id, status").eq("idempotency_key", key).maybeSingle();
  if (dup) return { id: dup.id as string, clientId: dup.client_id as string | null, duplicate: true };
  const { clientId, name } = await matchClient(admin, raw);
  const answers = Object.entries(raw)
    .filter(([q]) => !/^(timestamp|submitted ?at|response ?id)$/i.test(q))
    .map(([q, a]) => ({ q, a: a.slice(0, 4000) }));
  const { data, error } = await admin
    .from("client_intakes")
    .insert({ idempotency_key: key, client_id: clientId, business_name: name, answers, status: clientId ? "received" : "unmatched" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't save the intake");
  return { id: data.id as string, clientId, duplicate: false };
}

const s = { type: "string" };
const arr = { type: "array", items: s };
const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    business: s,
    offer: s,
    audience: s,
    locations: s,
    goals: s,
    voice: s,
    avoid: arr,
    proof: arr,
    competitors: arr,
    assets: arr,
    questions: arr,
    industry: { type: "string", enum: INDUSTRIES.map(([k]) => k) },
    industryDetail: s,
  },
  required: ["business", "offer", "audience", "locations", "goals", "voice", "avoid", "proof", "competitors", "assets", "questions", "industry", "industryDetail"],
  additionalProperties: false,
};

/**
 * Reads the intake into what the team and every agent need, sets the client's industry (unless the team set one),
 * and has the strategist write the first round. Safe to run again.
 */
export async function processIntake(admin: SupabaseClient, intakeId: string, opts: { firstRound?: boolean } = {}) {
  const { data: intake } = await admin.from("client_intakes").select("id, client_id, answers").eq("id", intakeId).single();
  if (!intake?.client_id) return { status: "unmatched" };
  // Archived: the answers are kept for when they come back, nothing more
  const { data: owner } = await admin.from("clients").select("archived_at, status").eq("id", intake.client_id).single();
  if (owner && !isLive(owner)) return { status: "not live" };
  try {
    const answers = intake.answers as { q: string; a: string }[];
    const summary = await askJson<IntakeSummary>({
      agent: "briefing",
      label: "marketing intake",
      system:
        "You read a new client's marketing intake form for a paid social agency and pull out what the creative team needs. Use only what they wrote; where a field wasn't answered, say \"Not given\" (or an empty list). Plain, specific, no hype.",
      schema: SUMMARY_SCHEMA,
      prompt: `<intake_form>\n${answers.map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n")}\n</intake_form>\n\nbusiness: what they are, one or two sentences. offer: what they sell and the offers or promotions they want to push. audience: who buys, as specific as they made it. locations: where they serve. goals: what they want from ads, with numbers if given. voice: how they talk and want to sound. avoid: what they don't want (claims, styles, words, competitors to mention). proof: reviews, results, awards, guarantees. competitors: named competitors. assets: photos, videos, brand files or links they have. questions: what the team should still ask before making creative. industry: the closest from the list, by how they sell (a brand that ships to customers online is "ecommerce" whatever it sells; a restaurant is a place people eat); industryDetail: two to four words ("Pizza restaurant").`,
    });
    await admin.from("client_intakes").update({ summary, status: "read", error: null }).eq("id", intakeId);
    // The industry, unless the team already set it by hand
    await admin
      .from("clients")
      .update({ industry: summary.industry, industry_detail: summary.industryDetail.slice(0, 80) || null, industry_source: "ai", industry_set_at: new Date().toISOString(), industry_version: 2 })
      .eq("id", intake.client_id)
      .or("industry_source.is.null,industry_source.eq.ai");
    // A first round only for a client we make creative for; for anyone else the intake is context and nothing more
    const { data: client } = await admin.from("clients").select("creative_package").eq("id", intake.client_id).single();
    // Historic intakes (backfilled) are context only: those clients are already running
    if (!client?.creative_package || opts.firstRound === false) return { status: "read" };
    const { suggestOnboarding } = await import("@/lib/suggestions");
    await suggestOnboarding(admin, intake.client_id);
    await admin.from("client_intakes").update({ status: "briefed" }).eq("id", intakeId);
    return { status: "briefed" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("client_intakes").update({ status: "failed", error: error.slice(0, 300) }).eq("id", intakeId);
    return { status: "failed", error };
  }
}

/** Read every intake that hasn't been read yet (a backfill of older answers): context only, no first rounds. */
export async function readBackfill(admin: SupabaseClient, max = 40) {
  const { data } = await admin.from("client_intakes").select("id").eq("status", "received").is("summary", null).not("client_id", "is", null).order("received_at").limit(max);
  let read = 0;
  for (const x of data ?? []) {
    const r = await processIntake(admin, x.id, { firstRound: false });
    if (r.status === "read") read++;
  }
  return { read, waiting: (data ?? []).length - read };
}
