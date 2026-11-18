import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { metaConfigured, metaGraph } from "@/lib/context/meta";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { canEditProject, projectRole, type ProjectAccess } from "@/lib/kaizen-ai/projects";
import { cleanList, removedRows } from "@/lib/list-clean/core";
import { decodeText, parseCsv, toCsv } from "@/lib/list-clean/csv";
import { readXlsx, type Sheet } from "@/lib/list-clean/xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  clip,
  cleanMoments,
  groupWork,
  memoryChunks,
  metaFindings,
  monthWindow,
  monthSection,
  NATIONAL_DAYS_TITLE,
  nyToday,
  onboardingItems,
  rowsText,
  sheetLink,
  statusEmail,
  summarizeSheet,
  weekOf,
  accountStatus,
  disableReason,
  guideCount,
  type MetaFacts,
  type WorkItem,
} from "./team-ops-core";
import { str, num, type AiTool, type ChatExtra } from "./types";

// Tools the email and social teams (and the onboarding side) asked for in Kaizen AI. Each one checks the person may see
// the client with their own session first; the server's rights are used only after that, for what they may read.
// Nothing here sends anything to a client: the email is a draft, the research is text, the notes are saved only when
// the person says so. Registered as one module in src/lib/kaizen-ai/extensions.ts.
//   clean_klaviyo_list          email team          a CSV or Excel contact list → Klaviyo-ready CSV + removed rows
//   monthly_moments             social, email       the month's holidays and moments for a client (the model checks dates on the web)
//   save_client_moments         social, email       saves the picked moments on the client
//   onboarding_research         everyone            a new client's facts and the intake questions, for the model to research and draft
//   save_client_note            everyone            saves a draft as dated background notes on the client, only when asked
//   meta_troubleshoot           everyone            reads the client's Meta connection and says what's wrong and the fix
//   onboarding_status           everyone            what's done and missing in setup, and a draft email asking for it
//   read_report_sheet           social, email       a Google Sheet link or attached Excel/CSV, read for the model to analyse
//   weekly_task_summary         everyone            the person's own open work this week, by due date and client
//   client_benchmarking_project social              finds or makes the client's Benchmarking project and saves a weekly note

const MB = 1_000_000;
const WEEK = 7 * 86_400;
const fail = (error: string) => ({ ok: false as const, error });

type ClientRow = { id: string; name: string; slug: string; website: string | null };

/** The client a tool is about (named in the input, or the thread's), only if the person may see it; their own session decides */
async function clientFor(user: Staff, input: Record<string, unknown>, chat?: ChatExtra): Promise<{ client: ClientRow } | { error: string }> {
  const db = await createClient();
  const asked = str(input.client);
  let row: ClientRow | null = null;
  if (asked) {
    const safe = asked.replace(/[%_,()]/g, " ").trim();
    const { data } = await db.from("clients").select("id, name, slug, website").is("archived_at", null).or(`slug.eq.${safe.toLowerCase().replace(/\s+/g, "-")},name.ilike.%${safe}%`).limit(8);
    const list = (data ?? []) as ClientRow[];
    const exact = list.find((c) => c.name.toLowerCase() === asked.toLowerCase() || c.slug === asked.toLowerCase());
    if (!exact && list.length > 1) return { error: `More than one client matches "${asked}": ${list.map((c) => c.name).join(", ")}. Which one?` };
    row = exact ?? list[0] ?? null;
  } else if (chat?.clientId) {
    const { data } = await db.from("clients").select("id, name, slug, website").eq("id", chat.clientId).maybeSingle();
    row = (data as ClientRow | null) ?? null;
  } else return { error: "Which client? Name the client, or pin one to the chat." };
  if (!row) return { error: asked ? `No client called "${asked}" that you can see.` : "You can't see this client." };
  // The email and social teams see only the clients that buy their service
  const { channelMaySeeClient } = await import("@/lib/kaizen-ai/tools");
  if (!(await channelMaySeeClient({ me: user, admin: createAdminClient() }, row.id))) return { error: asked ? `No client called "${asked}" that you can see.` : "You can't see this client." };
  return { client: row };
}

const download = async (admin: SupabaseClient, path: string) => {
  const { data, error } = await admin.storage.from(AI_BUCKET).download(path);
  if (error || !data) throw new Error("The file isn't there any more. Attach it again.");
  return new Uint8Array(await data.arrayBuffer());
};

