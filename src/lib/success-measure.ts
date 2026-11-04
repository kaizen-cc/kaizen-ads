import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversionFor } from "@/lib/kpi/conversions";
import type { Measure, MeasureRow, Reactions } from "@/lib/presentation-types";

// "Here's how we'll measure success": the targets we judge their ads by, shown in the plan they approve so they can
// confirm them, adjust them, or leave them to us. Their confirmed numbers become the KPI targets (marked as theirs),
// and every number goes into the Bible's targets with where it came from.

type Model = "ecommerce" | "restaurant" | "bookings" | "local_service" | "lead_gen";

/** What one result is, in their terms: a purchase, an order, a booking, a lead */
const RESULT: Record<Model, string> = { ecommerce: "purchase", restaurant: "order", bookings: "booking", local_service: "lead", lead_gen: "lead" };
/** The volume goal that fits how they make money */
const VOLUME: Record<Model, { label: string; unit: MeasureRow["unit"]; hint: string }> = {
  ecommerce: { label: "Monthly revenue goal", unit: "$", hint: "The online revenue a month you'd call a win" },
  restaurant: { label: "Monthly revenue goal from ads", unit: "$", hint: "Online orders, catering and events together" },
  bookings: { label: "Bookings a month", unit: "#", hint: "New bookings a month you'd call a win" },
  local_service: { label: "Leads a month", unit: "#", hint: "Calls and form requests a month you'd call a win" },
  lead_gen: { label: "Leads a month", unit: "#", hint: "Qualified leads a month you'd call a win" },
};

function kpiLabel(conversion: string, platform: string, model: Model) {
  const c = conversionFor(conversion);
  const where = platform === "google" ? "Google" : "Meta";
  if (c.roas) return { label: `${where}: return on ad spend`, unit: "x" as const, hint: "Revenue for every $1 spent, e.g. 3x" };
  const thing =
    conversion === "purchases" ? "purchase" : conversion === "lead_form" || conversion === "website_lead" ? "lead" : conversion === "schedules" ? "booking" : conversion === "applications" ? "application" : RESULT[model];
  return { label: `${where}: cost per ${thing}`, unit: "$" as const, hint: `What we'll aim to pay for each new ${thing}` };
}

/** The targets the plan shows, tailored to how they make money; benchmarks stand in where we have no number yet */
export async function measureFor(admin: SupabaseClient, clientId: string): Promise<Measure> {
  const [{ data: targets }, { businessModelOf }, { benchmarksFor, benchmarkTarget }] = await Promise.all([
    admin.from("kpi_targets").select("id, platform, conversion, target, source").eq("client_id", clientId).eq("active", true).order("platform"),
    import("@/lib/business-model"),
    import("@/lib/kpi/benchmark"),
  ]);
  const model = (await businessModelOf(admin, clientId).catch(() => null))?.model ?? "lead_gen";
  const bench = (await benchmarksFor(admin, [clientId]).catch(() => new Map())).get(clientId);
  const rows: MeasureRow[] = [];
  for (const t of targets ?? []) {
    const k = kpiLabel(t.conversion as string, t.platform as string, model);
    const b = t.target == null ? benchmarkTarget(bench, t.platform as string, k.unit === "x") : null;
    rows.push({
      key: t.id as string,
      label: k.label,
      unit: k.unit,
      value: t.target != null ? Number(t.target) : (b?.value ?? null),
      from: t.target != null ? (t.source === "client" ? "theirs" : "ours") : b ? "benchmark" : null,
      hint: b ? `${k.hint}. Industry benchmark for ${b.vertical} (${b.source} ${b.year})` : k.hint,
    });
  }
  // Both platforms judged on a cost: the blended target across them, starting from the higher of the two (all
  // platforms together can't be held to the cheaper one)
  const costs = rows.filter((r) => r.unit === "$" && r.value != null);
  if (costs.length > 1) rows.push({ key: "blended", label: `All platforms together: cost per ${RESULT[model]}`, unit: "$", value: Math.max(...costs.map((r) => r.value!)), from: "ours", hint: "Every platform's spend divided by every result" });
  const v = VOLUME[model];
  rows.push({ key: "volume", label: v.label, unit: v.unit, value: null, from: null, hint: v.hint });
  return { rows };
}

/**
 * After the plan is approved: their numbers become the KPI targets (marked as theirs and confirmed), or ours stay when
 * they left it to us. Returns a line for the team's notice.
 */
export async function applyMeasure(admin: SupabaseClient, clientId: string, r: Reactions) {
  const m = r.measure;
  if (!m) return "They didn't confirm the targets: ours stand, unconfirmed.";
  if (m.choice === "unsure") return "They weren't sure about the targets: ours stand, the media buyer decides.";
  const { rows } = await measureFor(admin, clientId);
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.key === "blended" || row.key === "volume") continue;
    const value = m.choice === "adjust" && m.values[row.key] != null ? m.values[row.key] : row.value;
    if (value == null) continue;
    await admin.from("kpi_targets").update({ target: value, source: "client", client_confirmed_at: now, updated_at: now }).eq("id", row.key).eq("client_id", clientId);
  }
  return m.choice === "adjust" ? "They adjusted the targets: the KPI board has their numbers now." : "They confirmed the targets.";
}

/** The targets for the Bible fold-in: what we showed, what they said, where each number came from */
export function measureBlock(measure: Measure | null, r: Reactions) {
  if (!measure?.rows.length) return "";
  const m = r.measure;
  const from = { theirs: "their own number", ours: "our estimate", benchmark: "industry benchmark" } as const;
  const lines = measure.rows.map((row) => {
    const said = m?.choice === "adjust" && m.values[row.key] != null ? m.values[row.key] : null;
    const shown = row.value == null ? "not set" : `${row.unit === "$" ? "$" : ""}${row.value}${row.unit === "x" ? "x" : ""}`;
    return `- ${row.label}: ${said != null ? `${row.unit === "$" ? "$" : ""}${said}${row.unit === "x" ? "x" : ""} (client adjusted; we showed ${shown})` : `${shown}${row.from ? ` (${from[row.from]})` : ""}`}`;
  });
  const verdict = !m ? "not confirmed (approved without an answer)" : m.choice === "right" ? "confirmed by the client" : m.choice === "adjust" ? "adjusted by the client" : "left to us: the media buyer decides";
  return `<success_targets>\nHow we'll measure success, ${verdict}:\n${lines.join("\n")}${m?.note ? `\nTheir note: ${m.note}` : ""}\nPut these in the Bible's targets with their source (client confirmed, our estimate, or benchmark).\n</success_targets>`;
}
