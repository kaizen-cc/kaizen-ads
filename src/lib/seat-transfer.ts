import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setPrimarySeat } from "@/lib/buyer-seats";
import { servicesOf } from "@/lib/services";
import { canTake, matchPerson, mayTransferSeat, planMoves, seatLabel, seatLine, type HeldSeat, type Mover, type Person, type PlannedMove, type SeatLine } from "@/lib/seat-transfer-core";
import type { HandoffDoc } from "@/lib/handoff";
import { movedLine } from "@/lib/handoff-roles";

// Moving someone's accounts in one plan: find every seat a person holds (that the asker may move), plan each move to
// the right person for its line, write the handoff ahead for the seats that get one, and apply each move on approval
// (the same assignment, work move and handoff as the client page). Every write checks who's asking again.

export type Asker = Mover & { id: string; fullName: string };

const PEOPLE = "id, full_name, role, also_buys, also_social, also_designs_email, teams";

/** The active team, with what lets each one hold a seat */
export async function activePeople(admin: SupabaseClient): Promise<Person[]> {
  const { data } = await admin.from("profiles").select(PEOPLE).eq("is_active", true).order("full_name");
  return (data ?? []) as Person[];
}

/** A teammate by name (active or not: someone leaving may already be switched off) */
export async function personNamed(admin: SupabaseClient, name: string): Promise<{ one: Person } | { many: Person[] } | { none: true }> {
  const { data } = await admin.from("profiles").select(`${PEOPLE}, is_active`).order("full_name");
  const all = (data ?? []) as (Person & { is_active: boolean })[];
  const active = matchPerson(all.filter((p) => p.is_active), name);
  return "none" in active ? matchPerson(all, name) : active;
}

/** Every seat this person holds on a client that isn't archived */
export async function seatsHeldBy(admin: SupabaseClient, personId: string): Promise<HeldSeat[]> {
  const { data } = await admin.from("client_assignments").select("client_id, role, is_primary, clients(name, archived_at, services, services_extra, services_removed, strategy_only)").eq("profile_id", personId);
  return (data ?? [])
    .map((r) => ({ r, c: r.clients as unknown as { name: string; archived_at: string | null; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null } | null }))
    .filter(({ c }) => c && !c.archived_at)
    .map(({ r, c }) => ({ clientId: r.client_id as string, client: c!.name, services: servicesOf(c!), role: r.role as string, primary: r.is_primary !== false }));
}

/** What the asker can see of someone's seats: the ones they may move, and how many others there are (another line's) */
export async function findAccounts(admin: SupabaseClient, me: Asker, name: string) {
  const found = await personNamed(admin, name);
  if ("none" in found) return { found: false as const, note: `Nobody on the team matches "${name}".` };
  if ("many" in found) return { found: false as const, choices: found.many.map((p) => p.full_name), note: "Several people match: ask which one." };
  const p = found.one;
  const seats = await seatsHeldBy(admin, p.id);
  const mine = seats.filter((s) => mayTransferSeat(me, s.role));
  return {
    found: true as const,
    person: { id: p.id, name: p.full_name, role: p.role },
    seats: mine.map((s) => ({ client: s.client, seat: seatLabel(s.role), line: seatLine(s.role), primary: s.primary })),
    otherLines: seats.length - mine.length,
  };
}

/**
 * Plans moving someone's seats: all of them, or only these clients and seats. `to` takes every seat they can hold;
 * `byLine` names someone for a line `to` can't cover. Seats nobody named fits are planned without a person (picked on
 * the page). Returns the plan's id and its moves.
 */
