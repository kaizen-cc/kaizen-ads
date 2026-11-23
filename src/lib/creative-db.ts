import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveToken } from "@/lib/context/google";
import { compact } from "@/lib/context/shared";

// Each client's Creative Database (a Google Sheet, "<Client> - Creative Database") is the source of truth for what the
// team DELIVERED (owner, Nov 23 2026): date created, creative type, new deliverables and "QTY of Total Creative
// (including variations)", which is what counts (every version counts). Its dated rows are kept on the client, so the
// allotment counts what was delivered inside the billing cycle; Asana and tickets give only what's in motion
// (client_allotment_usage). Read with the Account Overview sheet (12pm and 5pm ET), and on demand from the allotment
// card. A sheet can be linked by hand (clients.creative_db_sheet_id) when its name doesn't match the client's.

export type DbCount = { newImages: number; newVideos: number; allImages: number; allVideos: number; rows: number };
/** One delivered row, kept so the allotment counts it inside the client's billing cycle: d day, v video, n new, a in all with variations */
export type DbRow = { d: string; v: boolean; n: number; a: number };
export type CreativeDb = { sheetId: string; url: string; name: string; readAt: string; month: DbCount; last45: DbCount; rows?: DbRow[]; error?: string };

const zero = (): DbCount => ({ newImages: 0, newVideos: 0, allImages: 0, allVideos: 0, rows: 0 });
const num = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
/** "10/19/2026" (the sheets' format), or anything Date can read. */
function dateOf(v: string | undefined) {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return new Date(Date.UTC(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[1]) - 1, Number(m[2]), 12));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Google call, waiting out the Sheets per-minute read quota (a 429) up to twice instead of failing the client */
async function google<T>(token: string, url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = (await res.json()) as T & { error?: { message: string } };
    if (res.ok) return body;
    const quota = res.status === 429 || /quota/i.test(body.error?.message ?? "");
    if (!quota || attempt >= 2) throw new Error(body.error?.message ?? String(res.status));
    await wait(30_000 * (attempt + 1));
  }
}

