import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf } from "@/lib/services";
import { clientLines, routeSeat, SEAT_LABEL, teamLines, type Line, type SeatHolder } from "./seat-routing";
import { resolveTeammate, type Teammate } from "./teammates";

// The data behind routing a hand-off: a client's lines and seats, the active team, and the person a role or a name
// means on a client (seat-routing.ts and teammates.ts decide; this reads). Read with the server's rights after the
// caller checked the person may see the client.

export type ClientTeam = { id: string; name: string; lines: Line[]; seats: SeatHolder[] };

/** A client's lines (what it buys, plus seats held) and who sits in each seat, primary first */
export async function clientTeam(admin: SupabaseClient, clientId: string): Promise<ClientTeam | null> {
  const [{ data: c }, { data: rows }] = await Promise.all([
    admin.from("clients").select("id, name, services, services_extra, services_removed").eq("id", clientId).maybeSingle(),
    admin.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name, is_active)").eq("client_id", clientId),
  ]);
  if (!c) return null;
  type Row = { role: string; profile_id: string; is_primary: boolean | null; created_at: string | null; profiles: { full_name: string; is_active: boolean } | null };
  const seats = ((rows ?? []) as unknown as Row[])
    .filter((r) => r.profiles && r.profiles.is_active !== false)
    .sort((a, b) => Number(b.is_primary !== false) - Number(a.is_primary !== false) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .map((r) => ({ seat: r.role, profileId: r.profile_id, name: r.profiles?.full_name ?? "", primary: r.is_primary }));
  const services = servicesOf(c as { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null });
  return { id: c.id as string, name: c.name as string, lines: clientLines(services, seats), seats };
}

/** Everyone active on the team (joined), for finding a teammate by name or role */
export async function activeTeam(admin: SupabaseClient): Promise<Teammate[]> {
  const { data } = await admin.from("profiles").select("id, full_name, role, is_active").eq("is_active", true).not("joined_at", "is", null).limit(500);
  return ((data ?? []) as { id: string; full_name: string | null; role: string; is_active: boolean }[]).filter((p) => p.full_name).map((p) => ({ id: p.id, fullName: p.full_name as string, role: p.role, isActive: p.is_active }));
}

export type Recipient = { id: string; name: string; why: string | null };
export type RecipientResult = { ok: true; to: Recipient } | { ok: false; note: string; options?: string[] };

/** Words that name a role rather than a person */
export const ROLE_WORDS = /\b(buyer|strategist|manager|lead|designer|builder|editor|copy ?writer|coordinator|head of|account|success|team)\b/i;

const LINE_WORD: Record<Line, string> = { meta: "Meta ads", google: "Google ads", tiktok: "TikTok ads", email: "email", social: "organic social", creative: "creative", account: "account management" };

/**
 * Who a hand-off goes to: a teammate named ("Rahul", "Raul"), else on a client the seat the role words mean (through
 * its lines and the agent on the call), else the one teammate holding that role. Never a line the client doesn't buy;
 * an empty seat falls to the next owner on the line (said in `why`).
 */
export async function recipientFor(admin: SupabaseClient, input: { to: string; client: ClientTeam | null; agentRole: string | null; exclude: string }): Promise<RecipientResult> {
  const team = await activeTeam(admin);
  // A role ("the Meta media buyer") goes through the client's seats first, so a word in it never fuzzy-matches a name
  const roleWords = ROLE_WORDS.test(input.to);
  const byName = roleWords ? ({ kind: "none" } as const) : resolveTeammate(input.to, team, { exclude: input.exclude });
  if (byName.kind === "one" && byName.how !== "role") return { ok: true, to: { id: byName.person.id, name: byName.person.fullName, why: null } };
  if (byName.kind === "several") return { ok: false, note: "More than one teammate fits that name: ask which one in a few words.", options: byName.people.map((p) => p.fullName) };
  if (input.client && (roleWords || byName.kind === "none" || byName.how === "role")) {
    const r = routeSeat({ words: input.to, agentRole: input.agentRole, lines: input.client.lines, seats: input.client.seats });
    if (r.kind === "seat") return { ok: true, to: { id: r.holder.profileId, name: r.holder.name, why: null } };
    if (r.kind === "not_bought")
      return { ok: false, note: `${input.client.name} doesn't buy ${LINE_WORD[r.line]} (they have ${r.lines.map((l) => LINE_WORD[l]).join(", ") || "nothing on record"}). Say so in a few words and offer the owner on a line they do have; don't route there.` };
    if (r.kind === "fallback") {
      if (r.holder) return { ok: true, to: { id: r.holder.profileId, name: r.holder.name, why: r.why } };
      const head = team.find((p) => r.heads.includes(p.role as never) && p.id !== input.exclude) ?? team.find((p) => r.heads.includes(p.role as never));
      if (head) return { ok: true, to: { id: head.id, name: head.fullName, why: `${input.client.name} has no ${SEAT_LABEL[r.seat] ?? r.seat}, so it goes to the head of that line` } };
      return { ok: false, note: `${input.client.name} has nobody on ${LINE_WORD[r.line]} in the app. Ask who should get it.` };
    }
  }
  if (byName.kind === "one") return { ok: true, to: { id: byName.person.id, name: byName.person.fullName, why: null } };
  if (roleWords) {
    const byRole = resolveTeammate(input.to, team, { exclude: input.exclude });
    if (byRole.kind === "one") return { ok: true, to: { id: byRole.person.id, name: byRole.person.fullName, why: null } };
    if (byRole.kind === "several") return { ok: false, note: "Several teammates hold that role: name the client it's for, or ask which one in a few words.", options: byRole.people.map((p) => p.fullName) };
  }
  return { ok: false, note: `No teammate called "${input.to}" on the team in the app. Ask who they meant (a name or a role) in a few words.` };
}

/** The client a turn is about: the one the call was started from, else one named in what they said (their visible clients) */
export async function clientInPlay(db: SupabaseClient, clientId: string | null | undefined, text: string): Promise<string | null> {
  if (clientId) return clientId;
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (t.trim().length < 3) return null;
  const { data } = await db.from("clients").select("id, name").is("archived_at", null).limit(500);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hits = ((data ?? []) as { id: string; name: string }[]).filter((c) => {
    const n = norm(c.name);
    if (n && t.includes(` ${n} `)) return true;
    const first = n.split(" ")[0];
    return first.length >= 5 && t.includes(` ${first} `);
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** The client's team block for an agent's context on a call about a client (empty when none is in play) */
export async function clientTeamBlock(db: SupabaseClient, admin: SupabaseClient, clientId: string | null | undefined, text: string): Promise<string> {
  const id = await clientInPlay(db, clientId, text).catch(() => null);
  if (!id) return "";
  // Only a client this person may see (their own session decides)
  const { data: seen } = await db.from("clients").select("id").eq("id", id).maybeSingle();
  if (!seen) return "";
  const team = await clientTeam(admin, id);
  return team ? teamLines(team.name, team.lines, team.seats) : "";
}
