import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { addKnowledgeText, forgetIndex } from "@/lib/knowledge";
import { servicesOf } from "@/lib/services";
import { SOCIAL_STRATEGIST } from "@/lib/loom-lines";
import { cleanLessons, isSocialCandidate, socialExcerpt, topicLabel, type HarvestLesson, type SocialTopic } from "@/lib/social-training-core";

// Training the organic social agents from what Kaizen already reads (owner, Nov 19 2026): call notes (Gemini and
// Fireflies), the clients' Slack channels (theirs and ours) and Gmail, for every client with Social Media. The criteria
// (src/lib/social-training-core.ts) pick what touches the social work: the posting calendar, content pillars, reels and
// stories, engagement, community management, boosting, platform-specific asks and the client's feedback on posts. The
// AI reads those per client, a batch at a time, and distills two kinds of lessons:
//   about this client (what they like, dislike, asked for, their pillars and cadence) → a document per client and batch;
//   the social craft, true for any client (how the team plans, what works) → a method document, no client named.
// Both go to the Social Strategist's knowledge as pending: the Head of Social or an exec approves each (Settings › AI
// agents › Organic Social › Knowledge) before the agents read it, the same flow the Loom intake uses for email and social.
// It backfills the last 12 months first, oldest first, then keeps up with new messages; nothing is ever deleted.

type Admin = SupabaseClient;
const SOURCE = "social_training";
const SOURCES = ["call", "slack_internal", "slack_external", "gmail"] as const;
const BACKFILL_DAYS = 365;
const PAGE = 500;
const PER_BATCH = 14;
const SOURCE_WORD: Record<string, string> = { call: "Call notes", slack_internal: "Kaizen's internal Slack", slack_external: "The client's Slack channel", gmail: "Email" };

type Item = { id: string; client_id: string; source: string; occurred_at: string | null; created_at: string; author: string | null; title: string | null; body: string | null };
type Memo = { atIds?: string[]; filed?: number; read?: number; picked?: number };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["client_lessons", "method_lessons", "summary"],
  properties: {
    summary: { type: "string" },
    client_lessons: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["topic", "kind", "text", "when"], properties: { topic: { type: "string" }, kind: { type: "string", enum: ["prefer", "avoid", "note"] }, text: { type: "string" }, when: { type: "string" } } },
    },
    method_lessons: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["topic", "kind", "text", "when"], properties: { topic: { type: "string" }, kind: { type: "string", enum: ["prefer", "avoid", "note"] }, text: { type: "string" }, when: { type: "string" } } },
    },
  },
};

const SYSTEM = `You train Kaizen's organic social agents (the Social Strategist and its skills: the social audit and the social client desk). Kaizen is a marketing agency; its organic social team plans, makes and posts each client's Facebook, Instagram, TikTok and LinkedIn content, manages the community and reports on it. You read call notes, Slack messages and emails about one client and keep only what should change how the social agents work.

Topics: calendar (posting calendar and cadence), pillars (content pillars and themes), reels_stories (reels, stories and formats), engagement (engagement and growth), community (community management, comments, DMs, reviews), boosting (boosting posts), platforms (platform-specific asks), post_feedback (the client's feedback on posts, captions and graphics).

Return:
- client_lessons: what's true about THIS client's organic social and should hold from now on: what they like and dislike in posts, captions and visuals, their pillars and themes, how often and when they want to post, platforms they care about, what to never post, approvals they need, how they want comments and DMs handled, which posts they want boosted. One plain sentence each, an instruction or fact ("Post the weekly special every Monday", "Never show staff faces without asking first"). kind prefer (do this), avoid (don't) or note (a fact). when: the date or source it came from ("Slack, Oct 2026").
- method_lessons: the social craft that would help on ANY client (how Kaizen's social team plans a calendar, what made a post work, a review step that caught a mistake, how to handle a negative comment). Never name the client, a person or a brand. Most batches have none.
- summary: one or two sentences on what these messages were about, for the reviewer.
Leave out: paid ads work (campaigns, ad sets, budgets, ROAS) unless it's boosting an organic post; email and SMS marketing; scheduling a meeting, invoices and admin; anything a one-off already done ("send the logo"). Use only what's in the messages; no people's names (say "the client" or the role: "the social media manager"). 0 to 8 of each; empty is a fine answer.`;

const month = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "America/New_York" }) : "undated");
const lessonLine = (l: HarvestLesson) => `- ${l.kind === "avoid" ? "Avoid: " : l.kind === "prefer" ? "Do: " : ""}${l.text}${l.when ? ` (${l.when})` : ""}`;
const grouped = (ls: HarvestLesson[]) =>
  [...new Set(ls.map((l) => l.topic))]
    .map((t) => `## ${topicLabel(t as SocialTopic)}\n${ls.filter((l) => l.topic === t).map(lessonLine).join("\n")}`)
    .join("\n\n");

/** The clients with Social Media (not archived): their names */
async function socialClients(admin: Admin): Promise<Map<string, string>> {
  const { data } = await admin.from("clients").select("id, name, services, services_extra, services_removed, strategy_only").is("archived_at", null);
  return new Map((data ?? []).filter((c) => (servicesOf(c) as string[]).includes("social-media")).map((c) => [c.id as string, c.name as string]));
}