/** The parts of a Brand Bible whose heading matches, so the model reads what it needs rather than all of it */
const bibleParts = (md: string | null, re: RegExp, max: number) => (md ?? "").split(/\n(?=#{1,3} )/).filter((p) => re.test(p.split("\n")[0] ?? "")).join("\n\n").slice(0, max);

type Loaded = { name: string; sheets: Sheet[] };
/** An attached CSV, TSV or Excel file as sheets of rows */
async function readAttached(admin: SupabaseClient, f: { name: string; path: string }): Promise<{ ok: true; file: Loaded } | { ok: false; error: string }> {
  const ext = f.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xls") return { ok: false, error: `${f.name} is an old Excel (.xls) file. Open it in Excel or Google Sheets and save it as .xlsx or CSV, then attach it again.` };
  const bytes = await download(admin, f.path);
  if (ext === "xlsx") {
    const r = readXlsx(bytes);
    return r.ok ? { ok: true, file: { name: f.name, sheets: r.sheets } } : r;
  }
  return { ok: true, file: { name: f.name, sheets: [{ name: "File", rows: parseCsv(decodeText(bytes)) }] } };
}

const LISTY = /\.(csv|tsv|txt|xlsx|xls)$/i;

// ─── 1. Klaviyo list cleaning ────────────────────────────────────────────────────────────────────────────────────────

const cleanKlaviyoList: AiTool = {
  name: "clean_klaviyo_list",
  description:
    "Cleans a contact list (CSV or Excel attached to this message) to Klaviyo's import standards and returns two download links: the cleaned CSV (ready to import) and a CSV of every removed row with the reason. It finds the email column, trims and lowercases addresses and repairs common typos (gmial.com), removes invalid, duplicate, disposable and role addresses (info@, support@), turns phone numbers into +E.164 using a default country, splits full names into first and last and title-cases shouting or lowercase names, turns consent columns into one $consent column, renames headers to Klaviyo's properties ($email, $first_name, $last_name, $phone_number, $city, $region, $country, $zip and so on) and keeps every other column as a custom property. Handles 100,000 rows. Tell the person the counts and what was removed, and that nothing was imported: they import the file in Klaviyo themselves.",
  input_schema: {
    type: "object",
    properties: {
      file: { type: "string", description: "The attached file's name (default: the first CSV or Excel file attached)" },
      sheet: { type: "string", description: "For an Excel file with several sheets: the sheet's name (default: the first with data)" },
      default_country: { type: "string", description: "Two letter country for phone numbers written without a country code: US (default), CA, GB, AU, NZ, IE, DE, FR, MX and others" },
      keep_role_addresses: { type: "boolean", description: "True to keep shared inboxes such as info@ and support@ (removed by default)" },
      keep_disposable_addresses: { type: "boolean", description: "True to keep throwaway addresses (removed by default)" },
    },
    additionalProperties: false,
  },
  lines: ["email"],
  run: async (user: Staff, input, chat) => {
    const files = (chat?.files ?? []).filter((f) => LISTY.test(f.name));
    if (!files.length) return fail("Attach the contact list (a CSV or Excel file) to your message, then ask again.");
    const want = str(input.file)?.toLowerCase();
    const file = (want && files.find((f) => f.name.toLowerCase().includes(want))) || files[0];
    const admin = createAdminClient();
    const read = await readAttached(admin, file);
    if (!read.ok) return fail(read.error);
    const wantSheet = str(input.sheet)?.toLowerCase();
    const sheets = read.file.sheets.filter((s) => s.rows.some((r) => r.some((c) => c.trim())));
    const sheet = (wantSheet && sheets.find((s) => s.name.toLowerCase() === wantSheet)) || sheets[0];
    if (!sheet) return fail("The file has no data in it.");
    if (wantSheet && sheet.name.toLowerCase() !== wantSheet) return fail(`There's no sheet called "${input.sheet}". The sheets are: ${sheets.map((s) => s.name).join(", ")}.`);

    const res = cleanList(sheet.rows, { defaultCountry: str(input.default_country) ?? "US", keepRole: input.keep_role_addresses === true, keepDisposable: input.keep_disposable_addresses === true });
    if (!res.ok) return fail(res.error);

    const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "list";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const put = async (suffix: string, text: string) => {
      const path = `${user.id}/list-clean/${stamp}-${base}-${suffix}.csv`;
      const { error } = await admin.storage.from(AI_BUCKET).upload(path, new TextEncoder().encode(text), { contentType: "text/csv; charset=utf-8", upsert: false });
      if (error) throw new Error(`Couldn't save the ${suffix} file: ${error.message}`);
      const { data, error: sign } = await admin.storage.from(AI_BUCKET).createSignedUrl(path, WEEK, { download: `${base}-${suffix}.csv` });
      if (sign || !data) throw new Error("Couldn't make the download link.");
      return data.signedUrl;
    };
    const cleanedUrl = await put("klaviyo-cleaned", toCsv([res.header, ...res.rows]));
    // The removed file is for people to read: a byte order mark makes Excel show accents right
    const removedUrl = res.removed.length ? await put("removed-rows", `﻿${toCsv(removedRows(res))}`) : null;
    const s = res.stats;
    chat?.card({ type: "link", title: `${base}: cleaned list for Klaviyo`, detail: `${s.kept.toLocaleString("en-US")} of ${s.rowsIn.toLocaleString("en-US")} rows · CSV · the link works for 7 days`, href: cleanedUrl, cta: "Download the cleaned CSV", external: true });
    if (removedUrl) chat?.card({ type: "link", title: `${base}: removed rows and why`, detail: `${res.removed.length.toLocaleString("en-US")} rows · CSV · the link works for 7 days`, href: removedUrl, cta: "Download the removed rows", external: true });
    return {
      ok: true,
      note: "The download cards are on screen. Say what was done in a few lines (counts, what was removed and why, what was repaired, the columns renamed); don't repeat every number. Say plainly that nothing was imported. Remind them the first import in Klaviyo shows the column mapping to check, and that $consent only counts if they have the right to email those people.",
      file: file.name,
      sheet: sheet.name,
      header_row: res.headerLine,
      default_country_for_phones: res.defaultCountry,
      rows_in: s.rowsIn,
      rows_kept: s.kept,
      rows_removed: res.removed.length,
      removed_by_reason: s.removed,
      emails_repaired: s.emailsRepaired,
      phones_formatted: s.phonesFormatted,
      phones_cleared_because_invalid: s.phonesCleared,
      text_only_rows_kept_without_email: s.smsOnly,
      names_split_from_full_name: s.namesSplit,
      names_recased: s.namesFixed,
      zip_codes_given_back_their_leading_zero: s.zipsPadded,
      with_email_consent: s.consentEmail,
      with_sms_consent: s.consentSms,
      columns: res.mapping.map((m) => `${m.source || "(blank)"} → ${m.target || "left out"}${m.note ? ` (${m.note})` : ""}`),
      output_columns: res.header,
    };
  },
};

// ─── 2. Monthly moments ──────────────────────────────────────────────────────────────────────────────────────────────

const monthlyMoments: AiTool = {
  name: "monthly_moments",
  description:
    "Starts the month's holidays, observances and moments for a client: reads the client (industry, what they sell, where, who to) and their Brand Bible, the month's dates, and the moments already saved for them, so you can say which holidays, observances, local and industry moments fit them and which have potential. Then use web search to confirm each date for that year (floating holidays, awareness days, local events, sports and school calendars) before you answer. For each moment give: the name and date, why it fits this client, a social content angle, an email or offer angle, the lead time (when to start, counted back from the date) and how sure the date is. Split the answer into 'fits now' and 'has potential'. Then offer to save the ones they pick with save_client_moments.",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string", description: "The client's name (default: the client the chat is pinned to)" },
      month: { type: "string", description: "The month as 2027-02 or February 2027 (default: next month)" },
    },
    additionalProperties: false,
  },
  lines: ["social", "email"],
  run: async (user: Staff, input, chat) => {
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const c = got.client;
    const today = nyToday();
    const w = monthWindow(input.month, today);
    if ("error" in w) return fail(w.error);
    const db = await createClient();
    const admin = createAdminClient();
    const [{ data: rec }, { data: bible }, { data: saved }, { data: library }] = await Promise.all([
      admin.from("clients").select("industry, industry_detail, vertical_id, services, services_extra, website").eq("id", c.id).maybeSingle(),
      admin.from("client_brand_bibles").select("read_this_first, markdown").eq("client_id", c.id).maybeSingle(),
      db.from("client_moments").select("name, on_date, angle, status").eq("client_id", c.id).gte("on_date", w.start).lte("on_date", w.end).order("on_date"),
      // The fun national days by month (the Email Strategist's calendar knowledge, editable on its page)
      admin.from("ai_knowledge").select("body").eq("active", true).ilike("title", `${NATIONAL_DAYS_TITLE}%`).limit(3),
    ]);
    const month = Number(w.start.slice(5, 7));
    const nationalDays = (library ?? []).map((k) => monthSection(String(k.body ?? ""), month)).filter(Boolean).join("\n");
    const { data: v } = rec?.vertical_id ? await admin.from("verticals").select("name").eq("id", rec.vertical_id).maybeSingle() : { data: null };
    const model = await import("@/lib/business-model").then((m) => m.businessModelOf(admin, c.id)).catch(() => null);
    const md = (bible?.markdown as string | null) ?? null;
    return {
      ok: true,
      client: c.name,
      month: { label: w.label, from: w.start, to: w.end, starts_in_days: w.startsInDays },
      today,
      about_the_client: { industry: rec?.industry ?? null, sub_vertical: v?.name ?? null, what_they_do: rec?.industry_detail ?? null, website: rec?.website ?? c.website, how_they_sell: model ? `${model.model}${model.also ? ` and ${model.also}` : ""}` : null },
      brand_bible_start: String(bible?.read_this_first ?? "").slice(0, 3500) || null,
      brand_bible_audience_location_and_calendar: bibleParts(md, /moment|season|calendar|holiday|audience|avatar|customer|location|geograph|market|offer/i, 9000) || (md ? md.slice(0, 5000) : null),
      already_saved_for_this_month: (saved ?? []).map((m) => `${m.on_date} ${m.name} (${m.status})${m.angle ? `: ${m.angle}` : ""}`),
      national_days_this_month: nationalDays || null,
      how_to: [
        "Offer the fun national days from national_days_this_month alongside the big holidays (National Ice Cream Day, National Cake Day...), only the ones that fit this client. Campaign ideas lean about 80 percent story and product, 20 percent sales.",
        `Use web search to confirm the ${w.year} dates of each holiday and observance (several move each year) and to find local and industry moments for where this client sells; add ones with potential that aren't obvious, and say why.`,
        "Only moments that truly fit this business, its customers and how it sells: a roofer doesn't do Valentine's. Skip any that are already saved.",
        "Lead time: simple promo 28 days, new offer or landing page or shoot up to 56 days; say the date to start by.",
        "Plain words, no em dashes. Offer to save the picked ones with save_client_moments (they then appear on the client's page and are briefed automatically a few weeks ahead).",
      ],
    };
  },
};

