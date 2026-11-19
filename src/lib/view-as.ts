import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createSessionClient } from "@/lib/supabase/session";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { parseViewAsCookie, VIEW_AS_BLOCKED_COOKIE, VIEW_AS_COOKIE, ViewAsReadOnlyError, viewAsLabel, type ViewAsChoice } from "@/lib/view-as-core";

// The server side of view as (the pure parts and how it all holds together: lib/view-as-core.ts).

/** The profile columns a Staff is built from (lib/auth.ts) */
export const STAFF_COLUMNS = "id, email, full_name, avatar_url, role, is_exec, is_lead, is_creative, is_buyer, is_copywriter, is_coordinator, can_view_as";

export type StaffRow = {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  is_exec: boolean;
  is_lead: boolean;
  is_creative: boolean;
  is_buyer: boolean;
  is_copywriter: boolean;
  is_coordinator: boolean;
  can_view_as: boolean;
};

export type ActiveViewAs = {
  /** The owner, really signed in */
  actorId: string;
  actorName: string;
  /** Who the app answers as */
  target: StaffRow;
  mode: "person" | "role";
  role: TeamRole | null;
  /** "Peter Gonzalez (Head of Organic Social)" */
  label: string;
};

/** The choice in the cookie, unchecked (cheap: no database). Null outside a request. */
export async function viewAsCookieNow(): Promise<ViewAsChoice | null> {
  try {
    return parseViewAsCookie((await cookies()).get(VIEW_AS_COOKIE)?.value);
  } catch {
    return null;
  }
}

/**
 * Who the owner is viewing as, checked: the signed-in person must have can_view_as and the target must be an active
 * teammate other than them. Null for everyone else (and when nothing is chosen, without touching the database).
 */
export const activeViewAs = cache(async (): Promise<ActiveViewAs | null> => {
  const choice = await viewAsCookieNow();
  if (!choice) return null;
  try {
    const db = await createSessionClient();
    const { data: claims } = await db.auth.getClaims();
    const uid = claims?.claims?.sub;
    if (!uid) return null;
    const { data: me } = await db.from("profiles").select("id, full_name, can_view_as").eq("auth_user_id", uid).eq("is_active", true).maybeSingle();
    if (!me?.can_view_as || me.id === choice.id) return null;
    const { data: target } = await db.from("profiles").select(STAFF_COLUMNS).eq("id", choice.id).eq("is_active", true).maybeSingle();
    if (!target) return null;
    const t = target as StaffRow;
    const mode = choice.role ? "role" : "person";
    return {
      actorId: me.id as string,
      actorName: me.full_name as string,
      target: t,
      mode,
      role: choice.role,
      label: viewAsLabel({ name: t.full_name, roleLabel: roleLabel((choice.role ?? t.role) as TeamRole), mode }),
    };
  } catch {
    return null;
  }
});

/** Remembers, for the page, that a change was just refused (it shows the message once). Quiet where cookies can't be set. */
export async function flagViewAsBlocked() {
  try {
    (await cookies()).set(VIEW_AS_BLOCKED_COOKIE, "1", { path: "/", maxAge: 60, sameSite: "lax" });
  } catch {
    // A page render can't set cookies; the refusal itself still stands
  }
}

/**
 * For code that changes something outside the database (or wants to say so before it tries): refuses while viewing
 * as someone. Database writes and outside calls are refused anyway; this makes the message clear and early.
 */
export async function assertNotViewingAs() {
  const choice = await viewAsCookieNow();
  if (!choice) return;
  await flagViewAsBlocked();
  throw new ViewAsReadOnlyError(choice.name);
}

/** The refusal as an action's usual answer ({ ok: false, error }), or null when nothing is in the way */
export async function viewAsRefusal(): Promise<{ ok: false; error: string } | null> {
  try {
    await assertNotViewingAs();
    return null;
  } catch (e) {
    if (e instanceof ViewAsReadOnlyError) return { ok: false, error: e.message };
    throw e;
  }
}
