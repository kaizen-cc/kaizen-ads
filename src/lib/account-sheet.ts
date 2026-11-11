import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JWT } from "google-auth-library";
import { setPrimarySeat } from "@/lib/buyer-seats";

// The Kaizen Account Overview sheet, the source of truth for each account while the team moves over: its Meta,
// Google and TikTok tabs give every ad account's media buyer, monthly budget and KPI target, plus the team's notes (priority, the
// #1 problem and its solution, the latest media buying, creative and copy updates). Read at 12pm and 5pm ET: the
// buyer, budget and target it gives replace what's in Kaizen Ads, the notes sit on the KPI for the card and the
// agents, and the client's Meta buyer follows the sheet. Matched by ad account ID; nothing is written to the sheet.

export const SHEET_ID = process.env.ACCOUNT_SHEET_ID || "12GYdOWPTVuXVrCC9ryHa-we_8yaEjt8ZllbdMW2ANs8";
export const sheetConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_USER);

export async function token() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  // Read-only Drive access (already granted for the client folders) reads Sheets too
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/drive.readonly"], subject: process.env.GOOGLE_DRIVE_USER });
  return (await jwt.getAccessToken()).token!;
}

/** One tab as rows of text, as the sheet shows them (formulas already worked out). */
export async function readTab(tok: string, tab: string, sheetId = SHEET_ID): Promise<string[][]> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMATTED_VALUE`, {
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

/** The first amount in a cell: "$3,000 / $3,000" is 3000 (not 30003000), "3.15k" is 3150. */
const money = (v: string | undefined) => {
  const m = String(v ?? "").match(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** A monthly budget: an amount under $20 is a typo or a daily figure, not a month's budget. */
const budgetOf = (v: string | undefined) => {
  const n = money(v);
  return n != null && n >= 20 ? n : null;
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

type SheetPlatform = "meta" | "google" | "tiktok";

/** The sheet's tab names, to find the TikTok one however it's written ("TikTok", "Tiktok Ads") */
async function tabTitles(tok: string): Promise<string[]> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
  return res.ok ? ((await res.json()) as { sheets?: { properties: { title: string } }[] }).sheets?.map((s) => s.properties.title) ?? [] : [];
}

/** The ad account on a row: Meta's and Google's "Ad Account ID", TikTok's advertiser ID under whichever header it has */
export function accountOf(r: Record<string, string>) {
  const key = Object.keys(r).find((k) => /^ad\s*account\s*id$/i.test(k.trim())) ?? Object.keys(r).find((k) => /advertiser\s*id|account\s*id|ad\s*account/i.test(k));
  return digits(key ? r[key] : "");
}

/** Reads the sheet and brings Kaizen Ads in line with it. */
export async function syncAccountSheet(admin: SupabaseClient) {
  const { tracker } = await import("@/lib/progress");
  const t = await tracker(admin, "sheet", "accounts");
  try {
    const tok = await token();
    t.on("Reading the Meta, Google and TikTok tabs");
    const tiktokTab = (await tabTitles(tok).catch(() => [] as string[])).find((x) => /tik\s*tok/i.test(x)) ?? null;
    const [meta, google, tiktok] = await Promise.all([
      readTab(tok, "Meta"),
      readTab(tok, "Google").catch(() => [] as string[][]),
      tiktokTab ? readTab(tok, tiktokTab).catch(() => [] as string[][]) : Promise.resolve([] as string[][]),
    ]);
    const rows: { r: Row; platform: SheetPlatform }[] = [
      ...rowsOf(meta).map((r) => ({ r, platform: "meta" as const })),
      ...rowsOf(google).map((r) => ({ r, platform: "google" as const })),
      ...rowsOf(tiktok).map((r) => ({ r, platform: "tiktok" as const })),
    ];
    t.total(rows.length);

    const [{ data: targets }, { data: people }] = await Promise.all([
      admin.from("kpi_targets").select("id, client_id, platform, ad_account_id, conversion, target, monthly_budget, owner_id, sheet, client_confirmed_at").eq("active", true),
      admin.from("profiles").select("id, full_name").eq("is_active", true),
    ]);
    const person = (name: string) => {
      const n = name.trim().toLowerCase();
      if (!n) return null;
      return (people ?? []).find((p) => p.full_name.toLowerCase() === n || p.full_name.toLowerCase().split(" ")[0] === n.split(" ")[0]) ?? null;
    };
    const now = new Date().toISOString();
    const handoffs: string[] = [];
    const out = { updated: 0, unchanged: 0, created: [] as string[], noKpi: [] as string[], noAccount: [] as string[], unknownBuyer: [] as string[], buyers: 0 };

    // A row's client by its name, for rows not tied to a KPI yet (a new client with no ad account, or an account
    // that isn't tracked here yet): an exact name first, else the one client whose name it contains or is part of
    const { data: allClients } = await admin.from("clients").select("id, name").is("archived_at", null);
    const nm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const clientNamed = (name: string) => {
      const n = nm(name);
      if (n.length < 3) return null;
      const exact = (allClients ?? []).filter((c) => nm(c.name) === n);
      if (exact.length === 1) return exact[0];
      const loose = (allClients ?? []).filter((c) => nm(c.name).length >= 4 && (n.includes(nm(c.name)) || nm(c.name).includes(n)));
      return loose.length === 1 ? loose[0] : null;
    };
    // The row's buyer onto the client's Meta, Google or TikTok slot (a new Meta buyer takes the account's work and gets a handoff)
    const assign = async (clientId: string, platform: SheetPlatform, buyer: { id: string }) => {
      const slot = platform === "google" ? "google_buyer" : platform === "tiktok" ? "tiktok_buyer" : "meta_buyer";
      const { data: cur } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", slot);
      // Already on the seat (primary or secondary): nothing to change
      if ((cur ?? []).some((c) => c.profile_id === buyer.id)) return;
      // The sheet's buyer becomes the primary; any secondaries stay
      const res = await setPrimarySeat(admin, clientId, slot, buyer.id);
      if (!res.ok) return;
      out.buyers++;
      if (slot === "meta_buyer") {
        const { handOff } = await import("@/lib/handoff");
        const id = await handOff(admin, clientId, res.from, buyer.id, null, "sheet");
        if (id) handoffs.push(id);
      }
    };

    for (const { r, platform } of rows) {
      const name = r["Client Name"] ?? r["Clients"] ?? "";
      const account = accountOf(r);
      const buyerName = r["Media Buyer"] ?? "";
      const buyer = person(buyerName);
      if (buyerName && !buyer) out.unknownBuyer.push(`${buyerName} (${name})`);
      if (!account) {
        // No ad account yet (a client just onboarded): the buyer is still theirs from today
        const c = clientNamed(name);
        if (c && buyer) await assign(c.id, platform, buyer);
        out.noAccount.push(`${name} (${platform})${c ? "" : " · no client by that name"}`);
        t.tick(name);
        continue;
      }
      let target = (targets ?? []).find((x) => x.platform === platform && digits(x.ad_account_id ?? "") === account);
      if (!target) {
        // An ad account the sheet tracks but Kaizen Ads doesn't yet: its KPI is set up from the sheet's row
        const c = clientNamed(name);
        if (!c) {
          out.noKpi.push(`${name} (${platform}) · no client by that name`);
          t.tick(name, false);
          continue;
        }
        const { data: made } = await admin
          .from("kpi_targets")
          .insert({ client_id: c.id, platform, ad_account_id: account, conversion: platform === "google" ? "conversions" : platform === "tiktok" ? "conversions" : "purchases", target: money(r["KPI"]), monthly_budget: budgetOf(r["Budget"]), owner_id: buyer?.id ?? null })
          .select("id, client_id, platform, ad_account_id, conversion, target, monthly_budget, owner_id, sheet, client_confirmed_at")
          .single();
        if (!made) {
          out.noKpi.push(`${name} (${platform})`);
          t.tick(name, false);
          continue;
        }
        target = made;
        out.created.push(`${name} (${platform})`);
      }
      const kpi = money(r["KPI"]);
      const budget = budgetOf(r["Budget"]);
      const fromSheet = Object.fromEntries(NOTE_FIELDS.map(([k, h]) => [k, r[h] ?? ""]).filter(([, v]) => v)) as Record<string, string>;
      // Notes edited in Kaizen Ads hold: the sheet takes a field back only when that cell has changed since the edit
      const prev = (target.sheet ?? {}) as Record<string, unknown>;
      const edits = { ...((prev.edits ?? {}) as Record<string, { at: string; by: string; sheetWas: string }>) };
      const sheet: Record<string, string> = { ...fromSheet };
      for (const [k, e] of Object.entries(edits)) {
        if ((fromSheet[k] ?? "") === e.sheetWas) {
          if (prev[k]) sheet[k] = String(prev[k]);
          else delete sheet[k];
        } else delete edits[k];
      }
      const patch: Record<string, unknown> = { sheet: { ...sheet, edits, name, platform, syncedAt: now }, sheet_synced_at: now };
      // A ROAS KPI isn't a dollar target: the sheet's dollar KPI doesn't replace it. Nor one the client confirmed in their
      // plan review: it's theirs until the team changes it in Kaizen Ads
      if (kpi != null && target.conversion !== "roas" && !target.client_confirmed_at && Number(target.target) !== kpi) patch.target = kpi;
      if (budget != null && Number(target.monthly_budget) !== budget) patch.monthly_budget = budget;
      if (buyer && target.owner_id !== buyer.id) patch.owner_id = buyer.id;
      const changed = "target" in patch || "monthly_budget" in patch || "owner_id" in patch;
      await admin.from("kpi_targets").update(patch).eq("id", target.id);
      if (changed) out.updated++;
      else out.unchanged++;

      // The client's Meta and Google buyers follow the sheet: that's whose lists and views the account is on (a new
      // Meta buyer takes the account's work and gets a handoff)
      if (buyer) await assign(target.client_id, platform, buyer);
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
    // Each client's Client ID (the number we assign at enrollment, asked for on the intake form), where we don't have it:
    // the row's client by its ad account, else its name. An ID already on another client, or a different one on this
    // client, is reported, never overwritten.
    const ids = await clientIds(admin, rows.map(({ r }) => r), targets ?? [], clientNamed);
    Object.assign(out, ids);
    // Buyers the sheet names who aren't on the team: execs hear it once a day, not on every run
    const missing = [...new Set(out.unknownBuyer.map((x) => x.replace(/\s*\(.*$/, "")))];
    if (missing.length) {
      const { data: execs } = await admin.from("profiles").select("id").eq("role", "executive").eq("is_active", true).not("joined_at", "is", null);
      await admin.from("notifications").upsert(
        (execs ?? []).map((e) => ({
          profile_id: e.id,
          kind: "client",
          title: `The Account Overview sheet names ${missing.join(", ")}, not on the team in Kaizen Ads`,
          body: `Their accounts have no buyer here until they're added on the Team page: ${out.unknownBuyer.slice(0, 8).join("; ")}${out.unknownBuyer.length > 8 ? "…" : ""}`,
          href: "/team",
          key: `sheet-unknown-buyers:${now.slice(0, 10)}`,
          priority: "normal",
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
    }
    t.on("Reading the Onboarding tab");
    const onboarding = await syncOnboarding(admin, tok, now).catch((e) => ({ onboarding: 0, onboardingUnmatched: [] as string[], onboardingError: e instanceof Error ? e.message : String(e) }));
    t.on("Reading the Operations Database");
    const { syncOpsSheet } = await import("@/lib/ops-sheet");
    const ops = await syncOpsSheet(admin).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    t.on("Reading each client's Creative Database");
    const { syncCreativeDatabases } = await import("@/lib/creative-db");
    const creativeDb = await syncCreativeDatabases(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    await admin.from("sync_state").upsert({ source: "sheet", cursor_at: now, last_run_at: now, last_result: { ok: true, ...out, ...onboarding, creativeDb, ops: "filled" in ops ? { filled: ops.filled.length, contacts: ops.contacts.length } : ops } });
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

/** A row's Client ID, whatever the column is called ("Client ID", "ID", "Client #", "Kaizen ID") */
const ID_HEADERS = new Set(["clientid", "id", "client", "clientno", "clientnumber", "kaizenid"]);
function idOf(r: Record<string, string>) {
  for (const [h, v] of Object.entries(r)) if (ID_HEADERS.has(norm(h.replace(/#/g, "no"))) && /^\s*\d{1,7}\s*$/.test(v)) return Number(v);
  return null;
}

async function clientIds(admin: SupabaseClient, rows: Record<string, string>[], targets: { client_id: string; ad_account_id: string | null }[], named: (name: string) => { id: string } | null) {
  const { data: have } = await admin.from("clients").select("id, name, kaizen_id");
  const byId = new Map((have ?? []).filter((c) => c.kaizen_id != null).map((c) => [Number(c.kaizen_id), c]));
  const mine = new Map((have ?? []).map((c) => [c.id as string, c]));
  const idsSet: string[] = [];
  const idConflicts: string[] = [];
  for (const r of rows) {
    const id = idOf(r);
    if (id == null) continue;
    const name = r["Client Name"] ?? r["Clients"] ?? r["Business Name"] ?? "";
    const account = digits(r["Ad Account ID"]);
    const clientId = (account && targets.find((x) => digits(x.ad_account_id ?? "") === account)?.client_id) || named(name)?.id;
    const c = clientId ? mine.get(clientId) : null;
    if (!c) continue;
    if (c.kaizen_id != null) {
      if (Number(c.kaizen_id) !== id) idConflicts.push(`${name}: the sheet says ${id}, Kaizen Ads has ${c.kaizen_id}`);
      continue;
    }
    const taken = byId.get(id);
    if (taken && taken.id !== c.id) {
      idConflicts.push(`${name}: ${id} is already ${taken.name}'s`);
      continue;
    }
    await admin.from("clients").update({ kaizen_id: id }).eq("id", c.id).is("kaizen_id", null);
    c.kaizen_id = id;
    byId.set(id, c);
    idsSet.push(`${c.name} (${id})`);
  }
  return { idsSet, idConflicts: [...new Set(idConflicts)] };
}

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
  // Client IDs on this tab too (new clients are often here before they have an ad account)
  const pick = (name: string) => {
    const key = norm(name);
    const loose = all.filter((c) => c.key.length > 3 && key.length > 3 && (c.key.includes(key) || key.includes(c.key)));
    return all.find((c) => c.key === key) ?? (loose.length === 1 ? loose[0] : null);
  };
  await clientIds(admin, rows, [], pick).catch(() => null);
  // A client that's come off the tab is done there: its checklist goes
  if (matched.length) await admin.from("clients").update({ onboarding_sheet: null }).not("onboarding_sheet", "is", null).not("id", "in", `(${matched.join(",")})`);
  return { onboarding: matched.length, onboardingUnmatched: unmatched };
}

export type SheetNotes = { priority?: string; problem?: string; solution?: string; buying?: string; creative?: string; copy?: string; comments?: string; last7?: string; max30?: string; syncedAt?: string };

/**
 * The people on one account, from every tab of the Account Overview sheet: each column naming someone (Media Buyer,
 * Account Manager, CS, Email Strategist, Web Developer…) on the client's row, matched by Client ID or business name.
 * The tab and the column say what they do there; a name can hold several ("Ana / Luis").
 */
export async function accountPeople(client: { name: string; kaizenId: number | null }): Promise<{ person: string; role: string; tab: string }[]> {
  if (!sheetConfigured()) return [];
  const tok = await token();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
  const tabs = res.ok ? ((await res.json()) as { sheets?: { properties: { title: string } }[] }).sheets?.map((s) => s.properties.title) ?? [] : ["Meta", "Google", "Onboarding"];
  const PERSON = /buyer|manager|strategist|success|\bcs\b|\bam\b|specialist|designer|developer|editor|copywriter|builder|owner|assigned|lead\b|point of contact/i;
  const NOT = /id\b|#|name of|client name|budget|kpi|update|problem|solution|priority|comment|link|url|status|date|progress|notes|email address|phone/i;
  const out: { person: string; role: string; tab: string }[] = [];
  for (const tab of tabs) {
    const values = await readTab(tok, tab).catch(() => [] as string[][]);
    // The header row: within the first rows, the one with a client column
    const hi = values.slice(0, 6).findIndex((r) => r.some((h) => /client|business|account name/i.test(h ?? "")));
    if (hi < 0) continue;
    const head = values[hi].map((h) => (h ?? "").trim());
    const nameCol = head.findIndex((h) => /^(client name|clients?|business( name)?|account name)$/i.test(h));
    for (const row of values.slice(hi + 1)) {
      const r = Object.fromEntries(head.map((h, i) => [h, (row[i] ?? "").trim()]));
      const id = idOf(r);
      const named = nameCol >= 0 && norm(row[nameCol] ?? "") && norm(row[nameCol] ?? "") === norm(client.name);
      if (!(client.kaizenId != null && id === client.kaizenId) && !named) continue;
      head.forEach((h, i) => {
        const v = (row[i] ?? "").trim();
        if (!h || !v || !PERSON.test(h) || NOT.test(h) || /^(n\/?a|none|-|tbd|yes|no)$/i.test(v)) return;
        for (const person of v.split(/[/,&+]| and /).map((x) => x.trim()).filter((x) => x.length > 1 && !/\d/.test(x))) out.push({ person, role: h, tab });
      });
    }
  }
  return out;
}
