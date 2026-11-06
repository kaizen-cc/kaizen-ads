import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraph } from "@/lib/context/meta";
import { metaWrite, metaWritableSetup, metaWriteSetting, writeBlocked } from "@/lib/meta-write";
import { metaDeepLink } from "@/lib/chat-change-core";
import { step } from "@/lib/launch-cache";
import { canIdOn } from "@/lib/chat-permissions-server";
import { openSource, type SheetSource } from "./intake";
import { gridToSheet } from "./sheet";
import { resolveSheet } from "./resolve";
import { askQuestions, proposeStructure, readWithModel, replyToBuyer } from "./converse";
import { applyAnswers, followStructure, mergeQuestions, requiredQuestions } from "./questions";
import { buildPlan, planItems, runOutcome, runnable, unanswered } from "./plan";
import { adParams, adsetParams, campaignParams, creativeSpec, ENHANCEMENTS_OFF, formFields, scheduleParams, type Uploaded } from "./payloads";
import { explainMetaError } from "./errors";
import { isPostUrl } from "./sheet";
import type { ItemStatus, LaunchItem, LaunchPlan, LaunchQuestion, LaunchSheet, Resolution, RunStatus } from "./types";
import { ASKS_FOR_LINK, followLanding, urlIn, type LandingSet } from "@/lib/landing-pages-core";
import { settleLanding } from "@/lib/landing-pages";

// A launch from a sheet, start to finish, for any client and any chat surface:
//   read     the file (structure, links, colors) and the Media Buyer's read of it
//   resolve  check it against the live account and Drive (read-only)
//   ask      the summary, the checklist and the questions only the buyer can answer (nothing is planned before)
//   plan     the structure the conversation settled on, as line items, each dry-run with Meta (validate_only)
//   apply    on the buyer's confirm: created in order, PAUSED (or scheduled as agreed), each line once (its Meta id is
//            kept, so a stopped run resumes and only failed lines are retried), then read back and compared to the plan
// Every write goes through src/lib/meta-write.ts (the sandbox and per-client live-changes gate).

export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const now = () => new Date().toISOString();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Turn = { role: "user" | "assistant"; text: string; at: string };
type Run = {
  id: string;
  client_id: string;
  account: string | null;
  status: RunStatus;
  progress: string | null;
  source: SheetSource;
  sheet: LaunchSheet | null;
  summary: string | null;
  resolution: Resolution | null;
  questions: LaunchQuestion[];
  turns: Turn[];
  plan: LaunchPlan | null;
  created_by: string | null;
};

async function load(admin: SupabaseClient, id: string): Promise<Run | null> {
  const { data } = await admin.from("launch_runs").select("id, client_id, account, status, progress, source, sheet, summary, resolution, questions, turns, plan, created_by").eq("id", id).maybeSingle();
  return (data as Run | null) ?? null;
}
const patch = (admin: SupabaseClient, id: string, p: Record<string, unknown>) => admin.from("launch_runs").update({ ...p, updated_at: now() }).eq("id", id);

/** A new launch from a shared sheet; read and checked in the background (prepareRun) */
export async function startRun(admin: SupabaseClient, clientId: string, profileId: string, source: SheetSource, surface: "client_chat" | "kaizen_ai"): Promise<{ id: string } | { error: string }> {
  // Only someone who may launch in this client's Meta account starts one (every surface comes here)
  const allowed = await canIdOn(admin, profileId, "ads.launch", { platform: "meta", clientId });
  if (!allowed.ok) return { error: allowed.reason };
  const { data, error } = await admin.from("launch_runs").insert({ client_id: clientId, created_by: profileId, source, surface, status: "reading", progress: "Reading the sheet" }).select("id").single();
  if (error || !data) return { error: error?.message ?? "Couldn't start it." };
  return { id: data.id as string };
}