const saveClientMoments: AiTool = {
  name: "save_client_moments",
  description:
    "Saves moments the person picked as the client's marketing moments (they show on the client's page and the system briefs each one a few weeks ahead). Call it only after the person said which ones to save. Each moment needs a name and a future date (YYYY-MM-DD).",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string" },
      person_picked: { type: "boolean", description: "True only after the person said which moments to save" },
      moments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            on_date: { type: "string", description: "YYYY-MM-DD" },
            lead_days: { type: "integer", description: "How many days ahead to start (14 to 90, default 42)" },
            angle: { type: "string", description: "The idea in one line" },
            offer_idea: { type: "string", description: "The offer or promotion to ask the client for" },
            why: { type: "string", description: "Why it fits this client" },
            match_terms: { type: "array", items: { type: "string" }, description: "2 to 4 lowercase words a campaign for it would be named with" },
          },
          required: ["name", "on_date"],
        },
      },
    },
    required: ["moments", "person_picked"],
    additionalProperties: false,
  },
  lines: ["social", "email"],
  run: async (user: Staff, input, chat) => {
    if (input.person_picked !== true) return fail("Ask the person which moments to save first, then call again with person_picked true.");
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const admin = createAdminClient();
    const { data: rec } = await admin.from("clients").select("vertical_id").eq("id", got.client.id).maybeSingle();
    const model = await import("@/lib/business-model").then((m) => m.businessModelOf(admin, got.client.id)).catch(() => null);
    const { rows, skipped } = cleanMoments(input.moments, nyToday(), { clientId: got.client.id, verticalId: (rec?.vertical_id as string | null) ?? null, model: model?.model ?? null });
    if (!rows.length) return fail(`Nothing to save. ${skipped.join("; ")}`);
    const { error } = await admin.from("client_moments").upsert(rows, { onConflict: "client_id,name,on_date", ignoreDuplicates: true });
    if (error) return fail("Couldn't save the moments. Try again.");
    chat?.card({ type: "link", title: `${rows.length} moment${rows.length === 1 ? "" : "s"} saved for ${got.client.name}`, detail: rows.map((r) => `${r.on_date} ${r.name}`).slice(0, 6).join(" · "), href: `/clients/${got.client.slug}`, cta: "Open the client" });
    return { ok: true, saved: rows.map((r) => `${r.on_date} ${r.name} (start ${r.lead_days} days ahead)`), left_out: skipped, note: "A moment that was already saved for that date is kept as it was." };
  },
};

// ─── 3. Onboarding research ──────────────────────────────────────────────────────────────────────────────────────────

