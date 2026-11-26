import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gate, type Directory, type Gate, type Person } from "@/lib/item-gate-core";

// The relevance gate's data (src/lib/item-gate-core.ts has the rules): the person, the client's services and seats,
// and the team. Read once per call; the team for ten minutes.

type Admin = SupabaseClient;
let dirCache: { at: number; dir: Directory } | null = null;

async function directory(admin: Admin): Promise<Directory> {
  if (dirCache && Date.now() - dirCache.at < 600_000) return dirCache.dir;
  const { data } = await admin.from("profiles").select("id, full_name, role, is_exec, exec_focus").eq("is_active", true).limit(500);
  const people = (data ?? []).map((p) => ({ id: p.id as string, name: String(p.full_name ?? ""), role: String(p.role ?? ""), isExec: Boolean(p.is_exec), focus: (p.exec_focus as string[] | null) ?? [] }));
  const { webOwner } = await import("@/lib/client-signals");
  const web = await webOwner(admin).catch(() => null);
  const dir = { people, webOwnerId: web?.profileId ?? null };
  dirCache = { at: Date.now(), dir };
  return dir;
}

/** Whether an item is this person's, and if not whose (or nobody's) */
export async function gateFor(admin: Admin, o: { ownerId: string; clientId: string | null; text: string }): Promise<Gate> {
  const dir = await directory(admin);
  const me = dir.people.find((p) => p.id === o.ownerId);
  if (!me) return { verdict: "keep", line: null };
  if (!o.clientId) return { verdict: "keep", line: null };
  const { clientTeam } = await import("@/lib/assistant/routing-server");
  const { data: c } = await admin.from("clients").select("services, services_extra, services_removed").eq("id", o.clientId).maybeSingle();
  const ct = await clientTeam(admin, o.clientId);
  if (!c || !ct) return { verdict: "keep", line: null };
  const { servicesOf } = await import("@/lib/services");
  const services = servicesOf(c as { services?: string[] | null; services_extra?: string[] | null; services_removed?: string[] | null }) as string[];
  return gate({ person: me as Person, text: o.text, client: { services, seats: ct.seats }, dir });
}

/** Source refs the gate applies to: what a routine, the client-message reader or a schedule made for someone */
export const GATED = /^(routine:(?!call:)|signal:|recurring:|holdsend:)/;
