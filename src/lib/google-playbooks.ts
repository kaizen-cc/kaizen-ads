import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { isBranded } from "@/lib/google-ideas";
import { LIVE } from "@/lib/live";
import { parentNames, type Benchmark } from "@/lib/verticals";

// The Google playbook for each sub-vertical: the search intents that convert (with the keywords behind them), the copy
// angles and headline types that win, the campaign structures, the landing pages, the benchmarks and what fails. Built
// from our Google Hall of Fame and live winners across the clients in it, brand searches set aside (they always win and
// teach nothing to anyone else). Never names a client or a brand. Read by the Google go-to-market strategy, Google
// audits and "Use it on a client".

export type GoogleKeyword = { text: string; match: "exact" | "phrase" | "broad" };
export type GoogleIntent = { name: string; why: string; keywords: GoogleKeyword[]; examples: string[] };
export type GoogleAngle = { name: string; type: "benefit" | "proof" | "offer" | "urgency" | "local" | "question" | "statistic" | "other"; headlines: string[]; descriptions: string[]; why: string; examples: string[] };
export type GoogleStructure = { name: string; how: string; why: string };
export type GooglePlaybook = {
  verticalId: string;
  summary: string;
  intents: GoogleIntent[];
  angles: GoogleAngle[];
  structures: GoogleStructure[];
  landing: string[];
  watchouts: string[];
  sources: { clients: number; ads: number; keywords: number; terms: number };
  generatedAt: string | null;
};

const VERSION = "g1";
const list = (props: Record<string, unknown>, required: string[]) => ({ type: "array", items: { type: "object", properties: props, required, additionalProperties: false } });
const S = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    summary: S,
    intents: list({ name: S, why: S, keywords: list({ text: S, match: { type: "string", enum: ["exact", "phrase", "broad"] } }, ["text", "match"]), examples: { type: "array", items: S } }, ["name", "why", "keywords", "examples"]),
    angles: list(
      { name: S, type: { type: "string", enum: ["benefit", "proof", "offer", "urgency", "local", "question", "statistic", "other"] }, headlines: { type: "array", items: S }, descriptions: { type: "array", items: S }, why: S, examples: { type: "array", items: S } },
      ["name", "type", "headlines", "descriptions", "why", "examples"],
    ),
    structures: list({ name: S, how: S, why: S }, ["name", "how", "why"]),
    landing: { type: "array", items: S },
    watchouts: { type: "array", items: S },
  },
  required: ["summary", "intents", "angles", "structures", "landing", "watchouts"],
  additionalProperties: false,
};

const SYSTEM = `You are Kaizen's head of Google Ads strategy writing the Google playbook for one sub-vertical: how to win search for any client in it. It's read by the Google buyers, the go-to-market strategy builder and the auditor. Everything comes from OUR winners (A = search ads, K = keywords, S = search terms people typed before converting), all non-brand, each beating its client's target or account.
intents: 2 to 6 search intents that convert in this market (e.g. "emergency, near me", "price shopping", "comparison"). why: what the searcher wants and why it converts. keywords: 4 to 10 keywords to build the intent around, each with a match type, generalised so they work for any client in the sub-vertical (no brand or city names unless the city is the point, then write [city]). examples: the ids (K3, S7, A2) that prove it. Every intent must cite at least one of our winners.
angles: 2 to 6 copy angles that won, each with type (benefit, proof, offer, urgency, local, question, statistic, other), 2 to 4 headline patterns (30 characters or less, generic: [city], [service], [offer] placeholders) and 1 to 2 description patterns (90 characters or less), why it wins, examples (A ids).
structures: 1 to 4 campaign or ad group structures behind the winners (how they're split, match types, bidding where it shows), with why.
landing: 2 to 4 landing page patterns that convert (from the winning ads' final URLs: the kind of page, never the client's domain).
watchouts: what fails or to avoid in this market on Google (broad terms that waste, brand mixing, policy).
summary: three or four sentences on how to win this sub-vertical on Google right now, with the benchmarks.
Never name a client, brand or person. Only what the winners show; no invented numbers. No em dashes.`;

