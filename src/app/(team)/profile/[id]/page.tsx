import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { roleLabel, type TeamRole } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { ProfileView } from "./profile-view";
import { PlatformAliases } from "./platform-aliases";

export const metadata: Metadata = { title: "Profile" };

// One person's profile: picture, the name they go by, title, bio and how long they've been at Kaizen. Anyone on the team
// can read it (profiles are staff-wide); only the person themselves edits it. It starts from their Slack profile the
// first time (see src/lib/profile-slack.ts) and is theirs after that.

export default async function ProfilePage({ params }: PageProps<"/profile/[id]">) {
  const me = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  const base = await db.from("profiles").select("id, full_name, email, role, avatar_url, is_active").eq("id", id).maybeSingle();
  if (!base.data) notFound();
  // The profile fields are read on their own, so the page opens before the profiles migration
  const { data: more } = await db.from("profiles").select("display_name, title, bio, start_date, slack_user_id").eq("id", id).maybeSingle();
  // Names in ad platforms, read on their own too (before the account watch migration they're simply not there)
  const { data: aliasRow } = await db.from("profiles").select("platform_aliases").eq("id", id).maybeSingle();
  const p = base.data;
  const mine = p.id === me.id;
  return (
    <div className="mx-auto grid max-w-2xl gap-5">
      <Link href="/team" className="inline-flex min-h-11 items-center justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
        ← Team
      </Link>
      <ProfileView
        mine={mine}
        slack={Boolean(process.env.SLACK_BOT_TOKEN)}
        person={{
          id: p.id,
          fullName: p.full_name,
          email: p.email,
          role: roleLabel(p.role as TeamRole),
          active: p.is_active,
          avatarUrl: p.avatar_url,
          displayName: (more?.display_name as string | null | undefined) ?? null,
          title: (more?.title as string | null | undefined) ?? null,
          bio: (more?.bio as string | null | undefined) ?? null,
          startDate: (more?.start_date as string | null | undefined) ?? null,
        }}
      />
      <PlatformAliases profileId={p.id} initial={((aliasRow?.platform_aliases as string[] | null | undefined) ?? [])} canEdit={mine || me.isExec || me.isLead} />
    </div>
  );
}
