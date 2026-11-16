// Whether someone on the email or organic social team may read a client through a tool that uses the server's rights.
// Mirrors private.can_see_client for these positions (supabase/migrations/20261116120000_email_social_roles.sql): the
// head of a line sees every client that buys the line's service; everyone else only the clients they hold a seat on.
// Pure, so it's tested without a database.

export type ChannelWho = { id: string; role: string | null | undefined };
export type ChannelClient = { archived: boolean; services: readonly string[]; seatHolders: readonly string[] };

const HEAD_SERVICE: Record<string, string> = { head_of_email: "email-marketing", head_of_social: "social-media" };

export function channelMaySee(me: ChannelWho, client: ChannelClient): boolean {
  if (client.seatHolders.includes(me.id)) return true;
  const service = HEAD_SERVICE[me.role ?? ""];
  return Boolean(service) && !client.archived && client.services.includes(service);
}
