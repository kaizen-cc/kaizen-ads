import "server-only";
import { DOC_KINDS, DOC_LABEL, PRICE_PLACEHOLDER } from "@/lib/documents/core";
import { clientNamedForTools, type ChatTool, type ToolCtx } from "./tools";
import type { DocumentCard } from "./types";
import { seesAccountNumbers, seesMoney } from "@/lib/ai-access-core";

// Documents for the assistant and Kaizen AI: Kaizen's package definitions for a Scope of Work (package_details), a
// client's wins from their own data for a handoff or recap (client_wins), and the branded PDF itself (create_document),
// kept with the client's documents and shown as a card to open, download, or edit and draw again. A price is only one
// that's stored; anything else is drawn as a clearly marked placeholder.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT = { type: "string", description: "The client's name (or slug). Leave out to use the client the thread is pinned to." };
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Every tool name here (the email and social teams get them too) */
export const DOCUMENT_TOOLS = ["package_details", "client_wins", "create_document"] as const;

const ITEMS = { type: "array", items: { type: "string" } };

export function documentTools(ctx: ToolCtx): ChatTool[] {
  const card = (c: DocumentCard) => {
    ctx.cards.push(c);
    return ctx.cards.length - 1;
  };
  const maybeClient = async (input: Record<string, unknown>) => (input.client || ctx.clientId ? await clientNamedForTools(ctx, input) : null);

  return [
    {
      name: "package_details",
      description:
        "Kaizen's package definitions for a service, before writing a Scope of Work or proposal: every tier (for email: the Sprint Package and Basic, Silver, Gold) with what it includes, the Email Strategist's knowledge on the packages (flows, campaigns a month, SMS, reporting cadence, inclusions and exclusions, as written), the client's own package and the prices that are stored (package records, or what Stripe bills them via Kaizen Track). Use only these for scope and price; never invent either.",
      input_schema: { type: "object", properties: { client: CLIENT, service: { type: "string", description: "email (default), meta, google, creative, social, web" }, tier: { type: "string", description: "The package asked about, e.g. Basic" } }, additionalProperties: false },
      status: (input) => `Reading Kaizen's ${clip(input.tier, 30) || ""} package${input.tier ? "" : "s"}…`.replace("  ", " "),
      run: async (input) => {
        const c = await maybeClient(input).catch(() => null);
        const { packageFacts } = await import("@/lib/documents/server");
        const f0 = await packageFacts(ctx.admin, c?.id ?? null, input.service, clip(input.tier, 40) || null);
        // What Stripe bills a client is billing, for the executives only; the package record's own prices are Kaizen's price list
        const f = seesMoney(ctx.me).ok ? f0 : { ...f0, stored: f0.stored.filter((p) => p.source === "package") };
        return {
          service: f.service,
          client: c?.name ?? null,
          their_package: f.clientTier,
          tiers: f.tiers,
          knowledge: f.knowledge,
          stored_prices: f.stored.map((p) => ({ label: p.label, amount: p.amount, cadence: p.cadence, from: p.source === "package" ? "package record" : "what Stripe bills them now" })),
          price_rule: f.stored.length
            ? `Quote only these amounts, in the pricing table. Anything else is drawn as "${PRICE_PLACEHOLDER}".`
            : `No price is stored for this package: leave the price out of the pricing line and it's drawn as "${PRICE_PLACEHOLDER}". Say so when you hand it over.`,
          ...(f.knowledge.length || f.tiers.length ? {} : { note: "No package definitions found: ask what's in the package rather than guessing." }),
        };
      },
    },
    {
      name: "client_wins",
      description:
        "A client's wins from their own data, for a handoff, recap or renewal email: email revenue and list growth (last 30 days against the 30 before), subscribers on their main lists, flows live and the key flows, emails and flows we built and shipped on the Email Board, sprint moves done (forms, integrations, fixes), with dates. Quote these numbers as they are.",
      input_schema: { type: "object", properties: { client: CLIENT, since: { type: "string", description: "YYYY-MM-DD: what we shipped from this day (default 90 days ago)" } }, additionalProperties: false },
      status: (input, client) => `Pulling the wins for ${clip(input.client, 40) || client || "the client"}…`,
      run: async (input) => {
        if (!seesAccountNumbers(ctx.me)) return { error: "Account numbers aren't part of your view." };
        const c = await clientNamedForTools(ctx, input);
        const since = DAY.test(String(input.since ?? "")) ? String(input.since) : new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const [{ clientKlaviyo }, tickets, sprints] = await Promise.all([
          import("@/lib/klaviyo/store"),
          ctx.admin.from("email_tickets").select("number, kind, title, stage, live_at, trigger").eq("client_id", c.id).is("deleted_at", null).gte("created_at", `${since}T00:00:00Z`).order("created_at", { ascending: true }).limit(60),
          ctx.admin.from("email_sprints").select("id, status, started_at, closed_at, baseline, latest").eq("client_id", c.id).gte("started_at", `${since}T00:00:00Z`).order("started_at", { ascending: false }).limit(3),
        ]);
        const sprintIds = (sprints.data ?? []).map((s) => s.id as string);
        const { data: moves } = sprintIds.length ? await ctx.admin.from("email_sprint_actions").select("title, area, status, done_at").in("sprint_id", sprintIds).eq("status", "done").limit(40) : { data: [] };
        const k = await clientKlaviyo(ctx.admin, c.id).catch(() => null);
        const shipped = (tickets.data ?? []).filter((t) => t.live_at || t.stage === "live");
        const score = (j: unknown) => (j && typeof j === "object" && "score" in j ? Number((j as { score: unknown }).score) : null);
        const lists = (k?.audiences ?? []).filter((a) => a.kind === "list" && a.profiles != null).sort((a, b) => Number(b.profiles) - Number(a.profiles));
        return {
          client: c.name,
          since,
          email: k
            ? {
                source: k.providerName,
                revenue_last_30_days: k.revenueMeasured ? r2(k.now.revenue) : null,
                revenue_30_days_before: k.revenueMeasured ? r2(k.before.revenue) : null,
                flow_revenue_last_30_days: k.revenueMeasured ? r2(k.now.flowRevenue) : null,
                ...(k.revenueMeasured ? {} : { revenue_note: `${k.providerName} reports no revenue for this client: don't quote revenue.` }),
                list_growth_30d: k.now.listGrowth,
                main_lists: lists.slice(0, 4).map((a) => ({ name: a.name, subscribers: a.profiles, growth_30d: a.growth?.change ?? null })),
                flows_live: k.flows.filter((f) => String(f.status ?? "").toLowerCase() === "live").map((f) => ({ name: f.name, revenue_30d: r2(f.revenue30) })),
                key_flows: k.keyFlows.map((f) => ({ flow: f.label, state: f.state })),
                open_rate_pct: k.now.openRate == null ? null : Math.round(k.now.openRate * 1000) / 10,
                click_rate_pct: k.now.clickRate == null ? null : Math.round(k.now.clickRate * 1000) / 10,
              }
            : { connected: false, note: "Their email platform isn't connected, so there are no email numbers." },
          shipped_on_the_email_board: shipped.map((t) => ({ number: t.number, kind: t.kind, title: t.title, live: (t.live_at as string | null)?.slice(0, 10) ?? null, trigger: t.trigger })),
          in_progress: (tickets.data ?? []).filter((t) => !t.live_at && t.stage !== "live").map((t) => ({ number: t.number, kind: t.kind, title: t.title, stage: t.stage })),
          sprint: (sprints.data ?? []).map((s) => ({ status: s.status, started: (s.started_at as string).slice(0, 10), closed: (s.closed_at as string | null)?.slice(0, 10) ?? null, score_at_start: score(s.baseline), score_now: score(s.latest) })),
          sprint_moves_done: (moves ?? []).map((m) => ({ title: m.title, area: m.area, done: (m.done_at as string | null)?.slice(0, 10) ?? null })),
          note: "Lead with the strongest two or three numbers. A handoff document can quote these figures (dataFigures); never add a price.",
        };
      },
    },
    {
      name: "create_document",
      description: `Makes a Kaizen-branded PDF (the look of Kaizen's reports: Kaizen's mark beside the client's logo, a period band, clean sections and tables) from content you write: sow (a Scope of Work), proposal, handoff (a handoff or recap of what we did and the wins) or one_pager. It's kept with the client's documents and shown as a card to open, download, or edit the text and draw again. Write the finished content in one call. For a Scope of Work, read package_details first and build deliverables, cadence, inclusions and exclusions from it; pricing lines only carry a price that's stored (package_details has every tier's) or one the person confirmed in this conversation (also list those in confirmed_prices, every time); leave price out otherwise: it's drawn as "${PRICE_PLACEHOLDER}". Read what they asked for: an SOW "to pitch" ongoing work is a pitch proposal (lead with the tier they'd start on, the milestones as the path to the next tier), not a record of a signed scope. For a handoff, read client_wins and the handoff doc first; put the headline numbers in stats and list them in data_figures. Plain words, no em dashes, roles not names. To change one you made, pass its document_id with the whole new content. To attach it to an email, give its document_id to draft_message (attach).`,
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...DOC_KINDS] },
          client: CLIENT,
          service: { type: "string", description: "Whose prices apply: email (default), meta, google, creative, social, web" },
          title: { type: "string" },
          subtitle: { type: "string" },
          period: { type: "string", description: "The band under the title, e.g. 'December 2026 onward' or 'Sep 15 to Nov 15, 2026'" },
          summary: { type: "string", description: "The opening paragraph: what this is and why it matters to them" },
          stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, note: { type: "string" } }, required: ["value", "label"] }, description: "Up to 4 headline numbers (wins)" },
          sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" }, bullets: ITEMS }, required: ["heading"] } },
          deliverables: { type: "array", items: { type: "object", properties: { item: { type: "string" }, qty: { type: "string" }, detail: { type: "string" } }, required: ["item"] } },
          cadence: { type: "array", items: { type: "object", properties: { what: { type: "string" }, when: { type: "string" } }, required: ["what", "when"] } },
          pricing: { type: "array", items: { type: "object", properties: { item: { type: "string" }, price: { type: "string", description: "Only a stored price from package_details; leave out otherwise" }, cadence: { type: "string" }, note: { type: "string" } }, required: ["item"] } },
          inclusions: ITEMS,
          exclusions: ITEMS,
          next_steps: ITEMS,
          data_figures: { type: "array", items: { type: "number" }, description: "Dollar figures quoted from their own data (revenue won), so they aren't taken for prices" },
          document_id: { type: "string", description: "A document you made, to draw again with this content" },
          confirmed_prices: { type: "array", items: { type: "object", properties: { item: { type: "string" }, amount: { type: "number" }, cadence: { type: "string", enum: ["month", "one_time"] } }, required: ["item", "amount"] }, description: "Prices the person confirmed in this conversation (\"Basic is $1,000 a month\"): they're printed instead of a placeholder. Pass every one they confirmed, each time you draw it again." },
        },
        required: ["kind", "title"],
        additionalProperties: false,
      },
      status: (input, client) => `Making the ${DOC_LABEL[(DOC_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as (typeof DOC_KINDS)[number]) : "one_pager"]}${clip(input.client, 40) || client ? ` for ${clip(input.client, 40) || client}` : ""}…`,
      run: async (input) => {
        const c = await maybeClient(input);
        const id = /^[0-9a-f-]{36}$/i.test(String(input.document_id ?? "")) ? String(input.document_id) : null;
        if (id) {
          // Their own document, or one on a client they can see (their session decides)
          const { data: mine } = await ctx.db.from("kaizen_documents").select("id").eq("id", id).maybeSingle();
          if (!mine) return { made: false, error: "That document isn't one you can change. Make a new one instead." };
        }
        const figures = (Array.isArray(input.data_figures) ? input.data_figures : []).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 30);
        const { makeDocument } = await import("@/lib/documents/server");
        const { confirmedPrices } = await import("@/lib/documents/core");
        const confirmed = confirmedPrices(input.confirmed_prices, ctx.said ?? "", Boolean(ctx.me.isExec));
        const made = await makeDocument({ admin: ctx.admin, me: { id: ctx.me.id, fullName: ctx.me.fullName }, client: c ? { id: c.id, name: c.name } : null, loose: input, service: input.service, dataFigures: figures, id, confirmed });
        card({ type: "document", id: made.id, kind: made.kind, title: made.title, client: made.client, version: made.version, href: made.href, download: made.download, placeholders: made.placeholders });
        return {
          made: true,
          document_id: made.id,
          version: made.version,
          open: made.href,
          file: made.fileName,
          ...(made.placeholders.length ? { placeholders: made.placeholders, note: `These are drawn as "${PRICE_PLACEHOLDER}" because no price is stored for them: say so in a line. The card is on screen.` } : { note: "The card is on screen (Open, Download, Edit). Say what's in it in a line; don't repeat it." }),
          ...(c ? { filed: `In ${c.name}'s documents` } : {}),
        };
      },
    },
  ];
}