/** The launch this person has open with this client (being asked about, or a plan waiting), if any */
export async function openRunFor(admin: SupabaseClient, clientId: string, profileId: string) {
  const { data } = await admin
    .from("launch_runs")
    .select("id, status, platform, updated_at")
    .eq("client_id", clientId)
    .eq("created_by", profileId)
    .in("status", ["asking", "ready", "planning", "checking"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // An open run older than two weeks isn't what they're talking about now
  if (!data || Date.now() - Date.parse(data.updated_at as string) > 14 * 86_400_000) return null;
  return data as { id: string; status: RunStatus; platform: "meta" | "google" };
}

// ─── Read, check, ask ───────────────────────────────────────────────────────────────────────────────────────────

/** What the sheet is about, for ranking the client's pages: the event, the goal, the creatives and headlines */
export function metaTheme(sheet: LaunchSheet) {
  return [sheet.event.name, sheet.goal, ...sheet.rows.slice(0, 40).flatMap((r) => [r.creative.name, ...r.copy.slice(0, 2).map((c) => c.headline)])].join(" ").slice(0, 4000);
}

/** The client's landing pages for a Meta launch (kept a day), or null when they can't be read */
async function landingFor(admin: SupabaseClient, clientId: string, account: string | null): Promise<LandingSet | null> {
  const m = await import("@/lib/landing-pages");
  return m
    .findLandingPages(admin, clientId, { meta: account })
    .then((s) => m.keepOnRun(s))
    .catch(() => null);
}

/**
 * Reads the sheet, checks it against the account and Drive, then asks. The required questions are worked out by code,
 * so they're on the card (and answerable) as soon as the checks are done; the Media Buyer then tailors them on the
 * fast tier and they're merged in, keeping any answer already given. When the code found the table, the Media Buyer's
 * read (a summary and notes) runs alongside the checks instead of before them.
 */
export async function prepareRun(admin: SupabaseClient, id: string) {
  const t0 = Date.now();
  const scope = `meta run ${id.slice(0, 8)}`;
  const run = await load(admin, id);
  if (!run) return;
  let sheet!: LaunchSheet;
  let res!: Resolution;
  let read!: Awaited<ReturnType<typeof readWithModel>>;
  let pagesP: Promise<LandingSet | null> = Promise.resolve(null);
  const day = today();
  // The client's name and context for the tailoring step, read alongside everything else
  const ctxP = Promise.all([
    admin.from("clients").select("name").eq("id", run.client_id).single(),
    step(scope, "client context", import("@/lib/handoff").then((m) => m.accountBrief(admin, run.client_id, null)).then((b) => b.text)).catch(() => ""),
  ]);
  try {
    const opened = await step(scope, "open the sheet", openSource(admin, run.source));
    if (!opened.grid) throw new Error(opened.note ?? "The sheet couldn't be read.");
    const grid = opened.grid;
    sheet = gridToSheet(grid, day);
    const found = sheet.rows.length > 0;
    // The table wasn't found from the file's structure: the Media Buyer reads the rows first (the checks need them)
    const readP = step(scope, found ? "read summary (fast tier)" : "read rows (agent's model)", readWithModel(run.client_id, sheet, grid, opened.pdf, opened.name));
    readP.catch(() => undefined);
    if (!found) {
      const r = await readP;
      if (r.rows.length) {
        // The model's links point into the file's own links
        const links = [...new Set(grid.rows.flatMap((x) => x.flatMap((c) => c.links)))];
        sheet.via = "model";
        sheet.rows = r.rows.map((x, index) => {
          const ls = x.links.map((n) => links[n]).filter((u): u is string => Boolean(u));
          const post = ls.find(isPostUrl) ?? null;
          return {
            index,
            dateText: x.dateText,
            date: null,
            endDate: null,
            page: x.page,
            access: "",
            geo: x.geo,
            creative: { name: x.creative, links: ls },
            existingPost: post,
            copy: Array.from({ length: Math.max(x.headlines.length, x.primaries.length, x.descriptions.length) }, (_, i) => ({ headline: x.headlines[i] ?? "", primary: x.primaries[i] ?? "", description: x.descriptions[i] ?? "" })),
            link: null,
            cta: "",
            audience: "",
            color: x.color || null,
            colorHex: null,
            notes: [],
            extra: {},
          };
        });
        const { parseDate } = await import("./sheet");
        for (const x of sheet.rows) x.date = parseDate(x.dateText, Number(day.slice(0, 4)));
      }
    }
    if (!sheet.rows.length) throw new Error("No ads were found in the sheet (a table with rows of creative and copy).");
    // The checks match the account's campaigns by the event's name: when the code didn't find it, the read names it first
    if (!sheet.event.name) {
      const r = await readP;
      if (r.eventName) sheet.event.name = r.eventName;
    }
    await patch(admin, id, { sheet, status: "resolving", progress: `${sheet.rows.length} row${sheet.rows.length === 1 ? "" : "s"} read. Checking Pages, Drive files, places, the pixel and the account` });
    const checked = sheet;
    const [r1, r2] = await Promise.all([step(scope, "checks against the account and Drive", resolveSheet(admin, run.client_id, checked, day)), readP]);
    res = r1;
    read = r2;
    if (!sheet.event.name && read.eventName) sheet.event.name = read.eventName;
    if (!sheet.goal && read.goal) sheet.goal = read.goal;
    // The client's pages for the landing link (found alongside the tailoring; on the card now if already kept)
    pagesP = step(scope, "landing pages", landingFor(admin, run.client_id, res.account));
    res.landing = await Promise.race([pagesP, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    const must = followLanding(requiredQuestions(sheet, res, day), "link", res.landing, metaTheme(sheet));
    const colors = read.colorGuesses.filter((c) => c.color && c.guess);
    const summary = [read.summary, colors.length ? `Row colors (to confirm): ${colors.map((x) => `${x.color} probably means ${x.guess}`).join("; ")}.` : "", ...read.notes.map((n) => `Note: ${n}`)].filter(Boolean).join("\n\n");
    await patch(admin, id, { sheet, resolution: res, account: res.account, summary, questions: must, status: "asking", progress: "Tailoring the questions to the account", error: null });
    console.log(`[launch] ${scope} · questions on the card ${Date.now() - t0}ms`);
  } catch (e) {
    await patch(admin, id, { status: "failed", progress: null, error: msg(e).slice(0, 500) });
    return;
  }

  // ─── The Media Buyer tailors the questions (fast tier), merged in without touching answers ───
  try {
    const [{ data: c }, brief] = await ctxP;
    const must = requiredQuestions(sheet, res, day);
    const asked = await step(scope, "tailor questions (fast tier)", askQuestions(run.client_id, (c?.name as string) ?? "the client", brief, sheet, res, must, day));
    const latest = await load(admin, id);
    if (!latest) return;
    const colors = read.colorGuesses.filter((x) => x.color && x.guess);
    const summary = [read.summary, asked.summary, colors.length ? `Row colors (to confirm): ${colors.map((x) => `${x.color} probably means ${x.guess}`).join("; ")}.` : "", ...read.notes.map((n) => `Note: ${n}`)].filter(Boolean).join("\n\n");
    if (latest.status !== "asking") {
      await patch(admin, id, { summary, progress: latest.progress === "Tailoring the questions to the account" ? null : latest.progress });
      return;
    }
    const landing = (await pagesP) ?? latest.resolution?.landing ?? null;
    const questions = followLanding(mergeQuestions(asked.questions.map((q) => ({ ...q, answer: null })), must, latest.questions), "link", landing, metaTheme(sheet));
    await patch(admin, id, { summary, questions: followStructure(questions, latest.resolution?.existing ?? []), ...(latest.resolution ? { resolution: { ...latest.resolution, landing } } : {}), progress: null });
    console.log(`[launch] ${scope} · questions tailored ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[launch] ${scope} · tailoring failed:`, msg(e));
    // The questions from code stay; the pages still join them
    const landing = await pagesP;
    const latest = landing ? await load(admin, id) : null;
    if (latest?.resolution && latest.status === "asking") await patch(admin, id, { progress: null, resolution: { ...latest.resolution, landing }, questions: followLanding(latest.questions, "link", landing, metaTheme(sheet)) });
    else await patch(admin, id, { progress: null });
  }
}

// ─── The conversation ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The buyer's message about the launch: answers taken in, the Media Buyer's reply, and the plan built once every
 * required question is answered and the buyer wants it. offTopic: the message wasn't about the launch (the chat
 * answers it as usual instead).
 */
export async function launchReply(admin: SupabaseClient, id: string, message: string): Promise<{ answer: string; offTopic: boolean; building: boolean }> {
  const run = await load(admin, id);
  if (!run?.sheet || !run.resolution) return { answer: "", offTopic: true, building: false };
  // The client's pages, so a page named in words ("the homepage") is answered with its link
  const asksLink = run.questions.some((q) => q.key === "link");
  const landing = run.resolution.landing ?? (asksLink ? await landingFor(admin, run.client_id, run.resolution.account) : null);
  const theme = metaTheme(run.sheet);
  const out = await replyToBuyer(run.client_id, run.sheet, run.resolution, run.questions, run.turns, message, run.status, { set: landing, theme });
  if (out.offTopic) return { answer: "", offTopic: true, building: false };
  let questions = applyAnswers(run.questions, out.answers);
  if (out.newQuestions.length) questions = mergeQuestions(out.newQuestions.map((q) => ({ ...q, answer: null })), [], questions);
  questions = followStructure(questions, run.resolution.existing);
  // The landing link as a real link: a page named in words taken from the list, a typed link checked
  const settled = asksLink ? await settleLanding(questions, "link", landing, message, out.answers.some((a) => a.key === "link")) : { questions, note: null, took: false };
  questions = followLanding(settled.questions, "link", landing, theme);
  const said = settled.took && ASKS_FOR_LINK.test(out.answer) ? (settled.note ?? "") : [out.answer, settled.note].filter(Boolean).join(" ");
  if (settled.took) out.answers.push({ key: "link", answer: questions.find((q) => q.key === "link")?.answer ?? "" });
  out.answer = said;
  if (landing && !run.resolution.landing) await patch(admin, id, { resolution: { ...run.resolution, landing } });
  const turns = [...run.turns, { role: "user" as const, text: message.slice(0, 3000), at: now() }, { role: "assistant" as const, text: out.answer, at: now() }].slice(-40);
  if (out.setAside) {
    await patch(admin, id, { questions, turns, status: "set_aside" });
    return { answer: out.answer || "Set aside. Nothing was created.", offTopic: false, building: false };
  }
  const open = unanswered(questions);
  // Once a plan is checked, "go ahead" is the Create button on the card (it checks who may confirm): only a change
  // to an answer rebuilds it
  // Chat first: once a reply leaves nothing required open, the preview is built (they don't have to say "build it")
  const building = !open.length && (out.build || out.answers.length > 0) && (run.status === "asking" || out.answers.length > 0);
  const answer = out.build && open.length ? `${out.answer}\n\nBefore I can plan it I still need: ${open.map((q) => q.question).join(" ")}` : out.answer;
  // A change after the plan was made: back to asking until it's rebuilt
  const changed = out.answers.length > 0 && ["ready", "failed"].includes(run.status);
  await patch(admin, id, { questions, turns, ...(building ? { status: "planning", progress: "Laying out the plan" } : changed ? { status: "asking" } : {}) });
  return { answer, offTopic: false, building };
}

/** The buyer took the Media Buyer's proposals as they are (on the card): those questions answered with them */
export async function acceptProposals(admin: SupabaseClient, id: string, keys: string[], chosen: Record<string, string> = {}) {
  const run = await load(admin, id);
  if (!run) return;
  // An option the buyer clicked must be one the question offered
  const questions = applyAnswers(
    run.questions,
    run.questions
      .filter((q) => keys.includes(q.key) && !q.answer)
      .map((q) => ({ key: q.key, answer: chosen[q.key] && q.options.includes(chosen[q.key]) ? chosen[q.key] : q.proposal })),
  );
  await patch(admin, id, { questions: followStructure(questions, run.resolution?.existing ?? []) });
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────

async function accountInfo(account: string) {
  const a = await metaGraph<{ timezone_name?: string; timezone_offset_hours_utc?: number }>(`act_${account}`, { fields: "timezone_name,timezone_offset_hours_utc" }).catch(() => ({}) as { timezone_name?: string; timezone_offset_hours_utc?: number });
  return { tzName: a.timezone_name ?? "America/New_York", tz: a.timezone_offset_hours_utc ?? -5 };
}

/** Lays out the plan from the conversation, lists its lines and dry-runs them. Refused while a required question is open. */
export async function planRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.sheet || !run.resolution) return;
  const open = unanswered(run.questions);
  if (open.length) {
    await patch(admin, id, { status: "asking", progress: null, error: `Still to answer: ${open.map((q) => q.key).join(", ")}` });
    return;
  }
  try {
    const account = run.resolution.account;
    if (!account) throw new Error("No Meta ad account is linked to this client.");
    const day = today();
    const [{ tzName }, setup, settings, { data: client }] = await Promise.all([
      accountInfo(account),
      metaWritableSetup(admin, account).catch(() => null),
      metaWriteSetting(admin),
      admin.from("clients").select("url_tags").eq("id", run.client_id).single(),
    ]);
    const names = [...(setup?.campaigns ?? []).map((c) => `campaign: ${c.name}`), ...(setup?.adsets ?? []).slice(0, 20).map((s) => `ad set: ${s.name}`)];
    // The landing page the buyer chose is the sheet's link (rows with their own link keep it)
    const chosen = urlIn(run.questions.find((q) => q.key === "link")?.answer);
    const sheet: LaunchSheet = chosen ? { ...run.sheet, event: { ...run.sheet.event, link: chosen } } : run.sheet;
    const proposal = await proposeStructure(run.client_id, sheet, run.resolution, run.questions, run.turns, day, names, tzName);
    const urlTags = ((client?.url_tags as string | null) ?? "").trim() || (settings.urlTags ?? null);
    const { plan, warnings } = buildPlan(proposal, { sheet, resolution: run.resolution, account, urlTags, today: day, specialAdCategories: [] });
    // A new ad set copied from an existing one: its targeting, pixel, event and optimization, read as they are now
    for (const s of plan.adsets.filter((x) => x.cloneFrom)) {
      const src = await metaGraph<{ name?: string; targeting?: Record<string, unknown>; promoted_object?: Record<string, unknown>; optimization_goal?: string; billing_event?: string }>(s.cloneFrom!, { fields: "name,targeting,promoted_object,optimization_goal,billing_event" }).catch(() => null);
      if (!src?.targeting) {
        warnings.push(`Ad set "${s.name}": couldn't read the ad set it copies, so it uses the targeting in the plan.`);
        s.cloneFrom = null;
        continue;
      }
      s.cloned = { targeting: src.targeting, promotedObject: src.promoted_object ?? null, optimizationGoal: src.optimization_goal ?? s.optimizationGoal, billingEvent: src.billing_event ?? "IMPRESSIONS", name: src.name ?? "" };
      s.pixelId = (src.promoted_object?.pixel_id as string | undefined) ?? s.pixelId;
      s.event = (src.promoted_object?.custom_event_type as string | undefined) ?? s.event;
    }
    // The lines, replacing those of an earlier plan that weren't created (created ones are kept, never made twice)
    const { data: old } = await admin.from("launch_items").select("key, status").eq("run_id", id);
    const made = new Set((old ?? []).filter((o) => o.status === "created").map((o) => o.key as string));
    await admin.from("launch_items").delete().eq("run_id", id).neq("status", "created");
    const items = planItems(plan).filter((i) => !made.has(i.key));
    if (items.length)
      await admin.from("launch_items").insert(items.map((i) => ({ run_id: id, key: i.key, kind: i.kind, position: i.position, parent_key: i.parentKey, label: i.label, status: i.status, meta_id: i.metaId })));
    await patch(admin, id, { plan, plan_warnings: warnings, status: "checking", progress: "Checking every line with Meta (nothing is created)", error: null });
    await validateRun(admin, id);
  } catch (e) {
    await patch(admin, id, { status: "asking", progress: null, error: `The plan couldn't be laid out: ${msg(e)}`.slice(0, 500) });
  }
}

type ItemRow = { id: string; key: string; kind: LaunchItem["kind"]; position: number; parent_key: string | null; label: string; status: ItemStatus; meta_id: string | null; detail: Record<string, unknown> | null; error: string | null; help: string | null; checked_at: string | null };
async function items(admin: SupabaseClient, runId: string): Promise<ItemRow[]> {
  const { data } = await admin.from("launch_items").select("id, key, kind, position, parent_key, label, status, meta_id, detail, error, help, checked_at").eq("run_id", runId).order("position");
  return (data ?? []) as ItemRow[];
}
const asItem = (r: ItemRow): LaunchItem => ({ key: r.key, kind: r.kind, position: r.position, parentKey: r.parent_key, label: r.label, status: r.status, metaId: r.meta_id, error: r.error, help: r.help, checked: r.checked_at });
const setItem = (admin: SupabaseClient, runId: string, key: string, p: Record<string, unknown>) => admin.from("launch_items").update({ ...p, updated_at: now() }).eq("run_id", runId).eq("key", key);

/** Copies a Drive file into storage for Meta to fetch (videos, and images for the dry run), returning a signed URL */
async function stage(admin: SupabaseClient, runId: string, fileId: string): Promise<{ url: string; bytes: Buffer; mime: string; name: string }> {
  const { driveToken } = await import("@/lib/context/google");
  const token = await driveToken();
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!meta.ok) throw new Error("Kaizen's Google account can't open this file.");
  const f = (await meta.json()) as { name: string; mimeType: string };
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive download: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const path = `launch/${runId}/${fileId}-${f.name.replace(/[^\w.-]+/g, "-").slice(-80)}`;
  const up = await admin.storage.from("ad-media").upload(path, bytes, { contentType: f.mimeType, upsert: true });
  if (up.error) throw new Error(`Couldn't stage ${f.name} for Meta: ${up.error.message}`);
  const { data } = await admin.storage.from("ad-media").createSignedUrl(path, 60 * 60 * 24);
  if (!data?.signedUrl) throw new Error("Couldn't stage the file for Meta.");
  return { url: data.signedUrl, bytes, mime: f.mimeType, name: f.name };
}

/** A failed check or write on a line: Meta's words, in plain words, and the fix */
const failure = (e: unknown) => {
  const raw = msg(e);
  const x = explainMetaError(raw);
  return { error: `${x.plain} (Meta: ${raw.replace(/^Meta \([^)]*\):\s*/, "").slice(0, 300)})`, help: x.fix };
};

/** Meta's dry run (validate_only) of every line it can check before anything exists; the rest say why they wait */
export async function validateRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return;
  const plan = run.plan;
  const account = plan.account;
  const blocked = await writeBlocked(admin, account);
  const rows = await items(admin, id);
  const { tz } = await accountInfo(account);
  const setup = await metaWritableSetup(admin, account).catch(() => null);
  for (const r of rows) {
    if (r.status === "created" || r.status === "existing") continue;
    const at = now();
    const skip = (help: string) => setItem(admin, id, r.key, { status: "unchecked", error: null, help, checked_at: at });
    const result = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await setItem(admin, id, r.key, { status: "valid", error: null, help: null, checked_at: at });
      } catch (e) {
        await setItem(admin, id, r.key, { status: "invalid", ...failure(e), checked_at: at });
      }
    };
    if (blocked && r.kind !== "media") {
      await skip(`Not checked with Meta: ${blocked}`);
      continue;
    }
    if (r.kind === "campaign") {
      const c = plan.campaigns.find((x) => `campaign:${x.key}` === r.key)!;
      await result(() => metaWrite(admin, account, `act_${account}/campaigns`, campaignParams(c, plan.goLive, tz), true));
    } else if (r.kind === "adset") {
      const s = plan.adsets.find((x) => `adset:${x.key}` === r.key)!;
      const c = plan.campaigns.find((x) => x.key === s.campaignKey);
      const cbo = Boolean(c?.budget) || Boolean(c?.existingId && setup?.campaigns.find((x) => x.id === c.existingId && (x.dailyBudget || x.lifetimeBudget)));
      // Under a campaign that exists: checked against it. Under a new one: against a campaign in the account with the
      // same objective and the same budget setup, standing in for it (Meta needs a real campaign to check an ad set)
      const stand = c?.existingId ?? setup?.campaigns.find((x) => x.objective === c?.objective && Boolean(x.dailyBudget || x.lifetimeBudget) === cbo)?.id ?? null;
      if (!stand) await skip("Checked by Meta when its campaign is created (no campaign like it to check against yet).");
      else await result(() => metaWrite(admin, account, `act_${account}/adsets`, adsetParams({ ...s, start: s.start && s.start > today() ? s.start : null }, stand, cbo, plan.goLive, tz), true));
    } else if (r.kind === "media") {
      const fileId = r.key.slice("media:".length);
      try {
        const staged = await stage(admin, id, fileId);
        await setItem(admin, id, r.key, { status: "valid", error: null, help: null, checked_at: at, detail: { url: staged.url, mime: staged.mime, bytes: staged.bytes.length } });
      } catch (e) {
        await setItem(admin, id, r.key, { status: "invalid", error: msg(e), help: "Share the file with the agency's Google Workspace (or anyone with the link).", checked_at: at });
      }
    } else if (r.kind === "creative") {
      const ad = plan.ads.find((x) => `creative:${x.key}` === r.key)!;
      if (ad.source.kind === "files" && [ad.source.feed, ad.source.vertical].some((m) => m?.kind === "video")) {
        await skip("Videos are checked by Meta once they're uploaded, when the launch is confirmed.");
        continue;
      }
      // Images by URL for the dry run (the real one uses the library hash after upload)
      const fresh = await items(admin, id);
      const urlOf = (fileId?: string) => (fileId ? ((fresh.find((x) => x.key === `media:${fileId}`)?.detail as { url?: string } | null)?.url ?? null) : null);
      const media = ad.source.kind === "files" ? { feed: ad.source.feed ? { url: urlOf(ad.source.feed.fileId) } : null, vertical: ad.source.vertical ? { url: urlOf(ad.source.vertical.fileId) } : null } : { feed: null, vertical: null };
      try {
        await metaWrite(admin, account, `act_${account}/adcreatives`, formFields(creativeSpec(ad, media)), true);
        await setItem(admin, id, r.key, { status: "valid", error: null, help: null, checked_at: at });
      } catch (e) {
        // A refusal about the image link itself only means the dry run couldn't fetch it: the upload settles it
        if (/\burl\b|image_url|picture|hash|could not (download|fetch)/i.test(msg(e))) await skip("The images are checked by Meta when they're uploaded, at launch.");
        else await setItem(admin, id, r.key, { status: "invalid", ...failure(e), checked_at: at });
      }
    } else if (r.kind === "ad") await skip("Checked by Meta when it's created (it needs its creative first).");
  }
  const after = await items(admin, id);
  const bad = after.filter((x) => x.status === "invalid").length;
  await patch(admin, id, { status: "ready", progress: null, error: bad ? `${bad} line${bad === 1 ? "" : "s"} won't go through as planned: see each line.` : null });
}