type IdeaRow = { id: string; kind: "ad" | "keyword" | "search_term"; campaign: string | null; ad_group: string | null; content: { headlines?: string[]; descriptions?: string[]; url?: string | null; text?: string; match?: string }; spend: number; conversions: number; roas: boolean; result: number | null; usual: number | null; beat_by: number; client_id: string; clients: { name: string } | null };

/** The non-brand winners (Hall of Fame and live) of the clients in one sub-vertical, best first. */
async function winnersOf(admin: SupabaseClient, subId: string) {
  const { data } = await admin
    .from("google_ideas")
    .select("id, kind, campaign, ad_group, content, spend, conversions, roas, result, usual, beat_by, client_id, clients!inner(name, vertical_id)")
    .eq("clients.vertical_id", subId)
    .or(`fame.eq.true,live.eq.true`)
    .order("beat_by", { ascending: false })
    .limit(150);
  return ((data ?? []) as unknown as IdeaRow[]).filter((r) => !isBranded(r.clients?.name ?? "", r.kind, r.campaign, r.ad_group, r.content?.text));
}

const fingerprintOf = (clients: string[], ideas: string[]) => `${VERSION}:${clients.length}:${[...ideas].sort().slice(0, 15).join(",")}`;

/** Builds (or rebuilds) one sub-vertical's Google playbook. Without a non-brand winner of ours there isn't one. */
export async function buildGooglePlaybook(admin: SupabaseClient, subId: string) {
  const { data: sub } = await admin.from("verticals").select("id, name, description, conversion, google_benchmarks, parent_id").eq("id", subId).single();
  if (!sub) return null;
  const winners = await winnersOf(admin, subId);
  if (!winners.length) {
    await admin.from("google_playbooks").delete().eq("vertical_id", subId);
    return null;
  }
  const ads = winners.filter((w) => w.kind === "ad").slice(0, 15);
  const keywords = winners.filter((w) => w.kind === "keyword").slice(0, 30);
  const terms = winners.filter((w) => w.kind === "search_term").slice(0, 30);
  const clients = [...new Set(winners.map((w) => w.client_id))];
  const parent = (await parentNames(admin, [sub.parent_id])).get(sub.parent_id) ?? "";
  const bm = ((sub.google_benchmarks ?? []) as Benchmark[]).map((b) => `${b.metric}: good ${b.good ?? "?"}${b.unit}, great ${b.great ?? "?"}${b.unit} (${b.source} ${b.year})`).join("; ");
  const res = (w: IdeaRow) => (w.roas ? `${Number(w.result ?? 0).toFixed(2)}x ROAS vs ${Number(w.usual ?? 0).toFixed(2)}x` : `$${Number(w.result ?? 0).toFixed(2)} per conversion vs $${Number(w.usual ?? 0).toFixed(2)}`);
  const path = (u: string | null | undefined) => {
    try {
      return u ? new URL(u).pathname || "/" : "unknown";
    } catch {
      return "unknown";
    }
  };
  // Each winner gets a short id the AI cites, kept back to the real row
  const ids = new Map<string, string>();
  const tag = (prefix: string, w: IdeaRow, n: number) => {
    ids.set(`${prefix}${n + 1}`, w.id);
    return `${prefix}${n + 1}`;
  };

  const out = await askJson<Omit<GooglePlaybook, "verticalId" | "sources" | "generatedAt">>({
    agent: "verticals",
    label: `google playbook ${sub.name}`,
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 6000,
    prompt: `Sub-vertical: ${sub.name} (${parent}). ${sub.description ?? ""} A result is a ${sub.conversion ?? "conversion"}.
Google benchmarks: ${bm || "not researched yet"}
${clients.length} clients' Google accounts behind these winners.

<winning_search_ads>
${ads.map((w, n) => `${tag("A", w, n)}. ${res(w)}, ${Math.round(Number(w.conversions))} conversions · campaign "${w.campaign ?? "?"}" · headlines: ${(w.content.headlines ?? []).join(" | ")} · descriptions: ${(w.content.descriptions ?? []).join(" | ")} · landing page path: ${path(w.content.url)}`).join("\n") || "(none yet)"}
</winning_search_ads>

<winning_keywords>
${keywords.map((w, n) => `${tag("K", w, n)}. "${w.content.text}" (${String(w.content.match ?? "").toLowerCase()}) · ${res(w)}, ${Math.round(Number(w.conversions))} conversions · campaign "${w.campaign ?? "?"}"${w.ad_group ? ` / ad group "${w.ad_group}"` : ""}`).join("\n") || "(none yet)"}
</winning_keywords>

<winning_search_terms>
${terms.map((w, n) => `${tag("S", w, n)}. "${w.content.text}" · ${res(w)}, ${Math.round(Number(w.conversions))} conversions · campaign "${w.campaign ?? "?"}"`).join("\n") || "(none yet)"}
</winning_search_terms>`,
  });

  const real = (refs: string[]) => [...new Set(refs.map((r) => ids.get(r.trim().toUpperCase())).filter((x): x is string => Boolean(x)))];
  const clean = (s: string) => s.replace(/\s*—\s*/g, ", ");
  const intents = out.intents.map((i) => ({ ...i, name: clean(i.name), why: clean(i.why), examples: real(i.examples) })).filter((i) => i.examples.length);
  const angles = out.angles.map((a) => ({ ...a, name: clean(a.name), why: clean(a.why), headlines: a.headlines.map((h) => h.slice(0, 30)), descriptions: a.descriptions.map((d) => d.slice(0, 90)), examples: real(a.examples) }));
  const row = {
    vertical_id: subId,
    summary: clean(out.summary),
    intents,
    angles,
    structures: out.structures.map((x) => ({ name: clean(x.name), how: clean(x.how), why: clean(x.why) })),
    landing: out.landing.map(clean),
    watchouts: out.watchouts.map(clean),
    sources: { clients: clients.length, ads: ads.length, keywords: keywords.length, terms: terms.length },
    generated_at: new Date().toISOString(),
    fingerprint: fingerprintOf(clients, winners.map((w) => w.id)),
  };
  await admin.from("google_playbooks").upsert(row, { onConflict: "vertical_id" });
  return row;
}

