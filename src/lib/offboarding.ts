import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickLoose, stableKey } from "@/lib/zapier";

// The client offboarding form (Zapier → /api/zapier/offboarding): the client is archived (nothing deleted; Restore
// brings it all back). Archiving is hard to notice when it hits the wrong client, so the match is strict: the Client ID,
// or the business name exactly, or a partial name only when exactly one client fits; anything else waits for an exec.
// A last day in the future is kept and archived on that day. Every submission is kept, a Zapier retry counts once,
// and the client's team and the execs are told.

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const NAME_KEYS = ["businessname", "clientname", "companyname", "nameofbusiness", "brandname", "client", "business", "company", "brand"];
const ID_KEYS = ["clientid", "clientnumber", "accountid", "kaizenid"];
const REASON_KEYS = ["reasonforleaving", "whyaretheyleaving", "reasonforcancellation", "cancellationreason", "reason", "whyisthisclientleaving", "notes", "comments"];
const DATE_KEYS = ["lastday", "lastdayofservice", "finalday", "effectivedate", "enddate", "cancellationdate", "offboardingdate", "lastdate", "contractenddate"];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** A date answer as YYYY-MM-DD (New York), or null when it isn't one. */
function dayOf(text: string | null) {
  if (!text?.trim()) return null;
  const t = Date.parse(text.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

type Match = { clientId: string; name: string } | { clientId: null; asked: string | null; candidates: string[] };

async function match(admin: SupabaseClient, raw: Record<string, string>): Promise<Match> {
  const idText = pickLoose(raw, ID_KEYS);
  const asked = pickLoose(raw, NAME_KEYS);
  if (idText && /^\s*\d+\s*$/.test(idText)) {
    const { data } = await admin.from("clients").select("id, name").eq("kaizen_id", Number(idText)).maybeSingle();
    if (data) return { clientId: data.id as string, name: data.name as string };
  }
  if (!asked) return { clientId: null, asked: null, candidates: [] };
  const { data } = await admin.from("clients").select("id, name");
  const all = data ?? [];
  const exact = all.filter((c) => norm(c.name) === norm(asked));
  if (exact.length === 1) return { clientId: exact[0].id as string, name: exact[0].name as string };
  const close = norm(asked).length >= 4 ? all.filter((c) => norm(c.name).includes(norm(asked)) || norm(asked).includes(norm(c.name))) : [];
  if (!exact.length && close.length === 1) return { clientId: close[0].id as string, name: close[0].name as string };
  return { clientId: null, asked, candidates: (exact.length ? exact : close).map((c) => c.name as string).slice(0, 5) };
}

/** Tell people: the client's team and the execs (archived), or the execs alone (it couldn't be matched). */
async function tell(admin: SupabaseClient, clientId: string | null, n: { title: string; body: string; key: string; priority: "critical" | "normal" }) {
  const [{ data: execs }, { data: team }] = await Promise.all([
    admin.from("profiles").select("id").eq("is_active", true).in("role", ["exec", "executive", "ceo", "coo", "cmo", "head_of_customer_success", "customer_success"]),
    clientId ? admin.from("client_assignments").select("profile_id").eq("client_id", clientId) : Promise.resolve({ data: [] as { profile_id: string }[] }),
  ]);
  const ids = [...new Set([...(execs ?? []).map((p) => p.id as string), ...(team ?? []).map((a) => a.profile_id as string)])];
  if (!ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({ profile_id: id, kind: "client", title: n.title.slice(0, 200), body: n.body.slice(0, 1000), href: "/clients?view=archived", client_id: clientId, key: n.key, priority: n.priority })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

async function archive(admin: SupabaseClient, clientId: string, name: string, reason: string, key: string) {
  const { data: c } = await admin.from("clients").select("archived_at").eq("id", clientId).single();
  if (!c?.archived_at) {
    const { error } = await admin.rpc("system_archive_client", { p_client: clientId, p_reason: reason, p_source: "zapier" });
    if (error) throw new Error(error.message);
  }
  await tell(admin, clientId, { title: `${name} offboarded`, body: `Archived from the offboarding form. ${reason} Nothing was deleted: Restore on their page brings everything back.`, key: `offboarded:${key}`, priority: "normal" });
}

export type OffboardResult =
  | { ok: true; archived: string; client: string; duplicate?: boolean }
  | { ok: true; scheduled: string; client: string; on: string; duplicate?: boolean }
  | { ok: false; error: string; asked: string | null; candidates: string[] };

/** One offboarding form submission. */
export async function receiveOffboarding(admin: SupabaseClient, raw: Record<string, string>): Promise<OffboardResult> {
  const key = stableKey("offboarding", raw);
  const { data: seen } = await admin.from("integration_events").select("status, payload").eq("idempotency_key", key).maybeSingle();
  if (seen && seen.status !== "failed") {
    const p = (seen.payload ?? {}) as { clientId?: string; client?: string; on?: string };
    if (p.clientId) return seen.status === "scheduled" ? { ok: true, scheduled: p.clientId, client: p.client ?? "", on: p.on ?? "", duplicate: true } : { ok: true, archived: p.clientId, client: p.client ?? "", duplicate: true };
  }

  const m = await match(admin, raw);
  const reasonText = pickLoose(raw, REASON_KEYS)?.trim();
  const reason = reasonText ? `Reason: ${reasonText}` : "No reason given.";
  const on = dayOf(pickLoose(raw, DATE_KEYS));
  const now = new Date().toISOString();

  if (m.clientId === null) {
    await admin.from("integration_events").upsert({ source: "zapier-offboarding", idempotency_key: key, payload: { raw, asked: m.asked, candidates: m.candidates }, status: "failed", error: "No single matching client" }, { onConflict: "idempotency_key" });
    await tell(admin, null, {
      title: `Offboarding form: couldn't tell which client "${m.asked ?? "?"}" is`,
      body: m.candidates.length ? `It could be ${m.candidates.join(", ")}. Archive the right one from their page (nothing was archived).` : `No client by that name or Client ID. Archive them from their page if they're leaving (nothing was archived).`,
      key: `offboard-unmatched:${key}`,
      priority: "critical",
    });
    return { ok: false, error: m.candidates.length > 1 ? "More than one client could match: nothing archived" : "No matching client in Kaizen Ads", asked: m.asked, candidates: m.candidates };
  }

  // A last day still ahead: archived on that day (the hourly clients step), so the work runs until then
  if (on && on > today()) {
    await admin.from("integration_events").upsert({ source: "zapier-offboarding", idempotency_key: key, payload: { raw, clientId: m.clientId, client: m.name, reason, on }, status: "scheduled" }, { onConflict: "idempotency_key" });
    await tell(admin, m.clientId, { title: `${m.name} is leaving: last day ${on}`, body: `From the offboarding form. ${reason} They're archived on ${on}; until then everything carries on.`, key: `offboarding:${key}`, priority: "normal" });
    return { ok: true, scheduled: m.clientId, client: m.name, on };
  }

  await archive(admin, m.clientId, m.name, reason, key);
  await admin.from("integration_events").upsert({ source: "zapier-offboarding", idempotency_key: key, payload: { raw, clientId: m.clientId, client: m.name, reason }, status: "processed", processed_at: now }, { onConflict: "idempotency_key" });
  return { ok: true, archived: m.clientId, client: m.name };
}

/** The hourly step: offboardings whose last day has come are archived. */
export async function runScheduledOffboardings(admin: SupabaseClient) {
  const { data } = await admin.from("integration_events").select("idempotency_key, payload").eq("source", "zapier-offboarding").eq("status", "scheduled").limit(50);
  let done = 0;
  for (const e of data ?? []) {
    const p = e.payload as { clientId: string; client: string; reason: string; on: string };
    if (!p?.on || p.on > today()) continue;
    try {
      await archive(admin, p.clientId, p.client, p.reason, e.idempotency_key as string);
      await admin.from("integration_events").update({ status: "processed", processed_at: new Date().toISOString() }).eq("idempotency_key", e.idempotency_key);
      done++;
    } catch (err) {
      console.error("[offboarding] scheduled archive failed", p.client, err instanceof Error ? err.message : err);
    }
  }
  return done;
}
