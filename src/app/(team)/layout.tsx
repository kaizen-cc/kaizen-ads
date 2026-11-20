import { TeamShell } from "@/components/team-shell";
import { UploadProvider } from "@/components/upload-provider";
import { AgentCallProvider } from "@/components/agent-call-provider";
import { Toaster } from "@/components/toasts";
import { AuditWatcher } from "@/components/audit-watcher";
import { ActivityTracker } from "@/components/activity-tracker";
import { AssistantRinger } from "@/components/assistant-ringer";
import { FeedbackBubble } from "@/components/feedback-bubble";
import { DirectionSheet } from "@/components/direction-sheet";
import { CommentsSheet } from "@/components/item-comments";
import { Suspense } from "react";
import { after } from "next/server";
import { PeopleProvider } from "@/components/people-provider";
import { seedProfileFromSlack } from "@/lib/profile-slack";
import { shownName } from "@/lib/profile";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth";
import { canSeeReports, isChannelOnly, isCreativeRole, roleLabel } from "@/lib/roles";
import { formatList } from "@/lib/creative-formats";
import { CreativeFormatsProvider } from "@/components/creative-formats-provider";
import { can } from "@/lib/chat-permissions";
import { createClient } from "@/lib/supabase/server";
import type { Theme } from "./theme-actions";

export default async function TeamLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  const db = await createClient();
  // Their own assistant's color is read on its own, so the theme still loads before its migration
  // The team's pictures (profiles are staff-wide) and their own profile bits are read the same way: before the profiles
  // migration the second just comes back empty
  const [{ data: pref }, { data: look }, { data: people }, { data: mine }] = await Promise.all([
    db.from("profiles").select("theme").eq("id", me.id).maybeSingle(),
    db.from("profiles").select("assistant_color").eq("id", me.id).maybeSingle(),
    db.from("profiles").select("id, full_name, avatar_url"),
    db.from("profiles").select("display_name, assistant_name, profile_seeded_at").eq("id", me.id).maybeSingle(),
  ]);
  // First setup: their picture, name, title and status come over from Slack once (never again on its own)
  // (never while the owner views as them: nothing is changed for a real person)
  if (mine && !mine.profile_seeded_at && adminConfigured() && !me.viewAs) after(() => seedProfileFromSlack(createAdminClient(), me.id).catch(() => undefined));
  const shown = shownName({ display_name: mine?.display_name as string | null | undefined, full_name: me.fullName });
  return (
    <UploadProvider>
      <PeopleProvider people={(people ?? []).map((p) => ({ name: p.full_name as string, id: p.id as string, url: (p.avatar_url as string | null) ?? null, display: p.full_name as string }))}>
      <AgentCallProvider meId={me.id} assistantColor={(look?.assistant_color as string | null | undefined) ?? null} assistantName={(mine?.assistant_name as string | null | undefined) ?? null}>
      <TeamShell name={shown} fullName={me.fullName} meId={me.id} roles={roleLabel(me.role)} tier={me.isExec ? "exec" : me.isLead ? "lead" : "member"} creative={isCreativeRole(me.role) ? (me.role === "head_of_creative" ? "lead" : "maker") : null} reports={canSeeReports(me)} channel={isChannelOnly(me.role)} role={me.role} theme={(pref?.theme as Theme | null) ?? null} viewAs={me.viewAs ? { label: me.viewAs.label, name: me.fullName } : null} canViewAs={Boolean(me.viewAs || me.canViewAs)}>
        <CreativeFormatsProvider formats={formatList(me)} can={{ briefWhy: can(me, "brief").ok ? null : "Briefs are for the creative team and the buyers", copyWhy: can(me, "copy").ok ? null : "Copy is for the copywriter and the buyers" }}>
          {children}
        </CreativeFormatsProvider>
      </TeamShell>
      <Toaster />
      <AuditWatcher />
      <ActivityTracker />
      {/* Urgent items: their assistant rings them in the app (or leaves it in the chat) */}
      <AssistantRinger />
      <Suspense fallback={null}>
        <FeedbackBubble />
      </Suspense>
      {/* A client changed direction: the sheet opens over any page (?direction=<id>) */}
      <Suspense fallback={null}>
        <DirectionSheet />
      </Suspense>
      {/* Comments on any Overview or Today item: the sheet opens over any page (?comments=<key>) */}
      <Suspense fallback={null}>
        <CommentsSheet />
      </Suspense>
      </AgentCallProvider>
      </PeopleProvider>
    </UploadProvider>
  );
}
