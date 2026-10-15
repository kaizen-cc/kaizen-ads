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
- **Copy**: approving creative has the Copywriter draft Kaizen's set (3 short + 2 long) straight into Copy review, with live character counts, hard limits on approval, rewrite-with-a-note, reuse of approved copy per angle, and a learning loop from copy review's edits.

## Next: close the approval loop (Phase 1, before BFCM)

1. **Client portal**: the swipe-to-approve experience from the Phase 0 mockups. It shows a full ad preview, with creative and copy approved separately and revision notes captured. The first approval counts.
2. **Notifications and chasing**: Slack posts to each client's channel, plus 24h and 48h reminders in business time. After 48h the item goes to customer success's queue; auto-approval happens only for clients who opted in.
3. **Revisions loop**: client feedback goes back to the maker as a new version. Every revision note lands in client memory automatically.

## Then: launch and learn (Phase 2)

6. **Launcher**: approved ads are pushed to Meta **paused** through the system user. The AI suggests campaign, ad set and naming; the buyer confirms. Kyle's media-buyer logic plugs into its own agent slot.
7. **KPIs on the client page and in the AI**: the client's KPI status, pacing and trend feed the briefing, the brief strategist and the reviewer. A brief for an off-target account knows it's off target.
8. **Fatigue watcher**: frequency and cost trends per ad flag tiring creative, alert the buyer and open an iteration ticket. Motion's MCP can add creative-level context.
9. **Google Ads**: apply for the Google Ads API developer token now, since approval takes days. Then pull Google numbers into the same KPI dashboard (targets are already stored).
10. **Alerts**: a daily Slack digest per buyer listing what went off target or off pace overnight.

## Later (Phase 3)

- **Go-to-market agent**: the marketing intake form for a new client becomes an angle/avatar foundation and first-round requests.
- **Client-side requests and upgrades** in the portal, counted against the allotment.
- **Built-in timer** that logs to Kaizen Track without double counting.
- **PDF knowledge** in Settings (only text files today), and per-client knowledge for the agents.
- **Agent evals**: replay recent requests against a changed prompt or model before saving, to see what would differ.
- **TikTok, organic social, white-label portal**, and the move into Kaizen OS.