// ─── Creating it ────────────────────────────────────────────────────────────────────────────────────────────────

/** Holds the run for one worker (a click and a resume never create twice); a hold older than 10 minutes is stale */
async function lock(admin: SupabaseClient, id: string) {
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await admin.from("launch_runs").update({ locked_at: now() }).eq("id", id).or(`locked_at.is.null,locked_at.lt.${stale}`).select("id");
  return Boolean(data?.length);
}

/** Uploads one file from Drive into the ad account's library: an image's hash, or a video's id and poster */
async function upload(admin: SupabaseClient, runId: string, account: string, fileId: string, detail: Record<string, unknown> | null): Promise<Uploaded & { url?: string }> {
  const staged = await stage(admin, runId, fileId);
  if (staged.mime.startsWith("image/")) {
    const r = await metaWrite<{ images?: Record<string, { hash: string }> }>(admin, account, `act_${account}/adimages`, { bytes: staged.bytes.toString("base64") }, false);
    const hash = Object.values(r.images ?? {})[0]?.hash;
    if (!hash) throw new Error("Meta didn't return the image's hash");
    return { hash, url: staged.url };
  }
  const v = await metaWrite<{ id: string }>(admin, account, `act_${account}/advideos`, { file_url: staged.url, name: staged.name.slice(0, 200) }, false);
  for (let i = 0; i < 30; i++) {
    const s = await metaGraph<{ status?: { video_status?: string } }>(v.id, { fields: "status" }).catch(() => null);
    if (s?.status?.video_status === "ready") break;
    if (s?.status?.video_status === "error") throw new Error("Meta couldn't process the video");
    await new Promise((r) => setTimeout(r, 6000));
  }
  const thumbs = await metaGraph<{ data: { uri: string; is_preferred: boolean }[] }>(`${v.id}/thumbnails`, {}).catch(() => ({ data: [] }));
  void detail;
  return { videoId: v.id, thumb: thumbs.data.find((t) => t.is_preferred)?.uri ?? thumbs.data[0]?.uri ?? null };
}