/** Sub-verticals whose Google playbook is missing, or a day old with new winners, a couple per run. */
export async function keepGooglePlaybooks(admin: SupabaseClient, max = 2) {
  const [{ data: subs }, { data: have }, { data: ideas }] = await Promise.all([
    admin.from("verticals").select("id").not("parent_id", "is", null).eq("active", true),
    admin.from("google_playbooks").select("vertical_id, generated_at, fingerprint"),
    admin.from("google_ideas").select("clients!inner(vertical_id, status, archived_at)").or("fame.eq.true,live.eq.true").in("clients.status", LIVE).is("clients.archived_at", null).limit(3000),
  ]);
  // Where we have the most Google winners first
  const wins = new Map<string, number>();
  for (const r of ideas ?? []) {
    const v = (r.clients as unknown as { vertical_id: string | null } | null)?.vertical_id;
    if (v) wins.set(v, (wins.get(v) ?? 0) + 1);
  }
  const by = new Map((have ?? []).map((h) => [h.vertical_id as string, h]));
  let built = 0;
  for (const s of (subs ?? []).sort((a, b) => (wins.get(b.id) ?? 0) - (wins.get(a.id) ?? 0))) {
    if (built >= max) break;
    const h = by.get(s.id as string);
    if (!wins.get(s.id as string)) {
      if (h) await admin.from("google_playbooks").delete().eq("vertical_id", s.id);
      continue;
    }
    const current = Boolean(h?.fingerprint?.startsWith(`${VERSION}:`));
    if (current && h?.generated_at && Date.now() - Date.parse(h.generated_at) < 24 * 3_600_000) continue;
    if (h && current) {
      const w = await winnersOf(admin, s.id as string);
      if (fingerprintOf([...new Set(w.map((x) => x.client_id))], w.map((x) => x.id)) === h.fingerprint) continue;
    }
    if (await buildGooglePlaybook(admin, s.id as string).catch((e) => console.error("[google playbook]", e instanceof Error ? e.message : e))) built++;
  }
  return built;
}

