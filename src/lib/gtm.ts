import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiUnavailable, askJson, clientContext, contextBlock, researchWeb } from "@/lib/ai";

// The Meta go-to-market strategy (Kaizen's GTM Strategy Builder, from the Market Research Playbook, Division 1: Paid
// Media Research, Meta only). Built once a client's intake form, call notes and website are all in; the team reviews
// it on the client page, and from then on its summary feeds every agent with the rest of the client page.

const today = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date());

export type GtmGate = { intake: boolean; calls: boolean; website: boolean; missing: string[] };

/** The hard gate: the intake form, notes from a call about the client, and their website. Nothing is built without all three. */
export async function gtmGate(admin: SupabaseClient, clientId: string): Promise<GtmGate> {
  const [{ data: c }, { count: intakes }, { count: mentions }] = await Promise.all([
    admin.from("clients").select("website").eq("id", clientId).single(),
    admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", clientId).not("summary", "is", null),
    admin.from("call_mentions").select("call_id", { count: "exact", head: true }).eq("client_id", clientId),
  ]);
  const gate = { intake: Boolean(intakes), calls: Boolean(mentions), website: Boolean(c?.website?.trim()) };
  const missing = [!gate.intake && "the marketing intake form", !gate.calls && "notes from a call (access call, Ad Hawk or paid media deep-dive)", !gate.website && "the client's website"].filter(Boolean) as string[];
  return { ...gate, missing };
}

const SCHEMA = {
  type: "object",
  properties: {
    markdown: { type: "string" },
    readThisFirst: { type: "string" },
    openItems: { type: "array", items: { type: "object", properties: { item: { type: "string" }, who: { type: "string" } }, required: ["item", "who"], additionalProperties: false } },
    quality: { type: "array", items: { type: "object", properties: { check: { type: "string" }, pass: { type: "boolean" }, note: { type: "string" } }, required: ["check", "pass", "note"], additionalProperties: false } },
  },
  required: ["markdown", "readThisFirst", "openItems", "quality"],
  additionalProperties: false,
};

type Out = { markdown: string; readThisFirst: string; openItems: { item: string; who: string }[]; quality: { check: string; pass: boolean; note: string }[] };

