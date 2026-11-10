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