/** One client's batch read and filed: returns how many documents went to the Social Strategist for approval */
async function fileBatch(admin: Admin, clientId: string, name: string, items: Item[]): Promise<number> {
  const key = `${SOURCE}:${clientId}:${items[0].id}`;
  const had = async (url: string) => Boolean((await admin.from("knowledge_docs").select("id").eq("source_url", url).limit(1)).data?.length);
  // Read before (a run that stopped mid-page): never asked twice
  if ((await had(key)) || (await had(`${key}#method`))) return 0;
  const msgs = items
    .map((x, i) => `<message n="${i + 1}" source="${SOURCE_WORD[x.source] ?? x.source}" date="${(x.occurred_at ?? x.created_at).slice(0, 10)}"${x.title ? ` title="${x.title.replace(/"/g, "'").slice(0, 120)}"` : ""}>\n${socialExcerpt(x.body ?? "", x.source === "call" ? 2400 : 1500)}\n</message>`)
    .join("\n");
  const out = await askJson<{ summary: string; client_lessons: unknown; method_lessons: unknown }>({
    agent: "social_desk",
    label: "social training",
    bare: true,
    schema: SCHEMA,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 3000,
    clientId,
    system: SYSTEM,
    prompt: `<client>${name}</client>\n${msgs}`,
  });
  const forClient = cleanLessons(out.client_lessons);
  const method = cleanLessons(out.method_lessons, 5);
  const dates = items.map((x) => (x.occurred_at ?? x.created_at).slice(0, 10)).sort();
  const span = dates[0] === dates.at(-1) ? month(dates[0]) : `${month(dates[0])} to ${month(dates.at(-1)!)}`;
  const sources = [...new Set(items.map((x) => SOURCE_WORD[x.source] ?? x.source))].join(", ");
  let filed = 0;
  const target = { scope: "agent" as const, agentKey: SOCIAL_STRATEGIST };
  if (forClient.length) {
    const summary = String(out.summary ?? "").trim().slice(0, 600);
    const text = `# ${name}: organic social lessons (${span})\nFrom ${sources} about ${name}, read for the social team. ${summary}\n\n${grouped(forClient)}`;
    await addKnowledgeText(admin, target, null, { name: `${name}: organic social lessons (${span})`, text, title: `${name}: organic social lessons`, summary: summary || `What ${name} told us about their organic social, ${span}.`, keyPoints: forClient.map((l) => l.text).slice(0, 8), url: key, mime: "text/markdown", method: "conversations", review: "pending" });
    filed++;
  }
  if (method.length) {
    const text = `# Social craft from client conversations (${span})\nWhat Kaizen's organic social team learned working with a client, true for any client.\n\n${grouped(method)}`;
    await addKnowledgeText(admin, target, null, { name: `Social craft from conversations (${span})`, text, title: "Social craft from conversations", summary: method.map((l) => l.text).join(" ").slice(0, 600), keyPoints: method.map((l) => l.text), url: `${key}#method`, mime: "text/markdown", method: "conversations", review: "pending" });
    filed++;
  }
  return filed;
}

/**
 * The pass: messages since the cursor (the last 12 months to begin with), only social clients', only what meets the
 * criteria, read per client in batches until the time budget runs out. The cursor moves past every message looked at,
 * so the backfill goes through over several runs and then keeps up.
 */
export async function harvestSocialLearnings(admin: Admin, opts: { budgetMs?: number } = {}) {
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  const clients = await socialClients(admin);
  if (!clients.size) return { clients: 0 };
  const { data: state } = await admin.from("sync_state").select("cursor_at, last_result").eq("source", SOURCE).maybeSingle();
  const memo = (state?.last_result ?? {}) as Memo;
  let cursor = state?.cursor_at ? String(state.cursor_at) : new Date(0).toISOString();
  let atIds = new Set(memo.atIds ?? []);
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  let read = 0;
  let picked = 0;
  let filed = 0;
  while (Date.now() < deadline - 60_000) {
    const { data, error } = await admin
      .from("context_items")
      .select("id, client_id, source, occurred_at, created_at, author, title, body")
      .in("source", [...SOURCES])
      .in("client_id", [...clients.keys()])
      .gte("created_at", cursor)
      .gte("occurred_at", since)
      .order("created_at")
      .order("id")
      .limit(PAGE);
    if (error) return { error: error.message, read, picked, filed };
    const rows = ((data ?? []) as Item[]).filter((r) => !atIds.has(r.id));
    if (!rows.length) break;
    read += rows.length;
    const keep = rows.filter((r) => isSocialCandidate(r).ok);
    picked += keep.length;
    const byClient = new Map<string, Item[]>();
    for (const r of keep) byClient.set(r.client_id, [...(byClient.get(r.client_id) ?? []), r]);
    let stopped = false;
    for (const [clientId, items] of byClient) {
      for (let i = 0; i < items.length; i += PER_BATCH) {
        if (Date.now() > deadline - 45_000) {
          stopped = true;
          break;
        }
        filed += await fileBatch(admin, clientId, clients.get(clientId) ?? "the client", items.slice(i, i + PER_BATCH)).catch((e) => {
          console.error("[social training]", e instanceof Error ? e.message : e);
          return 0;
        });
      }
      if (stopped) break;
    }
    // Out of time mid-page: the page is read again next run (the documents already filed are kept once each)
    if (stopped) break;
    const last = rows.at(-1)!.created_at;
    atIds = new Set([...(last === cursor ? atIds : []), ...rows.filter((r) => r.created_at === last).map((r) => r.id)]);
    cursor = last;
    await admin.from("sync_state").upsert({ source: SOURCE, cursor_at: cursor, last_run_at: new Date().toISOString(), last_result: { atIds: [...atIds].slice(-500), read, picked, filed } satisfies Memo });
    if ((data ?? []).length < PAGE) break;
  }
  if (filed) forgetIndex();
  return { clients: clients.size, read, picked, filed };
}
