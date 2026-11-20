import { noIdeas } from "@/lib/maker-day-core";
import { canSeeReports, channelNavOk, isChannelOnly, isCreativeRole, isLeadMaker, ROLES, roleLabel, type TeamRole } from "@/lib/roles";

// View as: the owner sees the app exactly as one teammate (or one role) sees it, read only. The pure parts live here
// (the cookie, the message, which outside calls count as a change) so they're testable without a request.
//
// How it holds together:
// - The choice lives in the kz_view_as cookie. The server honors it only for a profile with can_view_as (set by
//   migration for the owner alone); for anyone else it's ignored (and only makes their own writes fail).
// - getViewer() answers as the target (lib/auth.ts), so every gate in the app (navigation, Overview, client list,
//   boards, KPIs, reports, Kaizen AI, the assistant) is the target's.
// - Every Supabase request carries x-kz-view-as. The database's pre-request hook makes the request READ ONLY and, for
//   the owner, makes private.current_profile_id() (and every RLS helper built on it) answer as the target. So rows
//   are the target's exactly, and nothing can be written through the session or the admin client.
// - Outside calls (Slack, email, Meta, Google, Asana, Klaviyo...) that would change anything are refused before they
//   leave (lib/view-as-fetch.ts); reads and the AI the assistant needs still go.

export const VIEW_AS_COOKIE = "kz_view_as";
/** Set for a moment when a change was refused, so the page can say why (read once by the bar, then cleared) */
export const VIEW_AS_BLOCKED_COOKIE = "kz_view_as_blocked";
export const VIEW_AS_HEADER = "x-kz-view-as";
export const VIEW_AS_ERROR_CODE = "KZ_VIEW_AS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_VALUES = new Set<string>(ROLES.map((r) => r.value));

/** What the cookie holds: the teammate shown, the role when a role was picked (shown through that teammate), and their name for messages */
export type ViewAsChoice = { id: string; role: TeamRole | null; name: string };

export function formatViewAsCookie(c: ViewAsChoice): string {
  return [c.id, c.role ?? "", encodeURIComponent(c.name.slice(0, 80))].join("|");
}

export function parseViewAsCookie(raw: string | null | undefined): ViewAsChoice | null {
  if (!raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // keep it as it came
  }
  const [id, role = "", name = ""] = value.split("|");
  if (!id || !UUID.test(id)) return null;
  let shown = name;
  try {
    shown = decodeURIComponent(name);
  } catch {
    // keep it as it came
  }
  return { id: id.toLowerCase(), role: ROLE_VALUES.has(role) ? (role as TeamRole) : null, name: shown || "this teammate" };
}

/** The one line anyone sees when a change is refused while viewing as someone */
export const viewAsMessage = (name: string) => `You're viewing as ${name}: exit to make changes.`;

