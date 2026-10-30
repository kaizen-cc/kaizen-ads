// Where each AI agent comes in: every moment in the app that calls it, what sets it off, and the run labels it logs
// under (so each moment shows how often it ran and when it last did). Kept next to the code that calls the agents;
// a new call should get a moment here.

export type Moment = {
  title: string; // what it does at that moment
  where: string; // the screen or job
  trigger: "auto" | "click"; // runs on its own, or when someone asks
  when: string; // what sets it off
  labels: string[]; // run labels it logs under (prefix match)
};

export const AGENT_MOMENTS: Record<string, Moment[]> = {
  suggest: [
    { title: "Suggests angle, audience, hooks, copy direction and the format mix", where: "New request form", trigger: "auto", when: "When a client is picked and as the request fills in", labels: ["suggest"] },
    { title: "Applies a fix from the review to the request", where: "New request form · Review", trigger: "click", when: "When someone clicks a suggested fix", labels: ["apply fix"] },
    { title: "Reads an Asana task into the request form when it's moved into Kaizen Ads", where: "Board \u00b7 Asana task \u2192 Migrate to Kaizen Ads", trigger: "click", when: "When someone migrates an Asana task", labels: ["asana migration"] },
  ],
  review: [
    { title: "Checks a request before it goes to the team", where: "New request form · Review", trigger: "auto", when: "When someone reaches the Review step", labels: ["review"] },
    { title: "Summarises what the client asked for in a revision", where: "Client portal → ticket", trigger: "auto", when: "When a client sends changes", labels: ["revision summary", "client summary"] },
    { title: "Turns client notes into lessons in client memory", where: "Client portal → client memory", trigger: "auto", when: "When a client approves or sends changes", labels: ["client lessons"] },
    { title: "Checks a strategist's brief against Kaizen's brief standard and fixes what's off", where: "Overview \u00b7 Suggested briefs (every brief the strategist writes)", trigger: "auto", when: "Right after each brief is written", labels: ["brief self-review"] },
  ],
  briefing: [
    { title: "Writes each client's briefing from Slack, email, Drive, Meta and calls", where: "Client page · Briefing", trigger: "auto", when: "12pm and 6pm, and on Refresh now", labels: ["briefing"] },
    { title: "Reads the marketing intake form", where: "Onboarding · Client page", trigger: "auto", when: "When an intake form comes in from Zapier", labels: ["marketing intake"] },
    { title: "Reads a custom package from the enrollment or upsell form", where: "Zapier · Client package", trigger: "auto", when: "When an enrollment or upsell has a custom package", labels: ["package from a form"] },
    { title: "Pulls the takeaways from a shared doc, video or link", where: "Ads Lab · Round table", trigger: "auto", when: "When someone shares a source", labels: ["lab source takeaways"] },
    { title: "Reads a file or link shared about a client", where: "Client page \u00b7 Documents \u00b7 Client desk", trigger: "auto", when: "When a file or link is shared", labels: ["client document"] },
    { title: "Decides how much thought a chat message needs (quick, considered, deep)", where: "Client desk \u00b7 Agent chats", trigger: "auto", when: "With every chat message", labels: ["route a chat message"] },
  ],
  copy: [
    { title: "Writes Kaizen's copy set for approved creative", where: "Board · Copy studio", trigger: "auto", when: "When creative is approved", labels: ["copy "] },
    { title: "Rewrites copy in the copy studio chat", where: "Board · Copy studio", trigger: "click", when: "When someone asks it to change the copy", labels: ["copy chat"] },
    { title: "Checks copy against what the client told us", where: "Board · Copy studio", trigger: "auto", when: "Before copy can be approved", labels: ["copy check against client"] },
    { title: "Learns from edits to copy", where: "Board · Copy studio → client memory", trigger: "auto", when: "When a copywriter edits the AI's copy", labels: ["copy lessons"] },
    { title: "Amends copy from a client's notes", where: "Client portal → copy review", trigger: "auto", when: "When a client sends copy changes", labels: ["copy revision"] },
    { title: "Writes the headline and description for each carousel card", where: "Board \u00b7 Copy studio (carousels)", trigger: "click", when: "When someone writes the carousel cards", labels: ["carousel cards"] },
    { title: "Reads copy brought in from a ticket moved over from Asana", where: "Board \u00b7 Migrated tickets", trigger: "auto", when: "When a migrated ticket has copy", labels: ["copy import"] },
  ],
  scripts: [{ title: "Writes the video script: three hooks, the beats and the shot list", where: "Board · Video tickets", trigger: "click", when: "When someone writes the script on a video ticket", labels: ["script"] }],
  brandbible: [
    { title: "Researches the client on the web", where: "Client page · Brand Bible", trigger: "click", when: "When someone builds or updates the Brand Bible", labels: ["brand bible research"] },
    { title: "Writes the Brand Bible from the research and everything known", where: "Client page · Brand Bible", trigger: "click", when: "Right after the research", labels: ["brand bible "] },
    { title: "Answers the review chat and edits the Bible from the team's answers", where: "Client page \u00b7 Brand Bible \u00b7 Clarify", trigger: "click", when: "When someone answers in the review chat", labels: ["brand bible review"] },
  ],
  creativecheck: [{ title: "Sorts uploaded designs into net new and variations, and checks sizes", where: "Board · Upload", trigger: "auto", when: "As a designer or editor uploads", labels: ["creative check"] }],
  creativereview: [{ title: "Reviews each design against the brief, the brand and Meta policy", where: "Board · Before internal review", trigger: "click", when: "When the maker runs the AI review", labels: ["creative review"] }],
  strategist: [
    { title: "Suggests briefs from the data (ads tiring, KPIs off, behind on creative, offers, unhappy clients)", where: "Overview · Suggested briefs", trigger: "auto", when: "Weekdays 8:30am, and on Look again", labels: ["suggested brief"] },
    { title: "Rewrites a suggested brief in its chat", where: "Any brief sheet", trigger: "click", when: "When someone talks a brief through", labels: ["suggested brief chat"] },
    { title: "Writes the first round for a new client", where: "Overview · Onboarding", trigger: "auto", when: "When the intake is in, or on Write the first round", labels: ["onboarding first round"] },
    { title: "Writes a refresh for a tiring ad", where: "Ads wearing out", trigger: "auto", when: "After each Meta sync, for every ad on the watch list", labels: ["refresh a tiring ad"] },
    { title: "Writes a brief from a promise made on a call", where: "Overview · Waiting on us · Request form", trigger: "auto", when: "Two business days after the call with nothing in motion, or when used in a request", labels: ["brief from a call"] },
    { title: "Writes a brief from one of our winning ads", where: "Ideas · Our winners · Request form", trigger: "click", when: "When someone clicks Create brief / Brief a client", labels: ["brief from a winner"] },
    { title: "Writes a brief from a live ad in the market", where: "Ideas · In the market · Request form · Client page", trigger: "click", when: "When someone clicks Create brief / Brief a client", labels: ["brief from a market ad"] },
    { title: "Writes the brief for an Ads Lab test", where: "Ads Lab · Running tests", trigger: "auto", when: "When a test starts for a client", labels: ["lab test brief"] },
    { title: "Writes next month's shot list: the photos and clips to ask the client for, from what's planned and winning minus what's already on Drive", where: "Client page · Creative · Shot list", trigger: "auto", when: "Monthly, when a client's footage on Drive runs low (and when someone asks for one)", labels: ["monthly shot list"] },
    { title: "Counts what's been made in Asana against each client's monthly allotment", where: "Clients \u00b7 Overview (allotments)", trigger: "auto", when: "With every Asana sync", labels: ["asana allotment count"] },
    { title: "Previews ideas for a new request (angles and formats to start from)", where: "New request form \u00b7 Ideas", trigger: "auto", when: "When a client is picked", labels: ["idea previews"] },
    { title: "Writes the handoff when an account moves to a new buyer", where: "Overview \u00b7 Handoffs", trigger: "auto", when: "When a buyer changes on an account (the Account Overview sheet or the Team page)", labels: ["account handoff"] },
    { title: "Writes the brief when a client comes back", where: "Client page \u00b7 Overview", trigger: "auto", when: "When a client is set back to active", labels: ["comeback brief"] },
    { title: "Answers questions about an account in a handoff", where: "Overview \u00b7 Handoff", trigger: "click", when: "When someone asks in a handoff", labels: ["account question"] },
    { title: "Answers the client desk: questions, strategy, summaries, files, and changes to what's remembered (with every campaign's scorecard)", where: "Client page \u00b7 KPI card \u00b7 Ask about \u2026", trigger: "click", when: "With every message", labels: ["client desk", "client chat"] },
  ],
  lab: [
    { title: "Speaks at the round table, one seat at a time (strategist, creative director, copywriter, media buyer, analyst, account manager)", where: "Ads Lab · Round table", trigger: "click", when: "When someone posts to the table, once per message", labels: ["lab round table"] },
    { title: "Reads a shared doc, video or link", where: "Ads Lab · Round table", trigger: "auto", when: "When someone shares a source", labels: ["lab source"] },
    { title: "Proposes which clients a winning test should be deployed to", where: "Ads Lab · Running tests", trigger: "click", when: "When a test wins", labels: ["lab deploy"] },
    { title: "Looks up what's true right now for a round table", where: "Ads Lab \u00b7 Round table", trigger: "auto", when: "When a deep round table needs research", labels: ["lab round table research"] },
  ],
  industry: [{ title: "Sorts clients into industries from everything on their page", where: "Clients · Winners · Market", trigger: "auto", when: "Hourly for new or thinly-read clients, and at 12pm and 6pm", labels: ["client industries"] }],
  calls: [
    { title: "Reads Gemini and Fireflies notes per client: what was said, decided and promised", where: "Client page · Calls", trigger: "auto", when: "Every 30 minutes in business hours", labels: ["read a call"] },
    { title: "Checks whether a promise has been covered by a request", where: "Overview · Waiting on us", trigger: "auto", when: "After every request, and with every call sync", labels: ["commitments covered"] },
    { title: "Re-checks each promise against the whole call: paid ads, or another Kaizen service", where: "Overview · Waiting on us", trigger: "auto", when: "With every call sync, once per promise", labels: ["recheck call promises"] },
    { title: "Reads Slack tags and emails nobody answered: does it really need a reply, and what's it about", where: "Your day · Waiting on us · Notifications", trigger: "auto", when: "Hourly on weekdays, once a message has waited a few working hours", labels: ["owed replies"] },
    { title: "Reads each Drive doc for a client (notes, decks, reports)", where: "Client page \u00b7 Documents \u00b7 Briefing", trigger: "auto", when: "Every 30 minutes for new and changed docs", labels: ["read a doc"] },
    { title: "Checks whether a yes in Slack or email has happened (the thread, tickets, Asana, the ad account)", where: "Overview \u00b7 Waiting on us", trigger: "auto", when: "When it comes due, and every couple of working hours after", labels: ["promise follow-through"] },
    { title: "Groups the same promise said in several places (calls, Slack, email)", where: "Overview \u00b7 Waiting on us", trigger: "auto", when: "After each read of new promises", labels: ["group promises"] },
    { title: "Picks out what the team said yes to in Slack and email", where: "Overview \u00b7 Waiting on us", trigger: "auto", when: "Every 15 minutes in working hours", labels: ["promises in messages"] },
  ],
  gtm: [
    { title: "Researches the client for the Meta go-to-market strategy", where: "Client page · Go-to-market", trigger: "auto", when: "At onboarding once the intake, call notes and website are in, or on Build it now", labels: ["gtm research"] },
    { title: "Writes the Meta go-to-market strategy", where: "Client page · Go-to-market", trigger: "auto", when: "Right after the research", labels: ["gtm strategy"] },
  ],
  market: [
    { title: "Reads each live market ad: why it works and what to take from it", where: "Ideas · In the market", trigger: "auto", when: "After each Motion sync (8:30am), or the first time someone hovers an ad", labels: ["read a market ad"] },
    { title: "Describes each brand on its own terms", where: "Ideas · In the market", trigger: "auto", when: "With each Motion sync", labels: ["describe market brands", "sort market brands"] },
    { title: "Matches each client to comparable brands from their client page", where: "Ideas · In the market · Request form · Client page", trigger: "auto", when: "Weekly per client, or when a client is picked for the first time", labels: ["match market brands"] },
    { title: "Checks brands found from intake forms are the right ones", where: "Ideas · In the market", trigger: "auto", when: "With each Motion sync", labels: ["check market brands"] },
    { title: "Picks standout advertisers in each niche we serve", where: "Ideas · In the market", trigger: "auto", when: "Weekly, with the Motion sync", labels: ["brands to watch"] },
    { title: "Reads a batch of market ads at once", where: "Ideas \u00b7 In the market", trigger: "auto", when: "When new market ads come in", labels: ["read market ads"] },
  ],
  winners: [
    { title: "Reads each winning ad: what the numbers show and why the creative works", where: "Ideas · Our winners", trigger: "auto", when: "After each Meta sync, or the first time someone hovers a winner", labels: ["read a winner"] },
    { title: "Reads a winning Google ad, keyword or search term: why it wins and how to use it on another client", where: "Ideas · Google · Hall of Fame and Live winners", trigger: "click", when: "The first time someone points at one (kept a week)", labels: ["read a Google winner"] },
    { title: "Writes each client's playbook: every angle, hook and format they've run, with what won and what didn't", where: "Client page \u00b7 Playbook \u00b7 Brand Bible learnings", trigger: "auto", when: "Hourly, each client in turn", labels: ["playbook angles", "playbook learnings"] },
  ],
  verticals: [
    { title: "Works out the verticals and sub-verticals from every client page and places each client", where: "Ideas · Verticals", trigger: "auto", when: "Weekly, and when there are none", labels: ["build verticals"] },
    { title: "Places new clients in a sub-vertical", where: "Ideas · Verticals · Client page", trigger: "auto", when: "Hourly, for new clients", labels: ["place clients in verticals"] },
    { title: "Places market brands in the sub-vertical they teach", where: "Ideas · In the market", trigger: "auto", when: "With each Motion sync", labels: ["place market brands"] },
    { title: "Researches Meta benchmarks for each sub-vertical, with sources", where: "Ideas · Verticals", trigger: "auto", when: "Hourly until done, then every 90 days", labels: ["benchmarks"] },
    { title: "Decides whether a lesson that worked for one client truly applies to others in its sub-vertical (product, buyer, sales motion, price point) and shares it, reworded and unnamed", where: "Client pages · client memory", trigger: "auto", when: "When an audit or a sprint learns what works", labels: ["share lesson"] },
    { title: "Writes each sub-vertical's playbook: avatars, the angles that land, and the ads that prove them", where: "Ideas · Verticals · Playbook", trigger: "auto", when: "Hourly when something new comes in, or Rebuild", labels: ["playbook"] },
  ],
  auditor: [
    { title: "Audits one ad account: why it's where it is against target, and the plan (changes, tests, creative, budget, questions for the client)", where: "KPIs · open a client · AI account audit", trigger: "click", when: "When someone runs an audit", labels: ["audit ", "audit"] },
    { title: "Checks each optimization sprint: what changed in Meta, what was ticked, and what to tell the buyer (a reminder, a wrong move, or I'll check back)", where: "KPIs · sprint page · Next for me", trigger: "auto", when: "Daily, or on the follow-up date it set", labels: ["sprint check"] },
    { title: "Writes the client-facing version of an audit for the PDF", where: "Audit · Client PDF", trigger: "click", when: "The first time someone opens the client PDF", labels: ["audit client report"] },
    { title: "Adds a move to a sprint from an audit or the buyer's note", where: "KPIs \u00b7 sprint page", trigger: "click", when: "When someone adds a move", labels: ["sprint add move"] },
  ],
  coach: [
    { title: "Edits another agent's playbook from your feedback", where: "Settings · AI agents · Coach", trigger: "click", when: "When someone coaches an agent", labels: ["coach"] },
    { title: "Answers an agent's chat in Settings and proposes edits to its skills", where: "Settings \u00b7 AI agents \u00b7 an agent's chat", trigger: "click", when: "With every message", labels: ["agent chat"] },
  ],
  launcher: [
    { title: "Places approved ads in the right ad set (or a copy of one) and names them to match it, then pushes them to Meta paused", where: "Board · Ready to launch · Launch to Meta", trigger: "click", when: "When the buyer plans a launch", labels: ["place a launch"] },
    { title: "Turns an audit action or sprint move into exact Meta changes (pause or turn on, daily budgets), dry-run with Meta first", where: "KPIs · audit · sprint", trigger: "click", when: "Make this change in Meta", labels: ["plan a Meta change"] },
    { title: "Spots patterns in how buyers correct its launches and proposes a rule", where: "Settings \u00b7 AI agents \u00b7 Launcher", trigger: "auto", when: "When the same correction keeps coming up", labels: ["launch rules pattern"] },
  ],
  google_auditor: [
    { title: "Audits a Google Ads account against its KPI target: campaigns, bidding, budgets, impression share, keywords and search terms, conversion tracking (with every campaign's scorecard)", where: "KPIs · a Google card · AI account audit", trigger: "click", when: "When someone runs an audit, or on its own when the account goes off target", labels: ["audit"] },
    { title: "Checks each Google optimization sprint: what changed in Google Ads, what was ticked, and what to tell the buyer", where: "KPIs · sprint page · Next for me", trigger: "auto", when: "Daily, or on the follow-up date it set", labels: ["sprint check"] },
  ],
  google_launcher: [
    { title: "Turns an audit action or sprint move into exact Google Ads changes (pause or enable, budgets, targets, negatives)", where: "KPIs · Google audit · sprint", trigger: "click", when: "Make this change in Google Ads", labels: ["plan a Google Ads change"] },
  ],
  reporter: [
    { title: "Writes the weekly and monthly client report for a Meta account, in the buyer's voice", where: "Reports · KPIs", trigger: "auto", when: "Mondays and the 1st, and when someone builds a report", labels: ["weekly report", "monthly report", "custom report", "built report"] },
    { title: "Rewrites a report from the buyer's note", where: "Reports · a report", trigger: "click", when: "When the buyer asks for changes", labels: ["revise report"] },
    { title: "Writes the message that goes with a joint report", where: "Reports · Build a report", trigger: "click", when: "When a report covers more than one service", labels: ["joint report message"] },
  ],
  google_reporter: [
    { title: "Writes the weekly and monthly client report for a Google Ads account, the same way as the Meta one", where: "Reports · KPIs", trigger: "auto", when: "Mondays and the 1st, and when someone builds a report", labels: ["weekly report", "monthly report", "custom report", "built report"] },
    { title: "Rewrites a report from the buyer's note", where: "Reports · a report", trigger: "click", when: "When the buyer asks for changes", labels: ["revise report"] },
  ],
  report_qa: [
    { title: "Checks every report before it goes out: numbers match the data, nothing invented, Kaizen's writing rules", where: "Reports", trigger: "auto", when: "Right after each report is written", labels: ["report QA"] },
  ],
  fatigue: [{ title: "Flags ads wearing out from their own numbers (no AI call; the strategist writes the refresh)", where: "Overview · Client page · Next for me", trigger: "auto", when: "After every Meta sync", labels: [] }],
};

/** The moment a run belongs to, by its label. */
export function momentOf(agent: string, label: string | null) {
  const l = (label ?? "").toLowerCase();
  const list = AGENT_MOMENTS[agent] ?? [];
  // Longest matching label first, so "copy chat" wins over "copy "
  let best: { m: Moment; len: number } | null = null;
  for (const m of list) for (const p of m.labels) if (l.startsWith(p.toLowerCase()) && (!best || p.length > best.len)) best = { m, len: p.length };
  return best?.m ?? null;
}
