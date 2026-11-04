import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// The team's Client Onboarding Sheet (a Google Sheet or Doc in Drive, "<Client> - Client Onboarding Sheet"), read as a
// source and split by where each part belongs: the brand facts the Bible keeps (products with features and benefits,
// the funnel, benchmarks, competitors with their good and bad reviews, market research, offers, the primary promise
// and unique mechanism), the Meta planning (campaign structure, cold audiences, testing and retargeting plans) for the
// Meta go-to-market strategy, and the Google planning (keywords, ad copy, sitelinks, callouts, locations, KPIs, notes
// by the client, landing page) for the Google one. Organic social and TikTok tabs are left out. Read once, and again
// only when the doc changes.

const SHEET = "application/vnd.google-apps.spreadsheet";
const DOC = "application/vnd.google-apps.document";
const MAX_TEXT = 120_000;

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string };
export type SheetPart = "bible" | "meta" | "google";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The client's name from the file's: "OceanBox - Client Onboarding Sheet" → "oceanbox" */
const clientKey = (fileName: string) => norm(fileName.replace(/client\s*onboarding\s*sheet/i, "").replace(/onboarding\s*sheet/i, ""));

/** A label left from the template, never content: "Competitor 1", "Keyword 3", "Status (For Client)", "Headlines" */
const PLACEHOLDER =
  /^(closest )?(competitor|keyword|aspect|test|pillar|persona|product \/ service|product\/service)\s*\d*\b.*$|^(status \(for client\)|comments \(if any\)|headlines?|descriptions?|sitelinks?|callouts?|details\/notes|features|benefits|good reviews|bad reviews|bof|mof|tof|brand|facebook ads library link|messaging\/creatives\/funnel|name \/ archetype|age \/ gender|income \/ location|what this includes|example post ideas|content mix % target|pillar name)$/i;

function clean(rows: string[][]) {
  return rows
    .map((r) => r.map((c) => (c ?? "").trim()).filter((c) => c && !PLACEHOLDER.test(c) && !/^✅/.test(c)))
    .filter((r) => r.length)
    .map((r) => r.join(" | "))
    .join("\n");
}

async function api(token: string, url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Every onboarding sheet the Drive user can see, in one search (the template itself left out) */
async function listSheets(token: string) {
  const out: DriveFile[] = [];
  let page: string | undefined;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({
      q: `name contains 'Onboarding Sheet' and trashed = false and (mimeType = '${SHEET}' or mimeType = '${DOC}')`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)",
      pageSize: "500",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
      ...(page ? { pageToken: page } : {}),
    });
    const r = (await (await api(token, `https://www.googleapis.com/drive/v3/files?${q}`)).json()) as { files: DriveFile[]; nextPageToken?: string };
    out.push(...r.files.filter((f) => !f.name.includes("{{")));
    page = r.nextPageToken;
    if (!page) break;
  }
  return out;
}