export const isViewAsMessage = (m: string | null | undefined) => Boolean(m && /^You're viewing as .+: exit to make changes\.?$/.test(m.trim()));

export class ViewAsReadOnlyError extends Error {
  code = VIEW_AS_ERROR_CODE;
  constructor(name: string) {
    super(viewAsMessage(name));
    this.name = "ViewAsReadOnlyError";
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Slack Web API methods that only read (Slack takes POST for these too) */
const SLACK_READS = /^\/api\/(conversations\.(history|replies|info|list|members)|users\.(info|list|lookupByEmail|profile\.get|conversations)|auth\.test|team\.info|files\.(info|list)|search\.(messages|all|files)|chat\.getPermalink|bots\.info|reactions\.(get|list)|usergroups\.(list|users\.list)|emoji\.list|pins\.list|bookmarks\.list)$/;

/** Hosts a read may POST to: the AI the assistant and Kaizen AI think with, speech, place search, sign-in token refresh */
const POST_READ_HOSTS = new Set(["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "speech.googleapis.com", "places.googleapis.com", "oauth2.googleapis.com", "api.voyageai.com"]);

/** Google endpoints that read with POST (Google Ads queries, Analytics reports) */
const GOOGLE_POST_READS = /:(search|searchStream|runReport|batchRunReports|runRealtimeReport|query)$/;

export type OutboundVerdict = "allow" | "block" | "block-supabase";

/**
 * Whether an outside call may go while viewing as someone. Reads always go; anything that could change something
 * (a Slack post, an email, a Meta or Google change, an Asana task, an upload) is refused. Supabase is handled apart:
 * RPCs go (the database runs them read only), table and storage changes are refused with an answer supabase-js reads.
 */
export function outboundVerdict(method: string | null | undefined, url: string, supabaseUrl?: string | null): OutboundVerdict {
  const m = (method ?? "GET").toUpperCase();
  if (READ_METHODS.has(m)) return "allow";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // A relative address is this app itself: its own API changes things like any other
    return "block";
  }
  const supa = (() => {
    try {
      return supabaseUrl ? new URL(supabaseUrl).host : null;
    } catch {
      return null;
    }
  })();
  if (supa && u.host === supa) {
    const p = u.pathname;
    if (p.startsWith("/rest/v1/rpc/")) return "allow";
    if (p === "/auth/v1/token" || p.startsWith("/auth/v1/token")) return "allow";
    if (p.startsWith("/storage/v1/object/sign/") || p.startsWith("/storage/v1/object/list/")) return "allow";
    return "block-supabase";
  }
  if (POST_READ_HOSTS.has(u.host)) return "allow";
  if (u.host === "slack.com" && SLACK_READS.test(u.pathname)) return "allow";
  if (u.host.endsWith(".googleapis.com") && GOOGLE_POST_READS.test(u.pathname)) return "allow";
  if (u.host === "api.elevenlabs.io" && /^\/v1\/(text-to-speech|speech-to-text)\b/.test(u.pathname)) return "allow";
  return "block";
}

/** The answer a refused Supabase change gets: shaped like PostgREST's (and storage's) errors, so callers read it as one */
export function viewAsSupabaseRefusal(name: string): Response {
  const message = viewAsMessage(name);
  return new Response(JSON.stringify({ code: VIEW_AS_ERROR_CODE, message, details: null, hint: null, error: message, statusCode: "403" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

/** How the bar names it: "Peter Gonzalez (Head of Organic Social)", or for a role "Head of Organic Social (shown through Peter Gonzalez)" */
export function viewAsLabel(v: { name: string; roleLabel: string; mode: "person" | "role" }): string {
  return v.mode === "role" ? `${v.roleLabel} (shown through ${v.name})` : `${v.name} (${v.roleLabel})`;
}

/**
 * The teammate who stands in for a role: the active one holding the most clients (their screens are the fullest, so
 * the most to train on), then by name. Null when nobody active holds the role.
 */
export function representativeFor<T extends { id: string; role: string; full_name: string; is_active: boolean; clients: number }>(role: TeamRole, people: T[]): T | null {
  const pool = people.filter((p) => p.is_active && p.role === role);
  pool.sort((a, b) => b.clients - a.clients || a.full_name.localeCompare(b.full_name));
  return pool[0] ?? null;
}

/**
 * What a role sees, in words (for the assistant: "what does a social manager see?"). The places follow the sidebar's
 * rules (components/team-shell.tsx) and the client access follows private.can_see_client() in the database.
 */
export function roleView(role: TeamRole): { role: string; tier: string; places: string[]; clients: string; reports: boolean; paidAds: boolean } {
  const exec = role === "executive";
  // profiles.is_lead: the Heads of Meta, Creative and Google (the Heads of Email and Social aren't, by design)
  const lead = role === "head_of_meta" || role === "head_of_creative" || role === "head_of_google";
  const tier = exec ? "exec" : lead ? "lead" : "member";
  const creative = isCreativeRole(role);
  const channel = isChannelOnly(role);
  const reports = canSeeReports({ role, isExec: exec });
  const all: { href: string; label: string; ok: boolean }[] = [
    { href: "/pipeline", label: "Overview", ok: true },
    { href: "/board", label: "Boards", ok: true },
    { href: "/board?view=kpis", label: "Team KPIs", ok: role === "head_of_creative" },
    { href: "/clients", label: "Clients", ok: true },
    { href: "/kpis", label: "KPIs", ok: !creative },
    { href: "/reports", label: "Reports", ok: reports },
    { href: "/ai", label: "Kaizen AI", ok: true },
    { href: "/ideas", label: "Ideas", ok: !noIdeas(role) },
    { href: "/lab", label: "Ads Lab", ok: (tier === "exec" || tier === "lead") && !creative },
    { href: "/settings", label: "Settings", ok: tier === "exec" || tier === "lead" },
  ];
  const places = all.filter((i) => i.ok && (!channel || i.href === "/settings" || channelNavOk(i.href, role))).map((i) => i.label);
  const clients =
    exec || lead || role === "customer_success" || role === "onboarding_specialist" || role === "tracking_specialist" || role === "copywriter"
      ? "Every client"
      : role === "head_of_email"
        ? "Every client buying email marketing (plus any they're assigned to)"
        : role === "head_of_social"
          ? "Every client buying organic social (plus any they're assigned to)"
          : isLeadMaker(role)
            ? "Every client (to see and request creative for)"
            : "Only the clients they're assigned to";
  return { role: roleLabel(role), tier, places: [...places, "Feedback"], clients, reports, paidAds: !channel };
}