const onboardingResearch: AiTool = {
  name: "onboarding_research",
  description:
    "Starts the research on a new client for the onboarding sheet and intake: returns what we already know (the client record, website, services, Brand Bible, the client's own intake answers, the onboarding sheet if one was read, competitors the market tools already match) and the intake questions with any answers so far. Then do the research yourself: read their website and key pages with web fetch, search for their social profiles (handles, followers, how often and what they post), their reviews (Google, Yelp, Trustpilot, the App Store or wherever they are) and what people praise and complain about, their positioning, offers and pricing, and 3 to 5 real competitors (site, positioning, offers, good and bad reviews). For the competitors' ads use search_market_ads and client_swipe_file, and link the Meta Ad Library page for each. Answer as a structured draft the strategist can copy: one section per sheet topic and one line per intake question, each answer with its source link and a mark of found, inferred or unknown. Never invent a number, offer or review: unknown goes under open questions to ask the client. Nothing is saved or sent: offer save_client_note if they want the draft kept.",
  input_schema: { type: "object", properties: { client: { type: "string", description: "The client's name (default: the client the chat is pinned to)" } }, additionalProperties: false },
  run: async (user: Staff, input, chat) => {
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const c = got.client;
    const db = await createClient();
    const admin = createAdminClient();
    const [{ data: rec }, { data: bible }, { data: intake }, { data: sheet }, { data: matches }] = await Promise.all([
      admin.from("clients").select("industry, industry_detail, vertical_id, services, services_extra, services_removed, website").eq("id", c.id).maybeSingle(),
      admin.from("client_brand_bibles").select("read_this_first, markdown, status").eq("client_id", c.id).maybeSingle(),
      db.from("client_intakes").select("answers, summary, received_at").eq("client_id", c.id).order("received_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("client_onboarding_sheets").select("url, name, modified_at, bible").eq("client_id", c.id).maybeSingle(),
      db.from("client_market_brands").select("score, why, market_brands(name, domain)").eq("client_id", c.id).order("score", { ascending: false }).limit(8),
    ]);
    const { servicesOf } = await import("@/lib/services");
    const services = servicesOf(rec ?? {});
    const { loadIntakeForm } = await import("@/lib/intake-form");
    const { bankFor, modelFor } = await import("@/lib/intake-questions");
    const form = await loadIntakeForm(admin, c.id).catch(() => null);
    const questions = form?.form ?? bankFor(services, modelFor((rec?.industry as string | null) ?? null));
    const answers = form?.answers ?? {};
    const sheetMd = (sheet?.bible as { markdown?: string } | null)?.markdown ?? null;
    const given = (intake?.answers ?? []) as { q: string; a: string }[];
    return {
      ok: true,
      client: c.name,
      today: nyToday(),
      client_record: { website: rec?.website ?? c.website, industry: rec?.industry ?? null, what_they_do: rec?.industry_detail ?? null, services },
      brand_bible: bible?.markdown ? { status: bible.status, start: String(bible.read_this_first ?? "").slice(0, 3000) } : "none yet",
      clients_own_intake_answers: given.length ? given.slice(0, 40).map((x) => ({ q: clip(x.q, 140), a: clip(x.a, 400) })) : "none yet",
      intake_summary: intake?.summary ?? null,
      onboarding_sheet_read_by_the_system: sheetMd ? { url: sheet?.url, edited: String(sheet?.modified_at ?? "").slice(0, 10), content: sheetMd.slice(0, 6000) } : "none read",
      competitors_the_market_tools_match: (matches ?? []).map((m) => {
        const b = (m as unknown as { market_brands: { name: string; domain: string | null } | null }).market_brands;
        return `${b?.name ?? "?"}${b?.domain ? ` (${b.domain})` : ""}: ${clip(m.why, 140)}`;
      }),
      intake_questions: questions.questions.map((q) => ({ id: q.id, section: q.section, question: q.q, answer_so_far: (q.id in answers ? answers[q.id] : (q.prefill ?? "")) || null })),
      sheet_sections_to_draft: [
        "Business and products (each product or service: details, features, benefits, proof)",
        "Primary promise and unique mechanism",
        "Offers, pricing and the email or SMS sign-up (pop-up) offer, word for word as it runs on the site",
        "Customers and personas (who buys, where they are, what they care about)",
        "Competitors (3 to 5: website, positioning, offers, good reviews, bad reviews, Meta Ad Library link)",
        "Reviews and what customers say (where, themes, quotes with the source link)",
        "Social presence (handles, followers, posting rhythm, formats, what gets engagement)",
        "Funnel and benchmarks as far as public sources show",
        "Brand voice and look (from the site and posts)",
        "Open questions to ask the client",
      ],
      how_to: [
        "Research with web search and web fetch; open the pages, don't guess from snippets. Give a source link for every fact.",
        "Mark each answer found, inferred or unknown. Never invent a number, offer, review or claim.",
        "Quote reviews exactly or not at all. Plain words, no em dashes, say roles not names.",
        "Return the draft in the sections above, then the answers to the intake questions by id. Nothing is saved or sent from here.",
      ],
    };
  },
};

const saveClientNote: AiTool = {
  name: "save_client_note",
  description: "Saves text (a research draft, a plan) on the client as dated background notes the AI and the team can read later. Call it only when the person asked to save it. Long text is split into several notes of up to 1,000 characters each.",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string" },
      title: { type: "string", description: "What it is, a few words: Onboarding research, Competitor notes" },
      text: { type: "string" },
      person_asked: { type: "boolean", description: "True only when the person asked to save it as a client note" },
    },
    required: ["title", "text", "person_asked"],
    additionalProperties: false,
  },
  run: async (user: Staff, input, chat) => {
    if (input.person_asked !== true) return fail("Only save it when the person asks. Ask whether to save it as a client note first.");
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const text = String(input.text ?? "").trim();
    if (text.length < 20) return fail("There's nothing to save yet.");
    const today = nyToday();
    const notes = memoryChunks(clip(input.title, 60) || "Note", text, today);
    const db = await createClient();
    const { error } = await db.from("client_memory").insert(notes.map((body) => ({ client_id: got.client.id, kind: "note", body, source: "team", dated: today, created_by: user.id })));
    if (error) return fail("Couldn't save the notes. Try again.");
    chat?.card({ type: "link", title: `${notes.length} note${notes.length === 1 ? "" : "s"} saved on ${got.client.name}`, detail: "Dated background, never a rule", href: `/clients/${got.client.slug}`, cta: "Open the client" });
    return { ok: true, saved_notes: notes.length, truncated: text.length > notes.join("").length + 200 };
  },
};

// ─── 4. Meta troubleshooting ─────────────────────────────────────────────────────────────────────────────────────────

