// TikTok's tracking and delivery checks, the plain parts: the pixels on an ad account and whether their events are
// firing (/pixel/list/ and /pixel/event/stats/), TikTok's own diagnosis of each ad group (/tool/diagnosis/get/), and the
// ad groups and ads TikTok has stuck learning or rejected (their secondary status). TikTok's answers for these aren't
// documented field by field the way reports are, so every parser here reads defensively: it takes what it recognizes,
// skips what it doesn't, and never throws. Stored compactly (tiktok_diagnostics), shown on the client's TikTok tab and
// read by the TikTok audit.

export type PixelEvent = { name: string; count: number | null };
export type PixelView = { id: string; name: string | null; status: string | null; lastActive: string | null; events: PixelEvent[] };
export type WarningKind = "learning" | "rejected" | "tracking" | "budget" | "creative" | "delivery" | "other";
export type DiagnosisWarning = { kind: WarningKind; level: "adgroup" | "ad" | "account"; id: string | null; name: string | null; text: string };
export type TikTokDiagnostics = { pixels: PixelView[]; warnings: DiagnosisWarning[]; checkedAt: string | null; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (v == null || v === "" || v === "-" ? null : String(v));
const numOrNull = (v: unknown) => {
  const x = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
  return v == null || v === "" || !Number.isFinite(x) ? null : x;
};
const first = (o: Obj, keys: string[]) => {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return null;
};
/** The first array of objects in a data block under any of these keys (TikTok names lists differently per endpoint) */
const listIn = (data: unknown, keys: string[]): Obj[] => {
  if (Array.isArray(data)) return data.filter(isObj);
  if (!isObj(data)) return [];
  for (const k of keys) if (Array.isArray(data[k])) return (data[k] as unknown[]).filter(isObj);
  return [];
};
/** "2026-11-08 10:00:00", seconds or milliseconds since 1970 → ISO (null when it isn't a time) */
function timeOf(v: unknown): string | null {
  if (v == null || v === "") return null;
  const asNum = Number(v);
  if (Number.isFinite(asNum) && asNum > 1e9) return new Date(asNum < 1e12 ? asNum * 1000 : asNum).toISOString();
  const s = String(v).trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ─── Pixels ────────────────────────────────────────────────────────────────

/** /pixel/list/'s data as pixels with their events (counts filled in later from the stats) */
export function parsePixels(data: unknown): PixelView[] {
  return listIn(data, ["pixels", "list"])
    .map((p): PixelView | null => {
      const id = str(first(p, ["pixel_id", "id"]));
      if (!id) return null;
      const events = listIn(p.events ?? p.event_list ?? [], ["events", "list"])
        .map((e) => str(first(e, ["name", "event_name", "custom_event_type", "event_type", "event_code", "code"])))
        .filter((x): x is string => Boolean(x));
      return {
        id,
        name: str(first(p, ["pixel_name", "name"])),
        status: str(first(p, ["activity_status", "pixel_status", "status"])),
        lastActive: timeOf(first(p, ["last_active_time", "last_activity_time", "last_fired_time", "update_time"])),
        events: [...new Set(events)].map((name): PixelEvent => ({ name, count: null })),
      };
    })
    .filter((x): x is PixelView => Boolean(x));
}

/**
 * /pixel/event/stats/'s data as each pixel's event counts. Read loosely: under each pixel, any list of entries that
 * carry an event's name and a count (or one object of name → count) is taken.
 */
export function parsePixelStats(data: unknown): Map<string, PixelEvent[]> {
  const out = new Map<string, PixelEvent[]>();
  const entries = listIn(data, ["stats", "list", "pixels", "results"]);
  const countOf = (e: Obj) => numOrNull(first(e, ["count", "total", "total_count", "event_count", "value", "num", "events_count"]));
  const nameOf = (e: Obj) => str(first(e, ["event", "event_name", "name", "event_type", "custom_event_type", "event_code", "code"]));
  const add = (pixel: string, name: string | null, count: number | null) => {
    if (!name) return;
    const list = out.get(pixel) ?? [];
    const had = list.find((x) => x.name === name);
    if (had) had.count = (had.count ?? 0) + (count ?? 0);
    else list.push({ name, count });
    out.set(pixel, list);
  };
  for (const s of entries) {
    const pixel = str(first(s, ["pixel_id", "id"])) ?? "";
    let found = false;
    for (const v of Object.values(s)) {
      if (Array.isArray(v)) {
        for (const e of v.filter(isObj)) {
          const name = nameOf(e);
          if (name) {
            found = true;
            add(pixel, name, countOf(e));
          }
        }
      } else if (isObj(v)) {
        for (const [k, c] of Object.entries(v)) {
          const x = numOrNull(c);
          if (x != null) {
            found = true;
            add(pixel, k, x);
          }
        }
      }
    }
    // One flat row per pixel and event
    if (!found && nameOf(s)) add(pixel, nameOf(s), countOf(s));
  }
  return out;
}

/** The pixels with the counts the stats gave (events seen only in the stats are added) */
export function withCounts(pixels: PixelView[], stats: Map<string, PixelEvent[]>): PixelView[] {
  return pixels.map((p) => {
    const counts = stats.get(p.id) ?? (pixels.length === 1 ? stats.get("") : undefined) ?? [];
    const names = new Set([...p.events.map((e) => e.name), ...counts.map((c) => c.name)]);
    return { ...p, events: [...names].map((name) => ({ name, count: counts.find((c) => c.name === name)?.count ?? p.events.find((e) => e.name === name)?.count ?? null })).sort((a, b) => (b.count ?? -1) - (a.count ?? -1)) };
  });
}

// ─── TikTok's diagnosis, and stuck or rejected objects ────────────────────

const TEXT_KEYS = ["title", "issue", "issue_title", "problem", "description", "suggestion", "suggestion_title", "content", "reason", "tip", "message", "detail", "text", "diagnosis"];

/** Whether a warning is about learning, a rejection, tracking, budget or bids, creative, or delivery */
export function warningKind(text: string, category = ""): WarningKind {
  const t = `${category} ${text}`.toLowerCase();
  if (/learn/.test(t)) return "learning";
  if (/reject|not[ _]pass|disapprov|violat|policy|review fail/.test(t)) return "rejected";
  if (/pixel|event|track|attribution|conversion api|events api/.test(t)) return "tracking";
  if (/budget|bid|cost cap|spend/.test(t)) return "budget";
  if (/creative|video|fatigue|hook|asset/.test(t)) return "creative";
  if (/deliver|audience|reach|impression|target/.test(t)) return "delivery";
  return "other";
}

/** Every human sentence in a diagnosis block, with the category it sits under */
function sentences(v: unknown, category: string, out: { text: string; category: string }[], depth = 0) {
  if (depth > 6 || out.length > 40) return;
  if (Array.isArray(v)) {
    for (const x of v) sentences(x, category, out, depth + 1);
    return;
  }
  if (!isObj(v)) {
    if (typeof v === "string" && v.trim().length > 12 && /\s/.test(v)) out.push({ text: v.trim(), category });
    return;
  }
  const own = TEXT_KEYS.map((k) => v[k]).find((x) => typeof x === "string" && x.trim().length > 3) as string | undefined;
  const cat = str(first(v, ["issue_category", "category", "type", "diagnosis_type"])) ?? category;
  if (own) out.push({ text: own.trim(), category: cat });
  for (const [k, x] of Object.entries(v)) {
    if (TEXT_KEYS.includes(k) && typeof x === "string") continue;
    if (typeof x === "object" && x) sentences(x, Array.isArray(x) || isObj(x) ? (/^(suggestions?|diagnos[ie]s|results?|list|data)$/.test(k) ? cat : k) : cat, out, depth + 1);
  }
}

/** /tool/diagnosis/get/'s data as warnings, one per issue per ad group (duplicates dropped, at most 30) */
export function parseDiagnosis(data: unknown): DiagnosisWarning[] {
  const out: DiagnosisWarning[] = [];
  const seen = new Set<string>();
  const results = listIn(data, ["results", "list", "diagnoses", "adgroups", "data"]);
  for (const r of results.length ? results : isObj(data) ? [data] : []) {
    const id = str(first(r, ["adgroup_id", "ad_id", "campaign_id"]));
    const level = r.ad_id != null && r.adgroup_id == null ? "ad" : id ? "adgroup" : "account";
    const name = str(first(r, ["adgroup_name", "ad_name", "campaign_name", "name"]));
    const found: { text: string; category: string }[] = [];
    const body = Object.fromEntries(Object.entries(r).filter(([k]) => !/(_id|_name|^name|_time)$/.test(k)));
    sentences(body, "", found);
    for (const f of found) {
      const key = `${id}|${f.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: warningKind(f.text, f.category), level, id, name, text: f.text.slice(0, 300) });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

/** An ad group or ad TikTok has stuck learning, limited or rejected, from its secondary status (null when it's fine) */
export function statusWarning(level: "adgroup" | "ad", o: { id: string; name: string | null; secondary_status?: string | null; status?: string | null }): DiagnosisWarning | null {
  const s = String(o.secondary_status ?? "").toUpperCase();
  if (!s) return null;
  const words = s.replace(/^(ADGROUP|AD|CAMPAIGN)_STATUS_/, "").toLowerCase().replace(/_/g, " ");
  if (/NOT_PASS|REJECT|DISAPPROV/.test(s)) return { kind: "rejected", level, id: o.id, name: o.name, text: `Rejected by TikTok (${words})` };
  if (/LEARN/.test(s) && /FAIL|LIMIT/.test(s)) return { kind: "learning", level, id: o.id, name: o.name, text: `Learning limited (${words})` };
  if (/BUDGET_EXCEED|BALANCE|NO_BUDGET|INSUFFICIENT/.test(s)) return { kind: "budget", level, id: o.id, name: o.name, text: `Not delivering: ${words}` };
  if (/LIMIT|FROZEN|PUNISH/.test(s)) return { kind: "delivery", level, id: o.id, name: o.name, text: `Delivery limited (${words})` };
  return null;
}

/** Whether a pixel event counts as a business event (a purchase, lead or sign-up), for saying "not firing" plainly */
export const isKeyEvent = (name: string) => /payment|purchase|order|lead|form|contact|submit|registration|sign ?up|subscribe|schedule|book|checkout/i.test(name.replace(/_/g, " "));

/** The tracking and delivery checks in words, for the audit and the AI ("" with nothing stored) */
export function diagnosticsText(d: TikTokDiagnostics | null | undefined): string {
  if (!d || (!d.pixels.length && !d.warnings.length && !d.errors.length)) return "";
  const lines = [`TRACKING AND DELIVERY IN TIKTOK${d.checkedAt ? ` (checked ${d.checkedAt.slice(0, 10)})` : ""}`];
  if (!d.pixels.length) lines.push("- Pixels: none found on this ad account (no TikTok pixel means conversions can't be tracked or optimized for).");
  for (const p of d.pixels) {
    const firing = p.events.filter((e) => (e.count ?? 0) > 0);
    const silent = p.events.filter((e) => e.count === 0 && isKeyEvent(e.name));
    lines.push(
      `- Pixel ${p.name ?? p.id}${p.status ? ` (${p.status.toLowerCase().replace(/_/g, " ")})` : ""}${p.lastActive ? `, last active ${p.lastActive.slice(0, 10)}` : ""}: ${firing.length ? `firing over the last 7 days: ${firing.slice(0, 10).map((e) => `${e.name} ${e.count}`).join(", ")}` : p.events.some((e) => e.count != null) ? "no events fired in the last 7 days" : `${p.events.length} events set up (counts not available)`}${silent.length ? `; key events with nothing in 7 days: ${silent.map((e) => e.name).join(", ")}` : ""}`,
    );
  }
  if (d.warnings.length) {
    lines.push("TikTok's diagnosis and stuck or rejected ad groups and ads:");
    for (const w of d.warnings.slice(0, 20)) lines.push(`- ${w.kind}: ${w.level === "account" ? "account" : `${w.level === "adgroup" ? "ad group" : "ad"} ${w.name ?? w.id}`}: ${w.text}`);
  } else lines.push("TikTok's diagnosis: no warnings on the active ad groups.");
  if (d.errors.length) lines.push(`(Some checks couldn't be read: ${d.errors.join("; ").slice(0, 300)})`);
  return lines.join("\n");
}
