import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { TeamRole } from "@/lib/roles";

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

// Who is signed in: a Kaizen team member or a client contact. RLS only lets each read themselves.
export const getViewer = cache(async (): Promise<Viewer> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login");
  const uid = claims.claims.sub;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, role, is_exec, is_lead, is_creative, is_buyer, is_copywriter, is_coordinator")
    .eq("auth_user_id", uid)
    .eq("is_active", true)
    .maybeSingle();

  if (profile) {
    return {
      kind: "staff",
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      avatarUrl: profile.avatar_url,
      role: profile.role as TeamRole,
      isExec: profile.is_exec,
      isLead: profile.is_lead,
      isCreative: profile.is_creative,
      isBuyer: profile.is_buyer,
      isCopywriter: profile.is_copywriter,
      isCoordinator: profile.is_coordinator,
    };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, email, full_name, contact_clients(clients(id, name, slug, logo_path, portal_live))")
    .eq("auth_user_id", uid)
    .eq("is_active", true)
    .maybeSingle();

  if (!contact) redirect("/login?error=inactive");

  const brands = (contact.contact_clients ?? [])
    .flatMap((cc: { clients: unknown }) => {
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

export async function requireContact() {
  const viewer = await getViewer();
  if (viewer.kind !== "contact") redirect("/");
  return viewer;
}

/** Execs, leads, customer success and the copywriter work across every client. */
export const seesAllClients = (s: Staff) => s.isExec || s.isLead || s.isCoordinator || s.isCopywriter;
