import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { askJson } from "@/lib/ai";
import { count, money, multiple, percent, platformName } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { Sections } from "@/lib/reports/write";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiTool } from "./types";

// The monthly recap in the team's own PowerPoint template. The template (a PowerPoint file in Drive, its id in
// app_settings "recap_template") is copied once per client per month into the client's Drive folder, converted to Google
// Slides on the way, and filled through the Slides API with the monthly recap report: KPIs, spend, results, trends, top
// ads, what we did and what's next, plus chart pictures drawn here (SVG → PNG) and the top ads' own pictures.
// A template with {{placeholders}} is filled by name. One without them is read once by the AI, which says where each
// piece goes (kept per template in recap_template_maps), so the next month fills the same way without asking again.

const SLIDES_SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/presentations"];
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const BUCKET = "recap-charts";

export async function recapTemplateId(admin: SupabaseClient) {
  const { data } = await admin.from("app_settings").select("value").eq("key", "recap_template").maybeSingle();
  const v = data?.value as { file_id?: string } | null;
  return v?.file_id ?? null;
}

/** A Google token as the Kaizen Drive user (service account, domain-wide delegation): Drive and Slides */
export async function slidesToken() {
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!user || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Google Drive isn't connected (GOOGLE_DRIVE_USER and GOOGLE_SERVICE_ACCOUNT_JSON).");
  const { JWT } = await import("google-auth-library");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const t = (await new JWT({ email: key.client_email, key: key.private_key, scopes: SLIDES_SCOPES, subject: user }).getAccessToken()).token;
  if (!t) throw new Error("Google didn't give a token: are the Drive and Slides scopes allowed for Kaizen's service account in Google Admin?");
  return t;
}

async function g<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    const msg = (() => {
      try {
        return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        return text;
      }
    })();
    throw new Error(`Google ${res.status}: ${msg.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const folderId = (v: string) => v.match(/folders\/([\w-]{10,})/)?.[1] ?? v.match(/[?&]id=([\w-]{10,})/)?.[1] ?? v.trim();

/** "Monthly recaps" inside the client's Drive folder (made the first time) */
async function recapFolder(token: string, parent: string) {
  const q = encodeURIComponent(`'${parent}' in parents and name = 'Monthly recaps' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const list = await g<{ files?: { id: string }[] }>(token, `https://www.googleapis.com/drive/v3/files?q=${q}&corpora=allDrives&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)`);
  if (list.files?.[0]) return list.files[0].id;
  const made = await g<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", { method: "POST", body: JSON.stringify({ name: "Monthly recaps", mimeType: "application/vnd.google-apps.folder", parents: [parent] }) });
  return made.id;
}

// ─── The data: every value the deck can show ─────────────────────────────────────────────────────────────────────────

const change = (now: number | null, before: number | null) => (now == null || before == null || !before ? "–" : `${now >= before ? "+" : ""}${(((now - before) / Math.abs(before)) * 100).toFixed(0)}%`);
const bullets = (xs: string[] | undefined) => (xs ?? []).filter(Boolean).map((x) => `• ${x}`).join("\n");

