import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { BusinessModel } from "@/lib/business-model";

// Patterns across clients: the superpower of running many accounts. "These concepts work across all restaurants",
// "these angles work across home improvement". Once a week (and when an exec asks), for each business model and its
// sub-verticals, the proven evidence from every client is read together: the playbook's winners and losers against
// each KPI (rule one: if it isn't profitable it isn't working), the Hall of Fame, Google's non-brand winners, the
// marketing moments that won or lost, Ads Lab results and the Bibles' proven learnings. The strategist writes what
// works (or fails) across several of them, with the evidence counted, and which clients in the group aren't using it
// yet: those are the opportunities, briefed from the Overview in one click. No client is ever named in a pattern.

export const MODEL_NAMES: Record<BusinessModel, string> = {
  ecommerce: "Online stores",
  restaurant: "Restaurants and food",
  bookings: "Bookings businesses",
  local_service: "Local services",
  lead_gen: "Lead-gen businesses",
};
const MODELS = Object.keys(MODEL_NAMES) as BusinessModel[];

export type PatternKind = "angle" | "concept" | "offer" | "format" | "audience" | "moment" | "google";
export type Pattern = {
  id: string;
  model: BusinessModel;
  verticalId: string | null;
  group: string;
  kind: PatternKind;
  verdict: "works" | "fails";
  title: string;
  detail: string;
  evidence: { clients: number; of: number; items: string[] };
  confidence: "high" | "medium" | "low";
  using: string[];
  missing: string[];
  generatedAt: string;
};

type Member = { id: string; name: string; verticalId: string | null; sub: string; model: BusinessModel; also: BusinessModel | null };

const S = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: S, // "all" or a sub-vertical's exact name
          kind: { type: "string", enum: ["angle", "concept", "offer", "format", "audience", "moment", "google"] },
          verdict: { type: "string", enum: ["works", "fails"] },
          title: S,
          detail: S,
          evidence: { type: "array", items: S },
          clients: { type: "integer" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          using: { type: "array", items: S },
          missing: { type: "array", items: S },
        },
        required: ["scope", "kind", "verdict", "title", "detail", "evidence", "clients", "confidence", "using", "missing"],
        additionalProperties: false,
      },
    },
  },
  required: ["patterns"],
  additionalProperties: false,
};

/** Every live client sorted into its business model and sub-vertical (several at a time, it's a few reads each) */
async function members(admin: SupabaseClient): Promise<Member[]> {
  const [{ data: cs }, { data: vs }, { businessModelOf }] = await Promise.all([
    admin.from("clients").select("id, name, industry_detail, vertical_id").is("archived_at", null).in("status", ["active", "onboarding", "paused"]).not("internal", "is", true),
    admin.from("verticals").select("id, name"),
    import("@/lib/business-model"),
  ]);
  const vName = new Map((vs ?? []).map((v) => [v.id as string, v.name as string]));
  const list = cs ?? [];
  const out: Member[] = [];
  for (let i = 0; i < list.length; i += 8) {
    const got = await Promise.all(
      list.slice(i, i + 8).map(async (c) => {
        const m = await businessModelOf(admin, c.id as string).catch(() => null);
        if (!m) return null;
        const vid = (c.vertical_id as string | null) ?? null;
        return { id: c.id as string, name: c.name as string, verticalId: vid, sub: (vid ? vName.get(vid) : null) ?? (c.industry_detail as string | null) ?? "Other", model: m.model, also: m.also };
      }),
    );
    out.push(...(got.filter(Boolean) as Member[]));
  }
  return out;
}