export async function planTransfer(
  admin: SupabaseClient,
  me: Asker,
  input: { fromId: string; toId: string | null; clientIds?: string[] | null; roles?: string[] | null; byLine?: Partial<Record<SeatLine, string>>; note?: string | null },
): Promise<{ id: string; moves: PlannedMove[] } | { error: string }> {
  const [held, people] = await Promise.all([seatsHeldBy(admin, input.fromId), activePeople(admin)]);
  const picked = held.filter((s) => (!input.clientIds?.length || input.clientIds.includes(s.clientId)) && (!input.roles?.length || input.roles.includes(s.role)));
  const moves = planMoves(me, input.fromId, picked, people, input.toId, input.byLine ?? {});
  if (!moves.length) return { error: held.length ? "None of their seats are ones you can move (a head moves their own line's seats; executives move any)." : "They don't hold any seats on live clients." };
  const { data: t, error } = await admin.from("seat_transfers").insert({ from_id: input.fromId, to_id: input.toId, asked_by: me.id, note: input.note?.slice(0, 500) ?? null }).select("id").single();
  if (error || !t) return { error: error?.message ?? "Couldn't save the plan." };
  const rows = moves.map((m) => ({ transfer_id: t.id, client_id: m.clientId, role: m.role, primary_seat: m.primary, from_id: input.fromId, to_id: m.toId, doc_status: needsDoc(m.role, m.primary, m.toId) ? "writing" : "none" }));
  const { error: e2 } = await admin.from("seat_transfer_moves").insert(rows);
  if (e2) {
    await admin.from("seat_transfers").delete().eq("id", t.id);
    return { error: e2.message };
  }
  return { id: t.id as string, moves };
}

/** The seats that get a handoff written for the new person: every seat they take over as its primary */
const needsDoc = (_role: string, primary: boolean, toId: string | null) => primary && Boolean(toId);

/** Writes the handoffs a plan's moves are waiting for (in the background, after planning or a change of person) */
export async function writeMoveDocs(admin: SupabaseClient, transferId: string) {
  const { data } = await admin.from("seat_transfer_moves").select("id, client_id, from_id, to_id, role").eq("transfer_id", transferId).eq("doc_status", "writing");
  const { handoffDoc } = await import("@/lib/handoff");
  // A few at a time: a leaving buyer can hold a dozen accounts
  const list = data ?? [];
  for (let i = 0; i < list.length; i += 3)
    await Promise.all(
      list.slice(i, i + 3).map(async (m) => {
        try {
          const doc = await handoffDoc(admin, m.client_id as string, m.to_id as string, (m.from_id as string | null) ?? null, m.role as string);
          // Only if the move still goes to the same person (it may have been changed while this was written)
          await admin.from("seat_transfer_moves").update({ doc, doc_status: "ready" }).eq("id", m.id).eq("to_id", m.to_id as string);
        } catch {
          await admin.from("seat_transfer_moves").update({ doc_status: "failed" }).eq("id", m.id);
        }
      }),
    );
}

type MoveRow = { id: string; transfer_id: string; client_id: string; role: string; primary_seat: boolean; from_id: string | null; to_id: string | null; status: string; doc: HandoffDoc | null; doc_status: string };

async function moveFor(admin: SupabaseClient, me: Asker, id: string): Promise<MoveRow> {
  const { data } = await admin.from("seat_transfer_moves").select("id, transfer_id, client_id, role, primary_seat, from_id, to_id, status, doc, doc_status").eq("id", id).maybeSingle();
  if (!data) throw new Error("That move isn't there any more.");
  // The server's own check: a head never moves another line's seat, whatever the browser sends
  if (!mayTransferSeat(me, data.role as string)) throw new Error(`Moving the ${seatLabel(data.role as string)} seat is for the executives and that line's head.`);
  return data as MoveRow;
}

/** Changes who takes a planned move (they must be able to hold the seat); the handoff is written again for them */
export async function setMovePerson(admin: SupabaseClient, me: Asker, id: string, toId: string) {
  const m = await moveFor(admin, me, id);
  if (!["planned", "failed"].includes(m.status)) throw new Error("That move is already done.");
  const { data: p } = await admin.from("profiles").select(`${PEOPLE}, is_active`).eq("id", toId).maybeSingle();
  if (!p?.is_active || !canTake(m.role, p as Person)) throw new Error(`They can't hold the ${seatLabel(m.role)} seat.`);
  if (toId === m.from_id) throw new Error("That's who has it now.");
  const doc = needsDoc(m.role, m.primary_seat, toId);
  await admin.from("seat_transfer_moves").update({ to_id: toId, status: "planned", error: null, doc: null, doc_status: doc ? "writing" : "none" }).eq("id", id);
  return { transferId: m.transfer_id, writeDoc: doc };
}

export async function dropMove(admin: SupabaseClient, me: Asker, id: string) {
  const m = await moveFor(admin, me, id);
  if (m.status === "applied") throw new Error("That move is already done: change the seat on the client's page.");
  await admin.from("seat_transfer_moves").update({ status: "dropped" }).eq("id", id);
  await settle(admin, m.transfer_id);
}

