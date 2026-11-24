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
export const DOCUMENT_TOOLS = ["package_details", "client_wins", "create_document", "create_case_study", "upload_to_drive", "run_after_call"] as const;

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
        "Puts documents Kaizen OS made (case studies, SOWs, proposals: their document_id) into a Google Drive folder the person points to, as them: the folder's link, or its path as they say it (\"00-Business Manifesto/08-Kaizen Content\": a shared drive or any folder they can reach, then subfolders). subfolder: a folder inside it to put them in, made when it isn't there (\"Case Studies\"). A file with the same name there is replaced with the new version. Returns each file's Drive link. When the folder isn't found, say so and ask for its link.",
      input_schema: { type: "object", properties: { document_ids: ITEMS, folder: { type: "string", description: "A Drive folder link, or a path of folder names" }, subfolder: { type: "string" } }, required: ["document_ids", "folder"], additionalProperties: false },
      status: () => "Putting it in Drive…",
      run: async (input) => {
        if (ctx.me.viewAs) return { error: "While viewing as someone, nothing is put in their Drive." };
        const ids = (Array.isArray(input.document_ids) ? input.document_ids : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 20);
        if (!ids.length) return { error: "Which documents? Use their document_id." };
        const { driveFolder, uploadToFolder, documentBytes } = await import("@/lib/drive-push");
        const f = await driveFolder(ctx.me.email, clip(input.folder, 500), clip(input.subfolder, 120) || null);
        if ("error" in f) return { uploaded: false, error: f.error };
        const out: { file: string; link: string | null }[] = [];
        const missing: string[] = [];
        for (const id of ids) {
          const d = await documentBytes(ctx.db, ctx.admin, id);
          if (!d) {
            missing.push(id);
            continue;
          }
          const up = await uploadToFolder(ctx.me.email, f.id, d.name, d.bytes, "application/pdf");
          out.push({ file: d.name, link: up.link });
        }
        if (f.link) ctx.cards.push({ type: "link", title: `In Drive: ${f.name}`, detail: `${out.length} file${out.length === 1 ? "" : "s"}${f.made ? ", in a new folder" : ""}`, href: f.link, cta: "Open the folder", external: true });
        return { uploaded: out.length, folder: f.name, folder_link: f.link, made_folder: f.made, files: out, ...(missing.length ? { not_found: missing.length } : {}) };
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
        if (input.confirmed !== true) return { queued: false, list: items.map((i) => i.client), note: "Say the list back in one line (and the Drive folder) and ask once; call again with confirmed: true on their yes." };
        if (input.folder) {
          const { driveFolder } = await import("@/lib/drive-push");
          const f = await driveFolder(ctx.me.email, clip(input.folder, 500), null);
          if ("error" in f) return { queued: false, error: `${f.error} Ask for the folder's link, or queue them without Drive.` };
        }
        const { queueJob } = await import("@/lib/assistant/after-call-jobs");
        const id = await queueJob(ctx.admin, { profileId: ctx.me.id, callId: null, title: `Case studies (${items.length})`, items, folder: clip(input.folder, 500) || null, subfolder: clip(input.subfolder, 120) || null });
        return { queued: true, job: id, clients: items.map((i) => i.client), note: "Queued: they run in the background now, about a minute or two each, and they'll get a notice in the app as each is ready (and in Drive when a folder was given). Say so in a line." };
      },
    },
  ];
}