/** What each client has proven, as short lines (no names): the AI reads them side by side */
async function evidence(admin: SupabaseClient, ids: string[]) {
  const [{ data: ledger }, { data: fame }, { data: google }, { data: moments }, { data: bibles }, { data: tests }] = await Promise.all([
    admin.from("client_ledger").select("client_id, kind, title, detail, verdict, verdict_reason, spend").in("client_id", ids).in("verdict", ["winner", "loser"]).order("spend", { ascending: false }).limit(4000),
    admin.from("hall_of_fame").select("client_id, ad_name, campaign_name, days_live, beat_by").in("client_id", ids).limit(500),
    admin.from("google_ideas").select("client_id, kind, campaign, ad_group, content, beat_by, fame, live").in("client_id", ids).or("fame.eq.true,live.eq.true").order("beat_by", { ascending: false }).limit(800),
    admin.from("client_moments").select("client_id, name, angle, offer_idea, status").in("client_id", ids).in("status", ["won", "lost"]).limit(400),
    admin.from("client_brand_bibles").select("client_id, learnings").in("client_id", ids),
    admin.from("lab_tests").select("title, status, client_ids, learning, verdict_note").not("learning", "is", null).limit(60),
  ]);
  const by = new Map<string, string[]>(ids.map((id) => [id, []]));
  const add = (id: string, line: string) => by.get(id)?.push(line.replace(/\s+/g, " ").slice(0, 220));
  const counts = new Map<string, Record<string, number>>();
  const bump = (id: string, k: string) => {
    const c = counts.get(id) ?? {};
    c[k] = (c[k] ?? 0) + 1;
    counts.set(id, c);
  };
  for (const r of ledger ?? []) {
    const id = r.client_id as string;
    const k = `${r.verdict}:${r.kind}`;
    bump(id, k);
    // A few of each per client, biggest spend first: winners count only when they beat the KPI (the ledger's verdict)
    if ((counts.get(id)?.[k] ?? 0) > (r.verdict === "winner" ? (r.kind === "creative" ? 5 : 4) : 3)) continue;
    const d = (r.detail ?? {}) as { angle?: string; hook?: string; offer?: string; format?: string; adset?: string };
    const what = r.kind === "angle" ? "Angle" : r.kind === "audience" ? "Audience" : "Ad";
    const extra = [d.angle && r.kind === "creative" ? `angle: ${d.angle}` : "", d.offer ? `offer: ${d.offer}` : "", d.format ? `format: ${d.format}` : "", d.hook ? `hook: ${d.hook}` : ""].filter(Boolean).join("; ");
    add(id, `${r.verdict === "winner" ? "WON" : "LOST"} ${what} "${String(r.title).slice(0, 80)}"${extra ? ` (${extra})` : ""}: ${r.verdict_reason ?? ""}`);
  }
  for (const f of fame ?? []) add(f.client_id as string, `HALL OF FAME ad "${String(f.ad_name ?? "").slice(0, 70)}": ${f.days_live} days live, beat its target by ${f.beat_by ?? "?"}`);
  const brand = /(^|[^a-z])brand(ed)?([^a-z]|$)/i;
  let g = 0;
  for (const x of google ?? []) {
    if (brand.test(`${x.campaign ?? ""} ${x.ad_group ?? ""}`) || g++ > 400) continue;
    const text = (x.content as { text?: string } | null)?.text ?? "";
    add(x.client_id as string, `GOOGLE ${x.fame ? "HALL OF FAME" : "LIVE WINNER"} ${x.kind} "${text.slice(0, 80)}" (beat by ${x.beat_by ?? "?"})`);
  }
  for (const m of moments ?? []) add(m.client_id as string, `MOMENT ${m.status === "won" ? "WON" : "LOST"}: ${m.name}${m.angle ? ` (${m.angle})` : ""}${m.offer_idea ? ` · offer: ${m.offer_idea}` : ""}`);
  for (const b of bibles ?? []) for (const l of ((b.learnings ?? []) as { kind: string; text: string }[]).slice(-5)) add(b.client_id as string, `PROVEN ${l.kind === "avoid" ? "AVOID" : "WORKS"}: ${l.text}`);
  for (const t of tests ?? []) for (const id of (t.client_ids ?? []) as string[]) if (by.has(id)) add(id, `ADS LAB TEST "${t.title}" (${t.status}): ${t.learning}`);
  return by;
}

