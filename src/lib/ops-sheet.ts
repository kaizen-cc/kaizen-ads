import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTab, token } from "@/lib/account-sheet";

// The Operations Database (a Google Sheet the onboarding automation fills: each client's Slack channels, Drive folder,
// ad accounts, contacts and more). Read with the Account Overview sheet, it fills what a client is missing in Kaizen
// Ads: it never overwrites what's already set, so a fix made here holds. Columns are found by what their headers say,
// in every tab, so the sheet can change shape without breaking this; what was found is kept for Sync health.

export const OPS_SHEET_ID = process.env.OPS_SHEET_ID || "1PuZ4Z0AAp_PUsJbGIlJXcC6kTMEF3aYqX6rIfabKbwQ";

type Field = "client" | "slack" | "slackInternal" | "drive" | "website" | "meta" | "google" | "contactName" | "contactEmail";
const COLUMNS: [Field, RegExp][] = [
  ["slackInternal", /internal.*slack|slack.*internal/],
  ["slack", /slack/],
  ["drive", /drive|folder/],
  ["website", /website|url|domain/],
  ["google", /google.*(id|account|customer)|customer.?id|gads/],
  ["meta", /(meta|facebook|fb).*(id|account)|ad.?account/],
  ["contactEmail", /email/],
  ["contactName", /contact|point.?of|poc|owner|decision/],
  ["client", /client|business|company|brand|account.?name|^name$/],
];
const nm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which column holds which field, from the header row. */
function mapHeaders(head: string[]) {
  const out = new Map<Field, number>();
  head.forEach((h, i) => {
    const k = h.toLowerCase().trim();
    if (!k) return;
    const f = COLUMNS.find(([field, re]) => re.test(k) && !out.has(field))?.[0];
    if (f) out.set(f, i);
  });
  return out;
}

/** The header row: within the first few rows, the one that names a client column and the most other fields. */
function headerRow(values: string[][]) {
  let best = -1;
  let score = 0;
  for (let i = 0; i < Math.min(6, values.length); i++) {
    const m = mapHeaders(values[i] ?? []);
    if (m.has("client") && m.size > score) {
      best = i;
      score = m.size;
    }
  }
  return best;
}

const slackId = (v: string) => v.match(/\b([CG][A-Z0-9]{8,12})\b/)?.[1] ?? v.match(/archives\/([A-Z0-9]+)/)?.[1] ?? null;
const driveId = (v: string) => v.match(/folders\/([\w-]{15,})/)?.[1] ?? (/^[\w-]{25,}$/.test(v.trim()) ? v.trim() : null);
const metaId = (v: string) => v.replace(/^act_/, "").match(/\b(\d{12,17})\b/)?.[1] ?? null;
const googleId = (v: string) => {
  const d = v.replace(/\D/g, "");
  return d.length === 10 ? d : null;
};