const metaTroubleshoot: AiTool = {
  name: "meta_troubleshoot",
  description:
    "Checks a client's Meta connection and says what's wrong and the exact steps to fix it: the ad account on file, whether Kaizen is a partner on it, the ad account's status and any disable reason, business verification, the pixel (dataset) and when it last fired, the linked Facebook Page and Instagram account, and any permission Kaizen's own Meta connection is missing, plus what the onboarding guide recorded. Read only. Explain the findings in plain words, worst first, each with the steps in order; use web search for Meta's current help pages when a menu or step may have changed, and say when you couldn't confirm something. If the person describes a symptom (ads not delivering, can't see the Page), say which finding explains it.",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string", description: "The client's name (default: the client the chat is pinned to)" },
      symptom: { type: "string", description: "What the person is seeing, in their words (optional)" },
    },
    additionalProperties: false,
  },
  run: async (user: Staff, input, chat) => {
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const c = got.client;
    const admin = createAdminClient();
    const [{ data: rec }, { data: targets }, guideMod, access, social, bmMod] = await Promise.all([
      admin.from("clients").select("meta_ad_account_id, services, services_extra, services_removed").eq("id", c.id).maybeSingle(),
      admin.from("kpi_targets").select("ad_account_id, label").eq("client_id", c.id).eq("platform", "meta").eq("active", true),
      import("@/lib/onboarding-guide"),
      import("@/lib/onboarding-guide").then((m) => m.accessSetting(admin)),
      import("@/lib/social/store").then((m) => m.socialLink(admin, c.id)).catch(() => null),
      import("@/lib/meta-tokens"),
    ]);
    const guide = await guideMod.loadGuide(admin, c.id);
    const { servicesOf } = await import("@/lib/services");
    const services = servicesOf(rec ?? {});
    const account = ((rec?.meta_ad_account_id as string | null) ?? (targets ?? []).map((t) => t.ad_account_id as string).find(Boolean) ?? "").replace(/\D/g, "") || null;
    const bm = await bmMod.clientBusinessManager(admin, c.id).catch(() => null);

    let live: MetaFacts["live"] = null;
    if (metaConfigured() && account) {
      type Page<T> = { data: T[] };
      const act = `act_${account}`;
      const read = await metaGraph<{ name?: string; account_status?: number; disable_reason?: number; business?: { name?: string; verification_status?: string } | null; agencies?: Page<{ id: string }> }>(act, { fields: "name,account_status,disable_reason,business{name,verification_status},agencies{id}" }).catch((e: unknown) => e as Error);
      if (read instanceof Error) live = { error: read.message };
      else {
        const [pixels, ig] = await Promise.all([
          metaGraph<Page<{ name: string; last_fired_time?: string }>>(`${act}/adspixels`, { fields: "name,last_fired_time", limit: "20" }).catch(() => null),
          metaGraph<Page<{ id: string }>>(`${act}/instagram_accounts`, { fields: "id", limit: "5" }).catch(() => null),
        ]);
        live = {
          status: read.account_status ?? null,
          disable: read.disable_reason ?? null,
          name: read.name ?? null,
          business: read.business?.name ?? null,
          verification: read.business?.verification_status ?? null,
          pixels: pixels ? pixels.data.map((p) => ({ name: p.name, lastFired: p.last_fired_time ?? null })) : null,
          partners: read.agencies ? read.agencies.data.map((a) => a.id) : null,
          instagram: ig ? ig.data.length : null,
        };
      }
    }
    const facts: MetaFacts = {
      configured: metaConfigured(),
      services: { meta: services.includes("facebook-ads") || services.includes("social-media") || Boolean(account) },
      account,
      kaizenBm: access.bmId,
      live,
      guide: { status: guide.meta.status, note: guide.meta.note, accountName: guide.meta.accountName, pageName: guide.meta.pageName },
      social: social ? { pageId: social.pageId, igId: social.igId, state: social.state, error: social.error ? { message: social.error.message, fix: social.error.fix } : null, missing: social.missing } : null,
      bm: (bm?.accounts ?? []).map((a) => ({ ok: a.ok, text: a.text })),
      now: Date.now(),
    };
    const findings = metaFindings(facts);
    return {
      ok: true,
      client: c.name,
      symptom: str(input.symptom),
      summary: findings.length ? `${findings.length} thing${findings.length === 1 ? "" : "s"} to sort out, ${findings.filter((f) => f.severity === "blocker").length} blocking` : "Nothing wrong found in what could be read",
      findings,
      what_was_read: {
        ad_account: account ? `act_${account}${live && !live.error ? ` (${live.name ?? "no name"}, ${accountStatus(live.status).label}${disableReason(live.disable) ? `, ${disableReason(live.disable)}` : ""})` : ""}` : "none on file",
        business: live && !live.error ? (live.business ?? "not shown") : null,
        pixels: live && !live.error ? (live.pixels ? live.pixels.map((p) => `${p.name}: ${p.lastFired ? `last fired ${p.lastFired.slice(0, 10)}` : "never fired"}`) : "couldn't be read") : null,
        partners_could_be_read: live && !live.error ? live.partners != null : null,
        facebook_page: social?.pageName ?? (social?.pageId ? social.pageId : "not linked"),
        instagram: social?.igUsername ?? (social?.igId ? social.igId : "not linked"),
        onboarding_guide_meta_step: guide.meta.status ?? "not started",
        kaizen_business_id: access.bmId,
      },
      could_not_read: [
        ...(!facts.configured ? ["Kaizen's Meta connection (nothing could be read)"] : []),
        ...(live?.error ? [`The ad account itself: ${live.error.slice(0, 160)}`] : []),
        ...(live && !live.error && live.partners == null ? ["Which businesses the account is shared with (Meta didn't allow it)"] : []),
        ...(live && !live.error && live.pixels == null ? ["The pixel"] : []),
      ],
      how_to: ["Worst first, each with its steps in order, in plain words a client can follow. Use web search to confirm Meta's current menu names when you give click paths. Say when something couldn't be read. Nothing is changed from here, and don't send anything to the client."],
    };
  },
};

// ─── 5. Account status and onboarding email ──────────────────────────────────────────────────────────────────────────

