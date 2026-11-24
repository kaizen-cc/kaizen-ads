import { roleOfAgent } from "@/lib/agent-access";

// Calling an agent from a chat in the app: which agent a screen's Call button reaches, the small context it passes
// (the client, the report, the Kaizen AI thread, the screen), how that context reads in the agent's prompt, and
// "take a look" (when the person wants the agent to see their screen, and how each device gets it a picture). Pure,
// so it's tested without a browser or a database.

/** What a Call button passes with the call: where the person is and what they're looking at */
export type CallContext = {
  /** The screen, in plain words ("Kaizen AI", "the client page, Email tab", "the KPI board", "a report") */
  screen: string;
  clientId?: string | null;
  /** The client's name, for the button's own label (the server reads the real one) */
  client?: string | null;
  reportId?: string | null;
  threadId?: string | null;
  /** A sales prospect (Sales › Prospects, a sales call brief): the Sales agent starts with all of it */
  prospectId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const words = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/[<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A context from the browser, checked: only ids that look like ids, a short screen name, nothing else */
export function parseCallContext(raw: unknown): CallContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ctx: CallContext = { screen: words(r.screen, 80) || "the app" };
  const clientId = id(r.clientId);
  const reportId = id(r.reportId);
  const threadId = id(r.threadId);
  const prospectId = id(r.prospectId);
  if (prospectId) ctx.prospectId = prospectId;
  if (clientId) ctx.clientId = clientId;
  if (reportId) ctx.reportId = reportId;
  if (threadId) ctx.threadId = threadId;
  const client = words(r.client, 120);
  if (client) ctx.client = client;
  if (!clientId && !reportId && !threadId && !prospectId && !words(r.screen, 80)) return null;
  return ctx;
}

// ─── Which agent a button reaches ───────────────────────────────────────────

/** The agents a Call button can reach, with their name and icon (the same as their ai_roles row) */
export const CALL_ROLES: Record<string, { label: string; icon: string }> = {
  assistant: { label: "Assistant", icon: "spark" },
  media_buyer: { label: "Media Buyer", icon: "rocket" },
  google_buyer: { label: "Google Ads Buyer", icon: "target" },
  email_strategist: { label: "Email Strategist", icon: "compass" },
  email_creative: { label: "Email Creative", icon: "pen" },
  email_builder: { label: "Email Builder", icon: "feed" },
  social_strategist: { label: "Social Strategist", icon: "pulse" },
  strategist: { label: "Strategist", icon: "compass" },
  creative_director: { label: "Creative Director", icon: "shield" },
  copywriter: { label: "Copywriter", icon: "pen" },
  market_analyst: { label: "Market Analyst", icon: "eye" },
  account_manager: { label: "Account Manager", icon: "feed" },
  tracking_engineer: { label: "Tracking Engineer", icon: "scan" },
  sales: { label: "Sales", icon: "target" },
};

/** The agent for a client's line or service tab: Media Buyer for ads, Email Strategist for email, and so on */
export function roleForService(service: string | null | undefined, opts: { desk?: "email" | "social" | null; platform?: "meta" | "google" | null; line?: "email" | "social" | null } = {}): string {
  const s = (service ?? "").toLowerCase();
  if (s === "google") return "google_buyer";
  if (s === "meta" || s === "tiktok") return "media_buyer";
  if (s === "email" || s === "klaviyo") return "email_strategist";
  if (s === "social") return "social_strategist";
  if (s === "creative") return "creative_director";
  if (opts.desk === "email" || opts.line === "email") return "email_strategist";
  if (opts.desk === "social" || opts.line === "social") return "social_strategist";
  if (opts.platform === "google") return "google_buyer";
  return "media_buyer";
}

/** The agent that writes a report on this platform */
export const roleForReport = (platform: string | null | undefined): string => roleForService(platform === "klaviyo" ? "email" : platform);

/** The agent behind a Kaizen AI thread's agent or skill; the assistant when the thread is general */
export function roleForThread(agentKey: string | null | undefined): string {
  const role = roleOfAgent(agentKey ?? null);
  return role && CALL_ROLES[role] ? role : "assistant";
}

// ─── How the context reads in the agent's prompt ────────────────────────────

export type ContextFacts = {
  screen: string;
  client?: { name: string } | null;
  report?: { client: string | null; platform: string; kind: string; period: string; status: string; message: string; sections: string; checks: number } | null;
  thread?: { title: string; client: string | null; turns: { who: "them" | "ai"; text: string }[] } | null;
  /** A sales prospect: its research, latest call brief, saved drafts and reviews, and earlier Sales conversations about it */
  prospect?: { name: string; text: string } | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The block the agent reads: where they called from and what was in front of them (the report, the chat so far) */
export function contextPrompt(f: ContextFacts): string {
  const parts: string[] = [`They called you from ${f.screen}.`];
  if (f.client) parts.push(`The client on screen is ${f.client.name}: when they say "this client" or "they", it's ${f.client.name}. Use it in your tools without asking which client.`);
  if (f.report) {
    const r = f.report;
    parts.push(
      `<the_report status="${r.status}">\n${[`${r.kind} ${r.platform} report${r.client ? ` for ${r.client}` : ""}, ${r.period}.`, r.checks ? `${r.checks} check${r.checks === 1 ? "" : "s"} flagged on it.` : "", r.message ? `The message to the client:\n${clip(r.message, 1500)}` : "", r.sections ? `What it says:\n${clip(r.sections, 3000)}` : ""].filter(Boolean).join("\n")}\n</the_report>\nYou write reports like this one: answer about it, what it shows and how to make it better. Changes to it are made in its chat on the report screen.`,
    );
  }
  if (f.thread) {
    const t = f.thread;
    const said = t.turns.map((x) => `${x.who === "them" ? "They wrote" : "Kaizen AI answered"}: ${clip(x.text.replace(/\s+/g, " ").trim(), 900)}`).join("\n");
    parts.push(`<their_chat title="${t.title.replace(/"/g, "'")}"${t.client ? ` client="${t.client.replace(/"/g, "'")}"` : ""}>\n${said || "(nothing written yet)"}\n</their_chat>\nThis call carries on from that chat: pick up where it left off.`);
  }
  if (f.prospect)
    parts.push(
      `<the_prospect name="${f.prospect.name.replace(/"/g, "'")}">\n${clip(f.prospect.text, 16000)}\n</the_prospect>\nThis conversation is about ${f.prospect.name}: "them" and "this prospect" mean ${f.prospect.name}. You already have everything above: use it without asking. When you find more (research_prospect, web_research) or they settle a pitch idea, a talking point or an objection answer, save it (save_to_brief; save_prospect for the stage, owner and notes) so it's there next time.`,
    );
  return `<where_they_are>\n${parts.join("\n\n")}\n</where_they_are>`;
}

// ─── Take a look ────────────────────────────────────────────────────────────

const LOOK = /\b(?:take a (?:look|peek|screenshot)|have a look|look at (?:this|that|my|the|what)|see (?:this|that|what i'?m|my screen)|what'?s on (?:my|the) screen|screen ?shot|can you see|check (?:out )?(?:my|this) screen|share (?:my )?screen)\b/i;

/**
 * Whether they seem to want the agent to see their screen ("take a look", "what's on my screen"). Only a hint in the
 * prompt: the agent decides with its look_at_screen tool, so "look at the numbers for Crust" doesn't grab the screen.
 */
export const looksLikeLook = (text: string) => LOOK.test(text);

/**
 * How a look request gets a picture: grab a frame of the screen already shared, ask to share (computers: the
 * browser's own picker for a tab, a window or the whole screen), or the upload panel for a screenshot (phones,
 * where browsers can't share the screen).
 */
export function lookPlan(p: { desktop: boolean; canShare: boolean; sharing: boolean }): "grab" | "ask_share" | "upload" {
  if (p.sharing) return "grab";
  if (p.desktop && p.canShare) return "ask_share";
  return "upload";
}

/** A frame's size scaled down to fit `max` on its longer side (never up), in whole pixels */
export function fitWithin(width: number, height: number, max = 1600): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** A screenshot's file name on the call (kept with the call's uploads, deleted with its audio) */
export const screenFileName = (at: Date) => `screen-${at.toISOString().replace(/[:.]/g, "-")}.jpg`;
