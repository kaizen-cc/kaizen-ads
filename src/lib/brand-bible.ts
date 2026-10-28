import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, BRAND_BIBLE_SCHEMA, clientContext, contextBlock, researchWeb, type BrandBibleOut } from "@/lib/ai";

// The Brand Bible: every client that touches Kaizen Ads gets one, and it's kept current. Built from web research, the
// intake form and sales calls (or what the team pastes), and everything the app already knows about the client.
// The heavy build (web research, then the Bible) happens once: when the client is added, and again only when a new
// intake form comes in. After that the Bible is maintained, not rebuilt: the client playbook (src/lib/ledger.ts) adds
// dated lessons from what their ads proved (what worked, what to avoid) to its living learnings, which agents and the
// team read as part of the Bible. Execs and leads can still rebuild it by hand from the client page. A built Bible is a
// draft until the head of creative marks it reviewed; agents read drafts as drafts.

const today = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

function bumpVersion(v: string) {
  const m = v.match(/^v(\d+)\.(\d+)$/);
  return m ? `v${m[1]}.${Number(m[2]) + 1}` : "v1.1";
}

/** The intake form, as a source, when the team hasn't pasted any */
async function intakeSource(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("client_intakes").select("received_at, summary, answers").eq("client_id", clientId).order("received_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return "";
  const answers = data.answers ? JSON.stringify(data.answers).slice(0, 30000) : "";
  return `Intake form received ${String(data.received_at).slice(0, 10)}:\n${data.summary ?? ""}${answers ? `\n\nAnswers:\n${answers}` : ""}`;
}

/** Marks the build started (the page shows progress), then runs it: research, then the Bible. Returns how it ended. */
export async function buildBible(admin: SupabaseClient, clientId: string, opts: { pasted?: string; by?: string | null } = {}): Promise<"built" | "failed" | "missing"> {
  const [{ data: client }, ctx, { data: prev }] = await Promise.all([
    admin.from("clients").select("id, name, website").eq("id", clientId).maybeSingle(),
    clientContext(admin, clientId),
    admin.from("client_brand_bibles").select("markdown, version, sources_pasted, research, researched_at").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!client || !ctx) return "missing";
  const sources = opts.pasted?.trim() || prev?.sources_pasted || (await intakeSource(admin, clientId));
  await admin.from("client_brand_bibles").upsert({
    client_id: clientId,
    status: "building",
    sources_pasted: sources.slice(0, 60000),
    error: null,
    started_at: new Date().toISOString(),
    ...(opts.by !== undefined ? { generated_by: opts.by } : {}),
  });

  const context = contextBlock(ctx);
  try {
    // Research is the expensive half: kept as soon as it's done, and reused for 30 days (a retry or an update within
    // the month doesn't pay for it again). Gathering pages runs on Sonnet with a few searches; the strategy is Opus.
    const fresh = prev?.research && prev.researched_at && Date.now() - Date.parse(prev.researched_at) < 30 * 86_400_000;
    const research = fresh
      ? (prev!.research as string)
      : await researchWeb({
      agent: "brandbible",
      model: "sonnet",
      maxSearches: 6,
      maxFetches: 5,
      maxTurns: 3,
      label: `brand bible research ${client.name}`,
      system: "You research a client for Kaizen Marketing's Brand Bible. Follow the research playbook skill. Report only what you actually found, each fact with its source URL and the date you read it.",
      prompt: `Research ${client.name}${client.website ? ` (website: ${client.website})` : ""} for their Brand Bible. Today is ${today()}.

Find and report, with a source URL on every line:
1. Website: what they sell, products/services with exact prices and offers as shown, claims, About/founder story, FAQ, locations.
2. Reviews: count and star rating per source (Google, website, marketplaces), then 8-15 verbatim quotes (word for word, first name + last initial, source, date) covering why people buy, what they love, complaints, and what nearly stopped them. If a review page can't be read, say so.
3. Competitors: 3-5 direct competitors with positioning, price, key claims, look and tone. Note any competitor ads you can see.
4. Market and rules: category trends, regulation and ad-policy limits for this category.
5. Calendar: holidays, seasons, industry dates and buying windows for the next 12 months.

What Kaizen already knows about this client (don't repeat it; use it to aim the research):
${context.slice(0, 12000)}`,
    });
    if (!fresh && research) await admin.from("client_brand_bibles").update({ research: research.slice(0, 100000), researched_at: new Date().toISOString() }).eq("client_id", clientId);

    const bible = await askJson<BrandBibleOut>({
      agent: "brandbible",
      label: `brand bible ${client.name}`,
      // A full Bible runs 15-25k tokens; 16k cut most of them off
      maxTokens: 48000,
      onText: () => {},
      system: "You are Kaizen Marketing's brand strategist.",
      schema: BRAND_BIBLE_SCHEMA,
      prompt: `${context}

<web_research date="${today()}">
${(research || "No research came back.").slice(0, 60000)}
</web_research>

<sources_pasted_by_the_team>
${sources || "None. There's no intake form or sales call yet: say so in section 1 and make the gaps tests."}
</sources_pasted_by_the_team>
${prev?.markdown ? `\n<current_brand_bible version="${prev.version}">\n${prev.markdown.slice(0, 40000)}\n</current_brand_bible>\nUpdate it: keep what still holds, bump the minor version, add a change-log line.\n` : ""}
Build ${client.name}'s Brand Bible following the Brand Bible structure skill. Today is ${today()}.
- markdown: the full Brand Bible in Markdown (headings, bullet lists and pipe tables), every fact with its source tag.
- readThisFirst: the "Read this first" page on its own, plain text, under 400 words. The brief strategist, copywriter and reviewer read this on every request.
- teamNotes: the "For the team" list (gaps, sensitive items left out).
- openQuestions: only true blockers, each with who answers (client, media buyer or Kaizen).`,
    });

    await admin
      .from("client_brand_bibles")
      .update({
        status: "draft",
        version: prev?.markdown ? bumpVersion(prev.version) : "v1.0",
        markdown: bible.markdown,
        read_this_first: bible.readThisFirst,
        team_notes: bible.teamNotes,
        open_questions: bible.openQuestions,
        generated_at: new Date().toISOString(),
        reviewed_at: null,
        reviewed_by: null,
        error: null,
      })
      .eq("client_id", clientId);
    return "built";
  } catch (e) {
    await admin
      .from("client_brand_bibles")
      .update({ status: prev?.markdown ? "draft" : "failed", error: e instanceof AiUnavailable ? e.message : "The build didn't finish. Try again." })
      .eq("client_id", clientId);
    return "failed";
  }
}

const DAY = 86_400_000;
/** At most this many Bibles a day (about $2 each), so the catch-up costs a predictable amount per day */
const DAILY_CAP = 15;

/**
 * Every client in Kaizen Ads (onboarding, active or paused; not archived) with a Brand Bible. Each run builds one, in
 * this order: clients with none (onboarding and active first), then ones whose new intake came in after the Bible was
 * built. No time-based rebuilds: between intakes the playbook keeps it current. A failed build waits a day.
 */
export async function autoBibles(admin: SupabaseClient, max = 1) {
  // Off until an exec switches it on: while the Bible is being dialed in, each one is started by hand from the client
  // page and reviewed before the next
  const { data: setting } = await admin.from("app_settings").select("value").eq("key", "brand_bibles").maybeSingle();
  if ((setting?.value as { auto?: boolean } | null)?.auto !== true) return { paused: "automatic builds are off; start each from the client page" };
  const [{ data: clients }, { data: bibles }, { data: intakes }] = await Promise.all([
    admin.from("clients").select("id, name, status, created_at").is("archived_at", null).in("status", ["onboarding", "active", "paused"]),
    admin.from("client_brand_bibles").select("client_id, status, markdown, generated_at, started_at"),
    admin.from("client_intakes").select("client_id, received_at").not("client_id", "is", null).order("received_at", { ascending: false }).limit(2000),
  ]);
  const bible = new Map((bibles ?? []).map((b) => [b.client_id as string, b]));
  const lastIntake = new Map<string, string>();
  for (const i of intakes ?? []) if (!lastIntake.has(i.client_id as string)) lastIntake.set(i.client_id as string, i.received_at as string);
  const now = Date.now();
  const ago = (iso: string | null | undefined) => (iso ? now - Date.parse(iso) : Infinity);

  type Todo = { id: string; name: string; rank: number; why: string };
  const todo: Todo[] = [];
  for (const c of clients ?? []) {
    const b = bible.get(c.id);
    const tier = c.status === "paused" ? 1 : 0;
    // A build in flight is left alone for 6 hours; a failed one waits a day before it's tried again
    if (b?.status === "building" && ago(b.started_at) < 6 * 3_600_000) continue;
    if (b?.status === "failed" && ago(b.started_at) < 24 * 3_600_000) continue;
    if (!b?.markdown) todo.push({ id: c.id, name: c.name, rank: tier, why: "new" });
    else if (lastIntake.get(c.id) && Date.parse(lastIntake.get(c.id)!) > Date.parse(b.generated_at ?? "1970-01-01")) todo.push({ id: c.id, name: c.name, rank: 2, why: "new intake" });
  }
  todo.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  // A ceiling per 24 hours, so building every client's Bible spreads over days instead of one spike
  const { count: lastDay } = await admin.from("ai_runs").select("id", { count: "exact", head: true }).eq("agent_key", "brandbible").not("label", "like", "brand bible research%").gte("created_at", new Date(Date.now() - DAY).toISOString());
  if ((lastDay ?? 0) >= DAILY_CAP) return { waiting: todo.length, results: {}, paused: `${DAILY_CAP} built in the last 24 hours` };
  const batch = todo.slice(0, max);
  const results = await Promise.all(batch.map(async (t) => [t.name, `${t.why}: ${await buildBible(admin, t.id, { by: null })}`] as const));
  return { waiting: todo.length - batch.length, results: Object.fromEntries(results) };
}
