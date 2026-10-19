import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JWT } from "google-auth-library";

// The Kaizen Account Overview sheet, the source of truth for each account while the team moves over: its Meta and
// Google tabs give every ad account's media buyer, monthly budget and KPI target, plus the team's notes (priority, the
// #1 problem and its solution, the latest media buying, creative and copy updates). Read at 12pm and 5pm ET: the
// buyer, budget and target it gives replace what's in Kaizen Ads, the notes sit on the KPI for the card and the
// agents, and the client's Meta buyer follows the sheet. Matched by ad account ID; nothing is written to the sheet.

export const SHEET_ID = process.env.ACCOUNT_SHEET_ID || "12GYdOWPTVuXVrCC9ryHa-we_8yaEjt8ZllbdMW2ANs8";
export const sheetConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_USER);

async function token() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  // Read-only Drive access (already granted for the client folders) reads Sheets too
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"], subject: process.env.GOOGLE_DRIVE_USER });
  return (await jwt.getAccessToken()).token!;
}

/** One tab as rows of text, as the sheet shows them (formulas already worked out). */
async function readTab(tok: string, tab: string): Promise<string[][]> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${tok}` },
    cache: "no-store",
  });
  const body = (await res.json()) as { values?: string[][]; error?: { message: string } };
  if (!res.ok) {
    const why = body.error?.message ?? String(res.status);
    if (/has not been used|is disabled/i.test(why)) throw new Error("Turn on the Google Sheets API in the Google Cloud project our key belongs to");
    throw new Error(`Google Sheets (${tab}): ${why}`);
  }
  return body.values ?? [];
}

const money = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const digits = (v: string | undefined) => String(v ?? "").replace(/\D/g, "");

type Row = Record<string, string>;
function rowsOf(values: string[][]): Row[] {
  const [head = [], ...rest] = values;
  return rest
    .map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])))
    .filter((r) => (r["Client Name"] || r["Clients"]) && !/^tier \d/i.test(r["Client Name"] ?? r["Clients"] ?? ""));
}

const NOTE_FIELDS: [string, string][] = [
  ["priority", "Priority"],
  ["problem", "#1 Problem of the Account"],
  ["solution", "Solution of the Account"],
  ["buying", "Media Buying Update"],
  ["creative", "Creative Update"],
  ["copy", "Copy Update"],
  ["creativeYesNo", "Are We Developing Creative?"],
  ["comments", "Kyle's Comments"],
  ["last7", "Last 7 days KPI"],
  ["max30", "Max KPI (Last 30)"],
];

/** Reads the sheet and brings Kaizen Ads in line with it. */
export async function syncAccountSheet(admin: SupabaseClient) {
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "sheet", "accounts");
  try {
    const tok = await token();
    t.on("Reading the Meta and Google tabs");
    const [meta, google] = await Promise.all([readTab(tok, "Meta"), readTab(tok, "Google").catch(() => [] as string[][])]);
    const rows = [...rowsOf(meta).map((r) => ({ r, platform: "meta" as const })), ...rowsOf(google).map((r) => ({ r, platform: "google" as const }))];
    t.total(rows.length);

    const [{ data: targets }, { data: people }] = await Promise.all([
      admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, conversion, target, monthly_budget, owner_id").eq("active", true),
      admin.from("profiles").select("id, full_name").eq("is_active", true),
    ]);
    const person = (name: string) => {
      const n = name.trim().toLowerCase();
      if (!n) return null;
      return (people ?? []).find((p) => p.full_name.toLowerCase() === n || p.full_name.toLowerCase().split(" ")[0] === n.split(" ")[0]) ?? null;
    };
    const now = new Date().toISOString();
    const handoffs: string[] = [];
    const out = { updated: 0, unchanged: 0, noKpi: [] as string[], noAccount: [] as string[], unknownBuyer: [] as string[], buyers: 0 };

    for (const { r, platform } of rows) {
      const name = r["Client Name"] ?? r["Clients"] ?? "";
      const account = digits(r["Ad Account ID"]);
      if (!account) {
        out.noAccount.push(`${name} (${platform})`);
        t.tick(name);
        continue;
      }
      const target = (targets ?? []).find((x) => x.platform === platform && digits(x.ad_account_id ?? "") === account);
      if (!target) {
        out.noKpi.push(`${name} (${platform})`);
        t.tick(name, false);
        continue;
      }
      const buyerName = r["Media Buyer"] ?? "";
      const buyer = person(buyerName);
      if (buyerName && !buyer) out.unknownBuyer.push(`${buyerName} (${name})`);
      const kpi = money(r["KPI"]);
      const budget = money(r["Budget"]);
      const sheet = Object.fromEntries(NOTE_FIELDS.map(([k, h]) => [k, r[h] ?? ""]).filter(([, v]) => v));
      const patch: Record<string, unknown> = { sheet: { ...sheet, name, platform, syncedAt: now }, sheet_synced_at: now };
      // A ROAS KPI isn't a dollar target: the sheet's dollar KPI doesn't replace it
      if (kpi != null && target.conversion !== "roas" && Number(target.target) !== kpi) patch.target = kpi;
      if (budget != null && Number(target.monthly_budget) !== budget) patch.monthly_budget = budget;
      if (buyer && target.owner_id !== buyer.id) patch.owner_id = buyer.id;
      const changed = "target" in patch || "monthly_budget" in patch || "owner_id" in patch;
      await admin.from("kpi_targets").update(patch).eq("id", target.id);
      if (changed) out.updated++;
      else out.unchanged++;

      // The client's Meta buyer follows the sheet: that's whose lists and views the account is on
      if (platform === "meta" && buyer) {
        const { data: cur } = await admin.from("client_assignments").select("profile_id").eq("client_id", target.client_id).eq("role", "meta_buyer");
        if (!(cur ?? []).some((c) => c.profile_id === buyer.id)) {
          await admin.from("client_assignments").delete().eq("client_id", target.client_id).eq("role", "meta_buyer");
          await admin.from("client_assignments").insert({ client_id: target.client_id, profile_id: buyer.id, role: "meta_buyer" });
          out.buyers++;
          // The account's work moves to the new buyer, and a handoff is written for them once the sheet is read
          const { handOff } = await import("@/lib/handoff");
          const id = await handOff(admin, target.client_id, (cur?.[0]?.profile_id as string | undefined) ?? null, buyer.id, null, "sheet");
          if (id) handoffs.push(id);
        }
      }
      t.tick(name);
    }
    if (out.updated || out.buyers) {
      // Fresh numbers against the new targets and budgets
      const { refreshClientKpis } = await import("@/lib/kpi/sync");
      const touched = [...new Set((targets ?? []).map((x) => x.client_id))];
      for (const id of touched.slice(0, 200)) await refreshClientKpis(admin, id, false).catch(() => null);
    }
    if (handoffs.length) {
      t.on(`Writing ${handoffs.length} handoff${handoffs.length === 1 ? "" : "s"} for new buyers`);
      const { writeHandoff } = await import("@/lib/handoff");
      for (const id of handoffs) await writeHandoff(admin, id);
    }
    t.on("Reading the Onboarding tab");
    const onboarding = await syncOnboarding(admin, tok, now).catch((e) => ({ onboarding: 0, onboardingUnmatched: [] as string[], onboardingError: e instanceof Error ? e.message : String(e) }));
    await admin.from("sync_state").upsert({ source: "sheet", cursor_at: now, last_run_at: now, last_result: { ok: true, ...out, ...onboarding } });
    await t.finish({
      summary: `${out.updated} accounts updated, ${out.unchanged} already matched${out.buyers ? `, ${out.buyers} buyers reassigned` : ""}${out.noKpi.length ? `, ${out.noKpi.length} with no KPI here` : ""}, ${onboarding.onboarding} onboarding checklists`,
    });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("sync_state").upsert({ source: "sheet", last_run_at: new Date().toISOString(), last_result: { ok: false, error } });
    await t.finish({ error });
    throw e;
  }
}

// The Onboarding tab: each new client's setup checklist, kept by the account managers
export const ONBOARDING_STEPS: [string, string, string][] = [
  ["welcome", "Welcome Email", "Welcome email"],
  ["call", "Onboarding Call", "Onboarding call"],
  ["access", "Access Granted", "Access"],
  ["internal", "Internal Meeting", "Internal meeting"],
  ["intake", "Intake Form Filled Out", "Intake form"],
  ["content", "Content Shared", "Content"],
  ["tracking", "Tracking Set Up", "Tracking"],
  ["live", "Campaigns Live", "Campaigns live"],
];
export type OnboardingSheet = { steps: Record<string, boolean>; progress: string | null; notes: string | null; services: string | null; onboarded: string | null; name: string; syncedAt: string };

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

/** The Onboarding tab onto each client it names (by business name), so the onboarding cards show where setup is. */
async function syncOnboarding(admin: SupabaseClient, tok: string, now: string) {
  const [head = [], ...rest] = await readTab(tok, "Onboarding");
  const rows = rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()]))).filter((r) => r["Business Name"]);
  const { data: clients } = await admin.from("clients").select("id, name").is("archived_at", null);
  const all = (clients ?? []).map((c) => ({ id: c.id as string, key: norm(c.name as string) }));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const r of rows) {
    const key = norm(r["Business Name"]);
    if (!key) continue;
    // Exact first, then one name inside the other ("Club 76" and "Club 76 Barbershop"), only when that's unambiguous
    const exact = all.find((c) => c.key === key);
    const loose = all.filter((c) => c.key.length > 3 && key.length > 3 && (c.key.includes(key) || key.includes(c.key)));
    const client = exact ?? (loose.length === 1 ? loose[0] : null);
    if (!client) {
      unmatched.push(r["Business Name"]);
      continue;
    }
    const sheet: OnboardingSheet = {
      steps: Object.fromEntries(ONBOARDING_STEPS.map(([k, h]) => [k, /^(true|yes|y|x|✓|✔|✅|done)$/i.test(r[h] ?? "")])),
      progress: r["Progress"] || null,
      notes: r["Notes"] || null,
      services: r["Services"] || null,
      onboarded: r["Date Onboarded"] || null,
      name: r["Business Name"],
      syncedAt: now,
    };
    await admin.from("clients").update({ onboarding_sheet: sheet }).eq("id", client.id);
    matched.push(client.id);
  }
  // A client that's come off the tab is done there: its checklist goes
  if (matched.length) await admin.from("clients").update({ onboarding_sheet: null }).not("onboarding_sheet", "is", null).not("id", "in", `(${matched.join(",")})`);
  return { onboarding: matched.length, onboardingUnmatched: unmatched };
}

export type SheetNotes = { priority?: string; problem?: string; solution?: string; buying?: string; creative?: string; copy?: string; comments?: string; last7?: string; max30?: string; syncedAt?: string };
