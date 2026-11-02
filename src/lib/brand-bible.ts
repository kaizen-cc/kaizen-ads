import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, BRAND_BIBLE_SCHEMA, clientContext, contextBlock, researchWeb, type BrandBibleOut } from "@/lib/ai";

// The Brand Bible: every client that touches Kaizen Ads gets one, and it's kept current. Built from web research (the
// brand, then the market: competitors with their links and ads, what buyers say in forums and in competitors' reviews,
// studies to use in ads), the intake form, every recorded call (Fireflies and Gemini, transcripts included), the full
// Slack and email history, what the client said about our creative, and everything else the app knows about them.
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

const day = (iso: string) => String(iso).slice(0, 10);

/**
 * Everything Kaizen holds about the client, for the Bible: links, KPI targets, every call (newest with the transcript,
 * older ones as what was said and decided), Slack and email, and the client's verdicts and comments on our creative.
 * Each block is capped so the whole stays readable in one go.
 */
async function bibleSources(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: kpis }, { data: own }, { data: mentioned }, { data: items }, { data: decided }, { data: said }] = await Promise.all([
    admin.from("clients").select("website, drive_folder_id, creative_db, onboarding_sheet, services").eq("id", clientId).maybeSingle(),
    admin.from("kpi_targets").select("platform, conversion, custom_action, target, monthly_budget").eq("client_id", clientId).eq("active", true),
    admin.from("client_calls").select("id, source, title, occurred_at, url, notes").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(60),
    admin.from("call_mentions").select("call_id, summary, client_calls(id, source, title, occurred_at, url, notes)").eq("client_id", clientId).limit(80),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).in("source", ["slack", "slack_internal", "gmail"]).order("occurred_at", { ascending: false }).limit(500),
    admin.from("designs").select("name, client_status, client_decided_at, requests(title, number)").eq("client_id", clientId).not("client_status", "is", null).order("client_decided_at", { ascending: false }).limit(60),
    admin.from("review_comments").select("body, created_at, author_name, requests(title, number)").eq("client_id", clientId).not("author_contact_id", "is", null).order("created_at", { ascending: false }).limit(120),
  ]);

  const links = [
    c?.website && `Website: ${c.website}`,
    c?.drive_folder_id && `Client Drive folder (asset library, brand files): https://drive.google.com/drive/folders/${c.drive_folder_id}`,
    c?.creative_db && `Creative database: ${c.creative_db}`,
    c?.onboarding_sheet && `Onboarding sheet: ${c.onboarding_sheet}`,
  ].filter(Boolean);

  // Calls: the client's own, and team calls that mentioned them, one entry per call
  type Call = { id: string; source: string; title: string; occurred_at: string; url: string | null; notes: string | null; summary?: { summary?: string; clientSaid?: string[]; decisions?: string[] } };
  const calls = new Map<string, Call>();
  for (const k of own ?? []) calls.set(k.id as string, k as Call);
  for (const m of mentioned ?? []) {
    const k = m.client_calls as unknown as Call | null;
    if (!k) continue;
    calls.set(k.id, { ...(calls.get(k.id) ?? k), summary: m.summary as Call["summary"] });
  }
  let budget = 160_000;
  const callLines = [...calls.values()]
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .map((k, i) => {
      const said = k.summary ? [k.summary.summary, k.summary.clientSaid?.length && `Client said: ${k.summary.clientSaid.join("; ")}`, k.summary.decisions?.length && `Decided: ${k.summary.decisions.join("; ")}`].filter(Boolean).join("\n") : "";
      // The newest calls with as much of the transcript as fits; older ones by what was said and decided
      const room = Math.max(0, Math.min(i < 8 ? 24_000 : 5_000, budget));
      const notes = (k.notes ?? "").slice(0, room);
      budget -= notes.length;
      return `<call date="${day(k.occurred_at)}" source="${k.source === "fireflies" ? "Fireflies" : "Gemini notes"}" title="${k.title.replace(/"/g, "'")}"${k.url ? ` link="${k.url}"` : ""}>\n${[said, notes].filter(Boolean).join("\n\n")}\n</call>`;
    });

  let room = 70_000;
  const messages: string[] = [];
  for (const i of items ?? []) {
    const line = `- ${day(i.occurred_at as string)} · ${i.source === "gmail" ? "Email" : i.source === "slack_internal" ? "Slack (internal)" : "Slack (with client)"}${i.author ? ` · ${i.author}` : ""}${i.title ? ` · "${i.title}"` : ""}: ${String(i.body ?? "").replace(/\s+/g, " ").slice(0, 700)}`;
    if ((room -= line.length) < 0) break;
    messages.push(line);
  }

  const verdicts = (decided ?? []).map((d) => {
    const r = d.requests as unknown as { title: string; number: number } | null;
    return `- ${day(d.client_decided_at as string)} · ${d.client_status} · "${d.name}"${r ? ` (request #${r.number} ${r.title})` : ""}`;
  });
  const comments = (said ?? []).map((x) => {
    const r = x.requests as unknown as { title: string; number: number } | null;
    return `- ${day(x.created_at as string)} · ${x.author_name ?? "Client"}${r ? ` on #${r.number} ${r.title}` : ""}: "${String(x.body).replace(/\s+/g, " ").slice(0, 500)}"`;
  });

  return [
    links.length && `<client_links note="link these wherever the Bible mentions them">\n${links.join("\n")}\n</client_links>`,
    kpis?.length && `<kpi_targets note="what the account is measured on today">\n${kpis.map((k) => `- ${k.platform === "google" ? "Google" : "Meta"}: ${k.conversion}${k.custom_action ? ` (${k.custom_action})` : ""}${k.target != null ? `, target ${k.target}` : ", no target set"}${k.monthly_budget ? `, monthly budget $${k.monthly_budget}` : ""}`).join("\n")}\n</kpi_targets>`,
    c?.services && `<services_kaizen_provides>${JSON.stringify(c.services)}</services_kaizen_provides>`,
    callLines.length ? `<calls note="every recorded call with or about the client, newest first; the client's own words on calls outrank the website">\n${callLines.join("\n")}\n</calls>` : "<calls>None recorded yet.</calls>",
    messages.length && `<slack_and_email note="the full history, newest first">\n${messages.join("\n")}\n</slack_and_email>`,
    (verdicts.length || comments.length) && `<client_creative_feedback note="what the client approved, rejected and said about our creative, in their words">\n${[...verdicts, ...comments].join("\n")}\n</client_creative_feedback>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Marks the build started (the page shows progress) and runs the first half: the web research. The Bible itself is
 * written in its own run (writeBible, started right after; the 10-minute Bible job picks it up if that start is lost),
 * because research and writing together take longer than one server run allows. Returns how the first half ended.
 */
export async function buildBible(admin: SupabaseClient, clientId: string, opts: { pasted?: string; by?: string | null } = {}): Promise<"researched" | "failed" | "missing"> {
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
    build_stage: "research",
    started_at: new Date().toISOString(),
    ...(opts.by !== undefined ? { generated_by: opts.by } : {}),
  });

  const context = contextBlock(ctx);
  try {
    // Research is the expensive half: kept as soon as it's done, and reused for 30 days (a retry or an update within
    // the month doesn't pay for it again). Gathering pages runs on Sonnet with a few searches; the strategy is Opus.
    const fresh = prev?.research && prev.researched_at && Date.now() - Date.parse(prev.researched_at) < 30 * 86_400_000;
    const aim = `What Kaizen already knows about this client (don't repeat it; use it to aim the research):\n${context.slice(0, 10000)}`;
    const research = fresh
      ? (prev!.research as string)
      : (
          await Promise.all([
            researchWeb({
              agent: "brandbible",
              model: "sonnet",
              maxSearches: 10,
              maxFetches: 10,
              maxTurns: 5,
              label: `brand bible research ${client.name}`,
              system: "You research a client for Kaizen Marketing's Brand Bible. Follow the research playbook skill. Report only what you actually found, each fact with its full source URL and the date you read it.",
              prompt: `Research ${client.name}${client.website ? ` (website: ${client.website})` : ""}: the brand itself. Today is ${today()}.

Find and report, with a full source URL on every line:
1. Who they are in their own words: the description they use, mission, vision and values (quote them; say so when the site has none).
2. What makes them different and how it actually works (their process, where the product comes from, how it's made or delivered): the unique selling proposition in their words.
3. Every product or service with exact prices and offers as shown, and every landing page ads could send people to: the page URL, what it promises, the price shown, the action it asks for.
4. Their socials and listings: Instagram, Facebook, TikTok, YouTube, Google Business, marketplace and review-site profile URLs.
5. Reviews: count and star rating per source, then 15-25 verbatim quotes (word for word, first name + last initial, source, date, link). Prefer reviews of 15-40 words that say something specific (a result, a feeling, a comparison, a moment, the words buyers search with). Include complaints. If a review page can't be read, say so.

${aim}`,
            }),
            researchWeb({
              agent: "brandbible",
              model: "sonnet",
              maxSearches: 12,
              maxFetches: 10,
              maxTurns: 5,
              label: `brand bible research ${client.name} (market)`,
              system: "You research a client's market for Kaizen Marketing's Brand Bible. Follow the research playbook skill. Report only what you actually found, each fact with its full source URL and the date you read it.",
              prompt: `Research the market around ${client.name}${client.website ? ` (${client.website})` : ""}. Today is ${today()}.

Find and report, with a full source URL on every line:
1. Competitors: 4-6 direct ones (the ones the client named first, if any are in the notes below). For each: website URL, main landing or offer page URL, Instagram, Facebook and TikTok URLs, positioning line, price, key claims, look and tone, and a Meta Ad Library search link (https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=<brand name>). Note any of their ads you can see: the promise, the angle, how long it has run.
2. What competitors' customers complain about: 5-10 negative reviews of competitors, word for word, with the competitor, source and link. These are angles our client can answer.
3. The buyer's own words about the category from forums, Reddit, Q&A sites and review sites: 10-15 quotes, each tagged pain, desire, objection or regret, with source, date and link. These are themes, never reviews of the client.
4. Market: category size and trends, buyer behavior, and studies, surveys, white papers or research reports with numbers creative could use (the stat, its source and link), tagged [certain] / [likely] / [guessing].
5. Rules: regulation and ad-platform policy that limit what ads in this category can say or show.
6. Calendar: holidays, seasons, industry dates and buying windows for the next 12 months.

${aim}`,
            }),
          ])
        )
          .filter(Boolean)
          .join("\n\n---\n\n");
    if (!fresh && research) await admin.from("client_brand_bibles").update({ research: research.slice(0, 100000), researched_at: new Date().toISOString() }).eq("client_id", clientId);
    await admin.from("client_brand_bibles").update({ build_stage: "write", started_at: new Date().toISOString() }).eq("client_id", clientId);
    await startWrite(clientId);
    return "researched";
  } catch (e) {
    await failed(admin, clientId, Boolean(prev?.markdown), e);
    return "failed";
  }
}

async function failed(admin: SupabaseClient, clientId: string, hadOne: boolean, e: unknown) {
  await admin
    .from("client_brand_bibles")
    .update({ status: hadOne ? "draft" : "failed", build_stage: null, error: e instanceof AiUnavailable ? e.message : "The build didn't finish. Try again." })
    .eq("client_id", clientId);
}

/** Starts the writing half in a run of its own (the request is let go once sent; that run carries on by itself) */
async function startWrite(clientId: string) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
  await fetch(`${base}/api/cron/context?step=bible_write&client=${clientId}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(4000), cache: "no-store" }).catch(() => {});
}

/** The second half: the Bible written from the research, what Kaizen holds and the current Bible (an update keeps what holds). */
export async function writeBible(admin: SupabaseClient, clientId: string): Promise<"built" | "failed" | "missing" | "busy"> {
  const [{ data: client }, ctx, { data: row }] = await Promise.all([
    admin.from("clients").select("id, name").eq("id", clientId).maybeSingle(),
    clientContext(admin, clientId),
    admin.from("client_brand_bibles").select("markdown, version, sources_pasted, research, build_stage").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!client || !ctx || !row) return "missing";
  if (row.build_stage !== "write") return "busy";
  // Taken: a second start (the job's pick-up) leaves it alone
  const { data: took } = await admin.from("client_brand_bibles").update({ build_stage: "writing", started_at: new Date().toISOString() }).eq("client_id", clientId).eq("build_stage", "write").select("client_id");
  if (!took?.length) return "busy";
  try {
    const held = await bibleSources(admin, clientId);
    const bible = await askJson<BrandBibleOut>({
      agent: "brandbible",
      label: `brand bible ${client.name}`,
      // A full Bible runs 20-35k tokens
      maxTokens: 64000,
      onText: () => {},
      system: "You are Kaizen Marketing's brand strategist.",
      schema: BRAND_BIBLE_SCHEMA,
      prompt: `${contextBlock(ctx)}

<what_kaizen_holds>
${held}
</what_kaizen_holds>

<web_research date="${today()}">
${(row.research || "No research came back.").slice(0, 90000)}
</web_research>

<sources_pasted_by_the_team>
${row.sources_pasted || "None. There's no intake form or sales call yet: say so in section 1 and make the gaps tests."}
</sources_pasted_by_the_team>
${row.markdown ? `\n<current_brand_bible version="${row.version}">\n${row.markdown.slice(0, 40000)}\n</current_brand_bible>\nUpdate it: keep what still holds, bring it up to the current structure, bump the minor version, add a change-log line.\n` : ""}
Build ${client.name}'s Brand Bible following the Brand Bible structure skill. Today is ${today()}.
- overview: the cover. statement: who they are in one or two sentences a stranger understands; mission and vision: the client's own words, quoted, or "" when they have none on record (never write one for them); goal: the business goal they gave us, in their words with the source (a revenue goal, a return, a cost per lead), or "" when none.
- markdown: the full Brand Bible in Markdown (headings, bullet lists and pipe tables), every fact with its source tag, and every page, profile, ad, review, file and folder you mention as a Markdown link [name](url) when you have its URL.
- readThisFirst: the "Read this first" page on its own, plain text, under 600 words, one labeled block per line ("Label: text", or a label line ending in a colon followed by its numbered or lettered lines). The brief strategist, copywriter and reviewer read this on every request.
- teamNotes: the "For the team" list: gaps, sensitive items left out, and today's problems in the business or on the site (sold-out notices, broken pages, prices that disagree), each starting "Current issue:". Those stay out of the Bible, which holds only what's true of the brand.
- openQuestions: only true blockers, each with who answers (client, media buyer or Kaizen).`,
    });

    await admin
      .from("client_brand_bibles")
      .update({
        status: "draft",
        build_stage: null,
        overview: bible.overview,
        version: row.markdown ? bumpVersion(row.version) : "v1.0",
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
    await failed(admin, clientId, Boolean(row.markdown), e);
    return "failed";
  }
}

const DAY = 86_400_000;
/** At most this many Bibles a day (about $4 each), so the catch-up costs a predictable amount per day */
const DAILY_CAP = 15;

/**
 * Every client in Kaizen Ads (onboarding, active or paused; not archived) with a Brand Bible. Each run builds one, in
 * this order: clients with none (onboarding and active first), then ones whose new intake came in after the Bible was
 * built, then a monthly update for active clients (it keeps what holds and brings in the month's calls, messages,
 * reviews and feedback). Between those the playbook adds what their ads prove. A failed build waits a day.
 */
export async function autoBibles(admin: SupabaseClient, max = 1) {
  // A Bible whose writing half never started (the start was lost) or died part way is written now, automatic or not
  const { data: stuck } = await admin
    .from("client_brand_bibles")
    .select("client_id, build_stage, started_at")
    .eq("status", "building")
    .in("build_stage", ["write", "writing"])
    .lt("started_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .limit(2);
  const picked = (stuck ?? []).filter((b) => b.build_stage === "write" || Date.now() - Date.parse(b.started_at as string) > 20 * 60_000).slice(0, 1);
  for (const b of picked) {
    await admin.from("client_brand_bibles").update({ build_stage: "write" }).eq("client_id", b.client_id);
    return { written: await writeBible(admin, b.client_id as string) };
  }
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
    // Monthly: new calls, messages, reviews and feedback in, and what's changing and the next 12 months brought current
    else if (ago(b.generated_at) > 30 * DAY && c.status !== "paused") todo.push({ id: c.id, name: c.name, rank: 3, why: "monthly update" });
  }
  todo.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  // A ceiling per 24 hours, so building every client's Bible spreads over days instead of one spike
  const { count: lastDay } = await admin.from("ai_runs").select("id", { count: "exact", head: true }).eq("agent_key", "brandbible").not("label", "like", "brand bible research%").gte("created_at", new Date(Date.now() - DAY).toISOString());
  if ((lastDay ?? 0) >= DAILY_CAP) return { waiting: todo.length, results: {}, paused: `${DAILY_CAP} built in the last 24 hours` };
  const batch = todo.slice(0, max);
  const results = await Promise.all(batch.map(async (t) => [t.name, `${t.why}: ${await buildBible(admin, t.id, { by: null })}`] as const));
  return { waiting: todo.length - batch.length, results: Object.fromEntries(results) };
}
