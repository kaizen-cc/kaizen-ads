-- The Brand Bible, v3 (the Brand Bible review with the agency's founder, Nov 3 2026):
-- * Rule one, profitability: not profitable means not working; only repeated, proven wins (or failures) go back into
--   the Bible, hypotheses go to the next brief.
-- * The top is broad and factual (mission, vision, values, success, tone, look); dos and don'ts come from a log of
--   what the client says, promoted after about three mentions or at once when said sternly, and lifted when the client
--   opens the door.
-- * Explicit targets, scope of work and creative package, expectations, goals with a roadmap, a live budget, nuggets,
--   offers with win/loss, a media-buyer section and a Google section, features vs benefits, funnels, all tailored to
--   the client's business model and sub-vertical.
-- * New brandbible skills: USP, customer avatars, offers, competitor overview.

-- The dos-and-don'ts log
create table if not exists public.client_bible_rules (
  client_id   uuid not null references public.clients(id) on delete cascade,
  key         text not null,
  rule        text not null,
  polarity    text not null check (polarity in ('do', 'dont')),
  status      text not null default 'logged' check (status in ('logged', 'rule', 'lifted')),
  count       int not null default 1,
  stern       boolean not null default false,
  mentions    jsonb not null default '[]'::jsonb,
  lifted_note text,
  updated_at  timestamptz not null default now(),
  primary key (client_id, key)
);
alter table public.client_bible_rules enable row level security;
create policy "staff read bible rules" on public.client_bible_rules for select to authenticated using (private.is_staff());

alter table public.client_brand_bibles add column if not exists rules_logged_at timestamptz;

-- The structure skill, v3
update public.ai_knowledge
set body = $body$One Brand Bible per client: the single source of truth every designer, editor, copywriter and media buyer builds from, and the "how to win" handoff for this client. It is reviewed once and stored. The Meta and Google go-to-market strategies are built from it and executed; their logs prove what works, and only what's proven again and again (or fails again and again) comes back into the Bible. Hypotheses and test ideas never go in: they go to the next creative brief. Everything in it is true of the brand and evergreen unless it is dated (goals and roadmap, budget, offers, "What's changing", the calendar). Today's problems in the business or on the site (sold-out notices, broken pages, prices that disagree) never go in the Bible: they go to "For the team" as "Current issue: …", and a lasting rule that follows from one goes in as the rule, not the glitch.

RULE ONE: if it isn't profitable, it isn't working. Three first purchases or seven good days are a direction, not proof. The Bible has a confident understanding of what makes this client profitable, from real data; with no ad data of their own it says so and uses the industry benchmarks (WordStream and similar, for their category and market) as the expectations, labeled "benchmark", updated as real data comes in. With historical ad data, work from the facts, but never take an unprofitable account's "best audiences" or "best ads" as proven.

TAILOR IT to the client's business model and sub-vertical (the business_model block): the funnels, the KPIs, where reviews come from, the offers that fit, where revenue or leads are tracked and how Google is used differ for an online store, a restaurant, a bookings business, a local service and a lead-gen business. A business can run two (a restaurant with online orders and event inquiries). Never write one kind of business's sections for another.

Header: Client — Brand Bible · Version · Status (Draft / Reviewed by Kaizen / Sent to client / Client-approved / Updated since approval) · Developed date · Last updated · Reviewed by (Head of Creative, date) · Approved by (client contact, date). The cover (the overview field) carries who they are in one statement, their mission and vision in their own words (never written for them), and the goal they gave us.

Links: every page, profile, listing, ad, review, call, file and folder that has a URL is a Markdown link [name](url). A reader should be able to click straight through to do a deep dive.

Audience letters: profiles are lettered A, B, C… Wherever a letter appears outside the profile index write it with the name, e.g. "A · Fresh-Fish Seeker". A profile with no review, angle or shot planned for it is a gap: say so.

Tables: every table is a proper pipe table with a header row and the same number of cells in every row; keep cells short (a sentence, not a paragraph) so they read cleanly.

**Read this first** (one page, plain text, one labeled block per line)
- Who they are: what they sell in one sentence a stranger understands; mission, vision and core values in their words (or "none on record"); what success looks like for them.
- Targets: the minimum revenue goal, the KPI per platform (e.g. Meta CPA, Google CPA, or ROAS), and the blended target once both run; each with its source, or "benchmark: …" when we have no data of our own.
- Scope: the services Kaizen runs now and the creative package (name and monthly count; a grandfathered package is written "grandfathered creative package: N assets a month").
- Who we make creative for: the profiles, one line each ("A. Name: one line. Show: product.").
- Foundational rules: a label line ending in a colon, then 3 to 7 numbered lines. Broad, 100% factual truths of the brand that hold across every call: the mission, what they stand for, tone, the creative look (e.g. "friend-to-friend design, never a department-store ad"; "fresh, never frozen"). Never one comment, one test or one conversation turned into a rule, and never anything a current test could contradict.
- Dos and don'ts in force: the rules from the dos-and-don'ts log (said three times or sternly), one line each with the date. Say "none yet" when the log has none.
- Voice in one line plus one example line; look in one line (colors with hex, fonts, photo style).
- Offer now: the front-facing offer for new customers and the sign-up offer, or "No offer: see 2c".
- Platforms and sizes: every placement for every platform Kaizen runs. Meta: Feed 4:5 (1080x1350), Stories and Reels 9:16 (1080x1920). Google, when Kaizen runs Google: responsive display landscape 1.91:1 (1200x628), square 1:1 (1200x1200), portrait 4:5 (960x1200), logos 1:1 (1200x1200) and 4:1 (1200x300); Performance Max and Demand Gen the same images plus video in 16:9, 1:1 and 9:16; YouTube 16:9 (1920x1080) and Shorts 9:16; headlines 30 characters, long headline 90, descriptions 90. TikTok 9:16.
- The 3 best reviews for ads: from the review bank (4b), named by RV#, word for word.

**1. The engagement**
- **1a. Scope of work**: every service Kaizen provides and on which platforms; the creative package with its monthly count (grandfathered packages named as such); the client's own content and organic posts we can use. When scope changed in a call, email or Slack (a service cut or added), it's current here with the date and where it was agreed.
- **1b. Expectations**: how and how often they want to hear from us, what they expect in reports, and what they told us they want in an agency (from the discovery call).
- **1c. Goals and targets**: the primary goals and targets in the client's words with the source (minimum revenue per month, the KPI per platform, blended, break-even and scaling CPA or ROAS, average order or job value, lifetime value, what growth they care about: new customers, repeat buyers, subscriptions, bookings, leads); what success looks like; what they worry about.
- **1d. Roadmap**: where they are today and where we're going (e.g. "$60k a month today, $100k a month target by Q3"), as a short forecast with milestones; "target date not set" when it isn't.
- **1e. Budget** (live, changes often): monthly ad budget per platform and in total, as of a date, with who set it; a change log of budget moves.
- **1f. Key calls**: date · type · what was decided, one line each, linked to the recording.

**2. The business**
What they sell; origin story in their words and whether they want it in ads; mission, vision and values in their words.
- **2a. Unique selling proposition**: dug out in detail (the USP identification skill): how they actually do it differently (sourcing, process, preparation, delivery, time, team, generations, certifications), in plain words a copywriter can turn into a hook, e.g. "a fourth-generation wholesaler that hand-selects and cuts the fish itself, seals it and ships it to your door in three days".
- **2b. Features and benefits**: Feature (what the product or service has) · Benefit (what the customer gets from it) · Proof. 6–12 rows.
- **2c. Offers** (the offer development skill): the front-facing offer for new customers; the sign-up (pop-up) offer; other offers live now. Offer history, newest first: date · offer · channel · result (Win / Loss / Untested, judged by whether that offer's own campaign was profitable; no numbers needed) · notes, including offers the client won't run. When there's no offer, say so plainly and recommend 2–3 offers that fit their business model and margins, for the client to choose from: the system keeps pushing until there is one, because the offer is the biggest lever a business has.
- **2d. Funnels**: each goal's journey step by step, from the business model (a store: page → product → add to cart → checkout → purchase; lead gen: landing page → form or call → thank-you; a restaurant: online order and event inquiry as two funnels), with the page for each step linked.
- **2e. Where ads send people**: page (link) · what it promises · price shown · action · last checked (date).
- **2f. Nuggets**: the small facts that change everything, each with its source (a region that's more profitable, a delivery promise, the product with the best margin, the season that pays the year).
- How they sell (channels, consultation or checkout, deposits, decision time, follow-up the ads hand off to); product or service table: line · what it is · price as listed · sold how (individually, only in a bundle or box, subscription) · status (push / show / don't show); what's changing (dated); next 12 months (dated).

**3. Audience profiles (3–5)** (the customer avatar skill)
- 3 minimum, 5 maximum. Evidence from at least two of: intake, calls, client comms, reviews, ad or sales data, with a source on every line. Weight: customer data > reviews > calls and intake > client comms > competitor targeting > inference. Confidence: Proven (profitable sales or ad data) · Likely (strong evidence, untested) · Hypothesis (to test). With no ad data, no profile is Proven. Letters are permanent; retired profiles stay listed with date and why.
- The key finding first: where who buys today, who responds to ads and who the client wants disagree (a three-lens table: lens · what it shows · finding). With no ad data, say the ads lens is empty.
- Index: Letter · Name · One line · Product to show · Confidence.
- Voice of customer: buyers' own words from forums, Reddit, review sites and competitors' reviews: quote · type (pain, desire, objection, regret) · profile · source link. Never used as the client's reviews.
- Pain to angle matrix: # · pain (their words) · profile (letter + name) · angle · promise · proof (RV#, facts, assets) · format that fits · status (Proven / To test). 6–10 rows, proven ones first. Every concept in a creative brief traces back to a row.
- Per profile: Who they are · A day in their life · What they want (their words) · What hurts (their words) · What stops them buying (objection + our answer) · Awareness level · Triggers · Where they are · Angles that fit (3–5, example hook each) · Visual cues · Never show them · Evidence · Confidence.

**4. Brand voice and messaging**
Positioning in one sentence; the full positioning statement ("For [who] who [need], [brand] is the [category] that [promise], unlike [alternatives] that [weakness], because [reasons]"); reasons to believe: reason · proof with source; 3–5 personality traits as "this, not that"; voice rules; words and lines the brand uses; lines the client approved and rejected, in their words, with why; claims in three columns: Approved (exact wording) · Needs client sign-off · Banned; required on every asset; Do / Don't table built from the dos-and-don'ts log (rule · do or don't · source · date · "said sternly" or how many times); a rule the client has since lifted is left out, or noted as lifted with the date.

**4b. Review bank**
From the sources this kind of business gets reviews on (the business model block: e.g. Google Business Profile, the website, Trustpilot, Facebook; Yelp and the BBB for local businesses; Angi and HomeAdvisor for home services; OpenTable and Resy for restaurants; the booking platform for appointments), plus long, positive comments from their own Facebook and Instagram posts. 15–25 real reviews, 4–5 stars, specific, 15–40 words preferred. Columns: RV# · review word for word · stars · shown as (first name + last initial · source) · source, date, link · profile (letter + name) · angle · Use in ads (OK / Needs client sign-off / Can't use, with why). Say which sources couldn't be read (e.g. Google reviews) so the team can pull them. It grows on every update.

**5. Look and feel**
Brand version in force (linked); colors (hex), fonts, logo rules; photo and video style; music; UGC and creator rules; creative the client loved and creative they rejected: date · piece · their words · what it teaches. Asset library: linked folders.

**5b. Assets, production and AI permissions**
What Kaizen makes; what the client provides; AI permissions by asset type: AI images · AI edits to real photos · AI video · animated and 3D or Pixar-style video · AI voiceover · AI music · AI people/avatars, each Approved / Not approved / Not asked, with limits, who said it when, and the source (new AI types are added as they come, "Not asked" until the client answers). Asset inventory with direct links: the brand guideline, the ad creative folder, the raw asset folders (images, video), and every third-party tool they share with us (a UGC platform, Canva, Figma, Dropbox…): name · link · what's there · access ("logins in the password manager"; never a password in the Bible). Gaps; shoot list: # · what to shoot · why (the profile and angle it unlocks) · who shoots it · specs and shots · priority.

**6. Competitors and their creative** (the competitor overview skill)
Table: brand (linked) · USP · positioning · price · key claims · offer · look and tone · how our client differs · links (landing page, Instagram, Facebook, TikTok, Ad Library). Their mission and vision as their sites state them, to show how our client's USP holds up against theirs. Creative they run now, longest-running first: brand · the promise · angle · our profile it targets · running since · what people say in the comments · Ad Library link. What their customers love (positive reviews: what our client must match) and complain about (negative reviews word for word: the callouts and hooks our client can own), each with source link and the angle it opens. Category conventions and the white space our client can own.

**7. Market and rules of the road**
Category size and trends; research to use in ads: stat · source (linked) · how creative could use it, tagged [certain] / [likely] / [guessing]; press and news that legitimize the category or how the client does business (dated, linked, how to use it); industry benchmarks for their category and market (cost per lead or purchase, conversion rate, CTR; source and year); regulation and ad-platform policy that limit what creative can say or show; seasonality.

**8. Marketing moments calendar (12 months)**
Date · moment · fit (High / Medium / Skip) · angle idea · the offer or promotion to ask the client for · asset-ready-by (moment minus 14 days) · result last time (Win / Loss / New) · notes (incl. moments the client bans and why). Moments that won before for this client, or for similar businesses in their sub-vertical, are marked.

**9. For the media buyers**
- Goals and economics: revenue goal, break-even and scaling CPA or ROAS per platform, blended target; creative volume (the package's monthly count plus the client's own content), which sets how we buy.
- Funnels and tracking: each goal's funnel (2d) with the events that fire at each step; pixel or dataset ID and whether it's installed and firing; the conversion and custom events and what each one means on the site (e.g. "Booking = the event-inquiry thank-you page"); where revenue or leads are tracked (the store, POS, booking tool or CRM from the business model) and whether it's connected.
- Meta: ad account ID and access confirmed; Facebook Page and Instagram; campaign structure (from the go-to-market strategy, not repeated here); audiences working and being tested; geographic targeting (zip codes, states or radius); creative live and in approval.
- Google (when Kaizen runs Google): account ID and access in our MCC; conversion tracking and attribution; keywords consolidated across campaigns (what we spend on and what wins); ad copy live and winning; the asset library with what's missing flagged (sitelinks, callouts, structured snippets, promotions, logos, images in every size); geographic targeting and bid adjustments; negative keywords; the URLs traffic goes to; Merchant Center (stores), Business Profile and YouTube linked; Performance Max and YouTube creative reviewed.
"Not shared yet" wherever setup is incomplete, so the gap is visible.

**10. What works: proven** (grows over time)
Only what held: profitable against the target over a real window, repeated. Date · learning · applies to · evidence dates. Then a short "Tested and didn't work" list. No raw metrics, no hypotheses.

**11. Open questions**: one bullet per question, exactly "- [offer|creative|media|business] Question {options: A | B | C}{multi}" ({options: …} only when there are natural choices; {multi} when several can be picked). Few and easy to answer: the client answers first; offer questions go to the media buyer if they can't, creative to the head of creative, media questions to the media buyer. Then the tests the creative will answer (not questions).
**12. Sources**: everything used, with dates read, linked; and what couldn't be read.
**Change log**: date · version · what changed · trigger · needs client confirmation (Y/N).

Quality bar: Read this first fits one page; targets explicit; foundational rules broad and factual; every section sourced, dated and linked; tailored to the business model; 3–5 profiles with 2+ sources and a confidence; a pain to angle matrix with proven vs to-test; claims split three ways; a review bank of 15+ that's claim-checked; competitors researched with links, praise and complaints; an offer section (or offers recommended); nothing point-in-time outside dated sections; no ad metrics outside the targets and benchmarks.$body$,
    updated_at = now()
where id = 'c68469f0-5799-4a39-aed6-134ee1c7f1ff';

update public.ai_knowledge
set body = $body$The Brand Bible is client-facing: published to the client's Drive, reviewed by the Head of Creative, then sent (the client sees the short presentation; the full Bible is a click away). Every line readable by the client: professional, factual, respectful. No internal opinions, relationship commentary or raw ad metrics; goals, targets, budget and benchmarks are allowed in section 1 and the media-buyer section, plain-language proven learnings in section 10. Leave out agreement terms, contract dates, a document owner or any named contact (Kaizen has no account managers); anything sensitive stays out (tell the team). Never a password: third-party logins live in the password manager.
It is the single source of truth for audiences, angles and brand facts; where another tool or note disagrees, flag it, don't silently pick.
SOURCES every client has (intake, sales call, website, reviews, socials, web research) are the backbone; what Kaizen holds (Slack, email, Drive, calls, past creative and the client's feedback on it) sharpens it. Internal calls often hold rules the client never wrote down; they outrank the website. A change agreed in a call, email or Slack (a service cut, a new target) updates the Bible with its date.
FOUR PASSES: 1) intake, sales call, goals, scope, budget, platforms; 2) client communication, brand files, an asset scan, every client statement about AI content; 3) market: website, reviews from the sources their kind of business uses, competitors (USP, praise, complaints, ad comments), press, benchmarks, regulation, a 12-month moments calendar; 4) audience profiles, offers, funnels, the media-buyer section, a shoot list from asset gaps, then the full Bible.
Every fact carries a source and date; quote clients and customers verbatim; when sources disagree, state both and add an open question.
WHAT GOES IN AND WHAT DOESN'T: rule one, if it isn't profitable it isn't working. Into the Bible: facts of the brand, the client's standing rules (from the dos-and-don'ts log: said about three times, or once sternly; lifted when they open the door), and results proven again and again in the go-to-market logs. Never: one comment as a rule, a single test, a good week, our own hypotheses (those go to the next brief and the go-to-market strategy, which test them).
STATUS: Draft > Reviewed by Kaizen > Sent > Client-approved (contact and date); never send before the Head of Creative's review. Updates bump the minor version with a change-log line; changes to sections 1-8 are marked 'needs client confirmation'. Re-scan assets when the client uploads footage. At offboarding the Bible and its change log are exported with the account's story, so a returning client picks up where we left off.$body$,
    updated_at = now()
where id = '9f779344-3b35-48fa-a022-0c76bd7811f3';

-- The four skills the Bible's sections call on
insert into public.ai_knowledge (agent_key, kind, title, body, active)
select 'brandbible', 'skill', t.title, t.body, true
from (values
  ('Identifying the unique selling proposition', $s$The USP is where most winning angles come from: dig it out the way a strategist would after hours of calls, not the line on the homepage.
1. Collect every claim of difference from the client's own words first (calls, intake, emails), then the site, reviews and press.
2. For each, ask how it actually works: where the product or service comes from (who, where, when in the season), how it's made, prepared, cut, cooked, built or delivered, how long it takes, who does it and how long they've done it (generations, certifications, awards), what it costs them that competitors won't pay.
3. Test it against the competitor overview: is it true of them too? Keep only what's actually different, or what they do and never say.
4. Write it as a chain a copywriter can split into hooks: "a fourth-generation wholesaler (heritage) that hand-selects whole fish by region and season (sourcing), breaks them down and seals each fillet in its own facility (process) and ships to your door within three days (delivery)". Each link is its own angle.
5. Add the business's model to it: for a store the product and delivery promise, for a restaurant the kitchen and the experience, for a bookings business the practitioner and the result, for a local service the crew, guarantee and speed, for lead gen the method and the proof.
6. Note the nuggets that change the economics or the story (a more profitable region, the highest-margin line), with the source.
Never invent a difference; when nothing is truly unique, say so and name the strongest "only we say it" claim.$s$),
  ('Identifying customer avatars', $s$Avatars are the backbone of every brief: 3 to 5, sharp, each with evidence.
1. Three lenses: who buys today (customer data, the client's description, reviews), who responds to ads (ad data, only from profitable results; with no ad data this lens is empty and says so) and who the client wants. Where they disagree is the key finding.
2. Build each from at least two sources, in this order of weight: customer data, reviews, calls and intake, client comms, competitor targeting, inference.
3. Make each specific to the business model and sub-vertical: the store's buyer and the gift buyer, the restaurant's regular, the family and the event planner, the bookings client and the first-timer, the homeowner with an emergency and the one planning a project, the B2B decision-maker and the researcher.
4. Per avatar: who they are, a day in their life, what they want and what hurts in their words, the objection and our answer, awareness level, triggers, where they are, 3 to 5 angles with a hook each, visual cues, what never to show them.
5. Confidence: Proven (profitable data), Likely (strong evidence), Hypothesis (to test). Never call an avatar proven from an account that wasn't profitable.$s$),
  ('Developing the offer', $s$The offer is the biggest lever a business owner can pull: nothing changes a company's trajectory like it. Every Bible has an offer section.
1. Find what exists: the front-facing offer for new customers, the sign-up (pop-up) offer for email or SMS, offers on the site, in emails and in past campaigns, and offers the client won't run (and why).
2. Judge past offers by their own campaign's profitability: each offer runs in its own campaign, so that campaign's result is the offer's Win or Loss. No numbers needed in the Bible, just the verdict and what it taught.
3. When there's no offer, or it's weak, recommend 2 to 3 that fit the business model and the margins (a store: first-order discount, free shipping threshold, bundle, gift with purchase, subscription savings; a restaurant: first online order, a free item, events, gift cards, catering packages; a bookings business: intro visit, new-client package, membership; a local service: free estimate or inspection, financing, a guarantee, seasonal pricing; lead gen: free consultation, audit, guide or webinar). Show the math against average order value or job value and the break-even cost per customer.
4. Keep pushing: until an offer is agreed, it stays an open [offer] question for the client, and the media buyer recommends.
5. Never invent a discount, price or guarantee in creative: an offer is only live once the client confirms it.$s$),
  ('Competitor overview', $s$The competitor overview is where the hooks come from.
1. Pick 4 to 6 direct competitors in the same market (and the same area for local businesses), the ones the client named first.
2. For each, from their own site: their USP, mission and vision, positioning, price, offer, key claims, look and tone, with links (site, landing page, socials, Meta Ad Library).
3. Reviews: their positive reviews (what people love, which our client must match or beat) and their negative reviews word for word (the complaints are our callouts and hooks).
4. Their ads: what's running and for how long (longest-running first means it works), the promise and angle, and the comments under them, praise and complaints.
5. Then compare: how our client's USP holds against theirs, where everyone sounds the same, and the white space our client can own.
Only what traces to a source; say what couldn't be read.$s$)
) as t(title, body)
where not exists (select 1 from public.ai_knowledge k where k.agent_key = 'brandbible' and k.title = t.title);

-- What goes into a Bible and what goes into a brief, for every agent
insert into public.ai_knowledge (agent_key, kind, title, body, active)
select null, 'knowledge', 'Brand Bible, go-to-market and briefs: what goes where', $s$Rule one: if it isn't profitable, it isn't working. A few first results or a good week are a direction, not proof.
Each client has one Brand Bible (the foundation, reviewed once and stored), and a Meta and a Google go-to-market strategy built from it. The strategies are executed and logged; only what the logs prove again and again (profitable and consistent, or failing again and again) goes back into the Bible.
A hypothesis ("a protein angle for 25 to 35 year olds will crush") never goes into the Bible: it goes into the next creative brief, the media buyers run it, and only proof goes back. A client's standing rule ("never use AI images of our food") does go in, as a do or don't, once they've said it about three times or sternly; it comes out when they open the door.
Briefs read the Bible's top first: keep that top broad (mission, vision, values, tone, look), so a narrow rule never blocks a new test the client wants.$s$, true
where not exists (select 1 from public.ai_knowledge k where k.agent_key is null and k.title = 'Brand Bible, go-to-market and briefs: what goes where');
