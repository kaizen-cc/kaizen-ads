import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { readDoc } from "@/lib/client-docs";
import { accessSetting } from "@/lib/onboarding-guide";

// Instant help inside the setup guide (Meta access, Google Ads): the client asks in their own words, with screenshots
// or files, and gets the exact next click for what's on their screen. It keeps going as long as it's helping; only
// after about five tries on the same problem, with them getting frustrated, does it offer to save it for the
// onboarding call (and then the team hears where they got stuck).

/** The access steps with help: Meta, Google Ads, the Google tools, their website and their email platform */
export type HelpStep = "meta" | "google" | "tools" | "website" | "email" | "tracking";
export type HelpTurn = { id: string; role: "client" | "ai"; text: string; files: string[]; at: string; suggestCall: boolean };
type Shared = { path: string; name: string; mime: string; bytes: number };

/** Tries on the same problem before the call can be offered */
export const TRIES_BEFORE_CALL = 5;

export async function loadHelp(admin: SupabaseClient, clientId: string): Promise<Record<HelpStep, HelpTurn[]>> {
  const { data } = await admin.from("setup_help").select("id, step, role, text, files, suggest_call, created_at").eq("client_id", clientId).order("created_at").limit(200);
  const out: Record<HelpStep, HelpTurn[]> = { meta: [], google: [], tools: [], website: [], email: [], tracking: [] };
  for (const r of data ?? []) {
    const step = r.step as HelpStep;
    if (!out[step]) continue;
    out[step].push({ id: r.id as string, role: r.role as "client" | "ai", text: r.text as string, files: ((r.files ?? []) as { name: string }[]).map((f) => f.name), at: r.created_at as string, suggestCall: Boolean(r.suggest_call) });
  }
  return out;
}