const toPlaybook = (d: Record<string, unknown>): GooglePlaybook => ({
  verticalId: d.vertical_id as string,
  summary: (d.summary as string) ?? "",
  intents: (d.intents ?? []) as GoogleIntent[],
  angles: (d.angles ?? []) as GoogleAngle[],
  structures: (d.structures ?? []) as GoogleStructure[],
  landing: (d.landing ?? []) as string[],
  watchouts: (d.watchouts ?? []) as string[],
  sources: (d.sources ?? { clients: 0, ads: 0, keywords: 0, terms: 0 }) as GooglePlaybook["sources"],
  generatedAt: (d.generated_at as string) ?? null,
});

export async function loadGooglePlaybook(db: SupabaseClient, subId: string): Promise<GooglePlaybook | null> {
  const { data } = await db.from("google_playbooks").select("*").eq("vertical_id", subId).maybeSingle();
  return data && String(data.fingerprint ?? "").startsWith(`${VERSION}:`) ? toPlaybook(data) : null;
}

export async function loadGooglePlaybooks(db: SupabaseClient): Promise<GooglePlaybook[]> {
  const { data } = await db.from("google_playbooks").select("*").like("fingerprint", `${VERSION}:%`);
  return (data ?? []).map(toPlaybook);
}

/** The examples a playbook cites, for showing: the winning ad, keyword or search term and how it did (no client name). */
export async function googlePlaybookExamples(db: SupabaseClient, p: GooglePlaybook) {
  const want = [...new Set([...p.intents.flatMap((i) => i.examples), ...p.angles.flatMap((a) => a.examples)])];
  if (!want.length) return new Map<string, { kind: string; text: string; result: string }>();
  const { data } = await db.from("google_ideas").select("id, kind, content, roas, result, usual, beat_by").in("id", want);
  return new Map(
    (data ?? []).map((r) => {
      const c = (r.content ?? {}) as { headlines?: string[]; text?: string; match?: string };
      const text = r.kind === "ad" ? (c.headlines ?? []).slice(0, 3).join(" | ") : r.kind === "keyword" ? `${c.text} (${String(c.match ?? "").toLowerCase()})` : `“${c.text}”`;
      const result = r.roas ? `${Number(r.result ?? 0).toFixed(1)}x ROAS, ${Math.round(Number(r.beat_by) * 100)}% above the bar` : `$${Number(r.result ?? 0).toFixed(2)}/conv, ${Math.round(Number(r.beat_by) * 100)}% under the bar`;
      return [r.id as string, { kind: r.kind as string, text, result }];
    }),
  );
}

/** The client's sub-vertical Google playbook, for the agents (Google go-to-market strategy, Google audits, deploys). */
export async function googlePlaybookBlock(db: SupabaseClient, clientId: string) {
  const { data: c } = await db.from("clients").select("vertical_id, verticals(name)").eq("id", clientId).maybeSingle();
  if (!c?.vertical_id) return "";
  const p = await loadGooglePlaybook(db, c.vertical_id);
  if (!p) return "";
  const name = (c.verticals as unknown as { name: string } | null)?.name ?? "their sub-vertical";
  const kw = (k: GoogleKeyword) => (k.match === "exact" ? `[${k.text}]` : k.match === "phrase" ? `"${k.text}"` : k.text);
  return `<google_playbook sub_vertical="${name}" source="our Google winners across ${p.sources.clients} clients, brand searches left out">
${p.summary}
Intents that convert:
${p.intents.map((i) => `- ${i.name} (proven by ${i.examples.length}): ${i.why} Keywords: ${i.keywords.map(kw).join(", ")}`).join("\n")}
Copy angles that win:
${p.angles.map((a) => `- ${a.name} (${a.type}): headlines like ${a.headlines.map((h) => `"${h}"`).join(", ")}; descriptions like ${a.descriptions.map((d) => `"${d}"`).join(", ")}. ${a.why}`).join("\n")}
Structures: ${p.structures.map((s) => `${s.name}: ${s.how}`).join("; ")}
Landing pages: ${p.landing.join("; ")}
Watch out: ${p.watchouts.join("; ")}
</google_playbook>
Use the Google playbook as the starting point for this market, then make it this client's: their offer, voice, locations and rules come first.`;
}
