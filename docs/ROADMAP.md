# Kaizen Ads: Roadmap

Where things stand on 2026-10-31 and what comes next, in order. The target is the full request → approval → launch loop live before Black Friday / Cyber Monday. See VISION.md for every decision behind it.

## Built

- **Request intake**: multistep request form with AI suggestions and an AI review. It checks allotment and creative package (including sprints), and each format becomes its own ticket on the **Board**.
- **Deliverables**: resumable uploads, versions, file viewer on each ticket.
- **Clients**: every client in one view; client page with AI briefing, memory, angles, team, contacts, package and connections.
- **Context sync**: Slack (internal and client channels), every inbox, the Drive client folders and Meta, on a schedule. Briefings at 12pm and 6pm.
- **KPI dashboard**: Meta targets, moving averages, MoM/QoQ, budget pacing, auto-linking of shared ad accounts.
- **Settings**: AI agents as cards with a coach chat that edits their playbooks, raw data inspector, sync health. Playbooks imported from Kaizen's Claude projects.
- **Video script writer** on video tickets, and the **Brand Bible builder** (web research) on every client page.
- **Internal review**: comments pinned to a spot on an image or a moment in a video, per version; the Head of Creative approves or sends back; comments can be saved to client memory.
- **Production QA**: nothing moves past production without a creative; tickets move only with the buttons in the ticket. On upload, the AI checks sizes and new vs variation against the ticket's counts (and the allotment). Before sending to review, the maker runs the **AI creative review** (real progress, notes per design and size), fixes and replaces, or sends anyway, which leads see.
- **Copy**: approving creative has the Copywriter draft Kaizen's set (3 short + 2 long) to the approved creative, with real progress; the copywriter is assigned when it's ready. The **copy studio** has the creative, live counts (heads-ups, not gates), a feed preview and a chat with the Copywriter that can rewrite the set. Approval is blocked only by missing copy or anything against what the client told us. Edits and chat rules become client memory.
- **Client portal** (built, off for every client): swipe right to approve, left for changes (design: pins on the image or comments on the video timeline; copy: notes, amended not rewritten). Design changes go back to the maker, and the AI check confirms each ask; copy goes to the AI then copy review. Revised ads come back tagged with "you asked / we changed". Shows what's running in their ad account. Lessons from client notes go to client memory. Contacts can't sign in until an exec switches the client live; no client notifications exist yet.
- **Industries and winners**: the AI sorts every client into an industry (the team can override). The **Winners library** lists every ad beating its own account's usual cost per result, filterable by industry, and starts a request from any of them; the request form and every agent see what's working for similar clients.
- **Verticals, Hall of Fame and playbooks** (Ideas): the AI works out verticals and sub-verticals from every client page and researches Meta benchmarks for each. The **Hall of Fame** keeps our ads that ran 30+ days and beat their KPI target (or the sub-vertical benchmark) for six months, creative saved. Each sub-vertical has a **playbook**: avatars (from the go-to-market strategies), the angles that land with each, and the Hall of Fame and market ads (live 30+ days) that prove them. It feeds onboarding first rounds, the strategist and GTM builds, and has a name-free share link for sales.
- **Suggested briefs on Home** (execs and leads): the Strategist reads every account (ads tiring, KPIs off, behind on the month's creative, a new offer in Slack with no request, a client who isn't happy, angles not landing) and writes a full brief with concepts. Approve (tickets go to the makers), edit in place, decline with a reason (it reads every reason next time), or talk it through and it rewrites. Weekdays at 8:30am, or "Look again".
- **KPIs on the client page and in every agent**: each client page opens with performance vs target (14-day value against the target, 7 and 30 days, vs last month, trend, daily spend and results, budget pacing). Every agent that reads a client (request suggestions and review, copy, creative review, scripts, briefings, the Strategist) gets the same KPI picture, so a brief for an off-target account knows it.
- **Fatigue watcher**: after every Meta sync, each ad still spending is compared with its own last three weeks (click-through, cost per result, frequency, video hook rate), with the account's own move taken out. Tiring and tired ads show on Home (a buyer's own clients; every client for execs and leads) and on the client page, with a 4-week trend. "Brief a refresh" has the Strategist write a refresh that keeps what worked and changes what's tired; approving it marks the ad as being refreshed with its tickets. Dismissing asks why, and the ad returns only if it gets worse. Every agent sees the tiring ads for the client.
- **Balanced suggestions**: the Strategist weighs what's already in motion. Clients full of open work drop back, clients nobody has touched in weeks move up, and a stretched design or video team gets fewer, smaller suggestions.
- **Clients in step with Kaizen**: enrollment, upsell, marketing intake and offboarding Zaps, plus an hourly mirror of Kaizen Track (archived, restored, new, packages). See docs/ZAPIER.md.
- **Archive**: execs and leads archive a client whole (tickets, files, copy, memory, briefings stay inside); it leaves the board, Home, lists, syncs and the AI. Restore, or re-enrolling, brings it all back.
- **Onboarding**: the marketing intake form is read by the AI into every agent's view of the client (and sets the industry). The Strategist writes the first round from the intake and the winning ads in the same industry. Execs and leads see new and returning clients in a red Onboarding callout at the top of Home (enrolled → intake → first round → production).
- **Ads Lab** (execs and leads): a round table with five AI seats (strategist, copywriter, creative director, media buyer, analyst) that reads a library of notes, docs, call transcripts, YouTube videos, links and skills, plus the winners and every past test. It proposes tests and flags ones already run. A started test takes a 14-day baseline per client and reaches each client as a suggested brief on Home. Results are read from the KPI tracker; a win is deployed as a learning into the memory of every client it fits (with the effect tracked since), and a flop goes back to the table to iterate.