async function guideFor(admin: SupabaseClient, step: HelpStep) {
  if (step === "tracking") {
    const [a, { stepsText }, { TRACKING_PLATFORMS }] = await Promise.all([accessSetting(admin), import("@/lib/platform-steps"), import("@/lib/tracking-platforms")]);
    const addr = { tech: a.techEmail ?? "the address their Kaizen contact gave them", klaviyo: a.klaviyoEmail ?? "" };
    return `THE STEP: tell Kaizen where their orders, bookings or leads are recorded (POS and online ordering for restaurants, booking software for spas, salons and gyms, CRM, job software and call tracking for service businesses, subscription apps for online stores), then add ${addr.tech} as a user on each so our tracking team can connect sales and leads to the ads. Some platforms can't add a user: then the tracking team sets up a report export or a connection with them on the onboarding call. Never ask for or accept a password.
${TRACKING_PLATFORMS.map((p) => `${p.name}${p.invite === "call" ? " (can't add a user: on the call)" : ""}:\n${stepsText(p.key, addr) || p.steps.map((x, i) => `${i + 1}. ${x.title}: ${x.body.replace(/\{tech\}/g, addr.tech).replace(/\*\*/g, "")}`).join("\n")}`).join("\n\n")}
Common snags: only an owner or admin can add users; some plans charge per user (then it's fine to do it on the call instead); a manager login may hide the team settings; if they're not sure which tool records their sales, ask how a customer orders, books or gets in touch, and suggest the call.`;
  }
  if (step === "tools" || step === "website" || step === "email") {
    const [a, { PLATFORM_STEPS, stepsText }, { EMAIL_PLATFORMS, GOOGLE_TOOLS, WEBSITE_PLATFORMS }] = await Promise.all([accessSetting(admin), import("@/lib/platform-steps"), import("@/lib/onboarding-guide-types")]);
    const addr = { tech: a.techEmail ?? "the address their Kaizen contact gave them", klaviyo: a.klaviyoEmail ?? a.techEmail ?? "the address their Kaizen contact gave them" };
    const block = (key: string, name: string) => (PLATFORM_STEPS[key] ? `${name}:\n${stepsText(key, addr)}` : "");
    if (step === "tools")
      return `THE STEP: give Kaizen access to their Google tools (beyond Google Ads), each by adding ${addr.tech} as an admin. Analytics and Tag Manager always; Business Profile if customers visit a location; Merchant Center if they sell products online.
${GOOGLE_TOOLS.map((t) => block(t.key, t.name)).join("\n\n")}
If they don't have one: they tap "I don't have one" and we set it up with them on the onboarding call. Common snags: the tool is owned by a different Google account than the one they're signed into (switch accounts top right); they need admin rights themselves to add users (ask whoever set it up: a web developer or former agency); in Analytics, Account access gives access to every property; in Business Profile, only an owner can add managers, and a listing nobody owns needs to be claimed (business.google.com/create, verified by postcard, phone or video).`;
    if (step === "website")
      return `THE STEP: give Kaizen access to their website. They pick their platform. Shopify: they send us their 4-digit collaborator request code and their store's myshopify.com address, and we send a collaborator request they accept. Every other platform: they invite ${addr.tech} as an admin.
${WEBSITE_PLATFORMS.map((x) => block(x.key === "other" ? "website-other" : x.key, x.name)).join("\n\n")}
Common snags: they're not the store owner or an admin (ask whoever built the site, often a web developer); on Shopify the collaborator code is under Settings › Users and permissions (or Users) › Collaborators, and the store address is in Settings › Domains (an admin address admin.shopify.com/store/NAME means NAME.myshopify.com); if a developer built the site, they can invite us.`;
    return `THE STEP: give Kaizen access to their email or SMS platform as an admin: on Klaviyo they add ${addr.klaviyo}; on every other platform ${addr.tech}.
${EMAIL_PLATFORMS.map((x) => block(x.key === "other" ? "email-other" : x.key, x.name)).join("\n\n")}
Common snags: only an Owner or Admin can add users; seat limits on cheaper plans (Mailchimp's free plan has one seat: they may need to upgrade, or we do it on the call); the invite lands in our inbox, not theirs.`;
  }
  if (step === "meta") {
    const a = await accessSetting(admin);
    return `THE STEP: give Kaizen access to their Facebook and Instagram ads, in Meta Business Settings (business.facebook.com/settings, on a computer).
Kaizen's Business ID (business portfolio ID): ${a.bmId ?? "ask their Kaizen contact"}. Kaizen team emails to invite as admin: ${a.adminEmails.join(", ") || "ask their Kaizen contact"}.
What the guide walks them through:
1. Open Business Settings, signed in with the Facebook account that owns their ad account and Page.
2. Users › Partners › Add › "Give a partner access to your assets", paste Kaizen's Business ID, Next.
3. Pick and give full control (Manage) of: the ad account, the Facebook Page, the Instagram account, the dataset (pixel), the catalog if they sell online. Save.
4. Users › People › Add: invite the Kaizen emails with Full control (admin), give access to the same ad account and Page, send.
5. Back in the guide: "Check my access" (the ad account ID is optional: Business Settings › Accounts › Ad accounts, the number under the name).
If they have NO business portfolio (Business Manager): business.facebook.com/overview › Create a business portfolio (business name, their name, business email) › then Accounts › Pages › Add (an existing Page they admin), Accounts › Instagram accounts › Add (log in), Accounts › Ad accounts › Add › Create a new ad account (name, time zone and currency, which can't change later; "my business"), add a payment method in Billing, then the partner steps above.
Common snags: Meta now calls Business Manager a "business portfolio"; the menu is also under "Settings" (gear) in Meta Business Suite; they must be an admin of the portfolio to add partners (else ask whoever is); a Page owned by a personal profile must be added to the portfolio first ("Add a Page" › request access if someone else owns it); the Instagram account must be connected to the Page or added in Instagram accounts; partner requests sometimes need the Security Center's two-factor turned on; the invite emails land in the Kaizen team's inbox, not theirs.`;
  }
  const { managerId } = await import("@/lib/context/google-ads");
  const m = managerId();
  return `THE STEP: send Kaizen their Google Ads account ID, then accept Kaizen's request to manage it.
Kaizen's manager account ID: ${m || "ask their Kaizen contact"}.
What the guide walks them through:
1. Find the ID: open ads.google.com; the 10-digit ID (123-456-7890) is at the top right next to the account name (click the account name if it's hidden). Type it into the guide and send.
2. Then in Google Ads: Admin (gear) › Access and security › Managers tab › Accept Kaizen's request.
If they have NO Google Ads account: ads.google.com › Start now › sign in with the business Google account › when it asks to make a campaign, "Switch to Expert Mode" (small link at the bottom) › "Create an account without a campaign" › check billing country, time zone and currency (can't change later) › Submit. Then find the ID as above.
Common snags: a manager (MCC) account ID isn't their ad account (pick the client account under it); several accounts under one login (the switcher top right); the request expires after 30 days; they need Admin access on the account to accept; "Smart mode" hides Admin (switch to Expert mode under Tools); the invite only shows once we've sent the request, after they type the ID in the guide.`;
}

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    stuck: { type: "boolean" },
    frustration: { type: "integer", minimum: 0, maximum: 5 },
    topic: { type: "string" },
    suggest_call: { type: "boolean" },
    blocker: { type: "string", enum: ["", "restricted", "no_permission", "cant_create", "verification", "billing", "other"] },
    blocker_detail: { type: "string" },
  },
  required: ["answer", "stuck", "frustration", "topic", "suggest_call", "blocker", "blocker_detail"],
  additionalProperties: false,
};

