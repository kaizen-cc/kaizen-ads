import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { LIVE } from "@/lib/live";

// A lesson that worked for one client ("works" lessons from audits and sprints), shared with clients it truly applies
// to. Two gates, both strict: first the same sub-vertical (never just the same broad industry: e-commerce seafood and
// e-commerce hair care are not alike), then an AI check of each candidate's product, buyer, sales motion and price
// point against the lesson, keeping only high-confidence matches. The shared lesson is reworded without the original
// client's specifics, never names it, and is removable on the receiving client's page like any memory.

const MAX_SHARES = 5;

type Profile = { id: string; line: string };

/** What a client is, in a few facts: enough to judge whether a lesson carries over. No names leave this function. */
async function profiles(admin: SupabaseClient, ids: string[]): Promise<Profile[]> {
  if (!ids.length) return [];
  const [{ data: clients }, { data: intakes }, { data: gtm }] = await Promise.all([
    admin.from("clients").select("id, industry, industry_detail, vertical_why").in("id", ids),
    admin.from("client_intakes").select("client_id, summary").in("client_id", ids).not("summary", "is", null),
    admin.from("client_gtm_strategies").select("client_id, read_this_first").in("client_id", ids),
  ]);
  return (clients ?? []).map((c) => {
    const s = ((intakes ?? []).find((i) => i.client_id === c.id)?.summary ?? {}) as { business?: string; offer?: string; audience?: string; locations?: string };
    const g = (gtm ?? []).find((x) => x.client_id === c.id)?.read_this_first ?? "";
    return {
      id: c.id as string,
      line: [
        c.industry_detail && `What: ${c.industry_detail}`,
        s.business && `Business: ${s.business}`,
        s.offer && `Sells: ${s.offer}`,
        s.audience && `Buyers: ${s.audience}`,
        s.locations && `Where: ${s.locations}`,
        c.vertical_why && `Placed because: ${c.vertical_why}`,
        g && `Strategy: ${String(g).slice(0, 500)}`,
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 1200),
    };
  });
}

const SCHEMA = {
  type: "object",
  properties: {
    portable: { type: "boolean" },
    general: { type: "string" },
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "integer" }, applies: { type: "boolean" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, why: { type: "string" } },
        required: ["n", "applies", "confidence", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["portable", "general", "matches"],
  additionalProperties: false,
};

const SYSTEM = `You decide whether a lesson that worked on one client's Meta ads also applies to other clients of the same agency. Be strict: sharing a lesson with the wrong business blends strategies that don't belong together and hurts their results. When in doubt, it does not apply.

portable: false if the lesson depends on something unique to the original client (its offer, price, brand, location, product, a specific ad or audience it built, a seasonal event of its own). Then matches is empty.
general: the lesson rewritten so it carries over: drop the original client's specifics (names, products, prices, dates), keep the mechanism ("Leading with the treatment-urgency angle beat prevention messaging for buyers dealing with an active problem"). One or two sentences. Never name the original client, a brand or a person.
matches: for each candidate, applies true only when ALL hold: it sells the same kind of product or service (not just the same broad industry: online seafood and hair care products are both e-commerce and are NOT alike), to the same kind of buyer with the same need, through the same sales motion (online order, booking, lead, store visit), at a broadly similar price point, so the mechanism behind the lesson would work the same way. confidence: high only when you'd bet on it; anything less is medium or low. why: one line naming what makes them alike (or what doesn't).`;

/**
 * Shares one client's "works" lesson with truly similar clients. Returns how many it went to. Safe to call for any
 * lesson: it does nothing without a sub-vertical, without close candidates, or without a high-confidence match.
 */
export async function shareLesson(admin: SupabaseClient, memoryId: string) {
  const { data: m } = await admin.from("client_memory").select("id, client_id, kind, body, source, origin_memory_id").eq("id", memoryId).single();
  if (!m || m.kind !== "prefer" || m.origin_memory_id || !["audit", "sprint", "lab"].includes(m.source)) return 0;
  const { data: from } = await admin.from("clients").select("id, vertical_id").eq("id", m.client_id).single();
  if (!from?.vertical_id) return 0; // not placed in a sub-vertical: nothing is close enough to be sure

  // Gate 1: the same sub-vertical, paid ads, live
  const { data: peers } = await admin.from("clients").select("id").eq("vertical_id", from.vertical_id).eq("paid_ads", true).is("archived_at", null).in("status", LIVE).neq("id", m.client_id).limit(25);
  if (!peers?.length) return 0;
  // Never twice to the same client
  const { data: already } = await admin.from("client_memory").select("client_id").eq("origin_memory_id", memoryId);
  const have = new Set((already ?? []).map((x) => x.client_id));
  const candidates = await profiles(admin, peers.map((p) => p.id).filter((id) => !have.has(id)));
  if (!candidates.length) return 0;
  const [source] = await profiles(admin, [m.client_id]);

  // Gate 2: does this lesson truly carry over, client by client
  const out = await askJson<{ portable: boolean; general: string; matches: { n: number; applies: boolean; confidence: "high" | "medium" | "low"; why: string }[] }>({
    agent: "verticals",
    label: "share lesson",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    prompt: `<lesson>\n${m.body}\n</lesson>\n\n<where_it_worked>\n${source?.line ?? "(little known)"}\n</where_it_worked>\n\n<candidates>\n${candidates.map((c, i) => `${i + 1}. ${c.line || "(little known)"}`).join("\n")}\n</candidates>`,
  });
  if (!out.portable || !out.general.trim()) return 0;
  const chosen = out.matches
    .filter((x) => x.applies && x.confidence === "high")
    .map((x) => ({ c: candidates[x.n - 1], why: x.why }))
    .filter((x) => x.c)
    .slice(0, MAX_SHARES);
  if (!chosen.length) return 0;
  const body = `Learned on a similar account: ${out.general.trim()}`.replace(/\s*—\s*/g, ", ").slice(0, 1000);
  await admin.from("client_memory").insert(
    chosen.map((x) => ({ client_id: x.c.id, kind: "prefer", source: "network", body, origin_client_id: m.client_id, origin_memory_id: memoryId, share_reason: x.why.slice(0, 300) })),
  );
  return chosen.length;
}

/** Shares several lessons, quietly: a failure never stops the audit or the check that learned them. */
export async function shareLessons(admin: SupabaseClient, memoryIds: string[]) {
  let n = 0;
  for (const id of memoryIds) n += await shareLesson(admin, id).catch((e) => (console.error("[lessons] couldn't share:", e instanceof Error ? e.message : e), 0));
  return n;
}