const onboardingStatus: AiTool = {
  name: "onboarding_status",
  description:
    "For a client in onboarding: what's done and what's still missing (Meta partner and admin access, Google Ads account, Google tools, tracking, website and email platform access, brand assets in Drive, the look they picked, the marketing intake and the onboarding call), and a ready-to-send email to the client asking for what's missing, in Kaizen's plain, warm voice. The email is a draft: nothing is sent from here. Show the person the checklist in a few lines and the draft email, and offer to change its tone or length.",
  input_schema: { type: "object", properties: { client: { type: "string", description: "The client's name (default: the client the chat is pinned to)" } }, additionalProperties: false },
  run: async (user: Staff, input, chat) => {
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const c = got.client;
    const admin = createAdminClient();
    const { loadGuide, guideHas } = await import("@/lib/onboarding-guide");
    const [guide, has, { data: ob }, { data: form }, { count: intakes }, { data: bible }] = await Promise.all([
      loadGuide(admin, c.id),
      guideHas(admin, c.id),
      admin.from("client_onboarding").select("welcomed_at, call_checked_at").eq("client_id", c.id).maybeSingle(),
      admin.from("client_intake_forms").select("status, answers, call_booked_at").eq("client_id", c.id).maybeSingle(),
      admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", c.id),
      admin.from("client_brand_bibles").select("status").eq("client_id", c.id).maybeSingle(),
    ]);
    const facts = {
      guide,
      has,
      welcomed: Boolean(ob?.welcomed_at),
      intake: { submitted: (intakes ?? 0) > 0 || form?.status === "submitted", started: Object.keys((form?.answers ?? {}) as object).length > 0 },
      call: { booked: Boolean(form?.call_booked_at), checked: Boolean(ob?.call_checked_at) },
      bible: Boolean(bible),
    };
    const items = onboardingItems(facts);
    const { clientRecipients } = await import("@/lib/client-emails");
    const contacts = await clientRecipients(admin, c.id).catch(() => []);
    const { portalUrl } = await import("@/lib/site");
    const portal = `${portalUrl()}/c/${c.slug}/start`;
    const first = contacts[0]?.first ?? null;
    const draft = statusEmail({ brand: c.name, first, items, portal });
    const { done, total } = guideCount(guide, has);
    const left = items.filter((i) => i.state !== "done");
    return {
      ok: true,
      client: c.name,
      portal_guide_welcome_sent: facts.welcomed,
      portal_link: portal,
      progress: `${items.filter((i) => i.state === "done").length} of ${items.length} items done (the portal guide counts ${done} of ${total} of its own steps)`,
      checklist: items.map((i) => ({ item: i.label, state: i.state, detail: i.detail })),
      brand_bible_built: facts.bible,
      to: contacts.map((x) => ({ first_name: x.first, email: x.email })),
      draft_email: draft ?? { note: "Nothing is missing: no email needed." },
      still_open: left.length,
      note: "This is a draft for the person to review. Nothing was sent. If they want to send it, they copy it into their own email (or use the client's page). Keep Kaizen's voice: warm, short, plain words, no em dashes, signed by the team, one link.",
    };
  },
};

// ─── 6. Report sheet analysis ────────────────────────────────────────────────────────────────────────────────────────

const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A Google Sheet (or an Excel or CSV file in Drive) by link, read with Kaizen's Drive access */
async function readDriveFile(id: string): Promise<{ ok: true; file: Loaded } | { ok: false; error: string }> {
  const { slidesToken } = await import("@/lib/ai-tools/recap-deck");
  let token: string;
  try {
    token = await slidesToken();
  } catch (e) {
    return { ok: false, error: `Google isn't connected here (${e instanceof Error ? e.message.slice(0, 120) : "no token"}). Attach the sheet as Excel or CSV instead.` };
  }
  const h = { authorization: `Bearer ${token}` };
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size&supportsAllDrives=true`, { headers: h, cache: "no-store" });
  if (!meta.ok) return { ok: false, error: "I can't open that sheet. Share it with Kaizen's Drive account (anyone at Kaizen can ask the head of the team which), or download it as Excel or CSV and attach it here." };
  const info = (await meta.json()) as { name: string; mimeType: string; size?: string };
  const url = info.mimeType === GOOGLE_SHEET ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(XLSX)}` : `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  if (info.size && Number(info.size) > 25 * MB) return { ok: false, error: `${info.name} is over 25 MB. Share a smaller range or tab.` };
  const res = await fetch(url, { headers: h, cache: "no-store" });
  if (!res.ok) return { ok: false, error: info.mimeType === GOOGLE_SHEET ? "Google wouldn't export that sheet (sheets over 10 MB can't be exported). Download the tab as CSV or Excel and attach it here." : "I couldn't download that file." };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (info.mimeType === GOOGLE_SHEET || info.mimeType === XLSX || /\.xlsx$/i.test(info.name)) {
    const r = readXlsx(bytes);
    return r.ok ? { ok: true, file: { name: info.name, sheets: r.sheets } } : r;
  }
  if (/^(text\/|application\/(csv|vnd\.ms-excel))/.test(info.mimeType) || /\.(csv|tsv|txt)$/i.test(info.name)) return { ok: true, file: { name: info.name, sheets: [{ name: "File", rows: parseCsv(decodeText(bytes)) }] } };
  return { ok: false, error: `${info.name} isn't a sheet I can read (${info.mimeType}).` };
}

