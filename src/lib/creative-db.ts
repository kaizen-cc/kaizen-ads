import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveToken } from "@/lib/context/google";
import { compact } from "@/lib/context/shared";

// Each client's Creative Database (a Google Sheet in their Drive folder, "<Client> - Creative Database") logs what the
// team delivered, ready for the client: date, creative type, how many new deliverables and how many in all with
// variations. It's read with the Account Overview sheet (12pm and 5pm ET) as a cross-check on the allotment count,
// which comes from tickets and Asana tasks (what's in motion). The sheet only has finished work, so it trails.

export type DbCount = { newImages: number; newVideos: number; allImages: number; allVideos: number; rows: number };
export type CreativeDb = { sheetId: string; url: string; name: string; readAt: string; month: DbCount; last45: DbCount; error?: string };

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

async function google<T>(token: string, url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(body.error?.message ?? String(res.status));
  return body;
}

/** One sheet's counts: this month (New York) and the last 45 days, new creatives and all with variations. */
async function readSheet(token: string, id: string) {
  const meta = await google<{ sheets: { properties: { title: string } }[] }>(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`);
  const tab = meta.sheets[0]?.properties.title;
  if (!tab) throw new Error("No tabs");
  const { values = [] } = await google<{ values?: string[][] }>(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMATTED_VALUE`);
  // The header row is the one naming the creative type (the first row also carries the how-to text)
  const h = values.findIndex((r) => r.some((c) => /creative type/i.test(c)));
  if (h < 0) throw new Error("Couldn't find the header row");
  const col = (re: RegExp) => values[h].findIndex((c) => re.test(c));
  const [cDate, cType, cNew, cAll] = [col(/date created/i), col(/creative type/i), col(/new deliverables/i), col(/total creative/i)];
  if (cDate < 0 || cNew < 0) throw new Error("Couldn't find the date or new deliverables columns");
  const [y, m] = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const since45 = Date.now() - 45 * 86_400_000;
  const month = zero();
  const last45 = zero();
  for (const r of values.slice(h + 1)) {
    const d = dateOf(r[cDate]);
    if (!d) continue;
    const video = /video|reel|ugc/i.test(r[cType] ?? "");
    const fresh = num(r[cNew]);
    const all = cAll >= 0 ? Math.max(num(r[cAll]), fresh) : fresh;
    if (!fresh && !all) continue;
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
  return { month, last45 };
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

  const { data: clients } = await admin.from("clients").select("id, name").eq("creative_package", true).is("archived_at", null);
  const now = new Date().toISOString();
  const out = { sheets: files.length, read: 0, failed: [] as string[], noSheet: [] as string[] };
  for (const c of clients ?? []) {
    const key = compact(c.name as string);
    // "<Client> - Creative Database"; the most recently edited when there are several
    const sheet = files
      .filter((f) => key.length >= 3 && compact(f.name.replace(/creative database.*/i, "")).startsWith(key))
      .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0];
    if (!sheet) {
      out.noSheet.push(c.name as string);
      continue;
    }
    try {
      const counts = await readSheet(token, sheet.id);
      const db: CreativeDb = { sheetId: sheet.id, url: sheet.webViewLink, name: sheet.name, readAt: now, ...counts };
      await admin.from("clients").update({ creative_db: db }).eq("id", c.id);
      out.read++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await admin.from("clients").update({ creative_db: { sheetId: sheet.id, url: sheet.webViewLink, name: sheet.name, readAt: now, month: zero(), last45: zero(), error } satisfies CreativeDb }).eq("id", c.id);
      out.failed.push(`${c.name}: ${error}`);
    }
  }
  return out;
}
