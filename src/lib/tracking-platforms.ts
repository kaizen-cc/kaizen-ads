import type { PlatformStep } from "@/lib/platform-steps";

// The platforms a client's revenue and conversions live in, so the tracking team can connect them to the ads: how a
// restaurant takes orders (POS, online ordering), how a med spa or gym takes bookings, where a home-services or
// professional business keeps its leads (CRM, field service, call tracking), and an online store's subscription app.
// Which list a client sees follows their industry and sub-vertical. Each platform says how to add our tech address,
// or, where it can't add a user, that the tracking team takes a report export or an API handoff with them on the call
// (never a password). Plain data, shared by the guide, the setup help and the team.

export type TrackingKind = "orders" | "bookings" | "leads" | "store";

export const TRACKING_KINDS: Record<TrackingKind, { title: string; line: string; ask: string }> = {
  orders: { title: "How you take orders", line: "Your POS and online ordering", ask: "Which do you use to take orders? Pick all that apply." },
  bookings: { title: "How you take bookings", line: "Your booking or scheduling software", ask: "Which do you use to take bookings and payments? Pick all that apply." },
  leads: { title: "How you handle leads", line: "Your CRM, job software and call tracking", ask: "Where do your leads, jobs and calls go? Pick all that apply." },
  store: { title: "Your store's apps", line: "Subscriptions and anything that takes payments", ask: "Do you use any of these alongside your store? Pick all that apply." },
};

/**
 * A platform: who adds us ("tech": they invite our tech address; "call": it can't add a user, so a report export or
 * API handoff is set up with them on the call), the steps, and what the tracking team needs from it.
 */
export type TrackingPlatform = { key: string; name: string; kinds: TrackingKind[]; invite: "tech" | "call"; steps: PlatformStep[]; needs: string };

const invite = (where: string, how: string, url: string, role: string): PlatformStep[] => [
  { title: "Open the team settings", body: where, url, hit: "Add" },
  { title: "Add Kaizen", body: `${how ? `${how} ` : ""}Paste our address and give it **${role}**, then save. They email us the invite.`, url, panel: { title: "Add user", rows: ["Kaizen Marketing", "{tech}", `Access: ${role}`], hit: "Save" }, copy: "tech" },
];
const viaCall = (name: string): PlatformStep[] => [
  {
    title: "We'll connect it together",
    body: `${name} doesn't let you simply add us as a user, so our tracking team sets it up with you on the onboarding call: a **report export** or a **connection** from your account. Nothing to do now, and never share your password.`,
    url: "your account",
    hit: "On our call",
  },
];