const SYSTEM = `You are Kaizen Marketing's Meta Go-to-Market Strategy Builder. You run Division 1: Paid Media Research from the Kaizen Market Research & Development Playbook, scoped to Meta (Facebook and Instagram) advertising, and write the client's Meta Go-to-Market strategy: the team's foundational reference for the client and good enough to put in front of the client without a rewrite. Meta only: no Google Ads, TikTok or combined plans.

The prime directive, above being complete: never invent anything.
- Never invent an offer, discount, guarantee, price, product name or pricing tier that isn't stated in the intake form, the call notes, the client's website or the research. If you don't have a number, don't write one.
- Never invent competitor data, customer language, reviews or testimonials. Only what traces to a source.
- Never round up confidence: "approximately $80 (client estimate, not confirmed)".
- When something is missing, the section says so plainly and it goes in openItems. A visibly incomplete section is always better than a plausible placeholder.
Every number, quote, competitor claim and offer carries its source in brackets: [intake], [call: <title> <date>], [website], [research: <url>], [Meta account].

The document, in Markdown, follows Kaizen's GTM Strategy Template ("Meta Advertising Strategy & Roadmap"), section by section with these exact headings and fields:
Cover: "Go-To-Market Strategy: Meta Advertising Strategy & Roadmap", the client name, prepared for (the client contact or company), prepared by (the media buyer, from the team, else "[media buyer]"), the date, status "Draft".
## 01 Executive Summary: The Opportunity (one to two sentences: the market opportunity and why now). Kaizen's Recommended Strategy (plain language: what we're doing and why it will work). The Competitive Edge (the single clearest advantage competitors aren't using). The 60-Day Bet (why this account will be profitable within 60 days, in one sentence). At a Glance: Target CPA, Platform (Meta: Facebook / Instagram), Launch Date.
## 02 Business Overview: What They Sell (product or service, pricing model, revenue model; prices only as stated). Key Differentiators. Current Marketing Activity (platforms, spend and results today). Profitability Snapshot: Avg. Order / Job Value, Customer LTV, Current CAC ("unknown" when it is). Funnel & Ad Account Assessment: Customer Journey / Funnel Map (ad click to conversion, friction points flagged) and Existing Ad Account Findings (what's been tested, what worked and didn't, audiences that exist; from the Meta account data when there is some).
## 03 Ideal Customer Profile: Demographics (age, gender split, income, geography). Psychographics (values, lifestyle, aspirations, buying motivations). Pain Points (in the customer's own words). Buying Triggers. Objections (price, trust, skepticism, alternatives). Voice of Customer: real customer language, direct quotes from real reviews, testimonials or the intake form only.
## 04 Competitive Landscape: Competitor 1, 2 and 3 (up to 5): name, positioning, strength, weakness, and their Meta presence. The Gap We're Exploiting (what competitors aren't saying or doing that Kaizen will own). Recurring Competitor Weakness (from review mining, real reviews only). Our Proof Point (from real client reviews only).
## 05 Messaging Strategy: at least three angles, numbered, each named and rooted in a specific finding: 1 Pain Point, 2 Transformation, 3 Offer / Value (confirmed real offers only, else "pending offer confirmation from client"), plus social proof, comparison or urgency where warranted. Each with Headlines (3, under 40 characters each) and Primary Text (3, each 2 to 4 sentences: hook, problem or benefit, CTA).
## 06 Meta Advertising Strategy: Recommended Meta Campaign Structure (campaign types including Advantage+, ad sets, objectives). Initial Testing Sequence (what's tested first, budget allocation). Benchmarks: Industry Avg. CPM, Industry Avg. CTR, Industry Avg. CPA / ROAS, each with its cited source. Profitability Scenario: The Math ("At our target CPA of $X with a $Y average order, we need a Z% conversion rate to be profitable", and why that's achievable, from the client's numbers). Offer Positioning (discount, guarantee, bundle or full price; confirmed only). Funnel Recommendation (website, GHL landing page or lead form).
## 07 90-Day Profitability Roadmap: 30 Days (what's being tested, what data we'll have, expected CPA range). 60 Days (expected CPA confidence, what's scaling). 90 Days (target ROAS / CPA / lead volume for profitable scale). Projected Return: monthly ROI on ad spend at target CPA, from the client's own numbers only, breakeven CPA math shown. Gap Analysis: what would need to be true for this NOT to work, honest risks and the plan if they happen.
## 08 Open Items & Confirmations Needed: Unconfirmed or Estimated Figures. Information Still Needed From Client. Research Still Pending (team side, e.g. Meta Ad Library pulls, a Motion board, swipe file examples). Then the Internal Quality Gate results.
Where a field has no sourced answer, write what's missing in the field itself and list it under 08; never leave a template placeholder in brackets and never fill it with a guess.
No client sign-off section.

Copy rules: never use em dashes anywhere; use periods, commas or restructure. Confident and direct, professional (client-facing): no internal slang or profanity.

readThisFirst: under 350 words, plain text, for the team's agents (brief strategist, copywriter, reviewer) on every request: the ICP in two lines, the angles that lead with their best hook, confirmed offers and prices, claims never to make, KPI targets, and what's still unconfirmed.
openItems: every open item with who answers it: "client", "media buyer" or "Kaizen".
quality: the quality gate, one entry per check, honestly: "Why this client is profitable within 60 days is answered", "At least one evidence-backed competitive advantage", "ICP consistent across sections", "90-day roadmap uses the client's real numbers", "KPI targets are sourced", "Client-ready: clear, digestible in about 15 minutes, no internal jargon", "Every number, quote, competitor claim and offer traces to a source", "Open items are visibly flagged". pass is false when it doesn't hold, and note says what's needed.`;

/**
 * Builds (or rebuilds) a client's Meta go-to-market strategy: web research first (their site, reviews, competitors and
 * their Meta presence, Meta benchmarks), then the document from that research and everything on the client page.
 * Waits (and says what's missing) until the intake form, call notes and website are all in.
 */
