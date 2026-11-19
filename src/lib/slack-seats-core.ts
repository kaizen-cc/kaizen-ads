// Slack access follows the seat: everyone assigned to a client in Kaizen OS (any seat) is in that client's internal
// and external Slack channels, so they're always in the conversation. Pure: given the clients' channels, who holds a
// seat on each, and who's in each channel, what's missing and why it can't be fixed. The server does the Slack calls.

export type ChannelKind = "internal" | "external";
export type SeatHolder = { profileId: string; name: string; slackId: string | null };
export type ClientSeats = { clientId: string; client: string; internal: string | null; external: string | null; people: SeatHolder[] };
/** Members of a channel, or why they couldn't be read (the bot isn't in it, the channel is gone) */
export type Members = { ok: true; ids: ReadonlySet<string> } | { ok: false; why: string };

export type Invite = { clientId: string; client: string; kind: ChannelKind; channel: string; profileId: string; name: string; slackId: string };
export type Problem = { client: string; kind: ChannelKind | null; name: string | null; why: string };

/** Who must be invited where, and what can't be done (no channel, no Slack user, a channel the bot can't read) */
export function planSlackSeats(clients: readonly ClientSeats[], members: ReadonlyMap<string, Members>): { invites: Invite[]; problems: Problem[]; inPlace: number } {
  const invites: Invite[] = [];
  const problems: Problem[] = [];
  let inPlace = 0;
  for (const c of clients) {
    if (!c.people.length) continue;
    for (const kind of ["internal", "external"] as const) {
      const channel = kind === "internal" ? c.internal : c.external;
      if (!channel) {
        problems.push({ client: c.client, kind, name: null, why: `No ${kind} Slack channel linked to the client` });
        continue;
      }
      const m = members.get(channel);
      if (!m) continue;
      if (!m.ok) {
        problems.push({ client: c.client, kind, name: null, why: m.why });
        continue;
      }
      for (const p of c.people) {
        if (!p.slackId) continue;
        if (m.ids.has(p.slackId)) inPlace++;
        else invites.push({ clientId: c.clientId, client: c.client, kind, channel, profileId: p.profileId, name: p.name, slackId: p.slackId });
      }
    }
  }
  // Someone with no Slack user is one problem per person, not one per channel
  const noSlack = new Map<string, string[]>();
  for (const c of clients) for (const p of c.people) if (!p.slackId) noSlack.set(p.name, [...(noSlack.get(p.name) ?? []), c.client]);
  for (const [name, list] of noSlack) problems.push({ client: list.join(", "), kind: null, name, why: "No Slack user found for their work email" });
  return { invites, problems, inPlace };
}

/**
 * Whether someone leaving a seat leaves the client's external channel too: only when they hold no other seat on the
 * client and they aren't an executive or a line head (who stay in every client's conversation). The internal channel
 * keeps them (the owner's call: out of the client's channel, still in the team's).
 */
export const leavesExternal = (otherSeatsOnClient: number, leader: boolean) => otherSeatsOnClient === 0 && !leader;

/** Group invites per channel (Slack invites up to 1000 people in one call) */
export function byChannel(invites: readonly Invite[]): { channel: string; invites: Invite[] }[] {
  const m = new Map<string, Invite[]>();
  for (const i of invites) m.set(i.channel, [...(m.get(i.channel) ?? []), i]);
  return [...m].map(([channel, list]) => ({ channel, invites: list }));
}