/** Applies one move: the seat changes hands; a Meta buyer seat also moves the account's work and opens the handoff */
export async function applyMove(admin: SupabaseClient, me: Asker, id: string): Promise<{ ok: true; handoffId: string | null; writeHandoff: boolean } | { ok: false; error: string }> {
  let m: MoveRow;
  try {
    m = await moveFor(admin, me, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (m.status === "applied") return { ok: true, handoffId: null, writeHandoff: false };
  if (!["planned", "failed"].includes(m.status)) return { ok: false, error: "That move isn't waiting." };
  if (!m.to_id) return { ok: false, error: `Pick who takes the ${seatLabel(m.role)} seat first.` };
  const fail = async (error: string) => {
    await admin.from("seat_transfer_moves").update({ status: "failed", error: error.slice(0, 300) }).eq("id", id);
    return { ok: false as const, error };
  };
  const { data: who } = await admin.from("profiles").select(`${PEOPLE}, is_active`).eq("id", m.to_id).maybeSingle();
  if (!who?.is_active || !canTake(m.role, who as Person)) return fail(`${(who?.full_name as string | undefined) ?? "They"} can't hold the ${seatLabel(m.role)} seat.`);
  await admin.from("seat_transfer_moves").update({ status: "applying", error: null }).eq("id", id);
  const { data: seat } = await admin.from("client_assignments").select("profile_id, is_primary").eq("client_id", m.client_id).eq("role", m.role);
  const rows = seat ?? [];
  if (m.from_id && !rows.some((r) => r.profile_id === m.from_id)) return fail("They're no longer on this seat: it changed since the plan was made.");
  let handoffId: string | null = null;
  let write = false;
  let moved: Record<string, number> | null = null;
  if (m.primary_seat) {
    const res = await setPrimarySeat(admin, m.client_id, m.role, m.to_id);
    if (!res.ok) return fail(res.error);
    if (res.to && res.to !== res.from) {
      const { handOff } = await import("@/lib/handoff");
      handoffId = await handOff(admin, m.client_id, res.from, res.to, me.id, "app", m.role);
      if (handoffId) {
        const { data: h } = await admin.from("account_handoffs").select("moved").eq("id", handoffId).maybeSingle();
        moved = (h?.moved as Record<string, number> | null) ?? null;
      }
      // The handoff read on the Handoffs page is the one they get; written now when it wasn't ready
      if (handoffId && m.doc && m.doc_status === "ready") await admin.from("account_handoffs").update({ status: "ready", doc: m.doc, ready_at: new Date().toISOString() }).eq("id", handoffId);
      else if (handoffId) write = true;
    }
    if ((m.role === "tiktok_buyer" || m.role === "meta_buyer") && res.to !== res.from) {
      const owner = await (await import("@/lib/tiktok/store")).tiktokOwner(admin, m.client_id).catch(() => undefined);
      if (owner !== undefined) await admin.from("kpi_targets").update({ owner_id: owner }).eq("client_id", m.client_id).eq("platform", "tiktok");
    }
  } else {
    // A secondary seat: they leave it, the new person joins it as a secondary (unless they're on it already)
    if (m.from_id) {
      const del = await admin.from("client_assignments").delete().eq("client_id", m.client_id).eq("role", m.role).eq("profile_id", m.from_id).eq("is_primary", false);
      if (del.error) return fail(del.error.message);
    }
    if (!rows.some((r) => r.profile_id === m.to_id)) {
      const ins = await admin.from("client_assignments").insert({ client_id: m.client_id, role: m.role, profile_id: m.to_id, is_primary: false });
      if (ins.error) return fail(ins.error.message);
    }
  }
  // Slack follows the seat: into the client's channels; the person leaving out of the client's own when it's their last seat
  const { seatSlackChange } = await import("@/lib/slack-seats");
  const slackDone = await seatSlackChange(admin, m.client_id, m.to_id, m.from_id).catch((e) => ({ internal: e instanceof Error ? e.message : String(e) }));
  await admin.from("seat_transfer_moves").update({ status: "applied", applied_by: me.id, applied_at: new Date().toISOString(), handoff_id: handoffId, error: null, moved, slack: slackDone }).eq("id", id);
  await settle(admin, m.transfer_id);
  return { ok: true, handoffId, writeHandoff: write };
}

/** A plan is done once nothing in it is waiting */
async function settle(admin: SupabaseClient, transferId: string) {
  const { data } = await admin.from("seat_transfer_moves").select("status").eq("transfer_id", transferId);
  const list = data ?? [];
  if (list.some((m) => ["planned", "applying", "failed"].includes(m.status as string))) return;
  await admin.from("seat_transfers").update({ status: list.some((m) => m.status === "applied") ? "done" : "dropped", updated_at: new Date().toISOString() }).eq("id", transferId);
}

export type MoveView = {
  id: string;
  clientId: string;
  client: string;
  slug: string | null;
  role: string;
  seat: string;
  primary: boolean;
  from: string | null;
  toId: string | null;
  to: string | null;
  status: string;
  error: string | null;
  docStatus: string;
  doc: HandoffDoc | null;
  handoffId: string | null;
  /** Who can take this seat (for the picker) */
  options: { id: string; name: string }[];
  /** After the move: the open work that followed it, and what happened in Slack */
  moved: string[];
  slack: { internal?: string; external?: string; leftExternal?: string } | null;
  canMove: boolean;
};

export type TransferView = { id: string; from: string | null; to: string | null; by: string | null; note: string | null; status: string; createdAt: string; moves: MoveView[] };

/** The plans the asker can act on: open ones, and the last few finished (each move with its handoff) */
export async function loadTransfers(admin: SupabaseClient, me: Asker, opts: { id?: string | null } = {}): Promise<TransferView[]> {
  let q = admin.from("seat_transfers").select("id, note, status, created_at, from:profiles!seat_transfers_from_id_fkey(full_name), to:profiles!seat_transfers_to_id_fkey(full_name), by:profiles!seat_transfers_asked_by_fkey(full_name)").order("created_at", { ascending: false }).limit(20);
  if (opts.id) q = q.eq("id", opts.id);
  const [{ data: ts }, people] = await Promise.all([q, activePeople(admin)]);
  const ids = (ts ?? []).map((t) => t.id as string);
  if (!ids.length) return [];
  const { data: ms } = await admin
    .from("seat_transfer_moves")
    .select("id, transfer_id, client_id, role, primary_seat, to_id, status, error, doc_status, doc, handoff_id, moved, slack, clients(name, slug), from:profiles!seat_transfer_moves_from_id_fkey(full_name), to:profiles!seat_transfer_moves_to_id_fkey(full_name)")
    .in("transfer_id", ids)
    .order("created_at");
  const name = (x: unknown) => (x as { full_name: string } | null)?.full_name ?? null;
  return (ts ?? [])
    .map((t) => ({
      id: t.id as string,
      from: name(t.from),
      to: name(t.to),
      by: name(t.by),
      note: (t.note as string | null) ?? null,
      status: t.status as string,
      createdAt: t.created_at as string,
      moves: (ms ?? [])
        .filter((m) => m.transfer_id === t.id && mayTransferSeat(me, m.role as string))
        .map((m) => {
          const c = m.clients as unknown as { name: string; slug: string } | null;
          return {
            id: m.id as string,
            clientId: m.client_id as string,
            client: c?.name ?? "A client",
            slug: c?.slug ?? null,
            role: m.role as string,
            seat: seatLabel(m.role as string),
            primary: m.primary_seat as boolean,
            from: name(m.from),
            toId: (m.to_id as string | null) ?? null,
            to: name(m.to),
            status: m.status as string,
            error: (m.error as string | null) ?? null,
            docStatus: m.doc_status as string,
            doc: (m.doc as HandoffDoc | null) ?? null,
            handoffId: (m.handoff_id as string | null) ?? null,
            options: people.filter((p) => canTake(m.role as string, p)).map((p) => ({ id: p.id, name: p.full_name })),
            moved: movedLine(m.role as string, (m.moved as Record<string, number> | null) ?? {}),
            slack: (m.slack as MoveView["slack"]) ?? null,
            canMove: true,
          };
        })
        .sort((a, b) => a.client.localeCompare(b.client) || a.seat.localeCompare(b.seat)),
    }))
    .filter((t) => t.moves.length > 0);
}

/** Single seat changes planned in a chat (a client's buyer) still waiting, from the last 30 days */
export async function pendingTeamChanges(admin: SupabaseClient): Promise<string[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await admin.from("ad_changes").select("id").eq("platform", "team").in("status", ["planning", "ready", "partial", "failed"]).gte("created_at", since).order("created_at", { ascending: false }).limit(20);
  return (data ?? []).map((r) => r.id as string);
}
