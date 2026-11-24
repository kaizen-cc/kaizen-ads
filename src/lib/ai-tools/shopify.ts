import "server-only";
import type { Staff } from "@/lib/auth";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { clientNamed } from "@/lib/client-named";
import { mayEditSetup, SETUP_REFUSAL } from "@/lib/setup-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { str, num, type AiTool } from "./types";

// Shopify, for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   store_revenue        a client's real store revenue for a period (orders, AOV, new customers, MER, channels, sources)
//   store_before_after   before and after a date (their Kaizen start by default): run-rates, growth, MER, every month,
//                        and ready-made slides for make_deck (case studies)
//   store_connections    which clients' stores are connected (and how far back), and who sells on Shopify unconnected
//   connect_shopify      the link that installs the Kaizen OS app on a client's store (execs and leads)
//   set_kaizen_start     the day a client started with Kaizen (execs and leads), the line before-and-after splits on
// Each shows on the client page's Store revenue card: open_screen with the client page (#store).

const NO_NUMBERS = "Store numbers aren't part of your view.";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function client(input: Record<string, unknown>) {
  try {
    return await clientNamed(await createClient(), str(input.client) ?? "");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Which client?" };
  }
}

const money = (n: number | null | undefined) => (n == null ? "–" : `$${Math.round(n).toLocaleString("en-US")}`);

const revenue: AiTool = {
  name: "store_revenue",
  description:
    "A client's real store revenue from their connected Shopify (not ad-platform attribution) for a period: store revenue (total sales less refunds), orders, AOV, new and returning customers, total ad spend (Meta + Google + TikTok, by platform), MER (store revenue / ad spend), sales by channel and by where buyers came from, and the same numbers for the period just before. start/end: YYYY-MM-DD (default: the last 30 days). Says so when no store is connected. Use it for 'how much did they sell', MER, true ROAS and whether ads grow the business.",
  input_schema: { type: "object", properties: { client: { type: "string" }, start: { type: "string" }, end: { type: "string" } }, required: ["client"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!seesAccountNumbers(user)) return { ok: false, error: NO_NUMBERS };
    const c = await client(input);
    if ("error" in c) return { ok: false, error: c.error };
    const t = nyToday();
    const end = str(input.end) && DAY.test(str(input.end)!) ? str(input.end)! : addDays(t, -1);
    const start = str(input.start) && DAY.test(str(input.start)!) ? str(input.start)! : addDays(end, -29);
    if (start > end) return { ok: false, error: "start is after end." };
    const r = await (await import("@/lib/shopify/store")).storeReport(createAdminClient(), c.id, { start, end });
    if (!r) return { ok: false, error: `${c.name} has no Shopify store connected. Connect it on their client page (Store revenue), or use connect_shopify.`, page: `/clients/${c.slug}#store` };
    return { ok: true, client: c.name, ...r, page: `/clients/${c.slug}#store` };
  },
};

