import "server-only";
import { providerName } from "@/lib/email-providers/core";
import { emailConnections } from "@/lib/email-providers/which";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { buys, linesFor, mayOpen, type Who } from "./access-core";
import { isChannelPlatform, lineOfPlatform, LINE_SERVICE, OWNER_SEAT, type ChannelLine } from "./core";

// Which clients a person reports on for a line, who is connected (and what to connect for those who aren't), and who owns
// each client's reports. Server side, with the admin client: it applies the same rule the database does on reads, because
// the writes and the PDF routes use the admin client too.

export type ChannelClient = { id: string; name: string; slug: string; services: string[]; hasChannel: boolean; whiteLabel: boolean };

type ClientRow = { id: string; name: string; slug: string; status: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null; slack_channel_id: string | null; client_type: string | null };

const toClient = (c: ClientRow): ChannelClient => ({ id: c.id, name: c.name, slug: c.slug, services: servicesOf(c), hasChannel: Boolean(c.slack_channel_id), whiteLabel: String(c.client_type ?? "").toLowerCase().replace(/[\s_-]/g, "") === "whitelabel" });

const CLIENT_FIELDS = "id, name, slug, status, services, services_extra, services_removed, slack_channel_id, client_type";

/** The seats this person holds, by client */
async function seatsOf(admin: SupabaseClient, profileId: string) {
  const { data } = await admin.from("client_assignments").select("client_id, role").eq("profile_id", profileId);
  const by = new Map<string, string[]>();
  for (const a of data ?? []) by.set(a.client_id as string, [...(by.get(a.client_id as string) ?? []), a.role as string]);
  return by;
}

/** The live clients this person reports on for a line: everyone's for an exec, the line's head's with the service, else their seated ones */
export async function channelClients(admin: SupabaseClient, me: Who & { id: string }, line: ChannelLine): Promise<ChannelClient[]> {
  if (!linesFor(me).includes(line)) return [];
  const [{ data }, seats] = await Promise.all([admin.from("clients").select(CLIENT_FIELDS).is("archived_at", null).eq("internal", false).in("status", [...LIVE]).order("name"), me.isExec ? Promise.resolve(new Map<string, string[]>()) : seatsOf(admin, me.id)]);
  // Only the clients on this service (an exec may open any client's report, but the list is the ones that buy it), and
  // for everyone but the execs and the line's head, only the ones they're seated on
  return ((data ?? []) as ClientRow[]).map(toClient).filter((c) => buys(c.services, line) && mayOpen(me, line, { services: c.services, myRoles: seats.get(c.id) ?? [] }));
}

/** Whether this person may open a channel report (the line's report on that client); false for anything that isn't a channel report */
export async function canOpenReport(admin: SupabaseClient, me: Who & { id: string }, r: { platform: string; client_id: string }): Promise<boolean> {
  if (!isChannelPlatform(r.platform)) return false;
  const line = lineOfPlatform(r.platform);
  if (me.isExec) return true;
  if (!linesFor(me).includes(line)) return false;
  const [{ data }, seats] = await Promise.all([admin.from("clients").select(CLIENT_FIELDS).eq("id", r.client_id).maybeSingle(), seatsOf(admin, me.id)]);
  if (!data) return false;
  return mayOpen(me, line, { services: toClient(data as ClientRow).services, myRoles: seats.get(r.client_id) ?? [] });
}

// ─── Who is connected ──────────────────────────────────────────────────────

export type Coverage = { clientId: string; state: "connected" | "missing" | "pending" | "failing"; /** What to connect or fix, in the team's words (null when connected) */ what: string | null };

/** Each client's connection for a line: connected ones are drafted, the others are listed with what to do */
export async function coverageFor(admin: SupabaseClient, line: ChannelLine, clientIds: string[]): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  if (!clientIds.length) return out;
  if (line === "email") {
    const by = await emailConnections(admin, clientIds).catch(() => null);
    const error = by == null;
    for (const id of clientIds) {
      const r = by?.get(id);
      if (error) out.set(id, { clientId: id, state: "missing", what: "Email isn't set up in the database yet." });
      else if (!r) out.set(id, { clientId: id, state: "missing", what: "Connect the client's email provider (Klaviyo, Brevo or Customer.io): paste its read-only key on their page, in Team & setup." });
      else if (r.status === "invalid") out.set(id, { clientId: id, state: "failing", what: `${providerName(r.provider)} refused the key. Paste a new key in Team & setup.` });
      else if (!r.lastSyncedAt) out.set(id, { clientId: id, state: "pending", what: "Connected, and the first read is still running. It reports once the numbers are in." });
      else out.set(id, { clientId: id, state: "connected", what: null });
    }
    return out;
  }
  const { data, error } = await admin.from("social_accounts").select("client_id, page_id, ig_id, status, last_synced_at, last_error, missing_permissions").in("client_id", clientIds);
  const by = new Map((data ?? []).map((r) => [r.client_id as string, r]));
  for (const id of clientIds) {
    const r = by.get(id);
    if (error) out.set(id, { clientId: id, state: "missing", what: "Social isn't set up in the database yet." });
    else if (!r || (!r.page_id && !r.ig_id) || r.status === "unlinked") out.set(id, { clientId: id, state: "missing", what: "Link the client's Facebook Page and Instagram account on their Social tab." });
    else if (r.status === "failing" && !r.last_synced_at) out.set(id, { clientId: id, state: "failing", what: `Meta couldn't be read${(r.missing_permissions as string[] | null)?.length ? ` (missing ${(r.missing_permissions as string[]).join(", ")})` : ""}. Fix it on the client's Social tab.` });
    else if (!r.last_synced_at) out.set(id, { clientId: id, state: "pending", what: "Linked, and the first read is still running. It reports once the numbers are in." });
    else out.set(id, { clientId: id, state: "connected", what: null });
  }
  return out;
}

// ─── Who owns a client's channel reports ───────────────────────────────────

/**
 * The owner of each client's reports on a line: its strategist (or social media manager), the primary one first. Never
 * the designer or the builder: with no strategist seated it's null, and the line's head and the execs still see it.
 */
export async function ownersFor(admin: SupabaseClient, line: ChannelLine, clientIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(clientIds.map((id) => [id, null]));
  if (!clientIds.length) return out;
  const { data } = await admin.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").in("client_id", clientIds).eq("role", OWNER_SEAT[line]).order("created_at");
  const rank = (r: { role: string; is_primary: boolean | null }) => r.is_primary === false ? 1 : 0;
  const rows = ((data ?? []) as { client_id: string; profile_id: string; role: string; is_primary: boolean | null }[]).sort((a, b) => rank(a) - rank(b));
  for (const r of rows) if (out.get(r.client_id) == null) out.set(r.client_id, r.profile_id);
  return out;
}

export { LINE_SERVICE };