/** One sheet's counts: this month (New York) and the last 45 days, new creatives and all with variations. */
async function readSheet(token: string, id: string) {
  const meta = await google<{ sheets: { properties: { title: string } }[] }>(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`);
  const tab = meta.sheets[0]?.properties.title;
  if (!tab) throw new Error("No tabs");
  const { values = [] } = await google<{ values?: string[][] }>(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMATTED_VALUE`);
  // The header row is the one naming the creative type (the first row also carries the how-to text)
  // (Rows under it that are the template's samples, "File" / "Ad Title" / "m/d/yyyy", have no real date and are skipped)
  const h = values.findIndex((r) => r.some((c) => /creative\s*type|type of creative/i.test(c)) && r.some((c) => /date/i.test(c)));
  if (h < 0) throw new Error("Couldn't find the header row (Date Created, Creative Type)");
  const col = (...res: RegExp[]) => {
    for (const re of res) {
      const i = values[h].findIndex((c) => re.test(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  const [cDate, cType, cNew, cAll] = [col(/date created/i, /^\s*date\b/i, /date/i), col(/creative\s*type/i, /type/i), col(/new deliverables/i, /\bnew\b/i), col(/total creative/i, /including variations/i, /\btotal\b/i)];
  if (cDate < 0 || (cNew < 0 && cAll < 0)) throw new Error("Couldn't find the date and quantity columns");
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const since45 = Date.now() - 45 * 86_400_000;
  // Rows from the last 100 days are kept dated, so the allotment counts each client's own billing cycle exactly
  const since100 = Date.now() - 100 * 86_400_000;
  const month = zero();
  const last45 = zero();
  const rows: DbRow[] = [];
  for (const r of values.slice(h + 1)) {
    const d = dateOf(r[cDate]);
    if (!d) continue;
    const video = /video|reel|ugc/i.test(r[cType] ?? "");
    const fresh = cNew >= 0 ? num(r[cNew]) : 0;
    const all = cAll >= 0 ? Math.max(num(r[cAll]), fresh) : fresh;
    if (!fresh && !all) continue;
    if (d.getTime() >= since100) rows.push({ d: d.toISOString().slice(0, 10), v: video, n: fresh, a: all });
    for (const [bucket, inIt] of [
      [month, d.getTime() >= monthStart],
      [last45, d.getTime() >= since45],
    ] as const) {
      if (!inIt) continue;
      bucket.rows++;
      if (video) {
        bucket.newVideos += fresh;
        bucket.allVideos += all;
      } else {
        bucket.newImages += fresh;
        bucket.allImages += all;
      }
    }
  }
  return { month, last45, rows: rows.slice(-400) };
}

/** Read one sheet into the client's record (the counts, and the dated rows the allotment counts) */
async function storeRead(admin: SupabaseClient, token: string, clientId: string, sheet: { id: string; name: string; webViewLink: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  try {
    const counts = await readSheet(token, sheet.id);
    const db: CreativeDb = { sheetId: sheet.id, url: sheet.webViewLink, name: sheet.name, readAt: now, ...counts };
    await admin.from("clients").update({ creative_db: db }).eq("id", clientId);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("clients").update({ creative_db: { sheetId: sheet.id, url: sheet.webViewLink, name: sheet.name, readAt: now, month: zero(), last45: zero(), error } satisfies CreativeDb }).eq("id", clientId);
    return { ok: false, error };
  }
}

/** A sheet by its id (a link pasted on the client page) */
async function sheetById(token: string, id: string) {
  return google<{ id: string; name: string; webViewLink: string }>(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,webViewLink`);
}

/** The sheet id in a Google Sheets link (or the id itself) */
export function sheetIdOf(link: string): string | null {
  const m = link.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) ?? link.match(/^([A-Za-z0-9_-]{25,})$/);
  return m ? m[1] : null;
}

/** Read one client's Creative Database now (the allotment card's Read now, and after a link is set) */
export async function readClientCreativeDb(admin: SupabaseClient, clientId: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const token = await driveToken();
  const { data: c } = await admin.from("clients").select("id, name, creative_db_sheet_id, creative_db").eq("id", clientId).maybeSingle();
  if (!c) return { ok: false, error: "No such client." };
  const id = (c.creative_db_sheet_id as string | null) ?? ((c.creative_db as CreativeDb | null)?.sheetId ?? null);
  if (!id) return { ok: false, error: "No Creative Database linked yet: paste its link." };
  const sheet = await sheetById(token, id).catch((e: unknown) => e as Error);
  if (sheet instanceof Error) return { ok: false, error: `Google won't open that sheet (${sheet.message.slice(0, 120)}). Share it with the Drive user, or check the link.` };
  const r = await storeRead(admin, token, clientId, sheet);
  return r.ok ? { ok: true, name: sheet.name } : r;
}

/** Finds every client's Creative Database in Drive and reads it. */
export async function syncCreativeDatabases(admin: SupabaseClient) {
  const token = await driveToken();
  const files: { id: string; name: string; modifiedTime: string; webViewLink: string }[] = [];
  let pageToken = "";
  do {
    const q = "name contains 'Creative Database' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
    const page = await google<{ files: typeof files; nextPageToken?: string }>(
      token,
      `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, corpora: "allDrives", includeItemsFromAllDrives: "true", supportsAllDrives: "true", pageSize: "200", fields: "nextPageToken, files(id, name, modifiedTime, webViewLink)", ...(pageToken ? { pageToken } : {}) })}`,
    );
    files.push(...page.files);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  const { data: clients } = await admin.from("clients").select("id, name, creative_db_sheet_id").eq("creative_package", true).is("archived_at", null);
  const out = { sheets: files.length, read: 0, failed: [] as string[], noSheet: [] as string[] };
  for (const c of clients ?? []) {
    const key = compact(c.name as string);
    // A sheet linked by hand wins; then the sheet named exactly for this client; a longer name (a location of theirs:
    // "Crust Pizza - Gleannloch Farms") only when there's no exact one, so a parent never reads a location's sheet
    const named = (f: { name: string }) => compact(f.name.replace(/creative database.*/i, ""));
    const newest = (a: { modifiedTime: string }, b: { modifiedTime: string }) => b.modifiedTime.localeCompare(a.modifiedTime);
    const linked = (c.creative_db_sheet_id as string | null) ?? null;
    const sheet =
      (linked ? (files.find((f) => f.id === linked) ?? (await sheetById(token, linked).catch(() => null))) : null) ??
      files.filter((f) => key.length >= 3 && named(f) === key).sort(newest)[0] ??
      files.filter((f) => key.length >= 3 && named(f).startsWith(key) && !(clients ?? []).some((o) => o.id !== c.id && compact(o.name as string).length > key.length && named(f).startsWith(compact(o.name as string)))).sort(newest)[0];
    if (!sheet) {
      out.noSheet.push(c.name as string);
      continue;
    }
    // Two reads a sheet: paced under the Sheets per-minute read quota
    await wait(1_200);
    const r = await storeRead(admin, token, c.id as string, sheet);
    if (r.ok) out.read++;
    else out.failed.push(`${c.name}: ${r.error}`);
  }
  return out;
}
