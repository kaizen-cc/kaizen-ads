// Requests to enable a connector, the plain parts: one pending request per person per connector (asking again updates
// the note), who hears about it (every exec, the owner included, never the person who asked), what the people who
// asked hear when it's enabled or declined, and which roles a connector is offered to once enabled from requests.
// A request's ref is the Directory entry's registry name ("kaizen.directory/asana"), or "connector:<id>" for a
// connector the team has that isn't offered to the person's role.

export type RequestStatus = "pending" | "enabled" | "declined";
export type RequestRow = { id: string; profile_id: string; ref: string; title: string; icon_url: string | null; note: string | null; status: RequestStatus; created_at: string };
export type Notice = { profile_id: string; kind: "connector"; title: string; body: string; href: string; key: string; priority: "normal"; actor_id: string | null };

export const REF_RE = /^(connector:[0-9a-f-]{36}|[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._@/-]{1,200})$/;
export const cleanNote = (note: unknown) => (typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 500) : "") || null;

/** Asking: a new request, or the note on the one this person already has pending for this connector */
export function planRequest(mine: Pick<RequestRow, "id" | "ref" | "status">[], ref: string): { kind: "new" } | { kind: "update"; id: string } {
  const open = mine.find((r) => r.ref === ref && r.status === "pending");
  return open ? { kind: "update", id: open.id } : { kind: "new" };
}

/** The bell for every exec when someone asks: "<role> asked to enable <connector>", once per request */
export function askNotices(execs: { id: string }[], r: { id: string; title: string; ref: string; roleLabel: string; note: string | null; requester: string }, href: string): Notice[] {
  return execs
    .filter((e) => e.id !== r.requester)
    .map((e) => ({
      profile_id: e.id,
      kind: "connector",
      title: `${r.roleLabel} asked to enable ${r.title}`.slice(0, 300),
      body: (r.note ? `"${r.note}"` : "Enable it for the team, or decline with a reason.").slice(0, 1000),
      href,
      key: `connector-ask:${r.id}`,
      priority: "normal",
      actor_id: r.requester,
    }));
}

const askers = (reqs: Pick<RequestRow, "id" | "profile_id">[]) => {
  const seen = new Set<string>();
  return reqs.filter((r) => (seen.has(r.profile_id) ? false : (seen.add(r.profile_id), true)));
};

/** Everyone who asked hears it's ready, with a link straight to connecting it in Kaizen AI */
export function readyNotices(reqs: Pick<RequestRow, "id" | "profile_id">[], c: { name: string }, href: string, actor: string | null): Notice[] {
  return askers(reqs).map((r) => ({
    profile_id: r.profile_id,
    kind: "connector",
    title: `${c.name} is ready to connect`.slice(0, 300),
    body: "It's enabled for you in Kaizen AI. Connect your own account and switch it on in any chat.",
    href,
    key: `connector-ready:${r.id}`,
    priority: "normal",
    actor_id: actor,
  }));
}

/** Everyone who asked hears it was declined, and why */
export function declinedNotices(reqs: Pick<RequestRow, "id" | "profile_id">[], title: string, reason: string | null, href: string, actor: string | null): Notice[] {
  return askers(reqs).map((r) => ({
    profile_id: r.profile_id,
    kind: "connector",
    title: `${title} wasn't enabled`.slice(0, 300),
    body: (reason ? reason : "An exec decided not to enable it for now.").slice(0, 1000),
    href,
    key: `connector-declined:${r.id}`,
    priority: "normal",
    actor_id: actor,
  }));
}

/**
 * The roles a connector is offered to once it's enabled from requests: everyone when it's new or already offered to
 * everyone; otherwise the roles it had plus those of the people who asked.
 */
export function rolesAfterEnable(existing: { roles: string[] | null } | null, askerRoles: string[]): string[] {
  if (!existing || !existing.roles?.length) return [];
  return [...new Set([...existing.roles, ...askerRoles.filter(Boolean)])];
}

/** The pending requests, one group per connector (oldest ask first), for Settings */
export type RequestGroup = { ref: string; title: string; icon_url: string | null; first: string; people: { id: string; name: string; role: string; note: string | null; at: string }[] };
export function groupRequests(rows: (RequestRow & { name: string; role: string })[]): RequestGroup[] {
  const by = new Map<string, RequestGroup>();
  for (const r of [...rows].filter((x) => x.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const g = by.get(r.ref) ?? { ref: r.ref, title: r.title, icon_url: r.icon_url, first: r.created_at, people: [] };
    g.people.push({ id: r.id, name: r.name, role: r.role, note: r.note, at: r.created_at });
    by.set(r.ref, g);
  }
  return [...by.values()].sort((a, b) => b.people.length - a.people.length || a.first.localeCompare(b.first));
}
