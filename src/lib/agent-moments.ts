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
  ],
  review: [
    { title: "Checks a request before it goes to the team", where: "New request form · Review", trigger: "auto", when: "When someone reaches the Review step", labels: ["review"] },
    { title: "Summarises what the client asked for in a revision", where: "Client portal → ticket", trigger: "auto", when: "When a client sends changes", labels: ["revision summary", "client summary"] },
    { title: "Turns client notes into lessons in client memory", where: "Client portal → client memory", trigger: "auto", when: "When a client approves or sends changes", labels: ["client lessons"] },
  ],
  briefing: [
    { title: "Writes each client's briefing from Slack, email, Drive, Meta and calls", where: "Client page · Briefing", trigger: "auto", when: "12pm and 6pm, and on Refresh now", labels: ["briefing"] },
    { title: "Reads the marketing intake form", where: "Onboarding · Client page", trigger: "auto", when: "When an intake form comes in from Zapier", labels: ["marketing intake"] },
    { title: "Reads a custom package from the enrollment or upsell form", where: "Zapier · Client package", trigger: "auto", when: "When an enrollment or upsell has a custom package", labels: ["package from a form"] },
    { title: "Pulls the takeaways from a shared doc, video or link", where: "Ads Lab · Round table", trigger: "auto", when: "When someone shares a source", labels: ["lab source takeaways"] },
  ],
  copy: [
    { title: "Writes Kaizen's copy set for approved creative", where: "Board · Copy studio", trigger: "auto", when: "When creative is approved", labels: ["copy "] },
    { title: "Rewrites copy in the copy studio chat", where: "Board · Copy studio", trigger: "click", when: "When someone asks it to change the copy", labels: ["copy chat"] },
    { title: "Checks copy against what the client told us", where: "Board · Copy studio", trigger: "auto", when: "Before copy can be approved", labels: ["copy check against client"] },
    { title: "Learns from edits to copy", where: "Board · Copy studio → client memory", trigger: "auto", when: "When a copywriter edits the AI's copy", labels: ["copy lessons"] },
    { title: "Amends copy from a client's notes", where: "Client portal → copy review", trigger: "auto", when: "When a client sends copy changes", labels: ["copy revision"] },
  ],
  scripts: [{ title: "Writes the video script: three hooks, the beats and the shot list", where: "Board · Video tickets", trigger: "click", when: "When someone writes the script on a video ticket", labels: ["script"] }],
  brandbible: [
    { title: "Researches the client on the web", where: "Client page · Brand Bible", trigger: "click", when: "When someone builds or updates the Brand Bible", labels: ["brand bible research"] },
    { title: "Writes the Brand Bible from the research and everything known", where: "Client page · Brand Bible", trigger: "click", when: "Right after the research", labels: ["brand bible "] },
  ],
  creativecheck: [{ title: "Sorts uploaded designs into net new and variations, and checks sizes", where: "Board · Upload", trigger: "auto", when: "As a designer or editor uploads", labels: ["creative check"] }],
  creativereview: [{ title: "Reviews each design against the brief, the brand and Meta policy", where: "Board · Before internal review", trigger: "click", when: "When the maker runs the AI review", labels: ["creative review"] }],
  strategist: [
    { title: "Suggests briefs from the data (ads tiring, KPIs off, behind on creative, offers, unhappy clients)", where: "Overview · Suggested briefs", trigger: "auto", when: "Weekdays 8:30am, and on Look again", labels: ["suggested brief"] },
    { title: "Rewrites a suggested brief in its chat", where: "Any brief sheet", trigger: "click", when: "When someone talks a brief through", labels: ["suggested brief chat"] },
    { title: "Writes the first round for a new client", where: "Overview · Onboarding", trigger: "auto", when: "When the intake is in, or on Write the first round", labels: ["onboarding first round"] },
    { title: "Writes a refresh for a tiring ad", where: "Ads wearing out", trigger: "auto", when: "After each Meta sync, for every ad on the watch list", labels: ["refresh a tiring ad"] },
    { title: "Writes a brief from a promise made on a call", where: "Overview · Promised on calls · Request form", trigger: "auto", when: "Two business days after the call with nothing in motion, or when used in a request", labels: ["brief from a call"] },
    { title: "Writes a brief from one of our winning ads", where: "Ideas · Our winners · Request form", trigger: "click", when: "When someone clicks Create brief / Brief a client", labels: ["brief from a winner"] },
    { title: "Writes a brief from a live ad in the market", where: "Ideas · In the market · Request form · Client page", trigger: "click", when: "When someone clicks Create brief / Brief a client", labels: ["brief from a market ad"] },
    { title: "Writes the brief for an Ads Lab test", where: "Ads Lab · Running tests", trigger: "auto", when: "When a test starts for a client", labels: ["lab test brief"] },
  ],
  lab: [
    { title: "Speaks at the round table, one seat at a time (strategist, creative director, copywriter, media buyer, analyst, account manager)", where: "Ads Lab · Round table", trigger: "click", when: "When someone posts to the table, once per message", labels: ["lab round table"] },
    { title: "Reads a shared doc, video or link", where: "Ads Lab · Round table", trigger: "auto", when: "When someone shares a source", labels: ["lab source"] },
    { title: "Proposes which clients a winning test should be deployed to", where: "Ads Lab · Running tests", trigger: "click", when: "When a test wins", labels: ["lab deploy"] },
  ],
  industry: [{ title: "Sorts clients into industries from everything on their page", where: "Clients · Winners · Market", trigger: "auto", when: "Hourly for new or thinly-read clients, and at 12pm and 6pm", labels: ["client industries"] }],
  calls: [
    { title: "Reads Gemini and Fireflies notes per client: what was said, decided and promised", where: "Client page · Calls", trigger: "auto", when: "Every 30 minutes in business hours", labels: ["read a call"] },
    { title: "Checks whether a promise has been covered by a request", where: "Overview · Promised on calls", trigger: "auto", when: "After every request, and with every call sync", labels: ["commitments covered"] },
    { title: "Re-checks each promise against the whole call: paid ads, or another Kaizen service", where: "Overview · Promised on calls", trigger: "auto", when: "With every call sync, once per promise", labels: ["recheck call promises"] },
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
  ],
  winners: [{ title: "Reads each winning ad: what the numbers show and why the creative works", where: "Ideas · Our winners", trigger: "auto", when: "After each Meta sync, or the first time someone hovers a winner", labels: ["read a winner"] }],
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
  ],
  coach: [{ title: "Edits another agent's playbook from your feedback", where: "Settings · AI agents · Coach", trigger: "click", when: "When someone coaches an agent", labels: ["coach"] }],
  launcher: [{ title: "Pushes approved ads to Meta, paused, with Kaizen's naming", where: "Board · Ready to launch", trigger: "click", when: "Coming with the Launcher", labels: ["launch"] }],
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