const beforeAfterTool: AiTool = {
  name: "store_before_after",
  description:
    "Before and after a date from a client's real Shopify revenue: the client's Kaizen start by default (set on their page, else their first ad spend we have), or any date (a launch, a new offer). Gives each side's revenue, monthly run-rate, orders, AOV, new customers, ad spend and MER, growth % (after against before, by run-rate), every month for a chart, and deck_slides ready for make_deck (a stats slide and a bars slide). days: how many days each side (default: as many as there are since the date, up to a year); whole: true compares everything before with everything since. Use it for case studies ('Sierra Dreams before Kaizen vs after', 'Aldecoa from $0 to $50K a month').",
  input_schema: { type: "object", properties: { client: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD; leave out for their Kaizen start" }, days: { type: "number" }, whole: { type: "boolean" } }, required: ["client"], additionalProperties: false },
  run: async (user: Staff, input, chat) => {
    if (!seesAccountNumbers(user)) return { ok: false, error: NO_NUMBERS };
    const c = await client(input);
    if ("error" in c) return { ok: false, error: c.error };
    const r = await (await import("@/lib/shopify/store")).storeBeforeAfter(createAdminClient(), c.id, { pivot: str(input.date), days: num(input.days), whole: input.whole === true });
    if ("error" in r) return { ok: false, error: r.error, page: `/clients/${c.slug}#store` };
    const label = r.pivotSource === "asked" ? str(input.date)! : "joining Kaizen";
    const deck_slides = [
      {
        kind: "stats",
        title: `${c.name}: before and after ${label}`,
        stats: [
          { value: money(r.before.perMonth), label: "a month before", note: `${r.before.start} to ${r.before.end}` },
          { value: money(r.after.perMonth), label: "a month after", note: `${r.after.start} to ${r.after.end}` },
          { value: r.growthPct == null ? "new" : `${r.growthPct >= 0 ? "+" : ""}${r.growthPct}%`, label: "store revenue growth", note: "Shopify, run-rate" },
          ...(r.after.mer != null ? [{ value: `${r.after.mer}x`, label: "MER since", note: r.before.mer != null ? `${r.before.mer}x before` : "store revenue / ad spend" }] : []),
        ],
      },
      {
        kind: "bars",
        title: "Store revenue by month (Shopify)",
        bars: r.months.map((m) => ({ label: m.month, value: m.revenue, display: money(m.revenue), tone: m.month >= r.pivot.slice(0, 7) ? "good" : undefined })),
        note: `Months from ${r.pivot.slice(0, 7)} on are with Kaizen.`,
      },
    ];
    chat?.card({
      type: "list",
      title: `${c.name}: store revenue before and after ${label}`,
      items: [
        { title: `Before: ${money(r.before.perMonth)} a month`, detail: `${r.before.start} to ${r.before.end} · ${money(r.before.revenue)} total · ${r.before.orders} orders · MER ${r.before.mer ?? "–"}` },
        { title: `After: ${money(r.after.perMonth)} a month`, detail: `${r.after.start} to ${r.after.end} · ${money(r.after.revenue)} total · ${r.after.orders} orders · MER ${r.after.mer ?? "–"}`, tone: r.growthPct != null && r.growthPct >= 0 ? "ok" : "warn" },
        ...(r.growthPct != null ? [{ title: `Growth: ${r.growthPct >= 0 ? "+" : ""}${r.growthPct}%`, detail: "Monthly run-rate, after against before" }] : []),
      ],
    });
    return { ok: true, client: c.name, ...r, deck_slides, page: `/clients/${c.slug}#store` };
  },
};

const connections: AiTool = {
  name: "store_connections",
  description:
    "Which clients have their Shopify store connected (how far back their history is read, any errors), and which clients sell on Shopify but aren't connected yet, with why we think so (their website, their Klaviyo's orders, their onboarding answers) and their store address when known. which: 'connected', 'to_connect' or 'all' (default).",
  input_schema: { type: "object", properties: { which: { type: "string", enum: ["connected", "to_connect", "all"] } }, additionalProperties: false },
  run: async (_user: Staff, input) => {
    const db = await createClient();
    const which = str(input.which) ?? "all";
    const out: Record<string, unknown> = { ok: true };
    if (which !== "to_connect") {
      const { data } = await db.from("client_integrations").select("account, label, status, settings, last_synced_at, last_error, clients(name, slug)").eq("kind", "shopify").neq("status", "disconnected");
      out.connected = (data ?? []).map((r) => {
        const s = (r.settings ?? {}) as { backfill?: { done?: boolean; before?: string | null }; earliest?: string | null; auth?: string };
        const cl = r.clients as unknown as { name: string; slug: string } | null;
        return { client: cl?.name, store: r.label ?? r.account, shop: r.account, status: r.status, via: s.auth === "token" ? "custom app token" : "Kaizen OS app", history: s.backfill?.done ? `complete, from ${s.earliest}` : `reading, back to ${s.backfill?.before ?? "today"} so far`, lastRead: r.last_synced_at, error: r.last_error, page: cl ? `/clients/${cl.slug}#store` : null };
      });
    }
    if (which !== "connected") {
      const list = await (await import("@/lib/shopify/store")).shopifyToConnect(db);
      out.toConnect = list.map((x) => ({ client: x.name, shop: x.shop, why: x.evidence, page: `/clients/${x.slug}#store` }));
    }
    return out;
  },
};

const connect: AiTool = {
  name: "connect_shopify",
  description:
    "An exec or team lead: the link that installs the Kaizen OS Shopify app (read only) on a client's store. shop: their .myshopify.com address (looked up from their site or onboarding answers when left out). Opening the link takes the person to Shopify to approve; the client can also do it from their onboarding guide. Then open it with open_screen (href).",
  input_schema: { type: "object", properties: { client: { type: "string" }, shop: { type: "string" } }, required: ["client"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!mayEditSetup(user) || user.viewAs) return { ok: false, error: SETUP_REFUSAL };
    const c = await client(input);
    if ("error" in c) return { ok: false, error: c.error };
    const { shopDomain } = await import("@/lib/shopify/core");
    let shop = shopDomain(str(input.shop));
    if (!shop) {
      const { data } = await createAdminClient().from("client_store_hints").select("shop_domain").eq("client_id", c.id).maybeSingle();
      shop = shopDomain(data?.shop_domain as string | null);
    }
    if (!shop) return { ok: false, error: `What's ${c.name}'s store address (it ends in .myshopify.com)? Or open their page to connect it.`, page: `/clients/${c.slug}#store` };
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) return { ok: false, error: "The Kaizen OS Shopify app isn't set up yet (SHOPIFY_API_KEY and SHOPIFY_API_SECRET in Vercel). Meanwhile a custom app token can be pasted on their page.", page: `/clients/${c.slug}#store` };
    return { ok: true, client: c.name, shop, href: `/api/shopify/install?client=${c.id}&shop=${encodeURIComponent(shop)}`, note: "Opening it goes to Shopify to approve read-only access." };
  },
};

const setStart: AiTool = {
  name: "set_kaizen_start",
  description: "An exec or team lead: set the day a client started with Kaizen (YYYY-MM-DD), the line their store's before-and-after splits on (case studies, the client page). Say what you'll set and ask first.",
  input_schema: { type: "object", properties: { client: { type: "string" }, date: { type: "string" } }, required: ["client", "date"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!mayEditSetup(user) || user.viewAs) return { ok: false, error: SETUP_REFUSAL };
    const c = await client(input);
    if ("error" in c) return { ok: false, error: c.error };
    const date = str(input.date);
    if (!date || !DAY.test(date)) return { ok: false, error: "The date must be YYYY-MM-DD." };
    const { error } = await createAdminClient().from("clients").update({ kaizen_started_on: date }).eq("id", c.id);
    return error ? { ok: false, error: error.message } : { ok: true, client: c.name, startedWithKaizen: date, page: `/clients/${c.slug}#store` };
  },
};

export const tools: AiTool[] = [revenue, beforeAfterTool, connections, connect, setStart];