export async function buildGtm(admin: SupabaseClient, clientId: string, by: string | null = null) {
  const gate = await gtmGate(admin, clientId);
  if (gate.missing.length) {
    await admin.from("client_gtm_strategies").upsert({ client_id: clientId, status: "waiting", missing: gate.missing, error: null }, { onConflict: "client_id" });
    return { status: "waiting" as const, missing: gate.missing };
  }
  const [{ data: client }, { data: prev }, ctx] = await Promise.all([
    admin.from("clients").select("name, website").eq("id", clientId).single(),
    admin.from("client_gtm_strategies").select("markdown, version").eq("client_id", clientId).maybeSingle(),
    clientContext(admin, clientId),
  ]);
  if (!client || !ctx) throw new Error("Client not found");
  await admin
    .from("client_gtm_strategies")
    .upsert({ client_id: clientId, status: "building", missing: [], error: null, started_at: new Date().toISOString(), generated_by: by }, { onConflict: "client_id" });

  try {
    // Everything the gate asks for, in full: the intake answers and every call this client came up in
    const [{ data: intake }, { data: mentions }, { data: buyers }] = await Promise.all([
      admin.from("client_intakes").select("answers, received_at").eq("client_id", clientId).not("summary", "is", null).order("received_at", { ascending: false }).limit(1).single(),
      admin.from("call_mentions").select("summary, client_calls(title, occurred_at, status)").eq("client_id", clientId).limit(20),
      admin.from("client_assignments").select("profiles(full_name)").eq("client_id", clientId).eq("role", "meta_buyer"),
    ]);
    // "Prepared by" on the cover: the client's media buyer
    const preparedBy = (buyers ?? []).map((b) => (b.profiles as unknown as { full_name: string } | null)?.full_name).filter(Boolean).join(" and ");
    const answers = ((intake?.answers ?? []) as { q: string; a: string }[]).filter((x) => x.a?.trim()).map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n");
    const calls = (mentions ?? [])
      .map((m) => {
        const call = m.client_calls as unknown as { title: string; occurred_at: string; status: string } | null;
        const s = m.summary as { summary: string; clientSaid: string[]; decisions: string[]; commitments: { what: string }[] };
        return `"${call?.title ?? "A call"}" ${call?.occurred_at.slice(0, 10) ?? ""}${call?.status === "internal" ? " (internal)" : ""}\n${s.summary}${s.clientSaid?.length ? `\nThe client said: ${s.clientSaid.join("; ")}` : ""}${s.decisions?.length ? `\nDecided: ${s.decisions.join("; ")}` : ""}${s.commitments?.length ? `\nWe committed to: ${s.commitments.map((c) => c.what).join("; ")}` : ""}`;
      })
      .join("\n\n");
    const context = contextBlock(ctx);

    const research = await researchWeb({
      agent: "gtm",
      label: `gtm research ${client.name}`,
      system: "You research a client for Kaizen Marketing's Meta go-to-market strategy. Report only what you actually found, every fact with its source URL. Meta only: no Google Ads or TikTok research.",
      prompt: `Research ${client.name} (website: ${client.website}) for their Meta go-to-market strategy. Today is ${today()}.

Report, with a source URL on every line:
1. Their website: what they sell, products and services with prices and offers exactly as shown, claims, guarantees, the funnel (how someone buys or becomes a lead), and testimonials word for word.
2. Reviews: rating and count per source (Google, Yelp, Trustpilot, the site), then 8 to 15 verbatim quotes with source and date: why people buy, what they love, complaints, what nearly stopped them.
3. Competitors: the 3 to 5 named in the intake or calls below (else the closest direct competitors you can find): positioning, stated offers and prices, and their Meta presence (Facebook and Instagram pages, anything visible from the Meta Ad Library). Negative reviews of competitors, word for word.
4. Meta benchmarks for this category (CPM, CTR, cost per lead or purchase, conversion rates) from credible sources, with the source and year.
If something can't be read or found, say so instead of guessing.

What Kaizen already knows (aim the research with it; don't repeat it):
<intake_form>
${answers.slice(0, 15000)}
</intake_form>
<calls>
${calls.slice(0, 10000)}
</calls>`,
      maxSearches: 12,
      maxFetches: 14,
    });

    const out = await askJson<Out>({
      agent: "gtm",
      label: `gtm strategy ${client.name}`,
      system: SYSTEM,
      schema: SCHEMA,
      prompt: `${context}

<intake_form source="intake">
${answers || "(no answers)"}
</intake_form>

<call_notes source="call">
${calls}
</call_notes>

<web_research date="${today()}" source="research">
${research || "No research came back."}
</web_research>
${prev?.markdown ? `\n<current_strategy version="${prev.version}">\n${prev.markdown.slice(0, 30000)}\n</current_strategy>\nUpdate it with what's new: keep what still holds, and add a short change-log line at the end.\n` : ""}
Write ${client.name}'s Meta Go-to-Market strategy. Today is ${today()}. Prepared by: ${preparedBy || "[media buyer not assigned yet]"}.`,
    });

    const version = prev?.markdown ? bump(prev.version) : "v1.0";
    // Never an em dash, whatever the model wrote
    const clean = (s: string) => s.replace(/\s*—\s*/g, ", ");
    await admin
      .from("client_gtm_strategies")
      .update({
        status: "draft",
        version,
        markdown: clean(out.markdown),
        read_this_first: clean(out.readThisFirst),
        open_items: out.openItems,
        quality: out.quality,
        research: research.slice(0, 100000),
        generated_at: new Date().toISOString(),
        reviewed_at: null,
        reviewed_by: null,
        error: null,
      })
      .eq("client_id", clientId);
    return { status: "draft" as const };
  } catch (e) {
    await admin
      .from("client_gtm_strategies")
      .update({ status: prev?.markdown ? "draft" : "failed", error: e instanceof AiUnavailable ? e.message : "The build didn't finish. Try again." })
      .eq("client_id", clientId);
    return { status: "failed" as const, error: e instanceof Error ? e.message : String(e) };
  }
}

