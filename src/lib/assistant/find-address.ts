import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientDomain, gmailQueries, matchesName, parseAddresses, SEARCH_ORDER, suggestAddress, type Address } from "./recipient-core";

// Someone's email address, looked for everywhere before the person is asked (src/lib/assistant/recipient-core.ts has
// the order and the matching): the client's contacts in Kaizen OS, the person's whole Gmail (from, to and cc, by name
// and by the client's domain), the client's Slack channel members, then a likely address from the client's pattern,
// offered to confirm. Read only; the person's own mailbox and the client data their session can see.

export type FoundAddress = { email: string; name: string; where: string };
export type AddressSearch = { found: FoundAddress[]; looked: string[]; suggestion: { email: string; why: string } | null; known: Address[] };

async function gmailHits(mailbox: string, name: string, domains: string[]): Promise<{ hits: FoundAddress[]; seen: Address[]; ok: boolean }> {
  const { gmailToken, google, googleConfigured } = await import("@/lib/context/google");
  if (!googleConfigured() || !mailbox) return { hits: [], seen: [], ok: false };
  try {
    const token = await gmailToken(mailbox);
    const hits = new Map<string, FoundAddress>();
    const seen = new Map<string, Address>();
    for (const q of gmailQueries(name, domains)) {
      const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q, maxResults: "15" });
      type Meta = { payload: { headers: { name: string; value: string }[] } };
      const metas = await Promise.all((list.messages ?? []).map((m) => google<Meta>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { format: "metadata" }).catch(() => null)));
      for (const m of metas) {
        if (!m) continue;
        for (const h of m.payload.headers) {
          if (!["from", "to", "cc"].includes(h.name.toLowerCase())) continue;
          for (const a of parseAddresses(h.value)) {
            seen.set(a.email, a);
            if (matchesName(a, name) && !hits.has(a.email)) hits.set(a.email, { email: a.email, name: a.name || name, where: `your Gmail (${h.name.toLowerCase()})` });
          }
        }
      }
      if (hits.size) break;
    }
    return { hits: [...hits.values()], seen: [...seen.values()], ok: true };
  } catch {
    return { hits: [], seen: [], ok: false };
  }
}

/** The client's Slack channel members who match the name (their Slack profile's email, when Slack shows it) */
async function slackHits(db: SupabaseClient, clientId: string, name: string): Promise<FoundAddress[]> {
  const { slack, slackConfigured } = await import("@/lib/context/slack");
  if (!slackConfigured()) return [];
  // The client's channel, read with the person's own session (a client they can see)
  const { data: c } = await db.from("clients").select("slack_channel_id").eq("id", clientId).maybeSingle();
  if (!c?.slack_channel_id) return [];
  try {
    const { members } = await slack<{ members: string[] }>("conversations.members", { channel: c.slack_channel_id as string, limit: "200" });
    const out: FoundAddress[] = [];
    for (const id of members.slice(0, 60)) {
      const { user } = await slack<{ user: { real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string; real_name?: string } } }>("users.info", { user: id }).catch(() => ({ user: {} as never }));
      const email = user?.profile?.email?.toLowerCase();
      if (!email || user.is_bot || user.deleted) continue;
      const a = { name: user.real_name ?? user.profile?.real_name ?? "", email };
      if (matchesName(a, name)) out.push({ ...a, where: "the client's Slack channel" });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Looks for a person's address: name as said; client when it's about one. `db` is the person's own session (the client
 * contacts they can see), `mailbox` their own Gmail.
 */
export async function findAddress(o: { db: SupabaseClient; admin: SupabaseClient; mailbox: string; name: string; client: { id: string; name: string } | null }): Promise<AddressSearch> {
  const looked: string[] = [];
  const found: FoundAddress[] = [];
  let known: Address[] = [];
  const domains: string[] = [];
  if (o.client) {
    looked.push(SEARCH_ORDER[0]);
    const [{ data: rows }, { data: c }] = await Promise.all([
      o.db.from("contact_clients").select("contacts(email, full_name)").eq("client_id", o.client.id).is("removed_at", null),
      o.db.from("clients").select("website").eq("id", o.client.id).maybeSingle(),
    ]);
    known = (rows ?? []).map((r) => r.contacts as unknown as { email: string; full_name: string | null } | null).filter((x): x is { email: string; full_name: string | null } => Boolean(x?.email)).map((x) => ({ name: x.full_name ?? "", email: x.email.toLowerCase() }));
    for (const k of known) if (matchesName(k, o.name)) found.push({ ...k, where: "the client's contacts in Kaizen OS" });
    for (const d of [...known.map((k) => clientDomain(k.email)), clientDomain((c?.website as string | null) ?? null)]) if (d && !domains.includes(d)) domains.push(d);
  }
  if (!found.length) {
    looked.push(SEARCH_ORDER[1]);
    const g = await gmailHits(o.mailbox, o.name, domains);
    found.push(...g.hits);
    // Addresses seen at the client's domain teach the pattern
    for (const a of g.seen) if (domains.some((d) => a.email.endsWith(`@${d}`)) && !known.some((k) => k.email === a.email)) known.push(a);
    if (!g.ok) looked[looked.length - 1] += " (couldn't be read)";
  }
  if (!found.length && o.client) {
    looked.push(SEARCH_ORDER[2]);
    found.push(...(await slackHits(o.db, o.client.id, o.name)));
  }
  const suggestion = found.length ? null : (looked.push(SEARCH_ORDER[3]), suggestAddress(o.name, known));
  return { found, looked, suggestion, known };
}