/** The text of a sheet (every tab, by name) or a doc */
async function readFile(token: string, f: DriveFile) {
  if (f.mimeType === SHEET) {
    const meta = (await (await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${f.id}?fields=sheets.properties.title`)).json()) as { sheets: { properties: { title: string } }[] };
    const titles = meta.sheets.map((s) => s.properties.title).slice(0, 40);
    if (!titles.length) return "";
    const q = titles.map((t) => `ranges=${encodeURIComponent(`'${t}'`)}`).join("&");
    const data = (await (await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${f.id}/values:batchGet?${q}&valueRenderOption=FORMATTED_VALUE`)).json()) as { valueRanges: { values?: string[][] }[] };
    return titles
      .map((t, i) => {
        const body = clean(data.valueRanges[i]?.values ?? []);
        return body ? `## ${t}\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_TEXT);
  }
  const text = await (await api(token, `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`)).text();
  return clean(text.split("\n").map((l) => [l])).slice(0, MAX_TEXT);
}

const S = { type: "string" };
const SCHEMA = { type: "object", properties: { empty: { type: "boolean" }, bible: S, meta: S, google: S }, required: ["empty", "bible", "meta", "google"], additionalProperties: false };

const SYSTEM = `You read a marketing agency's Client Onboarding Sheet: notes the team wrote by hand while onboarding a client, on a template. Pull out only what was actually filled in for this client and sort it into three parts, as concise markdown in the sheet's own words (keep names, links, numbers, quotes). Template labels and empty placeholders ("Competitor 1", "Keyword 2", "Status (For Client)", "Headlines") are not content: skip them. Leave out organic social media and TikTok content entirely.

bible: brand facts. Products or services each with details, features and benefits; the funnel or value journey; benchmarks; competitors (name, link, how they position, their good and bad reviews word for word); market research (what the market thinks, good reviews of the client); offers (incl. any email or SMS sign-up / pop-up offer, and new-customer offers); the primary promise and unique mechanism.
meta: Meta planning only: campaign structure, cold audience list, initial testing plan, retargeting plan, big ideas and angles, ad account assessment, and Meta copy (hooks, benefits, pain points, testimonies, offers).
google: Google planning only: product or service and main points, offers, KPIs (CPA), location targeting, main keywords and the selected keywords by funnel stage (brand, BOF, MOF, TOF), competitors' names and sites, campaign structure, campaign goal and targeting, initial testing plan, notes by the client, landing page, ad copies (headlines and descriptions with any client status or comments), sitelinks and callouts.
A part with nothing filled in is "". empty is true when the whole sheet is just the template.`;

/** The sheet's content for one client, sorted into its three parts */
async function extract(name: string, fileName: string, text: string) {
  return askJson<{ empty: boolean; bible: string; meta: string; google: string }>({
    agent: "brandbible",
    label: `read onboarding sheet ${name}`,
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 12000,
    override: { model: "sonnet", effort: "low" },
    prompt: `Client: ${name}\nFile: "${fileName}"\n\n<onboarding_sheet>\n${text}\n</onboarding_sheet>`,
  });
}

async function readInto(admin: SupabaseClient, token: string, clientId: string, name: string, f: DriveFile, source: "found" | "set") {
  const base = { client_id: clientId, file_id: f.id, url: f.webViewLink ?? `https://drive.google.com/open?id=${f.id}`, name: f.name, modified_at: f.modifiedTime, source, updated_at: new Date().toISOString() };
  try {
    const text = await readFile(token, f);
    const out = text.length < 200 ? { empty: true, bible: "", meta: "", google: "" } : await extract(name, f.name, text);
    const part = (s: string) => (out.empty || !s.trim() ? null : { markdown: s.trim() });
    await admin.from("client_onboarding_sheets").upsert({ ...base, bible: part(out.bible), meta: part(out.meta), google: part(out.google), error: null, read_at: new Date().toISOString() });
    return out.empty ? "template only" : "read";
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("client_onboarding_sheets").upsert({ ...base, error, read_at: new Date().toISOString() });
    return `failed: ${error}`;
  }
}

/**
 * Hourly: finds each client's onboarding sheet by name (or the one the team pointed to) and reads the ones that are new
 * or changed since, a few a run.
 */
export async function keepOnboardingSheets(admin: SupabaseClient, max = 3) {
  if (!process.env.GOOGLE_DRIVE_USER) return { skipped: "GOOGLE_DRIVE_USER not set" };
  const { driveToken } = await import("@/lib/context/google");
  const token = await driveToken();
  const [files, { data: clients }, { data: rows }] = await Promise.all([
    listSheets(token),
    admin.from("clients").select("id, name").is("archived_at", null),
    admin.from("client_onboarding_sheets").select("client_id, file_id, modified_at, source, read_at"),
  ]);
  const have = new Map((rows ?? []).map((r) => [r.client_id as string, r]));
  const byKey = new Map<string, DriveFile[]>();
  for (const f of files) {
    const k = clientKey(f.name);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const out: Record<string, string> = {};
  let read = 0;
  for (const c of clients ?? []) {
    if (read >= max) break;
    const row = have.get(c.id as string);
    let f: DriveFile | undefined;
    if (row?.source === "set") f = files.find((x) => x.id === row.file_id);
    else {
      const key = norm(c.name as string);
      // Their own sheet: the newest whose name is the client's (exact first, then one name inside the other)
      const exact = byKey.get(key);
      const loose = [...byKey.entries()].filter(([k]) => k.length > 3 && key.length > 3 && (k.includes(key) || key.includes(k))).flatMap(([, v]) => v);
      const pick = exact?.length ? exact : new Set(loose.map((x) => clientKey(x.name))).size === 1 ? loose : [];
      f = pick.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0];
    }
    if (!f) continue;
    if (row?.read_at && row.file_id === f.id && row.modified_at && Date.parse(row.modified_at as string) >= Date.parse(f.modifiedTime)) continue;
    out[c.name as string] = await readInto(admin, token, c.id as string, c.name as string, f, row?.source === "set" ? "set" : "found");
    read++;
  }
  return { sheets: files.length, read: out };
}

/** The team points to the client's sheet by its link (when it isn't found by name): read right away */
export async function setOnboardingSheet(admin: SupabaseClient, clientId: string, url: string) {
  const id = url.match(/\/d\/([\w-]{20,})/)?.[1] ?? url.match(/[?&]id=([\w-]{20,})/)?.[1] ?? (/^[\w-]{20,}$/.test(url.trim()) ? url.trim() : null);
  if (!id) return { ok: false as const, error: "That doesn't look like a Google Sheet or Doc link." };
  const { driveToken } = await import("@/lib/context/google");
  const token = await driveToken();
  let f: DriveFile;
  try {
    f = (await (await api(token, `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=id,name,mimeType,modifiedTime,webViewLink`)).json()) as DriveFile;
  } catch {
    return { ok: false as const, error: "Kaizen's Drive can't open that file: share it with the agency's Drive first." };
  }
  if (f.mimeType !== SHEET && f.mimeType !== DOC) return { ok: false as const, error: "It needs to be a Google Sheet or Google Doc." };
  const { data: c } = await admin.from("clients").select("name").eq("id", clientId).single();
  const r = await readInto(admin, token, clientId, (c?.name as string) ?? "the client", f, "set");
  return r.startsWith("failed") ? { ok: false as const, error: r } : { ok: true as const, result: r };
}

const NOTES: Record<SheetPart, string> = {
  bible: "the team's Client Onboarding Sheet, written by hand at onboarding: products with features and benefits, the funnel, benchmarks, competitors and their reviews, market research, offers. Its client facts are a source (cite it as the onboarding sheet); it's older than the calls and emails, so newer client words win",
  meta: "the team's Client Onboarding Sheet, Meta planning written at onboarding (campaign structure, cold audiences, testing and retargeting plans, angles and copy): build on it where the data agrees, and say where the strategy departs from it",
  google: "the team's Client Onboarding Sheet, Google planning written at onboarding (keywords by funnel stage, ad copy with the client's status and comments, sitelinks, callouts, locations, KPIs, notes by the client, landing page): build on it, keep what the client approved, and say where the strategy departs from it",
};

/** One part of the client's onboarding sheet, for the Bible or a go-to-market strategy ("" when there's none) */
export async function sheetBlock(admin: SupabaseClient, clientId: string, part: SheetPart) {
  const { data } = await admin.from("client_onboarding_sheets").select(`url, name, modified_at, ${part}`).eq("client_id", clientId).maybeSingle();
  const md = ((data as Record<string, unknown> | null)?.[part] as { markdown?: string } | null)?.markdown;
  if (!data || !md) return "";
  return `<onboarding_sheet source="${data.url}" edited="${String(data.modified_at ?? "").slice(0, 10)}" note="${NOTES[part]}">\n${md.slice(0, 20000)}\n</onboarding_sheet>`;
}
