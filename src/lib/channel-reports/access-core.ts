import { lineOfTeam } from "@/lib/roles";
import { LINE_SERVICE, type ChannelLine } from "./core";

// Who sees which channel reports, as plain functions shared by the Reports page, the studio's actions, the PDF routes and
// the tests. An exec sees both lines for every client. Someone on the email team sees email reports only, someone on the
// social team social reports only; ad people (media buyers, the heads of Meta and Google) see none of them. Which clients:
// the Head of Email every client that buys Email Marketing, the Head of Organic Social every client that buys Social Media,
// anyone else on those teams the clients they hold a seat on. The database enforces the client rule on reads
// (private.staff_can_see_client); the server uses the admin client and re-checks it here.

export type Who = { role: string | null | undefined; isExec?: boolean | null };

/** The lines a person reports on: an exec both, the email team email, the social team social, anyone else none */
export function linesFor(me: Who): ChannelLine[] {
  if (me.isExec) return ["email", "social"];
  const own = lineOfTeam(me.role);
  return own ? [own] : [];
}

/** The seats on a client that put someone on a line (their clients, for everyone but the line's head) */
export const SEATS_OF: Record<ChannelLine, readonly string[]> = {
  email: ["email_strategist", "email_designer", "email_builder"],
  social: ["social_manager", "social_creative"],
};

/**
 * The seats that own and send a line's reports, and the only people a report lists: the line's strategist. Email: the
 * Email Strategist; social: the Social Media Manager (Head of Social, Nov 19 2026). A designer, builder or social
 * creative seated on the client never shows on a report. The line's head sees the reports through the service rule below.
 */
export const REPORT_SEATS: Record<ChannelLine, readonly string[]> = {
  email: ["email_strategist"],
  social: ["social_manager"],
};

/** The head of a line sees every client that buys its service */
export const isHeadOf = (me: Who, line: ChannelLine) => me.role === (line === "email" ? "head_of_email" : "head_of_social");

/** Whether a client buys a line's service (its services, as the client page reads them) */
export const buys = (services: readonly string[], line: ChannelLine) => services.includes(LINE_SERVICE[line]);

/**
 * Whether this person may open a client's report on a line, given what is known about the client: the services it buys
 * and the seats this person holds on it (the roles of their assignments there).
 */
export function mayOpen(me: Who, line: ChannelLine, client: { services: readonly string[]; myRoles: readonly string[] }): boolean {
  if (me.isExec) return true;
  if (!linesFor(me).includes(line)) return false;
  if (isHeadOf(me, line) && buys(client.services, line)) return true;
  return client.myRoles.some((r) => REPORT_SEATS[line].includes(r));
}