/** A client's question in the setup guide: answered for what's on their screen, and the call offered only when it's time */
export async function askSetupHelp(admin: SupabaseClient, clientId: string, step: HelpStep, by: { name: string; contactId: string | null }, msg: { text: string; files: Shared[] }) {
  const [{ data: c }, { data: prior }, guide] = await Promise.all([
    admin.from("clients").select("name").eq("id", clientId).single(),
    admin.from("setup_help").select("role, text, files, stuck, frustration, topic").eq("client_id", clientId).eq("step", step).order("created_at").limit(60),
    guideFor(admin, step),
  ]);
  if (!c) throw new Error("Not found");

  // Their screenshots and files, looked at directly
  const pdfs: { data: string; title: string }[] = [];
  const images: { mediaType: "image/jpeg"; data: string }[] = [];
  const notes: string[] = [];
  const mine = msg.files.filter((f) => f.path.startsWith(`${clientId}/`)).slice(0, 6);
  for (const f of mine) {
    const r = await readDoc(admin, { id: f.path, kind: "file", name: f.name, path: f.path, url: null, mime: f.mime }).catch(() => null);
    if (r?.image) images.push(r.image as { mediaType: "image/jpeg"; data: string });
    else if (r?.pdf) pdfs.push({ data: r.pdf, title: f.name });
    else if (r?.text) notes.push(`${f.name}: ${r.text.slice(0, 4000)}`);
    else notes.push(`${f.name}: couldn't be opened`);
  }

  // How long they've been stuck on the same thing: their turns since the last answer that got them unstuck
  const turns = prior ?? [];
  let tries = 1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "ai") continue;
    if (!turns[i].stuck) break;
    tries++;
  }
  const lastFrustration = [...turns].reverse().find((t) => t.role === "ai")?.frustration ?? 0;
  const mayOffer = tries >= TRIES_BEFORE_CALL;

  const out = await askJson<{ answer: string; stuck: boolean; frustration: number; topic: string; suggest_call: boolean; blocker: string; blocker_detail: string }>({
    agent: step === "google" || step === "tools" ? "google_launcher" : "launcher",
    label: `setup help ${c.name}`,
    bare: true,
    override: { model: "sonnet", effort: "low" },
    system: `You're Kaizen Marketing's setup helper inside a new client's onboarding guide, chatting with someone at ${c.name} who is trying to give us access to their ad accounts. Help them finish it now, step by step, like a patient expert sitting beside them.
How to answer: short and concrete (two to six sentences, or a few numbered clicks), one step at a time, using the exact names of the buttons and menus they'll see. When they share a screenshot, look at it closely: say what you see and exactly where to click next ("top left, the gear icon labeled Settings"). Ask for a screenshot when it would help. Warm, never condescending, no jargon without a plain explanation. Never ask for passwords or codes, and never tell them to share a login.
stuck: true when their message shows the same problem still isn't solved (it didn't work, they can't find it, an error); false when they're moving forward or asking something new.
blocker: a big issue they can't fix with clicks, from their words or screenshot: "restricted" (ad account restricted, disabled or under review; Account Quality warnings), "no_permission" (they're not an admin of the Business Manager / ad account / Page, or Google says they lack admin access; someone else owns it), "cant_create" (Meta or Google won't let them create a Business Manager or ad account, a limit, a block), "verification" (stuck on identity, business or two-factor verification), "billing" (payment method declined, unpaid balance blocking the account), "other" (anything else only our team can sort out). "" for ordinary how-do-I questions. blocker_detail: one plain sentence on exactly what's wrong (the account, the message they see), else "".
When there IS a blocker: don't keep them clicking around. Say plainly what it means, the one thing they can do now if any (e.g. who to ask for admin access, where Account Quality is), that our team has been told and will be ready for it on the onboarding call, and set suggest_call true.
frustration: 0 calm to 5 very frustrated, from their words and how they've changed over the conversation.
topic: a few words for what they're stuck on ("adding the partner", "can't find the Business ID field"), else "".
suggest_call: ${mayOffer ? `allowed now (this is try ${tries} on the same problem). Set it true only if they're clearly getting frustrated (around 3 or more, and rising) or ask to stop; then, after one last concrete tip, gently offer to save this for the onboarding call so it doesn't take more of their time ("we can do this together on our call, it takes two minutes there"). Otherwise keep helping and set false.` : "always false for now: keep helping (it's only offered after several tries and real frustration)."}`,
    schema: SCHEMA,
    maxTokens: 2500,
    images,
    pdfs,
    prompt: [
      guide,
      turns.length ? `<conversation_so_far>\n${turns.map((t) => `${t.role === "client" ? "Them" : "You"}: ${t.text}${((t.files ?? []) as { name: string }[]).length ? ` [shared ${((t.files ?? []) as { name: string }[]).map((f) => f.name).join(", ")}]` : ""}`).join("\n")}\n</conversation_so_far>` : "",
      `Their frustration last time: ${lastFrustration}/5. Tries on the current problem, counting this one: ${tries}.`,
      notes.length ? `<their_files>\n${notes.join("\n")}\n</their_files>` : "",
      `Their message: ${msg.text.trim() || "(sent a screenshot or file without words: work out what they need from it)"}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const blocker = out.blocker && out.blocker_detail ? { kind: out.blocker, detail: out.blocker_detail.slice(0, 400) } : null;
  // A big issue can go to the call right away; otherwise only after several frustrated tries
  const suggest = (mayOffer || Boolean(blocker)) && out.suggest_call;
  const files = mine.map((f) => ({ path: f.path, name: f.name }));
  const now = Date.now();
  const { data: rows } = await admin
    .from("setup_help")
    .insert([
      { client_id: clientId, step, role: "client", text: msg.text.trim().slice(0, 4000), files, by_name: by.name, contact_id: by.contactId, created_at: new Date(now).toISOString() },
      { client_id: clientId, step, role: "ai", text: out.answer, stuck: out.stuck, frustration: Math.max(0, Math.min(5, out.frustration)), suggest_call: suggest, topic: out.topic || null, blocker: blocker?.kind ?? null, blocker_detail: blocker?.detail ?? null, created_at: new Date(now + 1).toISOString() },
    ])
    .select("id, role, text, files, suggest_call, created_at");
  return { turns: (rows ?? []).map((r) => ({ id: r.id as string, role: r.role as "client" | "ai", text: r.text as string, files: ((r.files ?? []) as { name: string }[]).map((f) => f.name), at: r.created_at as string, suggestCall: Boolean(r.suggest_call) })), blocker };
}

/** What they were stuck on, for the team's note when it's saved for the call */
export async function helpSummary(admin: SupabaseClient, clientId: string, step: HelpStep) {
  const { data } = await admin.from("setup_help").select("role, text, topic").eq("client_id", clientId).eq("step", step).order("created_at", { ascending: false }).limit(12);
  const topic = (data ?? []).find((r) => r.role === "ai" && r.topic)?.topic as string | undefined;
  const asks = (data ?? []).filter((r) => r.role === "client" && r.text).slice(0, 3).map((r) => `"${String(r.text).slice(0, 140)}"`);
  return [topic && `Stuck on ${topic}.`, asks.length && `They asked: ${asks.reverse().join(" · ")}`].filter(Boolean).join(" ");
}
