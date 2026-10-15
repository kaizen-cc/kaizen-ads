"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AiUnavailable, askJson, BRAND_BIBLE_SCHEMA, clientContext, contextBlock, researchWeb, type BrandBibleOut } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

const today = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

/**
 * Execs and leads: research the client on the web, then build (or update) their Brand Bible from that research,
 * pasted sources (intake form, sales call) and everything the app already knows. Runs in the background; the
 * page shows progress until it's done.
 */
export async function buildBrandBible(clientId: string, slug: string, pasted: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can build a Brand Bible." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const supabase = await createClient();
  const [{ data: client }, ctx] = await Promise.all([supabase.from("clients").select("id, name, website").eq("id", clientId).maybeSingle(), clientContext(supabase, clientId)]);
  if (!client || !ctx) return { ok: false, error: "You don't work on this client." };

  const admin = createAdminClient();
  const { data: prev } = await admin.from("client_brand_bibles").select("markdown, version, sources_pasted").eq("client_id", clientId).maybeSingle();
  const sources = pasted.trim() || prev?.sources_pasted || "";
  const { error } = await admin.from("client_brand_bibles").upsert({
    client_id: clientId,
    status: "building",
    sources_pasted: sources.slice(0, 60000),
    error: null,
    started_at: new Date().toISOString(),
    generated_by: me.id,
  });
  if (error) return { ok: false, error: error.message };

  const context = contextBlock(ctx);
  after(async () => {
    try {
      const research = await researchWeb({
        agent: "brandbible",
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

      const bible = await askJson<BrandBibleOut>({
        agent: "brandbible",
        label: `brand bible ${client.name}`,
        system: "You are Kaizen Marketing's brand strategist.",
        schema: BRAND_BIBLE_SCHEMA,
        prompt: `${context}

<web_research date="${today()}">
${research || "No research came back."}
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

      const version = prev?.markdown ? bumpVersion(prev.version) : "v1.0";
      await admin
        .from("client_brand_bibles")
        .update({
          status: "draft",
          version,
          markdown: bible.markdown,
          read_this_first: bible.readThisFirst,
          team_notes: bible.teamNotes,
          open_questions: bible.openQuestions,
          research: research.slice(0, 100000),
          generated_at: new Date().toISOString(),
          reviewed_at: null,
          reviewed_by: null,
          error: null,
        })
        .eq("client_id", clientId);
    } catch (e) {
      await admin
        .from("client_brand_bibles")
        .update({ status: prev?.markdown ? "draft" : "failed", error: e instanceof AiUnavailable ? e.message : "The build didn't finish. Try again." })
        .eq("client_id", clientId);
    }
  });

  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

function bumpVersion(v: string) {
  const m = v.match(/^v(\d+)\.(\d+)$/);
  return m ? `v${m[1]}.${Number(m[2]) + 1}` : "v1.1";
}

/** The Head of Creative (or an exec) reviewed it: from now on its "Read this first" feeds the brief strategist, copywriter and reviewer. */
export async function markBrandBibleReviewed(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only the head of creative or an exec can mark it reviewed." };
  const supabase = await createClient();
  const { error } = await supabase.from("client_brand_bibles").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}`);
  return error ? { ok: false, error: error.message } : { ok: true };
}