export async function syncOpsSheet(admin: SupabaseClient) {
  const tok = await token();
  const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${OPS_SHEET_ID}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
  const info = (await meta.json()) as { sheets?: { properties: { title: string } }[]; error?: { message: string } };
  if (!meta.ok) throw new Error(`Operations Database: ${info.error?.message ?? meta.status}`);
  const tabs = (info.sheets ?? []).map((s) => s.properties.title);

  const { data: clients } = await admin.from("clients").select("id, name, slack_channel_id, internal_slack_channel_id, drive_folder_id, website, meta_ad_account_id").is("archived_at", null);
  const { data: googleTargets } = await admin.from("kpi_targets").select("client_id").eq("platform", "google");
  const hasGoogle = new Set((googleTargets ?? []).map((t) => t.client_id));
  const byName = (name: string) => {
    const n = nm(name);
    if (n.length < 3) return null;
    const exact = (clients ?? []).filter((c) => nm(c.name) === n);
    if (exact.length === 1) return exact[0];
    const loose = (clients ?? []).filter((c) => nm(c.name).length >= 4 && (n.includes(nm(c.name)) || nm(c.name).includes(n)));
    return loose.length === 1 ? loose[0] : null;
  };

  const seen: { tab: string; headers: string[]; mapped: Record<string, string>; rows: number }[] = [];
  const filled: string[] = [];
  const contacts: string[] = [];
  const unmatched = new Set<string>();
  for (const tab of tabs) {
    const values = await readTab(tok, tab, OPS_SHEET_ID).catch(() => [] as string[][]);
    const h = headerRow(values);
    if (h < 0) {
      seen.push({ tab, headers: (values[0] ?? []).slice(0, 30), mapped: {}, rows: values.length });
      continue;
    }
    const head = values[h];
    const cols = mapHeaders(head);
    seen.push({ tab, headers: head.slice(0, 40), mapped: Object.fromEntries([...cols].map(([f, i]) => [f, head[i]])), rows: values.length - h - 1 });
    const cell = (row: string[], f: Field) => (cols.has(f) ? (row[cols.get(f)!] ?? "").trim() : "");
    for (const row of values.slice(h + 1)) {
      const name = cell(row, "client");
      if (!name) continue;
      const c = byName(name);
      if (!c) {
        unmatched.add(name);
        continue;
      }
      // Only what's missing: a value already set in Kaizen Ads is never replaced
      const patch: Record<string, string> = {};
      const s = slackId(cell(row, "slack"));
      if (s && !c.slack_channel_id) patch.slack_channel_id = s;
      const si = slackId(cell(row, "slackInternal"));
      if (si && !c.internal_slack_channel_id) patch.internal_slack_channel_id = si;
      const d = driveId(cell(row, "drive"));
      if (d && !c.drive_folder_id) patch.drive_folder_id = d;
      const w = cell(row, "website");
      if (/^https?:\/\/|\.\w{2,}/.test(w) && !c.website) patch.website = w.startsWith("http") ? w : `https://${w}`;
      const m = metaId(cell(row, "meta"));
      if (m && !c.meta_ad_account_id) patch.meta_ad_account_id = m;
      if (Object.keys(patch).length) {
        await admin.from("clients").update(patch).eq("id", c.id);
        Object.assign(c, patch);
        filled.push(`${c.name}: ${Object.keys(patch).join(", ")}`);
      }
      // A Google Ads account not tracked here yet: its KPI is set up (the buyer and target come from the Account Overview)
      const g = googleId(cell(row, "google"));
      if (g && !hasGoogle.has(c.id)) {
        await admin.from("kpi_targets").insert({ client_id: c.id, platform: "google", ad_account_id: g, conversion: "conversions" });
        hasGoogle.add(c.id);
        filled.push(`${c.name}: Google account ${g}`);
      }
      // The client's own contacts (never a Kaizen address); the first one is the primary approver
      const emails = (cell(row, "contactEmail").toLowerCase().match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).filter((e) => !e.endsWith("@kaizenmarketing.agency"));
      for (const email of emails) {
        // A contact we already know keeps their name; a new one is added with the name next to the email
        await admin.from("contacts").upsert({ email, full_name: emails.length === 1 ? cell(row, "contactName") || null : null }, { onConflict: "email", ignoreDuplicates: true });
        const { data: ct } = await admin.from("contacts").select("id").eq("email", email).maybeSingle();
        if (!ct) continue;
        const { count } = await admin.from("contact_clients").select("contact_id", { count: "exact", head: true }).eq("client_id", c.id);
        const { data: linked } = await admin.from("contact_clients").select("contact_id").eq("client_id", c.id).eq("contact_id", ct.id).maybeSingle();
        if (linked) continue;
        await admin.from("contact_clients").insert({ contact_id: ct.id, client_id: c.id, is_primary: !count });
        contacts.push(`${c.name}: ${email}`);
      }
    }
  }
  const result = { ok: true, tabs: seen, filled, contacts, unmatched: [...unmatched].slice(0, 60) };
  await admin.from("sync_state").upsert({ source: "ops-sheet", cursor_at: new Date().toISOString(), last_run_at: new Date().toISOString(), last_result: result });
  return result;
}