const readReportSheet: AiTool = {
  name: "read_report_sheet",
  description:
    "Reads report data from a Google Sheets link (the sheet has to be shared with Kaizen's Drive account) or from an attached Excel or CSV file, and returns it for you to analyse: every sheet's name and size, for the chosen sheet each column's type with totals, averages, minimums and maximums for numbers and the most common values for text, and the rows as text (400 at a time; ask again with from_row for more). Do the analysis the person asked for from this data: say which numbers you used, don't guess at cells you weren't shown, and say when the data is cut off. Read only.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "A Google Sheets (or Drive file) link" },
      file: { type: "string", description: "Or the attached file's name (default: the first Excel or CSV file attached, when there's no link)" },
      sheet: { type: "string", description: "The tab's name (default: the first)" },
      from_row: { type: "integer", description: "The row to start the text from (default 1)" },
      max_rows: { type: "integer", description: "How many rows of text (default 400, up to 1000)" },
    },
    additionalProperties: false,
  },
  lines: ["social", "email"],
  run: async (_user: Staff, input, chat) => {
    const url = str(input.url);
    let loaded: { ok: true; file: Loaded } | { ok: false; error: string };
    if (url) {
      const link = sheetLink(url);
      if (!link) return fail("That doesn't look like a Google Sheets link. Paste the sheet's address from the browser, or attach the file.");
      loaded = await readDriveFile(link.id);
    } else {
      const files = (chat?.files ?? []).filter((f) => LISTY.test(f.name));
      const want = str(input.file)?.toLowerCase();
      const f = (want && files.find((x) => x.name.toLowerCase().includes(want))) || files[0];
      if (!f) return fail("Paste a Google Sheets link, or attach an Excel or CSV file to your message.");
      loaded = await readAttached(createAdminClient(), f);
    }
    if (!loaded.ok) return fail(loaded.error);
    const sheets = loaded.file.sheets.filter((s) => s.rows.some((r) => r.some((c) => c.trim())));
    if (!sheets.length) return fail("The sheet has no data in it.");
    const want = str(input.sheet)?.toLowerCase();
    const sheet = (want && sheets.find((s) => s.name.toLowerCase() === want)) || sheets[0];
    if (want && sheet.name.toLowerCase() !== want) return fail(`There's no tab called "${input.sheet}". The tabs are: ${sheets.map((s) => s.name).join(", ")}.`);
    const sum = summarizeSheet(sheet.rows);
    const from = Math.max(1, Math.round(num(input.from_row) ?? 1));
    const text = rowsText(sheet.rows, from, Math.min(1000, Math.max(20, Math.round(num(input.max_rows) ?? 400))), 60_000);
    return {
      ok: true,
      file: loaded.file.name,
      tabs: sheets.map((s) => `${s.name} (${s.rows.filter((r) => r.some((c) => c.trim())).length} rows)`),
      reading_tab: sheet.name,
      header_row: sum.headerRow,
      data_rows: sum.dataRows,
      columns: sum.columns,
      rows_as_text: { from_row: from, to_row: text.last, cut_off: text.more, next: text.more ? `Call again with from_row ${text.last + 1} for more` : null, text: text.text },
      note: "Row numbers are the sheet's own. Totals above cover the whole tab even when the text is cut off.",
    };
  },
};

// ─── 7. Weekly task summary ──────────────────────────────────────────────────────────────────────────────────────────

const toDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null);

const weeklyTaskSummary: AiTool = {
  name: "weekly_task_summary",
  description:
    "The person's own open work this week from Kaizen OS: tickets they hold or make or buy for, their Asana tasks (the mirrored board), the plan tasks they own for clients, and the replies they owe (Slack and email people are waiting on), organised as late, each day of this week, later and no date, each group by client. Then also read their connected Gmail, Asana and Slack with those connectors if they are connected (flagged emails, tasks assigned to them, mentions) and merge what you find into the same list by due date and client. Present a clean list with the most urgent first. Read only: nothing is changed.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  run: async (user: Staff, _input, chat) => {
    const db = await createClient();
    const admin = createAdminClient();
    const today = nyToday();
    const items: WorkItem[] = [];
    const { stageInfo } = await import("@/lib/stages");
    type Rel = { name: string; slug: string } | null;
    const [{ data: tickets }, { data: plan }, asanaRes, owed] = await Promise.all([
      db.from("requests").select("number, title, stage, stage_due_at, clients(name, slug)").or(`assignee_id.eq.${user.id},creative_id.eq.${user.id},buyer_id.eq.${user.id}`).neq("stage", "launched").limit(150),
      db.from("client_tasks").select("title, due_on, status, phase, clients(name, slug)").eq("owner_id", user.id).in("status", ["ready", "in_progress"]).limit(100),
      /^[^\s,()]+@[^\s,()]+$/.test(user.email)
        ? admin.from("asana_tasks").select("name, due_on, section, url, clients(name, slug)").eq("open", true).is("request_id", null).or(`profile_id.eq.${user.id},assignee_email.ilike.${user.email}`).limit(150)
        : admin.from("asana_tasks").select("name, due_on, section, url, clients(name, slug)").eq("open", true).is("request_id", null).eq("profile_id", user.id).limit(150),
      import("@/lib/owed-replies").then((m) => m.loadOwedReplies(db, { id: user.id, role: user.role, isExec: user.isExec, isLead: user.isLead }, false)).catch(() => []),
    ]);
    for (const t of tickets ?? []) {
      const cl = t.clients as unknown as Rel;
      items.push({ kind: "ticket", title: `#${t.number} ${t.title}`, client: cl?.name ?? null, due: toDay(t.stage_due_at as string | null), status: stageInfo(t.stage as never)?.label ?? String(t.stage), href: `/board?t=${t.number}` });
    }
    for (const t of asanaRes.data ?? []) {
      const cl = t.clients as unknown as Rel;
      items.push({ kind: "asana", title: String(t.name), client: cl?.name ?? null, due: (t.due_on as string | null) ?? null, status: (t.section as string | null) ?? "Asana", href: (t.url as string | null) ?? null });
    }
    for (const t of plan ?? []) {
      const cl = t.clients as unknown as Rel;
      items.push({ kind: "plan_task", title: String(t.title), client: cl?.name ?? null, due: (t.due_on as string | null) ?? null, status: `${t.status === "in_progress" ? "In progress" : "Ready"} (${t.phase})`, href: cl ? `/clients/${cl.slug}` : null });
    }
    const week = groupWork(items, today);
    const owedList = owed.map((o) => ({ from: o.from, where: o.where, waiting_on_you: o.gist, client: o.client, asked: o.askedAt.slice(0, 10), escalated: o.status === "escalated", link: o.url }));
    const list = [...week.overdue, ...week.days.flatMap((d) => d.items)].slice(0, 12);
    if (list.length)
      chat?.card({ type: "list", title: `Your week: ${week.counts.overdue} late, ${week.counts.thisWeek} due this week`, items: list.map((i) => ({ title: i.title, detail: `${i.client ?? "No client"} · ${i.status}`, tone: i.due && i.due < today ? "bad" : i.due === today ? "warn" : null, href: i.href, when: i.due })) });
    return {
      ok: true,
      today,
      week: week.week,
      counts: { ...week.counts, replies_owed: owedList.length },
      late: week.overdue,
      this_week: week.days.filter((d) => d.items.length).map((d) => ({ day: `${d.name} ${d.day}`, items: d.items })),
      later: week.later,
      no_due_date: week.noDate,
      replies_owed: owedList,
      next_steps: ["Now check the person's connected Gmail, Asana and Slack with those connectors if they are connected, and add what you find by due date and client. Say which sources you checked and which weren't connected.", "Clean list, most urgent first: late, then each day, then later. One line per item: client, what, when."],
    };
  },
};