export const TRACKING_PLATFORMS: TrackingPlatform[] = [
  // Restaurants: POS and online ordering
  { key: "toast", name: "Toast", kinds: ["orders"], invite: "tech", steps: invite("In **Toast Web** (toasttab.com, signed in as an owner or manager), open **Employees › Employees** and click **Add employee**.", "Name it Kaizen Marketing.", "toasttab.com/restaurants/admin/employees", "a job with reporting access (e.g. Manager)"), needs: "Sales by day and channel (dine-in, takeout, online), to match ad spend to orders" },
  { key: "square", name: "Square", kinds: ["orders", "bookings"], invite: "tech", steps: invite("In your **Square Dashboard**, open **Staff › Team members** and click **Add team member**.", "Name it Kaizen Marketing, and turn on dashboard access.", "app.squareup.com/dashboard/team", "a permission set with Reports"), needs: "Sales and appointments by day, to match ad spend to revenue" },
  { key: "clover", name: "Clover", kinds: ["orders"], invite: "tech", steps: invite("In your **Clover web dashboard**, open **Employees** and click **Add employee**.", "Name it Kaizen Marketing.", "www.clover.com/employees", "Manager (or a role with Reporting)"), needs: "Sales by day and order type" },
  { key: "spoton", name: "SpotOn", kinds: ["orders"], invite: "tech", steps: invite("In your **SpotOn dashboard**, open **Settings › Users** (or **Employees**) and click **Add user**.", "Name it Kaizen Marketing.", "restaurant.spoton.com", "reporting access"), needs: "Sales by day and channel" },
  { key: "olo", name: "Olo", kinds: ["orders"], invite: "call", steps: viaCall("Olo"), needs: "Online order counts and revenue by day, ideally by source" },
  { key: "lunchbox", name: "Lunchbox", kinds: ["orders"], invite: "call", steps: viaCall("Lunchbox"), needs: "Online order counts and revenue by day, and the ordering site for the pixel" },
  { key: "chownow", name: "ChowNow", kinds: ["orders"], invite: "call", steps: viaCall("ChowNow"), needs: "Online order counts and revenue by day" },
  { key: "owner", name: "Owner.com", kinds: ["orders"], invite: "call", steps: viaCall("Owner.com"), needs: "Online orders and revenue by day, and the site for tracking" },
  // Bookings: med spas, salons, fitness, health
  { key: "mindbody", name: "Mindbody", kinds: ["bookings"], invite: "tech", steps: invite("In **Mindbody** (Business mode), open **Staff › Staff management** and click **Add new staff member**.", "Name it Kaizen Marketing and give it a login.", "clients.mindbodyonline.com", "a permission group with Reports"), needs: "New clients, bookings and sales by day and source" },
  { key: "vagaro", name: "Vagaro", kinds: ["bookings"], invite: "tech", steps: invite("In **Vagaro**, open **Settings › Employees** and click **Add employee**.", "Name it Kaizen Marketing.", "www.vagaro.com/merchants/settings", "access to Reports"), needs: "Bookings and sales by day, new vs returning clients" },
  { key: "boulevard", name: "Boulevard", kinds: ["bookings"], invite: "tech", steps: invite("In **Boulevard**, open **Settings › Staff** and click **Add staff**.", "Name it Kaizen Marketing.", "dashboard.boulevard.io/settings/staff", "a role with reporting access"), needs: "Bookings and revenue by day and source" },
  { key: "acuity", name: "Acuity Scheduling", kinds: ["bookings"], invite: "tech", steps: invite("In **Acuity**, open **Business settings › Users, roles & permissions** and click **Add user**.", "Name it Kaizen Marketing.", "secure.acuityscheduling.com/app.php", "Admin (or reports access)"), needs: "Bookings by day, and the scheduler for conversion tracking" },
  { key: "calendly", name: "Calendly", kinds: ["bookings", "leads"], invite: "tech", steps: invite("In **Calendly**, open **Admin center › Users** and click **Invite users** (on a free plan there's no team: we'll connect it on the call instead).", "", "calendly.com/app/admin/users", "Admin"), needs: "Booked calls by day and source, and the booking page for conversion tracking" },
  { key: "zenoti", name: "Zenoti", kinds: ["bookings"], invite: "call", steps: viaCall("Zenoti"), needs: "Bookings and sales by day and source" },
  { key: "glossgenius", name: "GlossGenius", kinds: ["bookings"], invite: "call", steps: viaCall("GlossGenius"), needs: "Bookings and sales by day" },
  // Leads: home services, professional, real estate, legal, financial, automotive
  { key: "servicetitan", name: "ServiceTitan", kinds: ["leads"], invite: "call", steps: viaCall("ServiceTitan (each user is a paid seat)"), needs: "Booked jobs and revenue by campaign and lead source" },
  { key: "jobber", name: "Jobber", kinds: ["leads"], invite: "tech", steps: invite("In **Jobber**, open **Settings › Manage team** and click **Add user**.", "Name it Kaizen Marketing.", "secure.getjobber.com/manage_team", "access to Reports"), needs: "Requests, quotes and jobs by day and lead source" },
  { key: "housecallpro", name: "Housecall Pro", kinds: ["leads"], invite: "tech", steps: invite("In **Housecall Pro**, open **My company › Employees** and click **Add employee**.", "Name it Kaizen Marketing.", "pro.housecallpro.com/app/employees", "Admin (or reporting access)"), needs: "Jobs and revenue by lead source" },
  { key: "gohighlevel", name: "GoHighLevel", kinds: ["leads", "bookings"], invite: "tech", steps: invite("In **GoHighLevel**, open your sub-account's **Settings › My Staff** and click **Add employee**.", "Name it Kaizen Marketing.", "app.gohighlevel.com/settings/staff/team", "Admin"), needs: "Leads, opportunities and bookings by source" },
  { key: "hubspot", name: "HubSpot", kinds: ["leads"], invite: "tech", steps: invite("In **HubSpot**, click **Settings** (the gear) › **Users & Teams** › **Create user**.", "", "app.hubspot.com/settings/users", "Super admin (or Reports and Contacts access)"), needs: "Leads and deals by source, to send conversions back to the ad platforms" },
  { key: "salesforce", name: "Salesforce", kinds: ["leads"], invite: "call", steps: viaCall("Salesforce (each user is a paid license)"), needs: "Leads and opportunities by source, for offline conversions" },
  { key: "callrail", name: "CallRail", kinds: ["leads", "bookings"], invite: "tech", steps: invite("In **CallRail**, open **Settings › Users** and click **Add user**.", "", "app.callrail.com/settings/users", "Manager"), needs: "Calls by source and keyword, so phone leads count as conversions" },
  { key: "zoho", name: "Zoho CRM", kinds: ["leads"], invite: "tech", steps: invite("In **Zoho CRM**, open **Setup › Users** and click **New user**.", "Name it Kaizen Marketing.", "crm.zoho.com/crm/settings/users", "a profile with Reports"), needs: "Leads and deals by source" },
  // Online stores: subscriptions and payments beside the store
  { key: "recharge", name: "Recharge", kinds: ["store"], invite: "tech", steps: invite("In **Recharge**, open **Settings › Users & permissions** and click **Add user**.", "", "admin.rechargeapps.com", "Admin (or analytics access)"), needs: "New subscriptions and churn by day, to read subscription revenue from ads" },
  { key: "skio", name: "Skio", kinds: ["store"], invite: "call", steps: viaCall("Skio"), needs: "New subscriptions and churn by day" },
  { key: "loop", name: "Loop Subscriptions", kinds: ["store"], invite: "call", steps: viaCall("Loop"), needs: "New subscriptions and churn by day" },
  { key: "stripe", name: "Stripe", kinds: ["store", "leads", "bookings"], invite: "tech", steps: invite("In **Stripe**, open **Settings › Team and security** and click **Add member**.", "", "dashboard.stripe.com/settings/team", "Analyst (view only)"), needs: "Payments by day, to match ad spend to revenue" },
];