/** Every text the deck can hold, by name ({{name}} in a template) */
export function recapValues(m: ReportMetrics, s: Sections | null, client: string, period: string): Record<string, string> {
  const a = m.main;
  const b = m.compare;
  const unit = m.conversion;
  const v: Record<string, string> = {
    client,
    month: period,
    period: `${a.start} – ${a.end}`,
    platform: platformName(m.platform),
    conversion: unit,
    spend: money(a.spend),
    spend_change: change(a.spend, b.spend),
    results: count(a.results),
    results_change: change(a.results, b.results),
    cost_per_result: money(a.costPerResult),
    cost_per_result_change: change(a.costPerResult, b.costPerResult),
    revenue: money(a.revenue),
    revenue_change: change(a.revenue, b.revenue),
    roas: multiple(a.roas),
    roas_change: change(a.roas, b.roas),
    ctr: percent(a.ctr),
    ctr_change: change(a.ctr, b.ctr),
    cpc: money(a.cpc),
    cpm: money(a.cpm),
    impressions: count(a.impressions),
    clicks: count(a.clicks),
    target: m.target == null ? "–" : m.roasKpi ? multiple(m.target) : money(m.target),
    budget: money(m.monthlyBudget),
    last_month_spend: money(b.spend),
    last_month_results: count(b.results),
    last_month_cost_per_result: money(b.costPerResult),
    last_month_roas: multiple(b.roas),
    headline: s?.headline ?? "",
    summary: s?.summary ?? "",
    what_we_did: bullets(s?.did),
    what_we_are_doing: bullets(s?.doing),
    next_steps: bullets(s?.next),
    highlights: bullets(s?.highlights),
    campaigns: m.campaigns
      .slice(0, 6)
      .map((c) => `${c.name}: ${money(c.spend)} · ${count(c.results)} ${unit.toLowerCase()}${c.costPerResult != null ? ` · ${money(c.costPerResult)} each` : ""}`)
      .join("\n"),
  };
  m.topAds.slice(0, 3).forEach((ad, i) => {
    const n = i + 1;
    v[`top_ad_${n}_name`] = ad.name;
    v[`top_ad_${n}_results`] = `${count(ad.results)} ${unit.toLowerCase()}`;
    v[`top_ad_${n}_cost`] = money(ad.costPerResult);
    v[`top_ad_${n}_spend`] = money(ad.spend);
    v[`top_ad_${n}_ctr`] = percent(ad.ctr);
    v[`top_ad_${n}_copy`] = ad.copy?.headline ?? ad.copy?.body?.slice(0, 140) ?? "";
  });
  return v;
}

export const IMAGE_KEYS = ["chart_daily", "chart_compare", "chart_campaigns", "top_ad_1_image", "top_ad_2_image", "top_ad_3_image"] as const;

// ─── Charts, drawn here ──────────────────────────────────────────────────────────────────────────────────────────────