// ─── 8. Benchmarking project ─────────────────────────────────────────────────────────────────────────────────────────

const PROJECT_INSTRUCTIONS = (client: string) =>
  `This project holds the weekly content benchmarking and desk research for ${client}. Each week: compare their organic posting (formats, cadence, hooks, topics, engagement) with their closest competitors and the category; note what is working, what to try next and what to avoid; check what the platforms changed. Use web search for what competitors posted and for platform news, and the client's Brand Bible for voice. Save each week as one note named "Benchmark · week of <Monday>" and compare it with the previous week's note. Plain words, no em dashes. Never post or send anything.`;

const benchmarkingProject: AiTool = {
  name: "client_benchmarking_project",
  description:
    "Finds the client's Benchmarking project in Kaizen AI (or makes it the first time, private to the person; they can share it in the project's settings) and, when you pass a note, saves this week's benchmark in it. Call it first without a note: it returns the project's link, the earlier weekly notes and the latest one's text, so you can compare week over week and do this week's desk research (web search for the client's competitors and the category). Then write the benchmark and call it again with the note to save it as 'Benchmark · week of <Monday>' (saving again the same week replaces that week's note). Start new chats in that project so the history comes with them.",
  input_schema: {
    type: "object",
    properties: {
      client: { type: "string", description: "The client's name (default: the client the chat is pinned to)" },
      note: { type: "string", description: "This week's benchmark, in full, to save in the project" },
      week_of: { type: "string", description: "The Monday the note is for, YYYY-MM-DD (default: this week's)" },
    },
    additionalProperties: false,
  },
  lines: ["social"],
  run: async (user: Staff, input, chat) => {
    const got = await clientFor(user, input, chat);
    if ("error" in got) return fail(got.error);
    const c = got.client;
    const db = await createClient();
    const { data: found, error: findErr } = await db
      .from("ai_projects")
      .select("id, name, created_by, visibility, everyone_can_edit, ai_project_members(profile_id, role)")
      .eq("client_id", c.id)
      .is("archived_at", null)
      .ilike("name", "%benchmark%")
      .order("updated_at", { ascending: false })
      .limit(10);
    if (findErr) return fail("Projects aren't switched on yet.");
    type P = { id: string; name: string; created_by: string; visibility: ProjectAccess["visibility"]; everyone_can_edit: boolean; ai_project_members: ProjectAccess["members"] };
    const mine = ((found ?? []) as unknown as P[]).map((p) => ({ p, role: projectRole({ created_by: p.created_by, visibility: p.visibility, everyone_can_edit: p.everyone_can_edit, members: p.ai_project_members ?? [] }, user) }));
    let project = mine.find((x) => canEditProject(x.role))?.p ?? null;
    let created = false;
    const readOnly = !project && mine.length > 0;
    if (!project && !readOnly) {
      const { data, error } = await db
        .from("ai_projects")
        .insert({ created_by: user.id, name: `${c.name} · Benchmarking`, description: `Weekly content benchmarking and desk research for ${c.name}`, instructions: PROJECT_INSTRUCTIONS(c.name), client_id: c.id, visibility: "private" })
        .select("id, name, created_by, visibility, everyone_can_edit")
        .single();
      if (error || !data) return fail("Couldn't make the project. Try again.");
      project = { ...(data as unknown as P), ai_project_members: [] };
      created = true;
    }
    if (!project) return fail(`There's a Benchmarking project for ${c.name} (${mine[0].p.name}) but you can only view it. Ask its owner to make you an editor, or I can make your own.`);
    const href = `/ai?p=${project.id}`;
    const { data: docs } = await db.from("ai_project_docs").select("id, name, chars, created_at, text").eq("project_id", project.id).order("created_at", { ascending: false }).limit(12);
    const monday = str(input.week_of) && /^\d{4}-\d{2}-\d{2}$/.test(String(input.week_of)) ? String(input.week_of) : weekOf(nyToday()).start;
    const note = String(input.note ?? "").trim();
    let saved: { name: string; replaced: boolean } | null = null;
    if (note) {
      if (note.length < 50) return fail("That note is too short to be a benchmark. Write the whole week's benchmark first.");
      const { MAX_DOC_CHARS } = await import("@/lib/kaizen-ai/projects-server");
      const text = note.slice(0, MAX_DOC_CHARS);
      const name = `Benchmark · week of ${monday}`;
      const existing = (docs ?? []).find((d) => d.name === name);
      const { error } = existing
        ? await db.from("ai_project_docs").update({ text, chars: text.length }).eq("id", existing.id)
        : await db.from("ai_project_docs").insert({ project_id: project.id, kind: "text", name, text, chars: text.length, added_by: user.id });
      if (error) return fail("Couldn't save the note in the project. Try again.");
      await db.from("ai_projects").update({ updated_at: new Date().toISOString() }).eq("id", project.id);
      saved = { name, replaced: Boolean(existing) };
    }
    chat?.card({ type: "link", title: project.name, detail: saved ? `${saved.name} ${saved.replaced ? "updated" : "saved"} · ${(docs ?? []).length + (saved && !saved.replaced ? 1 : 0)} notes` : created ? "Project made: private to you, share it in its settings" : `${(docs ?? []).length} notes`, href, cta: "Open the project" });
    const previous = (docs ?? []).filter((d) => d.name !== saved?.name);
    return {
      ok: true,
      project: { id: project.id, name: project.name, link: href, made_now: created, visibility: project.visibility },
      saved,
      week_of: monday,
      earlier_notes: previous.map((d) => ({ name: d.name, saved: String(d.created_at).slice(0, 10), chars: d.chars })),
      latest_note: !saved && previous[0] ? { name: previous[0].name, text: String(previous[0].text ?? "").slice(0, 8000) } : null,
      note: saved ? "Saved. Tell them where, and that new chats started in that project carry the history." : "Do this week's desk research (web search for the client's closest competitors' recent posts and the category, the Brand Bible for voice), compare with the latest note, write the benchmark, then call this again with it as the note.",
    };
  },
};

export const tools: AiTool[] = [cleanKlaviyoList, monthlyMoments, saveClientMoments, onboardingResearch, saveClientNote, metaTroubleshoot, onboardingStatus, readReportSheet, weeklyTaskSummary, benchmarkingProject];