/**
 * Creates the plan in Meta, line by line, in order. retry: failed lines are tried again (only them). Stops before
 * budgetMs runs out and leaves the run to be continued (the card continues it), so a long launch never half-creates.
 */
export async function applyRun(admin: SupabaseClient, id: string, opts: { retry?: boolean; budgetMs?: number; by: string }) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  // The person creating it must be allowed to launch in this client's Meta account (then the switch, below)
  const { data: owner } = await admin.from("launch_runs").select("client_id").eq("id", id).maybeSingle();
  const allowed = await canIdOn(admin, opts.by, "ads.launch", { platform: "meta", clientId: (owner?.client_id as string | undefined) ?? null });
  if (!allowed.ok) {
    await admin.from("launch_runs").update({ status: "ready", progress: null, error: allowed.reason, updated_at: now() }).eq("id", id).eq("status", "applying");
    return { blocked: allowed.reason };
  }
  if (!(await lock(admin, id))) return { busy: true };
  try {
    const run = await load(admin, id);
    if (!run?.plan) throw new Error("There's no plan to create.");
    const plan = run.plan;
    const account = plan.account;
    const blocked = await writeBlocked(admin, account);
    if (blocked) {
      await patch(admin, id, { status: "ready", progress: null, error: blocked });
      return { blocked };
    }
    if (opts.retry) await admin.from("launch_items").update({ status: "planned", error: null, help: null }).eq("run_id", id).in("status", ["failed", "invalid", "skipped"]);
    // Lines Meta already refused in the dry run are left out (with their reason) unless the buyer retries them
    else await admin.from("launch_items").update({ status: "skipped" }).eq("run_id", id).eq("status", "invalid");
    await patch(admin, id, { status: "applying", progress: "Creating in Meta" });
    const { tz } = await accountInfo(account);
    const day = today();
    const setup = await metaWritableSetup(admin, account).catch(() => null);
    let rows = await items(admin, id);
    const total = rows.filter((r) => r.status !== "existing").length;
    for (;;) {
      const next = runnable(rows.map(asItem), plan, false)[0];
      if (!next) break;
      if (Date.now() - started > budget) {
        await patch(admin, id, { progress: "Continuing…" });
        return { more: true };
      }
      const r = rows.find((x) => x.key === next.key)!;
      const metaOf = (key: string) => rows.find((x) => x.key === key)?.meta_id ?? null;
      await setItem(admin, id, r.key, { status: "creating" });
      await patch(admin, id, { progress: `Creating ${rows.filter((x) => x.status === "created").length + 1} of ${total}: ${r.label}` });
      try {
        let metaId: string | null = null;
        let detail: Record<string, unknown> = r.detail ?? {};
        let help: string | null = null;
        if (r.kind === "campaign") {
          const c = plan.campaigns.find((x) => `campaign:${x.key}` === r.key)!;
          metaId = (await metaWrite<{ id: string }>(admin, account, `act_${account}/campaigns`, campaignParams(c, plan.goLive, tz), false)).id;
          const notes: string[] = [];
          for (const s of c.budget?.schedules ?? []) {
            if (s.end < day) continue;
            await metaWrite(admin, account, `${metaId}/budget_schedules`, scheduleParams({ ...s, start: s.start < day ? day : s.start }, tz), false).catch((e) => notes.push(`Budget for ${s.start} to ${s.end} not scheduled: ${msg(e)}`));
          }
          help = notes.join(" ") || null;
        } else if (r.kind === "adset") {
          const s = plan.adsets.find((x) => `adset:${x.key}` === r.key)!;
          const c = plan.campaigns.find((x) => x.key === s.campaignKey)!;
          const campaignId = metaOf(`campaign:${c.key}`) ?? c.existingId!;
          const cbo = Boolean(c.budget) || Boolean(c.existingId && setup?.campaigns.find((x) => x.id === c.existingId && (x.dailyBudget || x.lifetimeBudget)));
          // A start that's already passed: it starts when turned on. A scheduled start needs a future date, else paused.
          const future = Boolean(s.start && s.start > day);
          const goLive = plan.goLive === "scheduled" && future ? "scheduled" : "paused";
          metaId = (await metaWrite<{ id: string }>(admin, account, `act_${account}/adsets`, adsetParams({ ...s, start: future ? s.start : null }, campaignId, cbo, goLive, tz), false)).id;
        } else if (r.kind === "media") {
          const up = await upload(admin, id, account, r.key.slice("media:".length), r.detail);
          detail = { ...detail, ...up };
          metaId = up.hash ?? up.videoId ?? null;
        } else if (r.kind === "creative") {
          const ad = plan.ads.find((x) => `creative:${x.key}` === r.key)!;
          const media = (fileId?: string): Uploaded | null => (fileId ? ((rows.find((x) => x.key === `media:${fileId}`)?.detail ?? null) as Uploaded | null) : null);
          const m = ad.source.kind === "files" ? { feed: media(ad.source.feed?.fileId), vertical: media(ad.source.vertical?.fileId) } : { feed: null, vertical: null };
          // Enhancement switches Meta doesn't know on this API version are dropped and the creative tried again
          let optOut = [...ENHANCEMENTS_OFF];
          let multiOff = true;
          for (let i = 0; i < 12 && !metaId; i++) {
            try {
              metaId = (await metaWrite<{ id: string }>(admin, account, `act_${account}/adcreatives`, formFields(creativeSpec(ad, m, { optOut, multiOff })), false)).id;
            } catch (e) {
              const t = msg(e);
              const named = optOut.find((f) => t.includes(f));
              if (multiOff && /contextual_multi_ads|multi.?advertiser/i.test(t)) multiOff = false;
              else if (named) optOut = optOut.filter((f) => f !== named);
              else if (optOut.length && /creative_features_spec|degrees_of_freedom|enroll_status|creative feature/i.test(t)) optOut = [];
              else throw e;
            }
          }
        } else if (r.kind === "ad") {
          const ad = plan.ads.find((x) => `ad:${x.key}` === r.key)!;
          const s = plan.adsets.find((x) => x.key === ad.adsetKey)!;
          const adsetId = metaOf(`adset:${s.key}`) ?? s.existingId!;
          const creativeId = metaOf(`creative:${ad.key}`)!;
          const goLive = plan.goLive === "scheduled" && s.start && s.start > day ? "scheduled" : "paused";
          try {
            metaId = (await metaWrite<{ id: string }>(admin, account, `act_${account}/ads`, adParams(ad, adsetId, creativeId, goLive, s.pixelId), false)).id;
          } catch (e) {
            // Meta won't take the tracking on this ad: made without it
            if (!/tracking/i.test(msg(e))) throw e;
            metaId = (await metaWrite<{ id: string }>(admin, account, `act_${account}/ads`, adParams(ad, adsetId, creativeId, goLive, null), false)).id;
          }
        }
        if (!metaId) throw new Error("Meta didn't return an id");
        await setItem(admin, id, r.key, { status: "created", meta_id: metaId, detail, error: null, help });
      } catch (e) {
        await setItem(admin, id, r.key, { status: "failed", ...failure(e) });
      }
      rows = await items(admin, id);
    }
    const outcome = runOutcome(rows.map(asItem));
    await patch(admin, id, { status: outcome, progress: outcome === "applied" ? "Reading back what was created" : null, applied_at: outcome !== "failed" ? now() : null, error: outcome === "applied" ? null : "Some lines didn't go through: see each line, fix what it says, then retry them." });
    await qaRun(admin, id).catch(() => undefined);
    return { outcome };
  } catch (e) {
    await patch(admin, id, { status: "failed", progress: null, error: msg(e).slice(0, 500) });
    return { error: msg(e) };
  } finally {
    await admin.from("launch_runs").update({ locked_at: null }).eq("id", id);
  }
}