const INK = "#1d1b20";
const MUTED = "#7a7480";
const BRAND = "#5b4bdb";
const SOFT = "#c9c3f5";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svgDaily(m: ReportMetrics) {
  const days = (m.daily ?? []).filter((d) => d.date >= m.main.start && d.date <= m.main.end);
  const W = 1600;
  const H = 800;
  const pad = { l: 40, r: 40, t: 70, b: 70 };
  const maxS = Math.max(1, ...days.map((d) => d.spend));
  const maxR = Math.max(1, ...days.map((d) => d.results));
  const bw = (W - pad.l - pad.r) / Math.max(1, days.length);
  const y = (v: number, max: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const bars = days.map((d, i) => `<rect x="${pad.l + i * bw + bw * 0.15}" y="${y(d.spend, maxS)}" width="${bw * 0.7}" height="${H - pad.b - y(d.spend, maxS)}" rx="4" fill="${SOFT}"/>`).join("");
  const line = days.map((d, i) => `${i ? "L" : "M"}${pad.l + i * bw + bw / 2},${y(d.results, maxR)}`).join(" ");
  const dots = days.map((d, i) => `<circle cx="${pad.l + i * bw + bw / 2}" cy="${y(d.results, maxR)}" r="6" fill="${BRAND}"/>`).join("");
  const ticks = days
    .map((d, i) => (i % Math.ceil(days.length / 8) === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${H - 28}" font-size="24" fill="${MUTED}" text-anchor="middle">${esc(d.date.slice(5))}</text>` : ""))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><g font-family="Helvetica, Arial, sans-serif"><text x="${pad.l}" y="40" font-size="28" fill="${INK}">Daily spend (bars) and ${esc(m.conversion.toLowerCase())} (line)</text>${bars}${days.length > 1 ? `<path d="${line}" fill="none" stroke="${BRAND}" stroke-width="5" stroke-linejoin="round"/>` : ""}${dots}${ticks}</g></svg>`;
}

function svgCompare(m: ReportMetrics) {
  const rows: [string, number | null, number | null, (n: number | null) => string][] = [
    ["Spend", m.main.spend, m.compare.spend, money],
    [m.conversion, m.main.results, m.compare.results, count],
    [m.roasKpi ? "ROAS" : "Cost per result", m.roasKpi ? m.main.roas : m.main.costPerResult, m.roasKpi ? m.compare.roas : m.compare.costPerResult, m.roasKpi ? multiple : money],
    ["CTR", m.main.ctr, m.compare.ctr, percent],
  ];
  const W = 1600;
  const H = 800;
  const gw = (W - 80) / rows.length;
  const g = rows
    .map(([label, now, before, f], i) => {
      const max = Math.max(1e-9, now ?? 0, before ?? 0);
      const x = 40 + i * gw;
      const h = (v: number | null) => ((v ?? 0) / max) * 480;
      return `<g><rect x="${x + gw * 0.18}" y="${640 - h(before)}" width="${gw * 0.28}" height="${h(before)}" rx="6" fill="${SOFT}"/><rect x="${x + gw * 0.52}" y="${640 - h(now)}" width="${gw * 0.28}" height="${h(now)}" rx="6" fill="${BRAND}"/><text x="${x + gw * 0.32}" y="${626 - h(before)}" font-size="24" fill="${MUTED}" text-anchor="middle">${esc(f(before))}</text><text x="${x + gw * 0.66}" y="${626 - h(now)}" font-size="26" fill="${INK}" text-anchor="middle">${esc(f(now))}</text><text x="${x + gw / 2}" y="700" font-size="28" fill="${INK}" text-anchor="middle">${esc(label)}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><g font-family="Helvetica, Arial, sans-serif"><text x="40" y="50" font-size="28" fill="${INK}">${esc(m.main.label)} vs ${esc(m.compare.label)}</text><rect x="${W - 420}" y="28" width="22" height="22" rx="4" fill="${SOFT}"/><text x="${W - 390}" y="47" font-size="22" fill="${MUTED}">Before</text><rect x="${W - 260}" y="28" width="22" height="22" rx="4" fill="${BRAND}"/><text x="${W - 230}" y="47" font-size="22" fill="${MUTED}">This month</text>${g}</g></svg>`;
}

function svgCampaigns(m: ReportMetrics) {
  const cs = [...m.campaigns].sort((a, b) => b.spend - a.spend).slice(0, 6);
  const W = 1600;
  const H = 800;
  const max = Math.max(1, ...cs.map((c) => c.spend));
  const rh = 600 / Math.max(1, cs.length);
  const rows = cs
    .map((c, i) => {
      const y = 100 + i * rh;
      const w = (c.spend / max) * 900;
      const name = c.name.length > 34 ? `${c.name.slice(0, 33)}…` : c.name;
      return `<text x="40" y="${y + rh * 0.55}" font-size="24" fill="${INK}">${esc(name)}</text><rect x="560" y="${y + rh * 0.2}" width="${Math.max(4, w)}" height="${rh * 0.55}" rx="6" fill="${BRAND}"/><text x="${575 + w}" y="${y + rh * 0.58}" font-size="22" fill="${MUTED}">${esc(money(c.spend))} · ${esc(count(c.results))}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><g font-family="Helvetica, Arial, sans-serif"><text x="40" y="50" font-size="28" fill="${INK}">Spend and ${esc(m.conversion.toLowerCase())} by campaign</text>${rows}</g></svg>`;
}

/** The charts the deck can show, as SVG, by name (the daily one only with two days or more) */
export function recapCharts(m: ReportMetrics): Record<string, string> {
  const out: Record<string, string> = { chart_compare: svgCompare(m), chart_campaigns: svgCampaigns(m) };
  if ((m.daily ?? []).filter((d) => d.date >= m.main.start && d.date <= m.main.end).length > 1) out.chart_daily = svgDaily(m);
  return out;
}

export async function chartPng(svg: string) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A picture Google Slides can fetch: kept in private storage, handed over with a link that works for an hour */
async function hand(admin: SupabaseClient, path: string, bytes: Buffer, mime: string) {
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
  if (up.error) throw new Error(up.error.message);
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (!data?.signedUrl) throw new Error("No signed link");
  return data.signedUrl;
}

/** The chart pictures and the top ads' pictures, by name */
async function imageUrls(admin: SupabaseClient, reportId: string, m: ReportMetrics) {
  const urls: Record<string, string> = {};
  await Promise.all(
    Object.entries(recapCharts(m)).map(async ([k, svg]) => {
      try {
        urls[k] = await hand(admin, `${reportId}/${k}.png`, await chartPng(svg), "image/png");
      } catch (e) {
        console.error("[recap deck] chart", k, e instanceof Error ? e.message : e);
      }
    }),
  );
  await Promise.all(
    m.topAds.slice(0, 3).map(async (ad, i) => {
      const k = `top_ad_${i + 1}_image`;
      try {
        // The kept copy of the ad's picture (Meta's own links expire), else the link saved with the ad
        const { data: kept } = await admin.from("ad_media").select("path, mime").eq("ad_id", ad.id).maybeSingle();
        let bytes: Buffer | null = null;
        if (kept?.path) {
          const { data } = await admin.storage.from("ad-media").download(kept.path as string);
          if (data) bytes = Buffer.from(await data.arrayBuffer());
        }
        if (!bytes && ad.image && /^https:\/\//.test(ad.image)) {
          const res = await fetch(ad.image, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
        }
        if (!bytes) return;
        // Slides takes PNG, JPEG or GIF under 50 MB and 25 megapixels: everything becomes a JPEG at most 1600px wide
        const jpg = await sharp(bytes).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
        urls[k] = await hand(admin, `${reportId}/${k}.jpg`, jpg, "image/jpeg");
      } catch (e) {
        console.error("[recap deck] ad picture", ad.id, e instanceof Error ? e.message : e);
      }
    }),
  );
  return urls;
}

// ─── Reading the template ────────────────────────────────────────────────────────────────────────────────────────────

type Dim = { magnitude?: number; unit?: string };
type El = {
  objectId: string;
  size?: { width?: Dim; height?: Dim };
  transform?: Record<string, number | string>;
  shape?: { shapeType?: string; text?: { textElements?: { textRun?: { content?: string } }[] }; placeholder?: { type?: string } };
  image?: { contentUrl?: string };
  table?: { rows?: number; columns?: number; tableRows?: { tableCells?: { text?: { textElements?: { textRun?: { content?: string } }[] } }[] }[] };
  elementGroup?: { children?: El[] };
};
type Presentation = { presentationId: string; slides?: { objectId: string; pageElements?: El[] }[]; pageSize?: { width?: Dim; height?: Dim } };

/** A place in the deck that can be filled: text in a shape or a table cell, or a picture */
export type Slot = { id: string; slide: number; pageId: string; objectId: string; kind: "text" | "image" | "cell"; text: string; row?: number; col?: number; size?: El["size"]; transform?: El["transform"]; role?: string | null };

const runText = (t?: { textElements?: { textRun?: { content?: string } }[] }) => (t?.textElements ?? []).map((e) => e.textRun?.content ?? "").join("").trim();

export function slotsOf(p: Presentation): Slot[] {
  const out: Slot[] = [];
  (p.slides ?? []).forEach((s, si) => {
    let n = 0;
    const walk = (els: El[] | undefined) => {
      for (const e of els ?? []) {
        if (e.elementGroup) {
          walk(e.elementGroup.children);
          continue;
        }
        const base = { slide: si, pageId: s.objectId, objectId: e.objectId, size: e.size, transform: e.transform };
        if (e.image) out.push({ ...base, id: `s${si}e${n++}`, kind: "image", text: "" });
        else if (e.shape) out.push({ ...base, id: `s${si}e${n++}`, kind: "text", text: runText(e.shape.text), role: e.shape.placeholder?.type ?? null });
        else if (e.table) {
          const id = `s${si}e${n++}`;
          (e.table.tableRows ?? []).forEach((r, ri) => (r.tableCells ?? []).forEach((c, ci) => out.push({ ...base, id: `${id}r${ri}c${ci}`, kind: "cell", text: runText(c.text), row: ri, col: ci })));
        }
      }
    };
    walk(s.pageElements);
  });
  return out;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export type Fill = { slot: string; fill: "text" | "image"; value: string };
export type TemplateMap = { fills: Fill[]; anchors: Record<string, string> };

const MAP_SCHEMA = {
  type: "object",
  properties: {
    fills: {
      type: "array",
      items: {
        type: "object",
        properties: { slot: { type: "string" }, fill: { type: "string", enum: ["text", "image"] }, value: { type: "string" } },
        required: ["slot", "fill", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["fills"],
  additionalProperties: false,
};

/** The AI's one-time read of a template without placeholders: which slot takes which piece of the recap */
async function mapTemplate(templateId: string, slots: Slot[], keys: string[]): Promise<TemplateMap> {
  const listing = slots
    .map((s) => `${s.id} [slide ${s.slide + 1}, ${s.kind}${s.role ? `, ${s.role.toLowerCase()}` : ""}${s.size?.width?.magnitude ? `, ${Math.round((s.size.width.magnitude ?? 0) / 12700)}x${Math.round((s.size.height?.magnitude ?? 0) / 12700)}pt` : ""}]: ${s.text ? JSON.stringify(s.text.slice(0, 160)) : "(empty)"}`)
    .join("\n");
  const out = await askJson<{ fills: Fill[] }>({
    agent: "reporter",
    label: "recap deck map ",
    override: { model: "sonnet", effort: "medium" },
    maxTokens: 8000,
    system: `You map a monthly client report into an agency's own presentation template. The template was made for a past month: its text shows last month's numbers, a client's name, example bullets. Say, for every place that holds month-specific content, what replaces it. Leave alone anything that stays the same every month (the agency's name, section titles, labels like "Spend", legal text, decorative shapes).

For a text slot: value is the new text, written with {{key}} for the data (any mix of words and keys, e.g. "{{spend}} spent ({{spend_change}} vs last month)"); keep the template's own wording and format where it is a label. For a picture slot that showed a chart or an ad: fill "image" and value is one image key. Use only the keys given. Every slot id must be one from the list.`,
    prompt: `<keys_text>\n${keys.join(", ")}\n</keys_text>\n<keys_image>\n${IMAGE_KEYS.join(", ")}\n</keys_image>\n\n<template_slots>\n${listing}\n</template_slots>`,
    schema: MAP_SCHEMA,
  });
  const known = new Map(slots.map((s) => [s.id, s]));
  const fills = (out.fills ?? []).filter((f) => known.has(f.slot) && (f.fill === "text" ? known.get(f.slot)!.kind !== "image" : (IMAGE_KEYS as readonly string[]).includes(f.value)));
  // What each filled slot held in the template, so a later copy whose slots moved is still filled in the right place
  const anchors = Object.fromEntries(fills.map((f) => [f.slot, known.get(f.slot)!.text.slice(0, 80)]));
  void templateId;
  return { fills, anchors };
}

/** A filled slot found again in a fresh copy: same place, or (if the template changed) the slot on that slide with the same text */
function locate(slots: Slot[], id: string, anchor: string | undefined) {
  const same = slots.find((s) => s.id === id);
  if (same && (!anchor || same.text.slice(0, 80) === anchor)) return same;
  const slide = Number(id.match(/^s(\d+)/)?.[1] ?? -1);
  return (anchor && slots.find((s) => s.slide === slide && s.text.slice(0, 80) === anchor)) || same || null;
}

const fillText = (template: string, values: Record<string, string>) => template.replace(PLACEHOLDER, (_m, k: string) => values[k] ?? "");

// ─── Filling ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DeckResult = { ok: true; id: string; url: string; pptx: string; notes: string[] } | { ok: false; error: string };

/** Fill the template for one monthly recap report: a copy in the client's Drive, filled, and its links */
export async function fillRecapDeck(admin: SupabaseClient, reportId: string, by: string | null, opts: { remap?: boolean } = {}): Promise<DeckResult> {
  const { data: r } = await admin.from("reports").select("id, kind, client_id, metrics, sections, period_start, period_end, clients(name, drive_folder_id)").eq("id", reportId).single();
  if (!r) return { ok: false, error: "That report isn't there." };
  if (r.kind !== "monthly") return { ok: false, error: "Only a monthly recap fills the template." };
  const m = r.metrics as ReportMetrics | null;
  if (!m) return { ok: false, error: "The report has no numbers yet." };
  const templateId = await recapTemplateId(admin);
  if (!templateId) return { ok: false, error: "No recap template is set (Settings: app_settings recap_template)." };
  const client = (Array.isArray(r.clients) ? r.clients[0] : r.clients) as { name: string; drive_folder_id: string | null } | null;
  const name = client?.name ?? "Client";
  const month = m.main.label || new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const notes: string[] = [];

  const { data: row } = await admin
    .from("recap_decks")
    .upsert({ report_id: reportId, client_id: r.client_id, template_id: templateId, status: "filling", error: null, created_by: by, updated_at: new Date().toISOString() }, { onConflict: "report_id" })
    .select("id, presentation_id")
    .single();

  try {
    const token = await slidesToken();
    // One copy per client per month: filling again replaces last time's copy
    if (row?.presentation_id) await g(token, `https://www.googleapis.com/drive/v3/files/${row.presentation_id}?supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({ trashed: true }) }).catch(() => null);
    let parents: string[] | undefined;
    if (client?.drive_folder_id) parents = [await recapFolder(token, folderId(client.drive_folder_id))];
    else notes.push("No Drive folder on the client page: the deck was saved in the Kaizen Drive instead.");
    const copy = await g<{ id: string }>(token, `https://www.googleapis.com/drive/v3/files/${templateId}/copy?supportsAllDrives=true&fields=id`, {
      method: "POST",
      body: JSON.stringify({ name: `${name} · Monthly recap · ${month}`, mimeType: "application/vnd.google-apps.presentation", ...(parents ? { parents } : {}) }),
    });
    const pres = await g<Presentation>(token, `https://slides.googleapis.com/v1/presentations/${copy.id}`);
    const slots = slotsOf(pres);
    const values = recapValues(m, r.sections as Sections | null, name, month);
    const images = await imageUrls(admin, reportId, m);
    const requests: unknown[] = [];

    const usesPlaceholders = slots.some((s) => /\{\{\s*[\w.]+\s*\}\}/.test(s.text));
    if (usesPlaceholders) {
      // {{name}} in the template: pictures first (a shape holding only {{chart_daily}} becomes the chart), then text
      for (const k of IMAGE_KEYS) {
        if (images[k]) requests.push({ replaceAllShapesWithImage: { imageUrl: images[k], imageReplaceMethod: "CENTER_INSIDE", containsText: { text: `{{${k}}}`, matchCase: false } } });
        else requests.push({ replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: false }, replaceText: "" } });
      }
      for (const [k, v] of Object.entries(values)) requests.push({ replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: false }, replaceText: v } });
      const unknown = [...new Set(slots.flatMap((s) => [...s.text.matchAll(PLACEHOLDER)].map((x) => x[1])))].filter((k) => !(k in values) && !(IMAGE_KEYS as readonly string[]).includes(k));
      if (unknown.length) notes.push(`The template asks for ${unknown.map((k) => `{{${k}}}`).join(", ")}, which the recap doesn't have: left as is.`);
    } else {
      const { data: kept } = await admin.from("recap_template_maps").select("mapping").eq("template_id", templateId).maybeSingle();
      let map = kept?.mapping as TemplateMap | undefined;
      if (!map || opts.remap) {
        map = await mapTemplate(templateId, slots, Object.keys(values));
        await admin.from("recap_template_maps").upsert({ template_id: templateId, mapping: map, created_at: new Date().toISOString() });
        notes.push("The template has no {{placeholders}}, so the AI worked out where each piece goes (kept for next month).");
      }
      let missed = 0;
      for (const f of map.fills) {
        const s = locate(slots, f.slot, map.anchors[f.slot]);
        if (!s) {
          missed++;
          continue;
        }
        if (f.fill === "image") {
          const url = images[f.value];
          if (!url) continue;
          if (s.kind === "image") requests.push({ replaceImage: { imageObjectId: s.objectId, url, imageReplaceMethod: "CENTER_INSIDE" } });
          else {
            requests.push({ createImage: { url, elementProperties: { pageObjectId: s.pageId, size: s.size, transform: s.transform } } });
            requests.push({ deleteObject: { objectId: s.objectId } });
          }
          continue;
        }
        const text = fillText(f.value, values);
        const cell = s.kind === "cell" ? { cellLocation: { rowIndex: s.row, columnIndex: s.col } } : {};
        if (s.text) requests.push({ deleteText: { objectId: s.objectId, ...cell, textRange: { type: "ALL" } } });
        if (text) requests.push({ insertText: { objectId: s.objectId, ...cell, insertionIndex: 0, text } });
      }
      if (missed) notes.push(`${missed} place${missed === 1 ? "" : "s"} in the template moved since it was mapped: fill again with "Map the template again" to redo it.`);
    }

    // Images first can fail one by one (an expired link): send the text alone if the whole batch is refused
    if (requests.length) {
      try {
        await g(token, `https://slides.googleapis.com/v1/presentations/${copy.id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
      } catch (e) {
        const textOnly = requests.filter((q) => !("createImage" in (q as object)) && !("replaceImage" in (q as object)) && !("replaceAllShapesWithImage" in (q as object)));
        await g(token, `https://slides.googleapis.com/v1/presentations/${copy.id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: textOnly }) });
        notes.push(`The pictures couldn't be placed (${e instanceof Error ? e.message.slice(0, 160) : "error"}); the text is filled.`);
      }
    }
    const url = `https://docs.google.com/presentation/d/${copy.id}/edit`;
    const pptx = `/api/reports/${reportId}/deck`;
    await admin.from("recap_decks").update({ presentation_id: copy.id, url, status: "done", notes, error: null, updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return { ok: true, id: copy.id, url, pptx, notes };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Couldn't fill the template";
    const hint = /unauthorized_client|403|insufficient|scope/i.test(error) ? " (Google Admin → Security → API controls → Domain-wide delegation: Kaizen's service account needs the Drive and Slides scopes)" : "";
    await admin.from("recap_decks").update({ status: "failed", error: `${error}${hint}`.slice(0, 600), updated_at: new Date().toISOString() }).eq("report_id", reportId);
    return { ok: false, error: `${error}${hint}` };
  }
}

export async function recapDeckFor(admin: SupabaseClient, reportId: string) {
  const { data } = await admin.from("recap_decks").select("presentation_id, url, status, notes, error, updated_at").eq("report_id", reportId).maybeSingle();
  return data;
}

/** The filled deck as a PowerPoint file (Drive's export) */
export async function deckPptx(presentationId: string) {
  const token = await slidesToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${presentationId}/export?mimeType=${encodeURIComponent(PPTX)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive export ${res.status}`);
  return { body: res.body!, type: PPTX };
}

// ─── For Kaizen AI ───────────────────────────────────────────────────────────────────────────────────────────────────

export const tools: AiTool[] = [
  {
    name: "fill_recap_deck",
    description: "Fill the team's PowerPoint template with a client's monthly recap report (KPIs, spend, results, trends, top ads, what we did, next steps, charts): a copy in the client's Drive folder. Returns the Slides link and the PPTX download link.",
    input_schema: { type: "object", properties: { report_id: { type: "string", description: "The monthly recap report" }, remap: { type: "boolean", description: "Work out again where each piece goes in the template" } }, required: ["report_id"] },
    run: async (user, input) => fillRecapDeck(createAdminClient(), String(input.report_id), user.id, { remap: input.remap === true }),
  },
  {
    name: "recap_deck_status",
    description: "The filled template for a monthly recap report, if there is one: its link, status and notes.",
    input_schema: { type: "object", properties: { report_id: { type: "string" } }, required: ["report_id"] },
    run: async (_user, input) => recapDeckFor(createAdminClient(), String(input.report_id)),
  },
];
