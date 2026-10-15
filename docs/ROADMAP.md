# Kaizen Ads: Roadmap

Where things stand on 2026-10-15 and what comes next, in order. The target is the full request → approval → launch loop live before Black Friday / Cyber Monday. See VISION.md for every decision behind it.

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
- **Suggested briefs on Home** (execs and leads): the Strategist reads every account (ads tiring, KPIs off, behind on the month's creative, a new offer in Slack with no request, a client who isn't happy, angles not landing) and writes a full brief with concepts. Approve (tickets go to the makers), edit in place, decline with a reason (it reads every reason next time), or talk it through and it rewrites. Weekdays at 8:30am, or "Look again".
- **KPIs on the client page and in every agent**: each client page opens with performance vs target (14-day value against the target, 7 and 30 days, vs last month, trend, daily spend and results, budget pacing). Every agent that reads a client (request suggestions and review, copy, creative review, scripts, briefings, the Strategist) gets the same KPI picture, so a brief for an off-target account knows it.
- **Fatigue watcher**: after every Meta sync, each ad still spending is compared with its own last three weeks (click-through, cost per result, frequency, video hook rate), with the account's own move taken out. Tiring and tired ads show on Home (a buyer's own clients; every client for execs and leads) and on the client page, with a 4-week trend. "Brief a refresh" has the Strategist write a refresh that keeps what worked and changes what's tired; approving it marks the ad as being refreshed with its tickets. Dismissing asks why, and the ad returns only if it gets worse. Every agent sees the tiring ads for the client.
- **Balanced suggestions**: the Strategist weighs what's already in motion. Clients full of open work drop back, clients nobody has touched in weeks move up, and a stretched design or video team gets fewer, smaller suggestions.
- **Clients in step with Kaizen**: enrollment, upsell, marketing intake and offboarding Zaps, plus an hourly mirror of Kaizen Track (archived, restored, new, packages). See docs/ZAPIER.md.
- **Archive**: execs and leads archive a client whole (tickets, files, copy, memory, briefings stay inside); it leaves the board, Home, lists, syncs and the AI. Restore, or re-enrolling, brings it all back.
- **Onboarding**: the marketing intake form is read by the AI into every agent's view of the client (and sets the industry). The Strategist writes the first round from the intake and the winning ads in the same industry. Execs and leads see new and returning clients in a red Onboarding callout at the top of Home (enrolled → intake → first round → production).
- **Ads Lab** (execs and leads): a round table with five AI seats (strategist, copywriter, creative director, media buyer, analyst) that reads a library of notes, docs, call transcripts, YouTube videos, links and skills, plus the winners and every past test. It proposes tests and flags ones already run. A started test takes a 14-day baseline per client and reaches each client as a suggested brief on Home. Results are read from the KPI tracker; a win is deployed as a learning into the memory of every client it fits (with the effect tracked since), and a flop goes back to the table to iterate.

## Next: close the approval loop (Phase 1, before BFCM)

1. **Client portal**: the swipe-to-approve experience from the Phase 0 mockups. It shows a full ad preview, with creative and copy approved separately and revision notes captured. The first approval counts.
2. **Notifications and chasing**: Slack posts to each client's channel, plus 24h and 48h reminders in business time. After 48h the item goes to customer success's queue; auto-approval happens only for clients who opted in.
3. **Revisions loop**: client feedback goes back to the maker as a new version. Every revision note lands in client memory automatically.

## Then: launch and learn (Phase 2)

4. **Launcher**: approved ads are pushed to Meta **paused** through the system user. The AI suggests campaign, ad set and naming; the buyer confirms. Kaizen's media-buying standards live in the Launcher agent's playbook.
7. **Google Ads**: apply for the Google Ads API developer token now, since approval takes days. Then pull Google numbers into the same KPI dashboard (targets are already stored).
8. **Alerts**: a daily Slack digest per buyer listing what went off target or off pace overnight.

## Later (Phase 3)

- **Go-to-market agent**: the marketing intake form for a new client becomes an angle/avatar foundation and first-round requests.
- **Client-side requests and upgrades** in the portal, counted against the allotment.
- **Built-in timer** that logs to Kaizen Track without double counting.
- **PDF knowledge** in Settings (only text files today), and per-client knowledge for the agents.
- **Agent evals**: replay recent requests against a changed prompt or model before saving, to see what would differ.
- **TikTok, organic social, white-label portal**, and the move into Kaizen OS.
