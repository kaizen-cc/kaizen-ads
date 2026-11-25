import "server-only";
import { DOC_KINDS, DOC_LABEL, PRICE_PLACEHOLDER } from "@/lib/documents/core";
import type { TemplateKey } from "@/lib/kaizen-docs/templates";
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
export const DOCUMENT_TOOLS = ["package_details", "client_wins", "make_document", "move_document", "create_document", "rate_card", "set_rate_card", "create_case_study", "upload_to_drive", "run_after_call"] as const;

const ITEMS = { type: "array", items: { type: "string" } };

/** What the assistant wrote for an email SOW, as the generator's brief: its draft content and what the person said */
function sowBrief(input: Record<string, unknown>, said: string | undefined): string {
  const keep = { ...input };
  for (const k of ["client", "document_id", "confirmed_prices", "service"]) delete keep[k];
  return [said ? `The person said: ${said}` : "", `The assistant's notes and draft for it: ${JSON.stringify(keep)}`].filter(Boolean).join("\n\n");
}

export function documentTools(ctx: ToolCtx): ChatTool[] {
  const card = (c: DocumentCard) => {
    ctx.cards.push(c);
    return ctx.cards.length - 1;
  };
  const maybeClient = async (input: Record<string, unknown>) => (input.client || ctx.clientId ? await clientNamedForTools(ctx, input) : null);

  /** Makes a Kaizen document in Google and puts its card on screen */
  const makeDoc = async (o: { template: TemplateKey | null; client: { id: string; name: string } | null; prospect: string | null; ask: string; brief: string; prices: { label: string; amount: number; cadence: "one_time" | "month" }[]; line: string | null; title: string | null; replaces?: string | null; folder?: unknown; confirmed?: unknown }) => {
    if (ctx.me.viewAs) return { made: false, error: "While viewing as someone, nothing is made in their Google Drive." };
    const { makeKaizenDoc } = await import("@/lib/kaizen-docs/server");
    const r = await makeKaizenDoc({ admin: ctx.admin, me: { id: ctx.me.id, fullName: ctx.me.fullName, email: ctx.me.email, isExec: ctx.me.isExec, isLead: ctx.me.isLead, role: ctx.me.role }, ask: o.ask, template: o.template, client: o.client, prospect: o.prospect, brief: o.brief, confirmed: o.prices, line: o.line, title: o.title, folder: typeof o.folder === "string" ? o.folder : null, folderYes: o.confirmed === true });
    if (!r.ok) return "where" in r ? r.where : { made: false, error: r.error, ...(r.ask ? { ask_them: r.ask } : {}) };
    card({ type: "document", id: r.id, kind: r.template === "proposal" ? "proposal" : "sow", title: r.title, client: o.client?.name ?? o.prospect ?? null, version: 1, href: r.url, download: r.pdf ?? r.url, placeholders: r.placeholders, google: { url: r.url, kind: r.kind, place: r.place } });
    return {
      made: true,
      document_id: r.id,
      google_link: r.url,
      kind: r.kind === "slides" ? "Google Slides" : "Google Doc",
      filed_in: r.place,
      folder: r.folderUrl,
      say: r.saved,
      ...(r.placeholders.length ? { still_to_fill: r.placeholders } : {}),
      ...(r.rateCardEmpty && r.placeholders.some((p) => /price/i.test(p)) ? { prices: "Kaizen's rate card is empty, so the fees are marked [Price to confirm]. Ask them for the prices (one question listing each), then make it again with confirmed_prices." } : {}),
      ...(o.replaces ? { note_on_versions: "Made as a new Google file; the earlier one stays in Drive." } : {}),
      note: "The card is on screen with the Google link (it opens in a new tab). Say the saved line (the file's link and its folder path) and what it is in a line; mention anything still to fill. To email it, give document_id to draft_message (attach): the PDF goes with it.",
    };
  };

  return [
    {
      name: "make_document",
      description: `Makes a client-facing Kaizen document as a Google file in the house style, in the person's Google Drive, in the Drive folder settled first (the Drive rule): the folder they named or linked, else the one they used last time for this client and kind of document, else Kaizen's default (a client's Headquarters › Proposals & SOWs; a prospect's Kaizen Sales › Prospects › <name>), said back as "Saving to <path>, OK?" before anything is written; on their yes call again with the same content and confirmed: true. Never guess a folder, and use My Drive's top level only when they ask for it (\"my drive\", or its link; confirmed once); when it can't be found, ask for the link. Returns the file's link and folder path. Templates: proposal (a sales proposal deck, Google Slides: pitch new work), quote (a project quote for a one-time build like a website, Google Doc), sow (a Scope of Work for a retainer, sprint or tier options, Google Doc; an email SOW is written by the Email SOW Generator), doc (any other document: a plan, audit, client brief, recap, in the SOW look) or deck (any other deck, in the proposal look). Leave template out to pick it from what they asked; if it says it's unclear, ask once. Proposals, quotes and SOWs are for the executives and line heads. Look things up first (get_client_context, package_details, client_wins, their KPIs, calls) and put what matters in brief with what they said; never ask what Kaizen OS already knows. Prices: only the rate card (rate_card), the email packages, or prices they confirmed (confirmed_prices, every time); anything else is marked [Price to confirm]. When the rate card is empty, ask for the prices once.`,
      input_schema: {
        type: "object",
        properties: {
          template: { type: "string", enum: ["proposal", "quote", "sow", "doc", "deck"] },
          ask: { type: "string", description: "What they asked for, in their words" },
          client: CLIENT,
          prospect: { type: "string", description: "A prospect's business name, when it isn't a client yet" },
          title: { type: "string" },
          line: { type: "string", description: "The service line it's about: email, meta, google, social, creative, web" },
          brief: { type: "string", description: "Everything the writer needs: what you looked up (numbers, package, services, call notes), their answers, the scope, timeline and terms they gave" },
          confirmed_prices: { type: "array", items: { type: "object", properties: { item: { type: "string" }, amount: { type: "number" }, cadence: { type: "string", enum: ["month", "one_time"] } }, required: ["item", "amount"] }, description: "Prices they confirmed in this conversation (relationship pricing). Pass every one, each time." },
          folder: { type: "string", description: "The Drive folder they named or linked in this conversation (its link, or its path like Shared drive/Folder)" },
          confirmed: { type: "boolean", description: "true only after they said yes to the folder you said back (Saving to <path>, OK?)" },
        },
        required: ["ask"],
        additionalProperties: false,
      },
      status: (input, client) => `Making the ${clip(input.template, 20) || "document"} in Google${clip(input.client, 40) || clip(input.prospect, 40) || client ? ` for ${clip(input.client, 40) || clip(input.prospect, 40) || client}` : ""}…`,
      run: async (input) => {
        const c = input.client || ctx.clientId ? await maybeClient(input).catch(() => null) : null;
        const { confirmedPrices } = await import("@/lib/documents/core");
        const { isTemplate } = await import("@/lib/kaizen-docs/templates");
        const confirmed = confirmedPrices(input.confirmed_prices, ctx.said ?? "", Boolean(ctx.me.isExec));
        return makeDoc({ template: isTemplate(input.template) ? input.template : null, client: c ? { id: c.id, name: c.name } : null, prospect: c ? null : clip(input.prospect, 120) || null, ask: clip(input.ask, 4000), brief: clip(input.brief, 16000), prices: confirmed.map((p) => ({ label: p.label, amount: p.amount, cadence: p.cadence === "one_time" ? "one_time" : "month" })), folder: input.folder, confirmed: input.confirmed, line: clip(input.line, 30) || null, title: clip(input.title, 200) || null });
      },
    },
    {
      name: "move_document",
      description: "Moves a Kaizen document already in Google Drive (its document_id) into another folder, under the Drive rule: the folder they named or linked (folder), or the one said back for a yes (confirmed: true after it). Use it when a prospect's proposal should now go into the client's folder, or they ask to move one. Returns the file's link and its new folder path.",
      input_schema: { type: "object", properties: { document_id: { type: "string" }, folder: { type: "string" }, confirmed: { type: "boolean" } }, required: ["document_id"], additionalProperties: false },
      status: () => "Moving it in Drive…",
      run: async (input) => {
        if (ctx.me.viewAs) return { moved: false, error: "While viewing as someone, nothing is moved in their Drive." };
        const id = /^[0-9a-f-]{36}$/i.test(String(input.document_id ?? "")) ? String(input.document_id) : null;
        const { data: d } = id ? await ctx.db.from("kaizen_documents").select("id, template, client_id, prospect_name, google_id").eq("id", id).maybeSingle() : { data: null };
        if (!d?.google_id) return { moved: false, error: "That isn't a Google document you can move." };
        const { data: c } = d.client_id ? await ctx.db.from("clients").select("id, name").eq("id", d.client_id as string).maybeSingle() : { data: null };
        const { docDestination } = await import("@/lib/kaizen-docs/destination");
        const { isTemplate } = await import("@/lib/kaizen-docs/templates");
        const where = await docDestination({ admin: ctx.admin, me: { id: ctx.me.id, email: ctx.me.email }, template: isTemplate(d.template) ? d.template : "doc", client: c ? { id: c.id as string, name: c.name as string } : null, prospect: (d.prospect_name as string | null) ?? null, folder: typeof input.folder === "string" ? input.folder : null, confirmed: input.confirmed === true });
        if ("reply" in where) return where.reply;
        const { moveToDestination, rememberDestination } = await import("@/lib/drive-destination");
        const { pathText, savedLine } = await import("@/lib/drive-destination-core");
        const m = await moveToDestination(ctx.me.email, d.google_id as string, where.save);
        await rememberDestination(ctx.admin, where.key, m.dest).catch(() => undefined);
        await ctx.admin.from("kaizen_documents").update({ folder_id: m.dest.id, folder_place: pathText(m.dest.path), updated_at: new Date().toISOString() }).eq("id", d.id);
        return { moved: true, link: m.link, folder_path: pathText(m.dest.path), say: savedLine(m.link, m.dest) };
      },
    },
    {
      name: "rate_card",
      description: "Kaizen's rate card: the starting prices documents quote, per service line and tier, one-time or monthly (the executives keep it in Settings › Rate card). Empty means no prices are set yet: ask for the prices instead of guessing.",
      input_schema: { type: "object", properties: { service: { type: "string", description: "Only this line (email, meta, google, social, creative, web)" } }, additionalProperties: false },
      status: () => "Reading the rate card…",
      run: async (input) => {
        let q = ctx.db.from("rate_card").select("id, service, tier, label, cadence, amount, note").eq("active", true).order("service").order("sort_order");
        if (input.service) q = q.ilike("service", `${clip(input.service, 30)}%`);
        const { data } = await q;
        return (data ?? []).length ? { rates: data, note: "A different price agreed with a client is relationship pricing: pass it in confirmed_prices." } : { rates: [], empty: true, note: "The rate card is empty: ask for the prices (one question listing each)." };
      },
    },
    {
      name: "set_rate_card",
      description: "Adds, changes or removes a price on Kaizen's rate card (executives only): service (email, meta, google, social, creative, web), tier (optional, e.g. Basic), label (what it is), cadence (one_time or month), amount. remove: true with its id takes it off. Say it back and ask first; confirmed: true after their yes.",
      input_schema: { type: "object", properties: { id: { type: "string" }, service: { type: "string" }, tier: { type: "string" }, label: { type: "string" }, cadence: { type: "string", enum: ["one_time", "month"] }, amount: { type: "number" }, note: { type: "string" }, remove: { type: "boolean" }, confirmed: { type: "boolean" } }, additionalProperties: false },
      status: () => "Updating the rate card…",
      run: async (input) => {
        if (!ctx.me.isExec) return { done: false, error: "Only the executives change the rate card." };
        if (input.confirmed !== true) return { done: false, note: "Say the change back and ask; run again with confirmed: true after their yes." };
        const { setRate } = await import("@/lib/kaizen-docs/rate-card");
        const r = await setRate(ctx.db, ctx.me.id, input);
        return r.ok ? { done: true, ...r } : { done: false, error: r.error };
      },
    },
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
      description: `The older name for make_document (it makes the same Google file): sow is a Scope of Work, proposal a sales proposal deck, handoff and one_pager a Kaizen document. Prefer make_document. Plain words, no em dashes, roles not names.`,
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
          folder: { type: "string", description: "The Drive folder they named or linked in this conversation (its link, or its path like Shared drive/Folder)" },
          confirmed: { type: "boolean", description: "true only after they said yes to the folder you said back (Saving to <path>, OK?)" },
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
        // Every document is made in Google now (src/lib/kaizen-docs): the content written here is the brief
        const { confirmedPrices } = await import("@/lib/documents/core");
        const confirmed = confirmedPrices(input.confirmed_prices, ctx.said ?? "", Boolean(ctx.me.isExec));
        const template = input.kind === "sow" ? "sow" : input.kind === "proposal" ? "proposal" : "doc";
        return makeDoc({ template, client: c, prospect: null, ask: `${clip(input.title, 200)}${ctx.said ? `. They said: ${clip(ctx.said, 1500)}` : ""}`, brief: sowBrief(input, ctx.said), prices: confirmed.map((p) => ({ label: p.label, amount: p.amount, cadence: p.cadence === "one_time" ? "one_time" : "month" })), folder: input.folder, confirmed: input.confirmed, line: String(input.service ?? "") || null, title: clip(input.title, 200) || null, replaces: id });
      },
    },
    {
      name: "create_case_study",
      description:
        "Makes a client-ready case study PDF in Kaizen's own case-study look (dark, bold, charts of the months), from the client's real monthly numbers (each ad account's spend, results and value from the synced data, email and store revenue) and their context: the wins first, the story of how we got them, every number true, nothing invented, never a price, a placeholder or next steps. It takes a minute. notes: what they asked for (what to feature, what to leave out, the angle). accent: a different accent colour (hex) only if they ask. It's kept with the client's documents and shown as a card; put it in their Drive with upload_to_drive. For several clients at once, or when they're signing off, use run_after_call.",
      input_schema: { type: "object", properties: { client: CLIENT, notes: { type: "string" }, accent: { type: "string", description: "A hex colour, e.g. #e11d2e (Kaizen red, the default)" }, document_id: { type: "string", description: "A case study you made, to make again" } }, additionalProperties: false },
      status: (input, client) => `Writing the case study for ${clip(input.client, 40) || client || "the client"}…`,
      run: async (input) => {
        if (!seesAccountNumbers(ctx.me)) return { made: false, error: "Case studies are built from account numbers, which aren't part of your view." };
        const c = await clientNamedForTools(ctx, input);
        const { writeCaseStudy, makeCaseStudy } = await import("@/lib/documents/case-study-server");
        const cs = await writeCaseStudy(ctx.admin, { id: c.id, name: c.name }, clip(input.notes, 2000));
        if (typeof input.accent === "string" && /^#[0-9a-f]{6}$/i.test(input.accent.trim())) cs.accent = input.accent.trim().toLowerCase();
        const id = /^[0-9a-f-]{36}$/i.test(String(input.document_id ?? "")) ? String(input.document_id) : null;
        const made = await makeCaseStudy(ctx.admin, { id: ctx.me.id }, { id: c.id, name: c.name }, cs, id);
        ctx.cards.push({ type: "link", title: `Case study: ${c.name}`, detail: made.title, href: made.href, cta: "Open the case study", external: false });
        return { made: true, document_id: made.id, version: made.version, title: made.title, results: cs.results.map((r) => `${r.value} ${r.label}`), charts: cs.charts.map((x) => x.title), note: "The card is on screen. Say the headline in a line; put it in Drive with upload_to_drive when they asked for that." };
      },
    },
    {
      name: "upload_to_drive",
      description:
        "Puts documents Kaizen OS made (case studies, SOWs, proposals: their document_id) into Google Drive, as the person. The Drive rule: folder is the one they named or linked in this conversation (its link, or its path as they say it: \"00-Business Manifesto/08-Kaizen Content\"); leave folder out when they didn't name one, and it proposes the folder they confirmed last time for this client and kind of document (say its 'say' line, then call again with confirmed: true on their yes) or tells you to ask. Never pick a folder yourself; My Drive's top level only when they ask for it (folder: \"my drive\", confirmed once). subfolder: folders inside it (\"Case Studies\" or \"08-Kaizen Content/Case Studies\"); only the last one is made when missing. Several matching folders come back as candidates to ask about; a folder that isn't found, say so. After saving, give each file's link and the folder's path. A file of the same name there is replaced with the new version.",
      input_schema: {
        type: "object",
        properties: { document_ids: ITEMS, folder: { type: "string", description: "The Drive folder link or path they named in this conversation; leave out otherwise" }, subfolder: { type: "string" }, confirmed: { type: "boolean", description: "True only after they said yes to the proposed folder" } },
        required: ["document_ids"],
        additionalProperties: false,
      },
      status: () => "Putting it in Drive…",
      run: async (input) => {
        if (ctx.me.viewAs) return { error: "While viewing as someone, nothing is put in their Drive." };
        const ids = (Array.isArray(input.document_ids) ? input.document_ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
        if (!ids.length) return { error: "Which documents? Use their document_id." };
        const { uploadToFolder, documentBytes } = await import("@/lib/drive-push");
        const { destinationForSave, rememberDestination } = await import("@/lib/drive-destination");
        const { pathText, savedLine } = await import("@/lib/drive-destination-core");
        const docs: { id: string; name: string; bytes: Uint8Array; clientId: string | null; kind: string }[] = [];
        for (const id of ids) {
          const d = await documentBytes(ctx.db, ctx.admin, id);
          if (d) docs.push({ id, ...d });
        }
        if (!docs.length) return { error: "None of those documents are ones you can see." };
        const key = { profileId: ctx.me.id, clientId: docs[0].clientId, docType: docs[0].kind };
        const where = await destinationForSave(ctx.admin, { email: ctx.me.email, key, folder: input.folder, subfolder: input.subfolder, confirmed: input.confirmed });
        if ("reply" in where) return where.reply;
        const dest = where.save;
        const out: { file: string; link: string | null }[] = [];
        for (const d of docs) {
          const up = await uploadToFolder(ctx.me.email, dest.id, d.name, d.bytes, "application/pdf");
          out.push({ file: d.name, link: up.link });
        }
        await rememberDestination(ctx.admin, key, dest);
        if (dest.link) ctx.cards.push({ type: "link", title: `In Drive: ${pathText(dest.path)}`, detail: `${out.length} file${out.length === 1 ? "" : "s"}${dest.made ? ", in a new folder" : ""}`, href: dest.link, cta: "Open the folder", external: true });
        return { saved: out.length, folder_path: pathText(dest.path), folder_link: dest.link, made_folder: Boolean(dest.made), files: out, say: out.map((f) => savedLine(f.link, dest)).join(" "), ...(docs.length < ids.length ? { not_found: ids.length - docs.length } : {}) };
      },
    },
    {
      name: "run_after_call",
      description:
        "Keeps working after the call or chat ends: case studies for a list of clients, each written, drawn and (when they named a folder) put into their Google Drive, one after another in the background. They're told in the app as each one is ready, with the file linked. Use it when they ask for several at once or are signing off (\"I'm going to bed, do all of these\"); never say you can only work while they're on the call. Say the list back and ask once; confirmed: true after their yes.",
      input_schema: {
        type: "object",
        properties: {
          clients: { type: "array", items: { type: "object", properties: { client: { type: "string" }, notes: { type: "string", description: "What to feature or leave out for this one" } }, required: ["client"], additionalProperties: false } },
          notes: { type: "string", description: "What applies to all of them" },
          folder: { type: "string", description: "A Drive folder link or path to put them in (optional)" },
          subfolder: { type: "string", description: "A folder inside it, made when needed (e.g. Case Studies)" },
          confirmed: { type: "boolean", description: "True only after they said yes to this list" },
        },
        required: ["clients"],
        additionalProperties: false,
      },
      status: () => "Lining up the work…",
      run: async (input) => {
        if (ctx.me.viewAs) return { error: "While viewing as someone, nothing is started as them." };
        if (!seesAccountNumbers(ctx.me)) return { error: "Case studies are built from account numbers, which aren't part of your view." };
        const asked = (Array.isArray(input.clients) ? input.clients : []).slice(0, 20) as { client?: unknown; notes?: unknown }[];
        if (!asked.length) return { error: "Which clients?" };
        const items: { client_id: string; client: string; notes: string }[] = [];
        const unknown: string[] = [];
        for (const a of asked) {
          try {
            const c = await clientNamedForTools(ctx, { client: a.client });
            items.push({ client_id: c.id, client: c.name, notes: [clip(input.notes, 1000), clip(a.notes, 1000)].filter(Boolean).join(" ") });
          } catch (e) {
            unknown.push(`${clip(a.client, 60)}: ${e instanceof Error ? e.message : "not found"}`);
          }
        }
        if (unknown.length) return { queued: false, unknown, note: "Some names didn't match a client you can see: ask about these first (offer the closest match), then queue them all together." };
        // The Drive rule: only the folder they named here, found now (several matches: ask; not found: say so)
        let folder: string | null = null;
        let folderPath: string | null = null;
        if (clip(input.folder, 500)) {
          const { findDestination } = await import("@/lib/drive-destination");
          const { pathText, subPath } = await import("@/lib/drive-destination-core");
          const f = await findDestination(ctx.me.email, clip(input.folder, 500), null, "find");
          if ("ask" in f) return { queued: false, candidates: f.ask.map((d) => ({ path: pathText(d.path), link: d.link })), say: f.say };
          if ("notFound" in f) return { queued: false, folder_not_found: true, say: `${f.notFound} Or queue them without Drive.` };
          folder = `https://drive.google.com/drive/folders/${f.dest.id}`;
          folderPath = pathText([...f.dest.path, ...subPath(clip(input.subfolder, 200))]);
        }
        if (input.confirmed !== true) return { queued: false, list: items.map((i) => i.client), drive_folder: folderPath ?? "none: kept in Kaizen OS only", note: "Say the list back in one line with the Drive folder's full path (or that they stay in Kaizen OS only when no folder was named) and ask once; call again with confirmed: true on their yes." };
        const { queueJob } = await import("@/lib/assistant/after-call-jobs");
        const id = await queueJob(ctx.admin, { profileId: ctx.me.id, callId: null, title: `Case studies (${items.length})`, items, folder, subfolder: clip(input.subfolder, 200) || null, folderPath });
        return { queued: true, job: id, clients: items.map((i) => i.client), note: "Queued: they run in the background now, about a minute or two each, and they'll get a notice in the app as each is ready (and in Drive when a folder was given). Say so in a line." };
      },
    },
  ];
}
