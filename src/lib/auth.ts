import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { canSeeReports, isCreativeRole, isLeadMaker, type TeamRole } from "@/lib/roles";
import { createSessionClient } from "@/lib/supabase/session";
import { activeViewAs, STAFF_COLUMNS, type StaffRow } from "@/lib/view-as";

export type Staff = {
  kind: "staff";
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: TeamRole;
  isExec: boolean;
  isLead: boolean;
  isCreative: boolean;
  isBuyer: boolean;
  isCopywriter: boolean;
  isCoordinator: boolean;
  /** Only the owner: may view the app as a teammate (profiles.can_view_as, set by migration, never by role) */
  canViewAs?: boolean;
  /**
   * Set while the owner views the app as this teammate (lib/view-as-core.ts): everything above is the teammate's, so
   * every gate is theirs; nothing can be changed. The real person signed in is viewAs.actorId.
   */
  viewAs?: { actorId: string; actorName: string; mode: "person" | "role"; role: TeamRole | null; label: string };
};

export type Brand = { id: string; name: string; slug: string; logoPath: string | null };

export type Contact = {
  kind: "contact";
  id: string;
  email: string;
  fullName: string | null;
  brands: Brand[];
};

export type Viewer = Staff | Contact;

const staffFrom = (p: StaffRow): Staff => ({
  kind: "staff",
  id: p.id,
  email: p.email,
  fullName: p.full_name,
  avatarUrl: p.avatar_url,
  role: p.role as TeamRole,
  isExec: p.is_exec,
  isLead: p.is_lead,
  isCreative: p.is_creative,
  isBuyer: p.is_buyer,
  isCopywriter: p.is_copywriter,
  isCoordinator: p.is_coordinator,
  canViewAs: Boolean(p.can_view_as),
});

// Who is signed in: a Kaizen team member or a client contact. RLS only lets each read themselves.
// While the owner views as a teammate (checked on the server for every request: lib/view-as.ts), it's that teammate.
export const getViewer = cache(async (): Promise<Viewer> => {
  const supabase = await createSessionClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login");
  const uid = claims.claims.sub;

  const va = await activeViewAs();
  if (va) return { ...staffFrom(va.target), viewAs: { actorId: va.actorId, actorName: va.actorName, mode: va.mode, role: va.role, label: va.label } };

  const { data: profile } = await supabase.from("profiles").select(STAFF_COLUMNS).eq("auth_user_id", uid).eq("is_active", true).maybeSingle();

  if (profile) return staffFrom(profile as StaffRow);

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, email, full_name, contact_clients(removed_at, clients(id, name, slug, logo_path, portal_live))")
    .eq("auth_user_id", uid)
    .eq("is_active", true)
    .maybeSingle();

  if (!contact) redirect("/login?error=inactive");

  const brands = (contact.contact_clients ?? [])
    .flatMap((cc: { clients: unknown; removed_at: string | null }) => {
      // Taken off this brand: it's no longer theirs
      if (cc.removed_at) return [];
      const c = cc.clients as { id: string; name: string; slug: string; logo_path: string | null; portal_live: boolean } | null;
      // A contact only has the brands Kaizen has switched live
      return c?.portal_live ? [{ id: c.id, name: c.name, slug: c.slug, logoPath: c.logo_path }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { kind: "contact", id: contact.id, email: contact.email, fullName: contact.full_name, brands };
});

export async function requireStaff() {
  const viewer = await getViewer();
  if (viewer.kind !== "staff") redirect("/");
  return viewer;
}

/** Executives and leaders (Head of Meta / Creative / Google). */
export const isExecOrLead = (s: Staff) => s.isExec || s.isLead;

export async function requireExec() {
  const staff = await requireStaff();
  if (!staff.isExec) redirect("/pipeline");
  return staff;
}

/**
 * The media-buying pages (the KPI board with its audits and sprints, the Ads Lab) aren't the creative team's.
 * Someone on it who lands on one (an old link, a bookmark) goes to their own place instead of a dead end: the
 * creative team's KPIs for the KPI board (the Head of Creative; designers and editors the Board), home otherwise.
 */
export async function keepCreativeOut(page: "kpis" | "lab") {
  const staff = await requireStaff();
  if (!isCreativeRole(staff.role)) return staff;
  const lead = staff.role === "head_of_creative";
  redirect(page === "kpis" ? (lead ? "/board?view=kpis" : "/board") : "/pipeline");
}

/**
 * Client reports are only for executives and media buyers (canSeeReports). Anyone else who lands on one (an old link,
 * a bookmark) goes home instead of a dead end.
 */
export async function requireReports() {
  const staff = await requireStaff();
  if (!canSeeReports(staff)) redirect("/pipeline");
  return staff;
}

export async function requireContact() {
  const viewer = await getViewer();
  if (viewer.kind !== "contact") redirect("/");
  return viewer;
}

/** Execs, leads, customer success and the copywriter work across every client. */
export const seesAllClients = (s: Staff) => s.isExec || s.isLead || s.isCoordinator || s.isCopywriter;

/**
 * Every client is an option for them (to see and request creative for): everyone above, plus a lead graphic designer or
 * lead video editor. Only the client choice widens; it isn't the contact-managing access seesAllClients also gives.
 * Matches private.can_see_client() in the database.
 */
export const hasEveryClient = (s: Staff) => seesAllClients(s) || isLeadMaker(s.role);