/** The angles each sub-vertical's playbook proposes, so a pattern can say who isn't running one yet */
async function playbookAngles(admin: SupabaseClient, verticalIds: string[]) {
  if (!verticalIds.length) return new Map<string, string[]>();
  const { loadPlaybook } = await import("@/lib/playbooks");
  const out = new Map<string, string[]>();
  for (const v of verticalIds.slice(0, 12)) {
    const p = await loadPlaybook(admin, v).catch(() => null);
    if (p) out.set(v, p.avatars.flatMap((a) => a.angles.map((x) => `${x.name}: ${x.hook}`)).slice(0, 10));
  }
  return out;
}

/** One business model: read every client in it together and write its patterns (replacing last week's) */
export async function buildPatterns(admin: SupabaseClient, model: BusinessModel, all?: Member[]) {
  const everyone = all ?? (await members(admin));
  const group = everyone.filter((m) => m.model === model || m.also === model);
  const now = new Date().toISOString();
  const done = async (n: number) => {
    const { data } = await admin.from("sync_state").select("last_result").eq("source", "patterns").maybeSingle();
    await admin.from("sync_state").upsert({ source: "patterns", last_run_at: now, last_result: { ...((data?.last_result ?? {}) as Record<string, unknown>), [model]: { at: now, patterns: n, clients: group.length } } });
    return n;
  };
  if (group.length < 2) {
    await admin.from("client_patterns").delete().eq("model", model);
    return done(0);
  }
  const ev = await evidence(admin, group.map((m) => m.id));
  const withEvidence = group.filter((m) => (ev.get(m.id) ?? []).length);
  if (withEvidence.length < 2) return done(0);
  const subs = [...new Set(group.map((m) => m.sub))];
  const angles = await playbookAngles(admin, [...new Set(group.map((m) => m.verticalId).filter(Boolean) as string[])]);
  // Clients as C1, C2…: the AI never sees a name, and the patterns can't leak one
  const code = new Map(group.map((m, i) => [m.id, `C${i + 1}`]));
  const back = new Map(group.map((m, i) => [`C${i + 1}`, m.id]));
  const vOf = new Map(group.map((m) => [m.sub, m.verticalId]));

  const out = await askJson<{ patterns: { scope: string; kind: Pattern["kind"]; verdict: Pattern["verdict"]; title: string; detail: string; evidence: string[]; clients: number; confidence: Pattern["confidence"]; using: string[]; missing: string[] }[] }>({
    agent: "strategist",
    label: `cross-client patterns ${model}`,
    override: { model: "sonnet", effort: "low" },
    system: `You find the patterns across a paid social agency's clients of one kind (${MODEL_NAMES[model]}): what works, or fails, for several of them, so every client in the group can use it. Kaizen runs Meta (and Google) ads and makes the creative.
RULE ONE: if it isn't profitable, it isn't working. Only WON lines (beat the client's KPI), the Hall of Fame, proven learnings and won moments count as "works"; LOST lines and lost moments count as "fails". A good week is not proof.
A pattern needs the same idea proven for at least 2 different clients (say how many). Look for: the angle or concept (what the ad says), the offer, the format (UGC, founder video, carousel, static), the audience, a marketing moment, and on Google the search intent or copy that wins (never brand searches).
For each: scope ("all" for the whole group, or one sub-vertical's exact name from the list when it only holds there); kind; verdict; title (the idea in a few words, e.g. "Behind-the-kitchen founder video"); detail (one or two sentences: what it is and why it works for this kind of business, how to use it); evidence (2 to 5 short lines, each "3 of 5 restaurants: …", never a client name or code); clients (how many clients prove it); confidence (high: 3+ clients and consistent; medium: 2 clients; low: suggestive); using (the client codes whose evidence shows it); missing (codes in that scope with no sign of it, who'd most likely benefit; leave out clients where it clearly doesn't fit).
Never name or describe a client so it could be identified. 4 to 12 patterns, strongest first; fewer if the evidence is thin. Fails only when clearly repeated.`,
    schema: SCHEMA,
    maxTokens: 8000,
    prompt: [
      `<group>${MODEL_NAMES[model]}: ${group.length} clients. Sub-verticals: ${subs.join(", ")}</group>`,
      `<clients>\n${group
        .map((m) => {
          const lines = ev.get(m.id) ?? [];
          return `${code.get(m.id)} (${m.sub}):\n${lines.length ? lines.slice(0, 24).map((l) => `  - ${l}`).join("\n") : "  (no proven results yet)"}`;
        })
        .join("\n")}\n</clients>`,
      angles.size ? `<playbook_angles note="what each sub-vertical's playbook proposes">\n${[...angles].map(([v, a]) => `${group.find((m) => m.verticalId === v)?.sub ?? v}:\n${a.map((x) => `  - ${x}`).join("\n")}`).join("\n")}\n</playbook_angles>` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const rows = out.patterns
    .filter((p) => p.title && p.clients >= 2)
    .map((p) => {
      const scoped = p.scope !== "all" && vOf.has(p.scope);
      const inScope = new Set(group.filter((m) => !scoped || m.sub === p.scope).map((m) => m.id));
      const ids = (xs: string[]) => [...new Set(xs.map((x) => back.get(x.trim())).filter((x): x is string => Boolean(x && inScope.has(x))))];
      return {
        model,
        vertical_id: scoped ? (vOf.get(p.scope) ?? null) : null,
        group_label: scoped ? p.scope : MODEL_NAMES[model],
        kind: p.kind,
        verdict: p.verdict,
        title: p.title.slice(0, 160),
        detail: p.detail.slice(0, 800),
        // Codes never reach the page, even if one slipped into a line
        evidence: { clients: p.clients, of: inScope.size, items: p.evidence.map((e) => e.replace(/\bC\d+\b/g, "a client").slice(0, 240)).slice(0, 5) },
        confidence: p.confidence,
        using_ids: ids(p.using),
        missing_ids: p.verdict === "works" ? ids(p.missing) : [],
        generated_at: now,
      };
    });
  await admin.from("client_patterns").delete().eq("model", model);
  if (rows.length) await admin.from("client_patterns").insert(rows);
  return done(rows.length);
}

/** Every group, one after another (the weekly run and "Refresh"); stops before the time runs out */
export async function runPatterns(admin: SupabaseClient, budgetMs = 240_000, only?: BusinessModel[]) {
  const start = Date.now();
  const all = await members(admin);
  const { data: s } = await admin.from("sync_state").select("last_result").eq("source", "patterns").maybeSingle();
  const last = (s?.last_result ?? {}) as Record<string, { at?: string }>;
  // Oldest first, so a run cut short picks up where the last one stopped
  const order = (only ?? MODELS).slice().sort((a, b) => (last[a]?.at ?? "").localeCompare(last[b]?.at ?? ""));
  const out: Record<string, number | string> = {};
  for (const m of order) {
    if (Date.now() - start > budgetMs) break;
    out[m] = await buildPatterns(admin, m, all).catch((e) => `error: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

const toPattern = (r: Record<string, unknown>): Pattern => ({
  id: r.id as string,
  model: r.model as BusinessModel,
  verticalId: (r.vertical_id as string | null) ?? null,
  group: r.group_label as string,
  kind: r.kind as PatternKind,
  verdict: r.verdict as Pattern["verdict"],
  title: r.title as string,
  detail: r.detail as string,
  evidence: (r.evidence ?? { clients: 0, of: 0, items: [] }) as Pattern["evidence"],
  confidence: r.confidence as Pattern["confidence"],
  using: (r.using_ids ?? []) as string[],
  missing: (r.missing_ids ?? []) as string[],
  generatedAt: r.generated_at as string,
});

export type PatternsState = {
  groups: { model: BusinessModel; name: string; patterns: Pattern[] }[];
  clients: Record<string, string>; // id → name, for "Brief it for …"
  generatedAt: string | null;
};

/** The Overview's patterns: grouped by business model then sub-vertical, works first. Leads see the groups their clients are in */
export async function loadPatterns(db: SupabaseClient, onlyClients?: string[] | null): Promise<PatternsState> {
  const { data } = await db.from("client_patterns").select("*").order("generated_at", { ascending: false }).limit(200);
  let list = (data ?? []).map(toPattern);
  if (onlyClients) {
    const mine = new Set(onlyClients);
    list = list.filter((p) => p.using.some((x) => mine.has(x)) || p.missing.some((x) => mine.has(x)));
  }
  const ids = [...new Set(list.flatMap((p) => p.missing))];
  const { data: cs } = ids.length ? await db.from("clients").select("id, name").in("id", ids) : { data: [] };
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const groups = MODELS.map((model) => ({
    model,
    name: MODEL_NAMES[model],
    patterns: list
      .filter((p) => p.model === model)
      .sort((a, b) => Number(a.verdict === "fails") - Number(b.verdict === "fails") || Number(a.verticalId != null) - Number(b.verticalId != null) || rank[a.confidence] - rank[b.confidence] || b.evidence.clients - a.evidence.clients),
  })).filter((g) => g.patterns.length);
  return { groups, clients: Object.fromEntries((cs ?? []).map((c) => [c.id as string, c.name as string])), generatedAt: list.map((p) => p.generatedAt).sort().pop() ?? null };
}

/** The patterns for a client's group (its model, the second model it runs, its sub-vertical), and whether it uses each */
export async function patternsForClient(db: SupabaseClient, clientId: string) {
  const [{ data: c }, { businessModelOf }] = await Promise.all([db.from("clients").select("vertical_id").eq("id", clientId).maybeSingle(), import("@/lib/business-model")]);
  const m = await businessModelOf(db, clientId).catch(() => null);
  if (!m) return { model: null, patterns: [] as (Pattern & { uses: boolean; opportunity: boolean })[] };
  const models = [m.model, m.also].filter(Boolean) as BusinessModel[];
  const { data } = await db.from("client_patterns").select("*").in("model", models).limit(80);
  const vid = (c?.vertical_id as string | null) ?? null;
  const patterns = (data ?? [])
    .map(toPattern)
    .filter((p) => !p.verticalId || p.verticalId === vid)
    .map((p) => ({ ...p, uses: p.using.includes(clientId), opportunity: p.missing.includes(clientId) }))
    .sort((a, b) => Number(a.verdict === "fails") - Number(b.verdict === "fails") || Number(b.opportunity) - Number(a.opportunity) || b.evidence.clients - a.evidence.clients);
  return { model: m.model, patterns };
}

/** The short block every agent reads: what's proven across businesses like this one, and what this client isn't using */
export async function patternsBlock(db: SupabaseClient, clientId: string) {
  const { patterns } = await patternsForClient(db, clientId);
  if (!patterns.length) return "";
  const line = (p: Pattern & { uses: boolean; opportunity: boolean }) => `- ${p.verdict === "works" ? "Works" : "Fails"} (${p.kind}, ${p.evidence.clients} of ${p.evidence.of} ${p.group.toLowerCase()}, ${p.confidence}): ${p.title}. ${p.detail}${p.verdict === "works" ? (p.uses ? " This client already uses it." : p.opportunity ? " This client isn't using it yet." : "") : ""}`;
  return `<patterns_across_clients>
Proven across several Kaizen clients like this one (profitable results only, never naming them). Build on what works, especially what this client isn't using yet; avoid what fails unless something is different here.
${patterns.slice(0, 10).map(line).join("\n")}
</patterns_across_clients>`;
}

export async function patternById(db: SupabaseClient, id: string) {
  const { data } = await db.from("client_patterns").select("*").eq("id", id).maybeSingle();
  return data ? toPattern(data) : null;
}
