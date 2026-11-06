import { TeamShell } from "@/components/team-shell";
import { UploadProvider } from "@/components/upload-provider";
import { Toaster } from "@/components/toasts";
import { AuditWatcher } from "@/components/audit-watcher";
import { ActivityTracker } from "@/components/activity-tracker";
import { FeedbackBubble } from "@/components/feedback-bubble";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { canSeeReports, isCreativeRole, roleLabel } from "@/lib/roles";
import { formatList } from "@/lib/creative-formats";
import { CreativeFormatsProvider } from "@/components/creative-formats-provider";
import { can } from "@/lib/chat-permissions";
import { createClient } from "@/lib/supabase/server";
import type { Theme } from "./theme-actions";

export default async function TeamLayout({ children }: LayoutProps<"/">) {
  const me = await requireStaff();
  const { data: pref } = await (await createClient()).from("profiles").select("theme").eq("id", me.id).maybeSingle();
  return (
    <UploadProvider>
      <TeamShell name={me.fullName} roles={roleLabel(me.role)} tier={me.isExec ? "exec" : me.isLead ? "lead" : "member"} creative={isCreativeRole(me.role) ? (me.role === "head_of_creative" ? "lead" : "maker") : null} reports={canSeeReports(me)} theme={(pref?.theme as Theme | null) ?? null}>
        <CreativeFormatsProvider formats={formatList(me)} can={{ briefWhy: can(me, "brief").ok ? null : "Briefs are for the creative team and the buyers", copyWhy: can(me, "copy").ok ? null : "Copy is for the copywriter and the buyers" }}>
          {children}
        </CreativeFormatsProvider>
      </TeamShell>
      <Toaster />
      <AuditWatcher />
      <ActivityTracker />
      <Suspense fallback={null}>
        <FeedbackBubble />
      </Suspense>
    </UploadProvider>
  );
}