// ─── Read back ──────────────────────────────────────────────────────────────────────────────────────────────────

export type QaLine = { key: string; ok: boolean; diffs: string[]; link: string | null };

/** Everything created, read back from Meta and compared with the plan, each with its place in Ads Manager */
export async function qaRun(admin: SupabaseClient, id: string) {
  const run = await load(admin, id);
  if (!run?.plan) return;
  const plan = run.plan;
  const rows = (await items(admin, id)).filter((r) => r.status === "created" && r.meta_id && r.kind !== "media");
  const minor = (n: number | undefined) => (n == null ? null : Math.round(n * 100));
  const out: QaLine[] = [];
  for (const r of rows) {
    const diffs: string[] = [];
    let link: string | null = null;
    try {
      if (r.kind === "campaign") {
        const c = plan.campaigns.find((x) => `campaign:${x.key}` === r.key)!;
        const m = await metaGraph<{ name: string; status: string; objective: string; daily_budget?: string; lifetime_budget?: string }>(r.meta_id!, { fields: "name,status,objective,daily_budget,lifetime_budget" });
        if (m.name !== c.name.slice(0, 400)) diffs.push(`name is "${m.name}"`);
        if (m.objective !== c.objective) diffs.push(`objective is ${m.objective}`);
        if (c.budget && Number(m[c.budget.type === "daily" ? "daily_budget" : "lifetime_budget"] ?? 0) !== minor(c.budget.amount)) diffs.push(`budget is $${Number(m.daily_budget ?? m.lifetime_budget ?? 0) / 100}`);
        if (plan.goLive === "paused" && m.status !== "PAUSED") diffs.push(`status is ${m.status}`);
        link = metaDeepLink(plan.account, "campaign", r.meta_id);
      } else if (r.kind === "adset") {
        const s = plan.adsets.find((x) => `adset:${x.key}` === r.key)!;
        const m = await metaGraph<{ name: string; status: string; daily_budget?: string; lifetime_budget?: string; promoted_object?: { pixel_id?: string; custom_event_type?: string }; targeting?: { age_min?: number } }>(r.meta_id!, { fields: "name,status,daily_budget,lifetime_budget,promoted_object,targeting" });
        if (m.name !== s.name.slice(0, 400)) diffs.push(`name is "${m.name}"`);
        if (s.pixelId && m.promoted_object?.pixel_id !== s.pixelId) diffs.push("optimizes for a different pixel");
        if (s.event && m.promoted_object?.custom_event_type && m.promoted_object.custom_event_type !== s.event) diffs.push(`optimizes for ${m.promoted_object.custom_event_type}`);
        if (!s.cloned && m.targeting?.age_min != null && m.targeting.age_min !== s.targeting.ageMin) diffs.push(`minimum age is ${m.targeting.age_min}`);
        if (s.budget && !plan.campaigns.find((c) => c.key === s.campaignKey)?.budget && Number(m[s.budget.type === "daily" ? "daily_budget" : "lifetime_budget"] ?? 0) !== minor(s.budget.amount)) diffs.push("budget differs");
        if (plan.goLive === "paused" && m.status !== "PAUSED") diffs.push(`status is ${m.status}`);
        link = metaDeepLink(plan.account, "adset", r.meta_id);
      } else if (r.kind === "creative") {
        const ad = plan.ads.find((x) => `creative:${x.key}` === r.key)!;
        const m = await metaGraph<{ asset_feed_spec?: { bodies?: unknown[]; titles?: unknown[] }; object_story_spec?: { page_id?: string } ; effective_object_story_id?: string }>(r.meta_id!, { fields: "asset_feed_spec,object_story_spec,effective_object_story_id" });
        if (ad.source.kind === "files" && (ad.copy.bodies.length > 1 || ad.copy.titles.length > 1)) {
          if ((m.asset_feed_spec?.bodies?.length ?? 1) !== ad.copy.bodies.length) diffs.push(`${m.asset_feed_spec?.bodies?.length ?? 1} primary texts instead of ${ad.copy.bodies.length}`);
          if ((m.asset_feed_spec?.titles?.length ?? 1) !== ad.copy.titles.length) diffs.push(`${m.asset_feed_spec?.titles?.length ?? 1} headlines instead of ${ad.copy.titles.length}`);
        }
        if (m.object_story_spec?.page_id && m.object_story_spec.page_id !== ad.identity.pageId) diffs.push("runs as a different Page");
      } else if (r.kind === "ad") {
        const ad = plan.ads.find((x) => `ad:${x.key}` === r.key)!;
        const m = await metaGraph<{ name: string; status: string; creative?: { id: string } }>(r.meta_id!, { fields: "name,status,creative{id}" });
        const creative = rows.find((x) => x.key === `creative:${ad.key}`)?.meta_id;
        if (creative && m.creative?.id !== creative) diffs.push("uses a different creative");
        if (plan.goLive === "paused" && m.status !== "PAUSED") diffs.push(`status is ${m.status}`);
        link = metaDeepLink(plan.account, "ad", r.meta_id);
      }
    } catch (e) {
      diffs.push(`couldn't be read back: ${msg(e)}`);
    }
    out.push({ key: r.key, ok: !diffs.length, diffs, link });
  }
  await patch(admin, id, { qa: { at: now(), lines: out }, progress: null });
}