/** What the tracking team needs from a platform they named themselves */
export const OTHER_NEEDS = "Where orders, bookings or leads are recorded, by day and source";

/**
 * Which list a client sees: from their industry, with their sub-vertical's name settling the close calls (a salon or
 * spa takes bookings, a pizza place takes orders, a store sells online)
 */
export function trackingKind(industry: string | null | undefined, sub: string | null | undefined, ecommerce: boolean | null): TrackingKind | null {
  const s = (sub ?? "").toLowerCase();
  if (/restaurant|pizza|cafe|coffee|bar\b|bakery|food truck|catering|grill|taco|burger|kitchen/.test(s)) return "orders";
  if (/spa|salon|barber|lash|nail|aesthetic|gym|fitness|yoga|pilates|studio|clinic|dental|chiro|therapy|massage|wellness/.test(s)) return "bookings";
  if (/e-?commerce|online store|dtc|direct to consumer|subscription box|apparel|supplement/.test(s) || ecommerce) return "store";
  switch (industry) {
    case "restaurant":
      return "orders";
    case "med_spa":
    case "fitness":
    case "dental":
    case "medical":
    case "hospitality":
    case "entertainment":
      return "bookings";
    case "ecommerce":
    case "cpg":
      return "store";
    case "home_services":
    case "real_estate":
    case "legal":
    case "financial":
    case "professional":
    case "automotive":
    case "education":
      return "leads";
    default:
      return industry ? "leads" : null;
  }
}

/** The platforms offered for a kind: its own first */
export const platformsFor = (kind: TrackingKind) => TRACKING_PLATFORMS.filter((p) => p.kinds.includes(kind)).sort((a, b) => Number(b.kinds[0] === kind) - Number(a.kinds[0] === kind));
export const trackingPlatform = (key: string) => TRACKING_PLATFORMS.find((p) => p.key === key) ?? null;