- **Calls**: Gemini notes and Fireflies are read per client (internal meetings too), paid ads and creative only. Each client's summary, what they said and what was decided joins their context. Promises are watched: if nothing is in motion two business days later, a brief from the call lands on Home, and the request form offers it ready to send. Any request that covers a promise clears it.
- **Go-to-market strategy**: Kaizen's Meta GTM template, built at onboarding once the intake form, call notes and website are in. Sourced, quality-gated, on the client page; every agent reads it, and the full Brand Bible.
- **Market (Motion)**: live Meta ads by industry from each client's tracked competitors, the competitors they named and standout advertisers, marked proven, new or being tested. Brief a client on one with the Motion link in the references; the client page, the request form and the Strategist use it too.
- **Refresh briefs written ahead** for every ad wearing out.
- **Errors and updates**: errors are grouped, triaged (harmless ones closed automatically), diagnosed and emailed with Mark fixed / Stop alerting / Have Claude fix it; Settings has an Errors tab. Open tabs get a refresh bar when a new version is live.
- **Archive, complete**: archiving sets aside everything tied to the client (KPI targets, briefs, promises, watch list, syncs, the Lab, intake) and is logged; the archive log on Clients shows who, when, why and what, and restoring brings it back.
- **Six role agents** (strategist, creative director, copywriter, media buyer, analyst, operator) with skills, on one locked strategy spine; the Ads Lab never creates agents.
- **Account audits and optimization sprints** on the KPI board: a real audit (found / do / watch), a client PDF in our voice, trackable moves the AI checks daily, lessons into client memory and shared only with truly similar accounts.
- **Account Overview sheet** as the source of truth for buyer, budget and KPI target (12pm and 5pm), plus the Onboarding tab's setup checklist and each client's Creative Database as a cross-check.
- **Asana mirror**: the Creative board as outline cards every 5 minutes, migrate any task into Kaizen Ads at its stage, Asana work counted in allotments in the month it's made, Asana tasks clearing call promises.
- **Docs across the Workspace**: new and edited Docs and Slides read for the client they're about; every team's calls kept as client context.
- **Handoffs**: a buyer change moves the work and writes the new buyer a handoff with a chat (waits until they've joined).
- **Overview as topics** and the **daily recap** for everyone (most critical first, jump to a topic, save for later, "taken care of by a teammate").
- **Team notifications**: bell, critical pop-ups, email, recap reminders, per-person settings. Boards scoped to each person's clients.
- **Google Ads on the KPI board**: Google accounts next to Meta, each campaign judged on its own result, campaigns left out, card metric switcher, hover readings on every chart. KPI numbers pulled every 30 minutes in business hours, hourly otherwise.
- **Each team sees its own line**: the Head of Meta and Meta buyers see Meta, the Head of Google and Google buyers see Google (buyers only their own accounts); only execs see both. KPI board, Clients, Overview, daily recap and Reports.
- **Reports in three parts**: Build a report, Ready to send (by platform and buyer, tagged Monday weekly, monthly recap or built by hand), Sent. Monday drafts replace last week's; the month's first Monday drafts the full monthly recap instead. A draft already waiting for a client is offered before building another. Heads see whether each buyer has opened their report. Slack must be connected to use reporting.
- **Ideas for Google**: a Meta and a Google side. Google Hall of Fame and Live winners (search ads, keywords, search terms that beat their target, brand searches set aside) with the AI's read of why each wins and how to use it on another client.
- **Clients page**: tabs by service line plus Paused; missing Slack and Drive connections filled in from the card; services added on the spot; Pause and Archive from the card; seats follow the allotment (no designer for video-only).
- **Launcher**: approved ads pushed to Meta paused through the system user, into existing or cloned ad sets, with naming learned per account.
- **Onboarding, steps 1 and 2**: on enrollment the client's whole email history (sales emails included) and their calls from before they signed are filed to them; Gmail and Slack follow every active client. The Brand Bible starts once the intake form is in (or after 4 business days without it, said so plainly). The client presentation (the short Bible) is approved by the buyer or a lead, or goes out on its own after 24 hours, and the client reacts part by part in their portal.
- **Onboarding, steps 3 to 5**: the client talks the presentation through in their portal (text, files, voice messages; customer list kept private); approving folds it into the Bible, tells the team and writes the first round; the 48-hour launch runs their own best posts as a paused engagement campaign with the checklist checked, turned on by the buyer, and the client is told it's live.
- **Report preview is the PDF itself**, every line the buyer wrote editable on the page; tiles, key metrics, campaign columns and lines changed or added by clicking them, remembered as the client's layout. **Client IDs** on client cards and the KPI board, filled from the Account Overview sheet.
- **Reports as stories**: trend charts (any metric, by week or month) each with what we see, why and what's next, numbers from the ad account; back to editing after approving; a buyer can send their part without waiting on the other.
- **Client dashboard in the portal**: every account together, then Meta or Google; any dates; tiles, the day-by-day against the period before, budget split, campaigns, best ads; questions about the numbers, worries flagged to the buyer. Reports link to it.
- **Onboarding guide in the portal**: access, Google Ads ID, assets, the look; sent at enrollment.

## Now: open items (feedback from Kyle and earlier sessions)

### Monday, Nov 23 2026
- **Owner's updates through the assistant go all the way through, database changes included.** Feedback sent through the assistant becomes a Claude fix that merges itself, but any fix with a database change fails at merge: the `SUPABASE_DB_URL` repository secret was never set (#113 was merged by hand on Nov 22 for this reason). The owner adds the secret (Supabase → Connect → Session pooler string, port 5432, with the database password → GitHub → Settings → Secrets and variables → Actions → `SUPABASE_DB_URL`). Then run the daily Checks and one Claude fix that carries a migration to confirm both reach the database, so an update sent through the assistant lands exactly as one sent from a Claude Code session.

### Tuesday, Nov 24 2026
- **Everyone's own Asana in Kaizen OS.** "Next for me in Asana" must mirror each person's Asana My tasks (private tasks too), which needs each person to connect their own Asana; the code is live (ed74712f: Connect card, per-person sign-in, writes as them) but waits on the Asana app. The owner creates it: app.asana.com/0/my-apps, Create new app "Kaizen OS", OAuth redirect URL `https://app.kaizenmarketing.agency/api/asana/callback`, then adds `ASANA_CLIENT_ID` and `ASANA_CLIENT_SECRET` to Vercel (Production) and redeploys. Then the owner connects first to confirm his My tasks appear (private ones included) and a change from Kaizen OS lands in Asana as him, and the team is told to tap Connect Asana on their Overview.

### Owner setup to do (added Nov 24 2026)
- **Phone alerts: connect Twilio** (code live and dormant, 0ae568c4; full steps in `docs/PHONE-NOTIFICATIONS.md`).
  1. Sign up at twilio.com with Kaizen's business details and upgrade with billing (a trial only calls verified numbers).
  2. Phone Numbers › Buy a number: US local, Voice + SMS (~$1.15/mo). Nothing to configure on it.
  3. Trust Hub: create the business Customer Profile, register SHAKEN/STIR Trusted Calling + Voice Integrity, and Branded Calls / CNAM as "Kaizen OS" (so calls don't show "Spam Likely").
  4. Texts (only for the "press 1 for the link" text): Messaging › Regulatory compliance › A2P 10DLC: register the Brand (Standard, needs the EIN) and a Campaign ("Account notifications"; opt-in: "employees opt in themselves in Kaizen OS Settings with a consent checkbox"). Approval takes days to weeks; calls work meanwhile.
  5. Voice (and Messaging) › Geo permissions: allow every country where a teammate's phone is.
  6. Vercel › kaizen-ads › Environment Variables (Production): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Sensitive; never pasted in a chat), `TWILIO_FROM_NUMBER` (+1…), then redeploy. If the Auth Token is ever rotated, update Vercel the same day.
  7. Test: Settings › Phone alerts → your number, consent, switch on, Test call; it shows in Settings › Calls & usage. Then tell the team they can opt in.
- **Shopify app: finish the App Store review.** Submitted Nov 24. Watch for Shopify's emails; after the Nov 24 review fixes (kaizen-os-4: embedded, scopes trimmed to orders/all orders/customers), update the listing's testing instructions (scopes line and "opens inside Shopify admin"), set capabilities to **Embedded**, pricing to **Free to install** with Shopify App Pricing off, and add the screencast (install on Kaizen Testing → approve → the app opens in admin connected). Once approved, connect the Shopify clients from Settings › Connections › Client stores. App config lives in `E:\Projects\Projects\kaizen-shopify-app\shopify.app.toml` (deploy with `npx.cmd @shopify/cli@latest app deploy`).
- **Google Workspace (Gmail, Drive, Calendar) usage tiers and MCP requirement.** Google's Nov 24 email: Standard (free, rate-limited) vs Scaled tiers; AI agents must use Workspace MCP servers by Feb 1 2027; Scaled billing from Apr 1 2027. Code is live behind `WORKSPACE_MCP` (351722b3, ab0ad8b2; details in `docs/WORKSPACE-MCP.md`). Steps: (1) Cloud Shell: `gcloud services enable gmailmcp.googleapis.com drivemcp.googleapis.com calendarmcp.googleapis.com docsmcp.googleapis.com sheetsmcp.googleapis.com slidesmcp.googleapis.com --project=atomic-athlete-510921-h2`; (2) join the Workspace Developer Preview Program if Google asks; (3) Admin console › Security › API controls › Domain-wide delegation: the service account has `gmail.compose` and `calendar.readonly`, and allow any new "MCP / AI tools" control; (4) as an exec open `/api/workspace-mcp/check` (each server `ok: true`); (5) Vercel `WORKSPACE_MCP=on`, then `only` after a few clean days (agent REST code removed before Feb 1 2027). Usage estimate ~500–1,000 agent requests/day per product vs the free 5,000/day Standard cap: stay on Standard.
- **SerpApi for Google ad intel (sales strategies).** Code is live and dormant (`googleAdIntel` in `src/lib/sales-intel.ts`, eefa0da5): every go-to-market strategy reads each prospect's and competitor's Google ads from the Ads Transparency Center (US, by domain, else name); until the key is set the PDF and notes say "Google: not checked". Steps: (1) sign up at serpapi.com and pick a plan (each strategy uses ~5–6 searches: the prospect plus 3–5 competitors); (2) copy the API key from the dashboard; (3) Vercel › kaizen-ads › Environment Variables (Production): `SERPAPI_KEY` (Sensitive, never pasted in a chat), then redeploy; (4) tell Claude so both sample strategies are rebuilt with Google ads included. The same key also unlocks competitors' Google ad copy for Google In the market (item 10).
- **Meta Ad Library API access (ad history in sales strategies).** Meta refuses our app's `ads_archive` calls (code 10), so strategies only see live ads (via Motion), no history or inactive ads. The Meta developer app's owner confirms their ID at facebook.com/ID and accepts the Ad Library API terms for the app; no code change needed.
- **"Jake H." YouTube channel:** confirm which creator was meant on the Nov 24 call (closest match: Jake Setterlun) so the agents subscribe to the right one.

### Client portal
18. **The portal as the client's home**, not only creative approvals: the dashboard, reports, setup and creative in one experience, designed for the wow factor (in progress).

### Client page: one dashboard for the whole business (MER)
3. **Shopify in Kaizen Ads** (likely as a Shopify app the client installs): orders, revenue, customers.
4. **Our own attribution**: Shopify sales matched to Meta and Google through the UTM parameters on every ad, clearer than Shopify's or Meta's own view.
5. **The business dashboard** on the client page: total spend, total revenue, MER, impressions; revenue and ROAS goals; average order value, customer lifetime value, returning-customer rate, win-back rate.
6. **What moved the business**: changes in Meta, Google and email campaigns marked on the timeline with their effect on the whole business, and incrementality (lift) reads.
7. **Projections**: financial forecasts from the same numbers.

### Ideas for Google (next steps)
8. **Deploy an idea to a client.** Google buyers and the Head of Google turn an idea into an action item on a client: copy around it, a campaign around it, or the keywords to add. Meta roles keep the brief flow. Execs choose Meta or Google first on the same hover.
9. **Google Verticals**: a Google playbook per industry from the Hall of Fame (the intents, copy and structure that won).
10. **Google In the market**: built, waiting on Google. OAuth brand verification on the Cloud project (home page and privacy policy on kaizenmarketing.agency, domain verified in Search Console), then apply for **Basic access** to the Google Ads API to unlock Keyword Planner. Auction Insights needs Google to allowlist us (GOOGLE_ADS_AUCTION_INSIGHTS=1 once it does). Competitors' actual ad copy would need a paid service (SerpApi recommended over ScraperAPI).

### Smaller items
11. **Mobile pass on Settings › AI agents and skills**, so execs can work on agents and skills from their phones.
12. **"Also buys" on the Team page**: today it's set in the database (Kyle has it); a switch on each person.
13. **KPI board for creative, customer success and copy**: decide whether they see one platform, both (limited to their clients, as now), or none.
14. **"Missing someone"** as a filter on the Clients page, if still wanted (the card still shows "N to fill").

## Next: close the approval loop (Phase 1, before BFCM)

1. ~~Client portal~~ and ~~revisions loop~~: built (see above); each client goes live when an exec switches them on.
2. ~~Notifications and chasing~~: built, off for every client. Creative reaching "With client" gets one short post in the client's Slack channel and an email to their portal contacts (one per batch, at most once a day, with the portal link), a reminder at 24 business hours and another at 48 (1 and 2 business days on the business clock), and at 48 the ticket goes to customer success's Waiting on the client list (the execs when nobody holds the seat) with a notification. Clients who opted into auto-approval have it approved for them at 48 instead, with a note to them and the team. Every notice is logged once per ticket and round and shows on the ticket's timeline and the client's Team & setup. It reaches a client only with their portal live, the client outreach hold lifted and their own Client notifications switch on (an exec's). White label clients' messages never name Kaizen.

## Then: launch and learn (Phase 2)

4. ~~Launcher~~: built (see Built).
7. ~~Google Ads~~: on the KPI board, in reports, audits and Ideas (see Built). Basic API access still to apply for (see Now, item 10).
8. ~~Alerts~~: covered by team notifications and the daily recap.

## Later (Phase 3)

- **Client-side requests and upgrades** in the portal, counted against the allotment.
- **Built-in timer** that logs to Kaizen Track without double counting.
- **PDF knowledge** in Settings (only text files today), and per-client knowledge for the agents.
- **Agent evals**: replay recent requests against a changed prompt or model before saving, to see what would differ.
- **TikTok, organic social, white-label portal**, and the move into Kaizen OS.

## Head media buyer's review (Nov 4): open items

All built.

1. ~~**"Why?" on every audit item**~~: built. Ask the agent that wrote an audit action, cause or sprint move why, answered from the numbers that audit read (src/app/(team)/kpis/why-actions.ts, src/lib/audit-why.ts).
2. ~~**Loom audits into the Media Buyer's knowledge**~~: built. Looms from Slack links, /api/loom, bulk paste and Atlassian's MCP server, distilled into media-buying insights by platform and industry (src/lib/buying-insights.ts).
3. ~~**Request flow fixes**~~: built. Similar clients match on what the business sells, thumbnails that never break, a star to save any brief for later.
4. ~~**Creative suggestions in the audit**~~: built. "Creative I'd make" on every audit, from the creative analysis, the playbook, our Hall of Fame and the Brand Bible, each opening its quick preview.
5. ~~**Open in Ads Manager on every in-platform action**~~: built. Every audit action, sprint move and planned change that names a Meta campaign, ad set or ad links to that exact object in Ads Manager (selected_campaign_ids / selected_adset_ids / selected_ad_ids), and Google ones to the campaign or ad group in Google Ads; audits and sprint moves from before Nov 5 are linked by the names in their text.
6. ~~**Numbers that match Ads Manager**~~: built. The $598 per purchase (Ads Manager: $299, Oct 28 to Nov 3) was a part day's spend counted over a week whose late purchase hadn't been read yet; windows are complete days ending yesterday, the last 8 days are read again on every sync, one purchase type is counted (never its aliases added together), every read asks for 7-day click, 1-day view, and purchases are booked on the impression's day as Ads Manager does.
7. ~~**Hook rate, hold rate and watch time on the KPI card's ads**~~: built. "Ads this week" is a sortable table (spend, result, cost per result or ROAS, CTR, hook rate, hold rate, watched), a card per ad on phones. See-more rate stays n/a: Meta doesn't report taps on "See more".

## Lead video editor's review (Nov 10): open items

Briefs are created in Kaizen Ads for every client from now on (ticket fulfilment stays in Asana until the board is ready), and the lead video editor compares three versions for one client: the talk-it-through brief as written, the same brief after his corrections, and his own brief from before Kaizen Ads.

1. ~~**Fewer steps to a brief**~~: built. a brief written by the AI (talk it through, suggested, in the market) goes straight to Ready to send and sends without a second review; questions asked inside the chat, not in a side panel; facts only the client knows never block a brief or a ticket (the maker confirms them once they have the ticket); no padding or scroll jumps in Ready to send; suggested briefs load fast.
2. ~~**Briefs with the creative thinking in them**~~: built. never promise a reveal, hack or tip without saying what it is; every asset named with its Drive link and only when it fits the angle; talk it through shows live market ads (Motion) from the client's own industry; images, videos, audio and web files can be added to the chat.
3. ~~**Uploads filed in the right Drive folder**~~: built, and every client's Ad Creatives folder fills itself in from the onboarding Drive folder. the client's Ad Creatives folder by year and month, not a folder of its own.
4. ~~**The ticket, redesigned by stage**~~: built. today it's one long scroll with everything at once. Each stage shows what that stage needs first (Requested: the brief and assets; In production: the brief, specs and upload; Internal review: the creative and comments; Copy: the copy studio; With client: what the client said; Ready to launch: the launch card), everything else one tap away, the same layout on phones.
5. **Connectors in Kaizen AI by role**: the MCP connectors the creative team uses in Claude (ElevenLabs sound effects first) built into Kaizen AI and switched on by role (video editors, designers); the lead video editor is sending the list.
6. ~~**AI and likeness rules**~~: built. altering a real person's voice or face (AI avatars from customer testimonials) needs the client's written consent and a disclaimer; clients who reject AI content (client memory) never get an AI avatar or voice suggested.

## Client portal and marketing intake (added Nov 12 2026)

1. **Client portal, fully developed**: the portal as the client's one home for Kaizen. Today it has creative approvals, the dashboard, the onboarding guide and the presentation chat, all off until an exec switches a client live. To finish: every service the client has in one place (paid ads, email, organic social, creative), reports and the weekly report, requests and upgrades counted against the allotment, messages with their team, files and brand assets, invoices and package, a polished mobile app feel, white-label versions, and switching the first clients live.
2. **Marketing intake form in Kaizen Ads**: the intake built into the app and the portal instead of the outside form that reaches us through Zapier today. Multistep and mobile first, prefilled from what we already know (sales calls, emails, website), saves as they go, asks only what's missing for their services, files and links to Drive, and on submit feeds the Brand Bible, the agents and onboarding exactly as the current intake does. The team sees who hasn't finished it and the portal nudges them.

## Monthly reports as one team send (later; the ops are still moving over)

The monthly report is gathered from every team (paid ads, email, organic social, creative) and goes to the client as one email, kicked off by customer success once ALL of that client's reports are done. Built so far (Nov 13 2026): every report kind in the buyer's design, Download PDF, and Save to Drive (with the write-up, in the client's 30 - Reports / year / month folder). Next, when the new ops are in place:

1. **A monthly round per client**: each service's report for the month listed with its owner and status (drafting, ready, approved), and who is still missing.
2. **Customer success sends once**: when every part is approved, CS reviews one combined email (each team's summary and its PDF, or one combined PDF), edits it and sends it to the client's contacts; nothing goes out automatically, and white label clients' sends never name Kaizen.
3. **Chasing**: a gentle nudge to the owners still drafting as the send date nears, and the round shows on CS's Home.
4. **Saved for the record**: the sent PDFs filed to the client's Drive month folder and on the client's Reports history.

## Email team in Kaizen Ads (Klaviyo, read and write)

Klaviyo is connected per client and read today (campaigns, flows, lists, daily email revenue). Keys are created with Full Access from Nov 12 2026, so the same keys cover writing later. Next, for the email team:

1. **Email briefs and tickets** on the Board, like creative: an email brief (goal, audience segment, offer, send date), the copywriter drafting subject lines, preview text and body, review and client approval in the portal.
2. **Design emails in Kaizen Ads**: build from the client's Klaviyo templates and Brand Bible, preview desktop and mobile, then push the template to Klaviyo.
3. **Deploy to Klaviyo**: create the campaign (audience, schedule, A/B subject lines) as a draft for the email lead to confirm, never sent without a person's go-ahead; flows edited the same way.
4. **Email KPIs**: open, click, revenue per recipient and flow revenue against targets on the KPI board, audits for email accounts, and email in the weekly report.
5. **Full development of the client Email tab** (built so far, Nov 12 2026: tabs like Meta and Google, 90-day revenue, revenue per recipient and deliverability score charts with the scrub, campaigns with previews, flows, audience, deliverability, account health). Next: targets and status like the Meta and Google performance card (on target, getting there, off), flow-by-flow performance over time and the gaps in key flows, segment and list health, campaign calendar (sent and planned), A/B results, SMS as its own view, benchmarks against Kaizen's other email clients, and Act-on-this-first items that open the brief or ticket to fix them.
6. **Email agents, fully built** (Email Strategist, Email Creative and Email Builder, parked today with skill shells): write their cores and skills from the email team's playbooks (roles, not names), give them the Klaviyo context and tools (read today; drafts in Klaviyo once write is on), connect them to their moments in the app (email strategy and calendar, email briefs and copy, template design and build, account audits and the Email tab's findings), test each change against evals, then switch them on line by line. An email lead position so the email team trains its own agents, like the heads of Meta, Google and Creative.

## Every role, developed one at a time (added Nov 20 2026)

The owner's plan: go through **each type of role** in Kaizen OS and develop its view further, so the OS keeps fitting
each person's day better and better. One role per pass, with someone in that role walking through their day.
For each one:

- **Their Overview:** what they need first thing, what's on their plate, and what's about to land on them.
- **Their pages:** what they open, what they never need (taken out), and what's missing.
- **Their actions:** what they can do from the OS instead of another tool (Asana, Slack, Drive, the ad platforms).
- **Their assistant and Kaizen AI:** the tools and knowledge their role needs, and the words they use.
- **Their measures:** how they and their lead see that the work is going well (targets, never client-facing scores).

The roles, in no fixed order:

- **Executives**
- **Ads:** Head of Meta, Head of Google, Meta and Google media buyers
- **Creative:** Head of Creative, lead graphic designer, lead video editor, graphic designers, video editors, the copywriter
- **Email:** Head of Email, email strategists, email designers, email builders
- **Organic social:** Head of Organic Social, social media managers
- **Support:** Customer Success Coordinator, Onboarding Specialist, Tracking Specialist (added Nov 20 2026)

Where the support positions start (Nov 20 2026):

- **Overview:** Today only, with their own open Asana tasks (read live from all of Asana) and what's next.
- **Clients:** every client with its services broken down, like the execs, read only. No audits and no setup changes.
- **Reports:** the Customer Success Coordinator and the Onboarding Specialist only.
- **Shared tools:** Kaizen AI, the assistant (calls and chat) and Feedback, like everyone.
- **Never shown:** Boards, the KPI board, Ideas and the Ads Lab.
- **Teams:** they can be tagged onto any team (an Onboarding Specialist also on the social team can hold the social media manager seat).

## AI first rounds, then approval straight to launch (added Nov 20 2026, not built yet)

From the creative team's wishlist call. Two steps, in this order:

1. **AI first-round assets from approved briefs.** Once a brief is approved, the first round of designs (and, later, video cuts) is generated from it: the brief, the client's Brand Bible, their proven winners and assets. Designers move to QA (checking, fixing and finishing what the AI made) and to training it (their fixes become the lessons the next first round learns from).
2. **Client portal approval leads to auto-launch.** When the client approves a piece in the portal, it's launched into their ad accounts automatically (Meta and Google, the launcher's rules: existing or cloned ad sets, Kaizen naming), and the buyers review what went live instead of building it by hand.

## Sales agent (added Nov 24 2026)

Internal first (the executives and leads), front-facing later. Prices come only from the rate card (Settings › Rate card); proposals and SOWs are made by the document system and filed under Kaizen Sales › Prospects › <name> after the folder is confirmed.

**Phase 1, built (Nov 24 2026):** the **Sales** agent in the Rolodex (five skills: prospect research, prospect lists, pitch drafts, sales-call review, the sales desk; execs train it, execs and leads talk to it and call it); **web research** for execs and leads in the assistant, agent calls and Kaizen AI (`web_research`; Kaizen AI also searches the web natively); **prospect briefs** (what they sell, locations, positioning, site, offers, reviews, social, Meta Ad Library and Google Ads Transparency Center, email capture, gaps, fit score, and a Kaizen strategy: rate-card services, the angle, internal proof from similar clients, talking points); **prospect lists** from public sources scored by fit; **pitch drafts** (call script, email, LinkedIn note and message, sent by the person); **sales-call review** from a transcript, a Google Doc or an attached file; and **Sales › Prospects**, a light pipeline (new → researched → contacted → talking → proposal → won / lost, with owner, notes, drafts, reviews and documents). Won prospects link to the client once enrolled (Kaizen Track's enrollment starts onboarding) and their documents move to the client's Headquarters on a yes. LinkedIn is research and drafts only: nothing browses, scrapes, connects or sends there (its terms forbid automation and accounts get banned).

**Sales go-to-market engine (Nov 25 2026, built):** research now adds the market (area, income and demographics or the US-wide avatar, TAM, the competitors advertising in the public ad libraries with their funnel, messaging, offer and USP, search demand and CPCs, sourced WordStream/LocaliQ benchmarks, seasonality, email programs from public archives) and three tiers weighted by the kind of business; a go-to-market strategy PDF in the gold-standard structure (Kaizen's look, or a white-label partner's with zero Kaizen mentions and ad spend only) with internal talking notes that are never sent; the proposal follows the CEO's 11-slide structure and rules, with case studies from a stored table.

**Email competitive intel: the swipe bot (Nov 25 2026, built).** Public archives (Milled, MailCharts) only hold newsletters, so Kaizen follows the best brands itself and keeps every email as it arrives, flows included. One mailbox: the swipe@kaizenmarketing.agency alias (each brand signs up as swipe+<brand>@, so every email maps to its brand), read through the Workspace's domain-wide delegation; the app resolves which user the alias lives on and checks it doesn't auto-forward before anything is signed up. A browser runner (GitHub Actions, every three hours, .github/workflows/swipe.yml) signs each brand up, opens a link from its welcome email and browses products (browse abandon), adds to cart and leaves (cart abandon), and starts checkout with the email only where the store allows it (Shopify); it never buys, never solves a CAPTCHA (the brand goes to the email lead as "needs a human signup"), respects robots.txt and paces itself. Every email is stored with its flow type, offer, CTA and SMS ask (Haiku), its timing after the trigger, the HTML and a screenshot, grouped into flows with steps and cadence; brands silent 14 days after signup are flagged. Seeded with 28 top brands (ecommerce first, then local service verticals); every researched prospect and the competitors its research finds join automatically. Used through the assistant (swipe_flows, swipe_brands, swipe_add_brand, swipe_subscribed) and on the prospect page next to competitors.
- **Owner setup: done.** The swipe@ alias exists (Nov 25 2026).
- Post-purchase flows only come from a real order by a person; winback flows appear on their own after months of no purchase.

**Phase 2, outbound and inbound (not built):**
- **Outbound email sequences** to prospects from Kaizen's own Klaviyo account, to contacts with a lawful basis only (no bought lists; B2B contacts found publicly are emailed under CAN-SPAM with a working one-click unsubscribe, Kaizen's physical address, honest subject lines and suppression honoured across every sequence). Replies and unsubscribes write back to the prospect's stage.
- **Interest form** in the OS and the portal: a prospect's business info (name, site, location, services wanted, budget band, contact with consent) lands in the pipeline as a new prospect, researched automatically and assigned an owner.
- **Interested leads into a Kaizen Klaviyo list** (with the consent captured on the form), for nurture.

**Phase 3, voice outreach (not built; legal and compliance review first):** voicemail drops and AI cold calling need a compliance approach the owner signs off on before anything is built: TCPA consent rules for prerecorded and artificial (AI) voice calls, which the FCC treats as needing prior express (written, for marketing) consent, and ringless voicemail, which is treated as a call; the National Do Not Call Registry and Kaizen's own internal do-not-call list; state rules (mini-TCPAs such as Florida's and Oklahoma's, state DNC lists, registration and disclosure rules); permitted call-time windows in the recipient's time zone; and accurate, callable caller ID (no spoofing, STIR/SHAKEN). Nothing gets built here until that sign-off.

**Phase 4, front-facing (not built):** the Sales agent on Kaizen's website: a chat that answers questions about Kaizen's services from the rate card and case studies (no client names), qualifies the visitor, books a call on the team's calendar, and creates the prospect in the pipeline with the conversation attached.

## Attribution and dashboards by business model (added Nov 24 2026, from the exec call; not built yet)

**Unified attribution view, per client.** One place that puts every source of truth side by side for the same days: Meta and Google (and TikTok) as each platform reports itself, GA4 (sessions, conversions and revenue by source/medium and campaign), and the store or CRM (Shopify orders and revenue; GoHighLevel/HubSpot leads and closed deals). It shows where they agree and where they don't: platforms over-claiming against the store, two platforms counting the same orders, GA4's last click against the platforms' view-through, and the gap that's untracked. Never adds platform conversions together (the store or CRM is the total when connected). Builds on what's live: the tracking watchdogs (platform vs store, conversion rate drops, audit tracking findings), store orders through Klaviyo, and the Tracking Engineer agent. Needs a GA4 connection (Data API, read only) and the Shopify and CRM connections live per client.

**Dashboards by business model.** The client page and reports open on the dashboard that fits how the client makes money:
- **Lead generation:** spend, leads (by source and form), cost per lead, booked and closed deals and their value from the CRM, close rate and cost per closed deal, and the GoHighLevel pipeline by stage (new, contacted, booked, showed, won/lost) with where leads stall. Leads with no CRM follow-up surface as an item.
- **E-commerce:** spend, revenue (the store's), ROAS and blended MER, new vs returning customers, AOV, and the funnel with its drop-off (sessions → product views → add to cart → checkout → purchase, from GA4 and the pixel), with the biggest leak called out.
A client's business model (already known per client) picks the default; either can be opened.

## Asana to Kaizen OS: delegation moves fully into the OS (added Nov 24 2026, exec call decision)

Aligned on the Nov 24 exec call: once delegation in Kaizen OS is validated, it moves out of Asana entirely. Until then
Asana stays the place work is assigned, and Kaizen OS mirrors it both ways (the Asana bridge).

1. **Export the delegation rules (first step).** Write down, in Kaizen OS, every rule Asana delegation runs on today:
   which project and section a request lands in, who it's assigned to by line and role, due-date conventions, the
   templates and custom fields (client ID, priority, sizes), the automations and rules on each project, and who reviews
   what. Source: each Asana project's rules, sections, templates and custom fields (read through the Asana API), plus
   the heads of each line confirming what's real. Kept as a page in Settings that the assistant and agents can read.
2. **Delegate in Kaizen OS by those rules.** Requests, briefs and tasks created in Kaizen OS are assigned by the same
   rules (line, role, client seat, due dates), still written to Asana so nothing is lost while both run.
3. **Validate side by side.** For two weeks, compare what Kaizen OS assigned with what Asana would have: same person,
   same due date, nothing missed. Each line head signs off.
4. **Switch.** Delegation happens only in Kaizen OS; Asana projects go read only and are archived when every open task
   has moved (with its comments and files).