function bump(v: string) {
  const m = v.match(/^v(\d+)\.(\d+)$/);
  return m ? `v${m[1]}.${Number(m[2]) + 1}` : "v1.1";
}

/**
 * Onboarding: clients whose intake form came in during the last 60 days get a strategy as soon as the gate clears
 * (waiting until then, with what's missing on their page). One build per run; each is a few minutes of research.
 */
export async function autoGtm(admin: SupabaseClient, max = 1) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data: intakes } = await admin.from("client_intakes").select("client_id, clients!inner(archived_at, status)").gte("received_at", since).not("client_id", "is", null).not("summary", "is", null).is("clients.archived_at", null);
  const ids = [...new Set((intakes ?? []).filter((i) => (i.clients as unknown as { status: string }).status !== "offboarded").map((i) => i.client_id as string))];
  if (!ids.length) return { candidates: 0, built: 0 };
  const { data: have } = await admin.from("client_gtm_strategies").select("client_id, status, started_at").in("client_id", ids);
  const state = new Map((have ?? []).map((h) => [h.client_id, h]));
  // A build that died mid-way (the function timed out) is tried again after an hour
  const stale = (h: { status: string; started_at: string | null }) => h.status === "building" && (!h.started_at || Date.now() - Date.parse(h.started_at) > 3_600_000);
  const todo = ids.filter((id) => {
    const h = state.get(id);
    return !h || h.status === "waiting" || stale(h);
  });
  let built = 0;
  const results: Record<string, string> = {};
  for (const id of todo) {
    if (built >= max) {
      // Still record who's waiting on what, so the page says it
      const gate = await gtmGate(admin, id);
      if (gate.missing.length) await admin.from("client_gtm_strategies").upsert({ client_id: id, status: "waiting", missing: gate.missing }, { onConflict: "client_id" });
      continue;
    }
    const r = await buildGtm(admin, id);
    results[id] = r.status;
    if (r.status !== "waiting") built++;
  }
  return { candidates: todo.length, built, results };
}

/** The strategy as the agents read it: the summary once reviewed; a draft only as a draft. */
export async function gtmForContext(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("client_gtm_strategies").select("status, version, read_this_first, markdown").eq("client_id", clientId).in("status", ["draft", "reviewed"]).maybeSingle();
  if (!data?.markdown && !data?.read_this_first) return null;
  return `${data.read_this_first ? `In short:\n${data.read_this_first}\n\n` : ""}${data.markdown ? `The full strategy:\n${data.markdown.slice(0, 40000)}` : ""}\n(Meta go-to-market strategy ${data.version}${data.status === "reviewed" ? ", reviewed by Kaizen" : ", a draft the team hasn't reviewed yet: treat anything unconfirmed as unconfirmed"})`;
}
